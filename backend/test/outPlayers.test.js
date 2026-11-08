import { test, describe, beforeAll as before, beforeEach, afterAll as after } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nba-dfs-out-players-'));
process.env.DATABASE_TYPE = 'sqlite';
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');

let db;
let out;
let backfill;
let snapshots;
let source;
let migrations;

before(async () => {
  db = (await import('../src/config/database.js')).default;
  await (await import('../src/config/schema.js')).createTables(db);
  out = await import('../src/services/outPlayerService.js');
  backfill = await import('../src/services/rotowireSlateBackfillService.js');
  snapshots = await import('../src/services/slateSnapshotService.js');
  source = await import('../src/services/slateSource.js');
  migrations = await import('../src/config/snapshotMigrations.js');
});

after(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(async () => {
  for (const t of ['slates', 'players', 'slate_player_snapshots', 'slate_catalog', 'historical_games']) await db.run(`DELETE FROM ${t}`);
});

// RotoWire players.php entry
const rw = (rwID, first, last, {
  pos = ['PG', 'G', 'UTIL'], team = 'NYK', opp = 'BOS', dateTime = '2026-10-23 19:30:00',
  salary = 6000, pts = '30.00', minutes = 30, injuryStatus = null
} = {}) => ({
  rwID, firstName: first, lastName: last, rotoPos: pos[0], pos, injuryStatus, isHome: true,
  imageURL: `https://img/${rwID}.jpg`, team: { abbr: team }, opponent: { team: opp }, game: { dateTime },
  salary, pts, rostership: 5, minutes, lineup: { slot: '', isConfirmed: true },
  odds: { moneyline: null, overUnder: null, spread: null, impliedPts: null, impliedWinProb: null },
  stats: { season: { games: 3, minutes: '20.0' }, advanced: { rest: '1' } }
});

const payload = () => [
  rw(1, 'Jalen', 'Brunson', { salary: 9000, pts: '45.00', minutes: 36 }),
  rw(2, 'Karl-Anthony', 'Towns', { pos: ['PF', 'F', 'C', 'UTIL'], salary: 8800, pts: '44.00', minutes: 35 }),
  rw(3, 'Jayson', 'Tatum', { pos: ['SF', 'PF', 'F', 'UTIL'], team: 'BOS', opp: 'NYK', salary: 9500, pts: '47.00', minutes: 36 }),
  rw(4, 'Mitchell', 'Robinson', { pos: ['C', 'UTIL'], salary: 4500, pts: '0.00', minutes: 0, injuryStatus: 'OUT' }),
  rw(5, 'Jrue', 'Holiday', { team: 'BOS', opp: 'NYK', salary: 5500, pts: '0.00', minutes: 0, injuryStatus: 'DOUBT' }),
  rw(6, 'Deep', 'Bench', { salary: 3000, pts: '0.00', minutes: 0 }),
  rw(7, 'Josh', 'Hart', { salary: 6500, pts: '30.00', minutes: 32, injuryStatus: 'QUES' }),
  // second game: a DK classic slate needs 2+
  rw(8, 'Luka', 'Doncic', { team: 'LAL', opp: 'GSW', dateTime: '2026-10-23 22:00:00', salary: 11000, pts: '52.00', minutes: 36 })
];

describe('excludedPlayersFromRotowire', () => {
  test('keeps players the pool drops that carry an injury tag, as 0-projection context rows', () => {
    const rows = out.excludedPlayersFromRotowire(payload(), { stripStats: true });
    assert.deepEqual(rows.map(r => [r.name, r.injury_status]), [['Mitchell Robinson', 'OUT'], ['Jrue Holiday', 'DOUBT']]);
    const mitch = rows[0];
    assert.equal(mitch.pool_excluded, 1);
    assert.equal(mitch.projected_points, 0);
    assert.equal(mitch.salary, 4500);
    assert.equal(mitch.team, 'NYK');
    assert.equal(mitch.position, 'C,UTIL');
    assert.equal(JSON.parse(mitch.raw_data).stats, undefined, 'stats stripped (current-season lookahead)');
    assert.equal(JSON.parse(mitch.raw_data).game.dateTime, '2026-10-23 19:30:00');
  });

  test('keptIds from the sync transform decide who made the pool', () => {
    const rows = out.excludedPlayersFromRotowire(payload(), { keptIds: new Set(['1', '2', '3']) });
    assert.deepEqual(rows.map(r => r.name), ['Mitchell Robinson', 'Jrue Holiday', 'Josh Hart']);
    assert.ok(JSON.parse(rows[0].raw_data).stats, 'a live payload keeps stats (pre-game at sync time)');
  });
});

describe('confirmPostlockOut', () => {
  // NYK played 10/20, 10/23 (slate), 10/25; fetched 10/27
  const ctx = (played) => ({
    teamDates: new Map([['NYK', ['2026-10-20', '2026-10-23', '2026-10-25']]]),
    played: new Map(Object.entries(played).map(([k, d]) => [k, new Set(d)]))
  });
  const check = (played, over = {}) => out.confirmPostlockOut({
    key: 'mitchell robinson', team: 'NYK', gameDate: '2026-10-23', fetchDate: '2026-10-27', status: 'OUT', ...over
  }, ctx(played));

  test('missed the previous game and every game through the fetch date: confirmed', () => {
    assert.deepEqual(check({}), { ok: true, reason: 'missed 2026-10-20 through 2026-10-27', opener: false });
  });
  test('played in the previous game: the absence was not known before tip-off', () => {
    assert.equal(check({ 'mitchell robinson': ['2026-10-20'] }).ok, false);
  });
  test('played that night or after it (the tag is a later injury): rejected', () => {
    assert.equal(check({ 'mitchell robinson': ['2026-10-23'] }).ok, false);
    assert.equal(check({ 'mitchell robinson': ['2026-10-25'] }).ok, false);
  });
  test('only OUT-like tags, and only when the team game is in the box scores', () => {
    assert.equal(check({}, { status: 'QUES' }).ok, false);
    assert.equal(check({}, { status: 'DOUBT' }).ok, false);
    assert.equal(check({}, { gameDate: '2026-10-22' }).ok, false);
  });
  test('a team\'s first game of the season has no previous game to check', () => {
    const r = check({}, { gameDate: '2026-10-20' });
    assert.equal(r.ok, true);
    assert.equal(r.opener, true);
  });
});

describe('classifyExcluded', () => {
  const excluded = () => out.excludedPlayersFromRotowire(payload(), { stripStats: true });
  const empty = { teamDates: new Map(), played: new Map() };

  test('a payload fetched before tip-off keeps every tag as pre-lock', () => {
    const rows = out.classifyExcluded(excluded(), { gameDate: '2026-10-23', fetchedAt: '2026-10-23T16:00:00Z', ctx: empty });
    assert.deepEqual(rows.map(r => [r.player.name, r.evidence]), [
      ['Mitchell Robinson', 'payload_prelock'], ['Jrue Holiday', 'payload_prelock']
    ]);
  });

  test('a payload fetched after tip-off needs the absence spell (no box scores: nothing)', () => {
    assert.deepEqual(out.classifyExcluded(excluded(), { gameDate: '2026-10-23', fetchedAt: '2026-10-27T16:00:00Z', ctx: empty }), []);
  });
});

describe('backfill --out-only', () => {
  const run = ({ fetchedAt, ...opts } = {}) => backfill.backfillRotowireSlates({
    from: '2026-10-23', to: '2026-10-23', slateIds: ['29850'], fetchSlate: async () => payload(), fetchOdds: async () => new Map(),
    fetchedAtOf: () => (fetchedAt ? new Date(fetchedAt) : null), now: new Date('2026-10-27T15:00:00Z'), outOnly: true, ...opts
  });
  const rows = () => db.all(`SELECT player_key, pool_excluded, out_evidence, capture_source, injury_status, projected_points
    FROM slate_player_snapshots WHERE slate_id = '29850' ORDER BY player_key`);

  test('writes pre-lock OUT rows only, never pool rows, and is idempotent', async () => {
    await run({ fetchedAt: '2026-10-23T16:00:00Z' });
    await run({ fetchedAt: '2026-10-23T16:00:00Z' });
    assert.deepEqual(await rows(), [
      { player_key: 'jrue holiday', pool_excluded: 1, out_evidence: 'payload_prelock', capture_source: 'rotowire_backfill', injury_status: 'DOUBT', projected_points: 0 },
      { player_key: 'mitchell robinson', pool_excluded: 1, out_evidence: 'payload_prelock', capture_source: 'rotowire_backfill', injury_status: 'OUT', projected_points: 0 }
    ]);
  });

  test('a post-lock payload writes only box-score-confirmed OUT tags', async () => {
    for (const [key, team, date, minutes] of [
      ['mitchell robinson', 'NYK', '2026-10-20', 0], ['jalen brunson', 'NYK', '2026-10-20', 35],
      ['jalen brunson', 'NYK', '2026-10-23', 36], ['jrue holiday', 'BOS', '2026-10-23', 0], ['jayson tatum', 'BOS', '2026-10-23', 36]
    ]) {
      await db.run(`INSERT INTO historical_games (player_key, player_name, team, opponent, game_date, minutes, dk_fantasy_points)
        VALUES (?, ?, ?, 'X', ?, ?, 0)`, key, key, team, date, minutes);
    }
    await run({ fetchedAt: '2026-10-27T16:00:00Z' });
    // Holiday is DOUBT (not an OUT tag) on a post-lock payload
    assert.deepEqual((await rows()).map(r => [r.player_key, r.out_evidence]), [['mitchell robinson', 'payload_postlock_confirmed']]);
  });

  test('never replaces a pool row or a live capture', async () => {
    const slate = { slate_id: '29850', start_time: null };
    const now = new Date('2026-10-23T15:00:00Z');
    const raw = JSON.stringify({ game: { dateTime: '2026-10-23 19:30:00' } });
    await snapshots.upsertSnapshotRow(snapshots.snapshotRowFor(
      { name: 'Mitchell Robinson', team: 'NYK', salary: 4500, projected_points: 18, raw_data: raw }, { slate, site: 'draftkings', now }));
    await snapshots.upsertSnapshotRow(snapshots.snapshotRowFor(
      { name: 'Jrue Holiday', team: 'BOS', salary: 5500, projected_points: 0, injury_status: 'OUT', raw_data: raw, pool_excluded: 1, out_evidence: 'live_sync' },
      { slate, site: 'draftkings', now }));
    await run({ fetchedAt: '2026-10-23T16:00:00Z' });
    assert.deepEqual((await rows()).map(r => [r.player_key, r.pool_excluded, r.out_evidence, r.capture_source, r.projected_points]), [
      ['jrue holiday', 1, 'live_sync', null, 0],
      ['mitchell robinson', null, null, null, 18]
    ]);
  });
});

describe('live sync capture', () => {
  const seed = async (startTime = null) => db.run(`INSERT INTO slates (slate_id, name, sport, start_time, site) VALUES ('s1', 'Main', 'NBA', ?, 'draftkings')`, startTime);
  const excludedAt = (dateTime) => out.excludedPlayersFromRotowire([rw(4, 'Mitchell', 'Robinson', { dateTime, pts: '0.00', minutes: 0, injuryStatus: 'OUT' })]);

  test('writes OUT rows for games not yet started and skips started ones', async () => {
    await seed();
    const now = new Date('2026-10-23T20:00:00Z'); // 4 PM ET
    assert.equal(await out.snapshotExcludedPlayers('s1', excludedAt('2026-10-23 19:30:00'), { now }), 1);
    assert.equal(await out.snapshotExcludedPlayers('s1', excludedAt('2026-10-23 13:00:00'), { now }), 0);
    const row = await db.get(`SELECT * FROM slate_player_snapshots WHERE slate_id = 's1'`);
    assert.equal(row.pool_excluded, 1);
    assert.equal(row.out_evidence, 'live_sync');
    assert.equal(row.injury_status, 'OUT');
    assert.equal(row.game_date, '2026-10-23');
    assert.equal((await db.get(`SELECT COUNT(*) AS n FROM players`)).n, 0, 'never written to players');
  });

  test('a pool row from an earlier sync becomes an OUT row, and back to a pool row when he returns', async () => {
    await seed();
    const playerModel = (await import('../src/models/playerModel.js')).default;
    const raw = JSON.stringify({ game: { dateTime: '2026-10-23 19:30:00' } });
    await playerModel.bulkCreateOrUpdate('s1', [{ playerId: '4', name: 'Mitchell Robinson', team: 'NYK', opponent: 'BOS', position: 'C', salary: 4500, projectedPoints: 18, projectedMinutes: 22, rawData: raw }]);
    const morning = new Date('2026-10-23T14:00:00Z');
    await snapshots.snapshotSlate('s1', { now: morning });
    await db.run(`DELETE FROM players`);
    await out.snapshotExcludedPlayers('s1', excludedAt('2026-10-23 19:30:00'), { now: new Date('2026-10-23T20:00:00Z') });
    let row = await db.get(`SELECT pool_excluded, projected_points, injury_status FROM slate_player_snapshots WHERE slate_id = 's1'`);
    assert.deepEqual(row, { pool_excluded: 1, projected_points: 0, injury_status: 'OUT' });

    await playerModel.bulkCreateOrUpdate('s1', [{ playerId: '4', name: 'Mitchell Robinson', team: 'NYK', opponent: 'BOS', position: 'C', salary: 4500, projectedPoints: 17, projectedMinutes: 21, rawData: raw }]);
    await snapshots.snapshotSlate('s1', { now: new Date('2026-10-23T21:00:00Z') });
    row = await db.get(`SELECT pool_excluded, out_evidence, projected_points FROM slate_player_snapshots WHERE slate_id = 's1'`);
    assert.deepEqual(row, { pool_excluded: null, out_evidence: null, projected_points: 17 });
  });
});

describe('readers leave OUT rows out of the pool', () => {
  test('backtest slate players, slate picker counts and the pool filter', async () => {
    const slate = { slate_id: 'past', start_time: null };
    const now = new Date('2026-10-20T15:00:00Z');
    const raw = JSON.stringify({ game: { dateTime: '2026-10-20 19:30:00' } });
    for (const p of [
      { name: 'Jalen Brunson', team: 'NYK', opponent: 'BOS', position: 'PG', salary: 9000, projected_points: 45, raw_data: raw },
      { name: 'Mitchell Robinson', team: 'NYK', opponent: 'BOS', position: 'C', salary: 4500, projected_points: 0, injury_status: 'OUT', raw_data: raw, pool_excluded: 1, out_evidence: 'live_sync' }
    ]) await snapshots.upsertSnapshotRow(snapshots.snapshotRowFor(p, { slate, site: 'draftkings', now }));

    const resolved = await source.resolveSlate({ slateDate: '2026-10-20', now: new Date('2026-10-25T12:00:00Z') });
    assert.equal(resolved.playerCount, 1);
    const players = await source.loadSlatePlayers(resolved, { includeZero: true, sanity: false, injuryRisk: false });
    assert.deepEqual(players.map(p => p.name), ['Jalen Brunson']);
    const listed = await source.listBacktestSlates({ now: new Date('2026-10-25T12:00:00Z') });
    assert.equal(listed[0].players, 1);
    assert.equal(migrations.inPool('s'), 'COALESCE(s.pool_excluded, 0) = 0');
  });

  test('migration adds the columns idempotently', async () => {
    await migrations.migrateSlatePlayerSnapshots(db);
    await migrations.migrateSlatePlayerSnapshots(db);
    const cols = (await db.all(`PRAGMA table_info(slate_player_snapshots)`)).map(c => c.name);
    assert.ok(cols.includes('pool_excluded') && cols.includes('out_evidence'));
  });
});

describe('snapshot rest days', () => {
  test('days since the previous game minus 1, NULL rows only, no later games', async () => {
    const { restDaysBefore, fillSnapshotRestDays } = await import('../src/services/snapshotRestDays.js');
    assert.equal(restDaysBefore('2026-10-23', ['2026-10-22', '2026-10-20', '2026-10-25']), 0);
    assert.equal(restDaysBefore('2026-10-23', ['2026-10-20']), 2);
    assert.equal(restDaysBefore('2026-10-23', ['2026-10-23', '2026-10-24']), null);

    for (const [key, date] of [['a', '2026-10-21'], ['a', '2026-10-22'], ['a', '2026-10-24'], ['b', '2026-10-19']]) {
      await db.run(`INSERT INTO historical_games (player_key, player_name, team, opponent, game_date, minutes) VALUES (?, ?, 'NYK', 'BOS', ?, 30)`, key, key, date);
    }
    const slate = { slate_id: 'r', start_time: null };
    const now = new Date('2026-10-23T12:00:00Z');
    const raw = JSON.stringify({ game: { dateTime: '2026-10-23 19:30:00' } });
    for (const [name, rest] of [['A', null], ['B', 5], ['C', null]]) {
      await snapshots.upsertSnapshotRow(snapshots.snapshotRowFor({ name, raw_data: raw, rest_days: rest }, { slate, site: 'draftkings', now }));
    }
    assert.deepEqual(await fillSnapshotRestDays(), { candidates: 2, filled: 1, noPriorGame: 1 });
    assert.deepEqual(await fillSnapshotRestDays(), { candidates: 1, filled: 0, noPriorGame: 1 });
    const rows = await db.all(`SELECT player_key, rest_days FROM slate_player_snapshots ORDER BY player_key`);
    assert.deepEqual(rows, [{ player_key: 'a', rest_days: 0 }, { player_key: 'b', rest_days: 5 }, { player_key: 'c', rest_days: null }]);
  });
});
