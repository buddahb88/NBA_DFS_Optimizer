import { test, describe, beforeAll as before, beforeEach, afterAll as after } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'salaries');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nba-dfs-snapshot-details-'));
process.env.DATABASE_TYPE = 'sqlite';
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');

let db;
let createTables;
let snapshots;
let backfill;
let legacy;
let playerModel;

before(async () => {
  db = (await import('../src/config/database.js')).default;
  ({ createTables } = await import('../src/config/schema.js'));
  await createTables(db);
  snapshots = await import('../src/services/slateSnapshotService.js');
  backfill = await import('../src/services/snapshotBackfillService.js');
  legacy = await import('../src/services/variance/legacyRanges.js');
  playerModel = (await import('../src/models/playerModel.js')).default;
});

after(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(async () => {
  for (const t of ['players', 'slates', 'slate_player_snapshots', 'player_archetypes']) {
    await db.run(`DELETE FROM ${t}`);
  }
});

// RotoWire raw_data as stored on players.raw_data
const rawFor = ({ dateTime = '2026-10-21 22:00:00', last3 = 55.1, last5 = 56.7, last7 = 61.6, season = 61.1, isHome = true } = {}) =>
  JSON.stringify({
    game: { dateTime },
    isHome,
    stats: { avgFpts: { last3: String(last3), last5: String(last5), last7: String(last7), last14: '65.8', season: String(season) } }
  });

const rwPlayer = (playerId, name, overrides = {}) => ({
  playerId,
  name,
  team: 'LAL',
  opponent: 'GSW',
  position: 'PG,G,UTIL',
  salary: 11000,
  projectedPoints: 52.97,
  projectedMinutes: 35,
  value: 4.8,
  valueGpp: 4.9,
  gameInfo: 'LAL vs GSW',
  injuryStatus: null,
  lineupConfirmed: 0,
  per: 28.34,
  usage: 38.26,
  restDays: 2,
  fptsLast3: 55.1,
  fptsLast5: 56.7,
  fptsLast7: 61.6,
  fptsLast14: 65.8,
  vegasImpliedTotal: 120.25,
  vegasSpread: -6.5,
  vegasOverUnder: 234,
  vegasWinProb: 66.7,
  rostership: 11.8,
  headshot: 'https://img/luka.jpg',
  dvpPtsAllowed: 25,
  floor: 50.18,
  ceiling: 55.76,
  volatility: 0.05,
  boomProbability: 2.5,
  bustProbability: 40,
  fppm: 1.51,
  leverageScore: 19.7,
  blowoutRisk: 0,
  stdDev: 2.79,
  rawData: rawFor(),
  ...overrides
});

async function seedSlate(slateId, players, { site = 'draftkings', startTime = '10:00 PM' } = {}) {
  await db.run(`INSERT INTO slates (slate_id, name, sport, start_time, site) VALUES (?, ?, 'NBA', ?, ?)`,
    slateId, `Slate ${slateId}`, startTime, site);
  await playerModel.bulkCreateOrUpdate(slateId, players);
}

const snapshotRows = () => db.all(`SELECT * FROM slate_player_snapshots ORDER BY slate_id, player_key`);

// 1 PM ET on 10/21: before the 10 PM ET tip. 10/23 noon ET: after it.
const PRE_LOCK = new Date('2026-10-21T17:00:00Z');
const POST_LOCK = new Date('2026-10-23T16:00:00Z');

describe('snapshot detail columns', () => {
  test('migration adds every rebuild column, idempotently', async () => {
    await createTables(db);
    await createTables(db);
    const cols = new Set((await db.all(`PRAGMA table_info(slate_player_snapshots)`)).map(c => c.name));
    for (const c of snapshots.SNAPSHOT_DETAIL_COLUMNS.map(c => c.name)) {
      assert.ok(cols.has(c), `missing column ${c}`);
    }
    for (const c of ['roster_positions', 'site_player_id', 'game_start_time', 'std_dev', 'volatility',
      'boom_probability', 'bust_probability', 'headshot', 'raw_data', 'archetype', 'player_id']) {
      assert.ok(cols.has(c), `missing column ${c}`);
    }
  });

  test('a pre-lock snapshot stores the complete player row', async () => {
    await seedSlate('s1', [rwPlayer('4396', 'Luka Doncic')]);
    await db.run(`UPDATE players SET roster_positions = 'PG/G/UTIL', site_player_id = '41100'`);

    assert.equal(await snapshots.snapshotSlate('s1', { now: PRE_LOCK }), 1);
    const [row] = await snapshotRows();
    assert.equal(row.player_id, '4396');
    assert.equal(row.site_player_id, '41100');
    assert.equal(row.roster_positions, 'PG/G/UTIL');
    assert.equal(row.game_info, 'LAL vs GSW');
    // 10:00 PM Eastern (EDT) = 02:00 UTC next day
    assert.equal(row.game_start_time, '2026-10-22T02:00:00.000Z');
    assert.equal(row.is_home, 1);
    assert.equal(row.std_dev, 2.79);
    assert.equal(row.volatility, 0.05);
    assert.equal(row.boom_probability, 2.5);
    assert.equal(row.bust_probability, 40);
    assert.equal(row.leverage_score, 19.7);
    assert.equal(row.fppm, 1.51);
    assert.equal(row.value, 4.8);
    assert.equal(row.per, 28.34);
    assert.equal(row.usage, 38.26);
    assert.equal(row.fpts_last5, 56.7);
    assert.equal(row.vegas_win_prob, 66.7);
    assert.equal(row.rest_days, 2);
    assert.equal(row.dvp_pts_allowed, 25);
    assert.equal(row.headshot, 'https://img/luka.jpg');
    assert.equal(JSON.parse(row.raw_data).game.dateTime, '2026-10-21 22:00:00');
  });

  test('roster_positions is derived from position when the players row has none', async () => {
    await seedSlate('s1', [rwPlayer('1', 'Luka Doncic', { position: 'PG' })]);
    await db.run(`UPDATE players SET roster_positions = NULL`);
    await snapshots.snapshotSlate('s1', { now: PRE_LOCK });
    const [row] = await snapshotRows();
    assert.equal(row.roster_positions, 'PG/G/UTIL');
  });

  test('archetype is captured from player_archetypes for the game season (prior season fallback)', async () => {
    await db.run(`INSERT INTO player_archetypes (season, player_key, archetype) VALUES ('2025-26', 'luka doncic', 'primary_creator')`);
    await seedSlate('s1', [rwPlayer('1', 'Luka Doncic')]);
    await snapshots.snapshotSlate('s1', { now: PRE_LOCK });
    const [row] = await snapshotRows();
    assert.equal(row.archetype, 'primary_creator');
  });

  test('a post-lock re-snapshot keeps pre-lock values and only fills missing columns', async () => {
    await seedSlate('s1', [rwPlayer('1', 'Luka Doncic')]);
    await snapshots.snapshotSlate('s1', { now: PRE_LOCK });
    // Older snapshot rows lacked the detail columns
    await db.run(`UPDATE slate_player_snapshots SET std_dev = NULL, headshot = NULL, site_player_id = NULL`);

    // After lock: ranges recomputed with a new model, a late salary-file ID, an injury edit
    await db.run(`UPDATE players SET floor = 36.7, ceiling = 69.3, std_dev = 15.9, boom_probability = 21,
      site_player_id = '41100', injury_status = 'OUT', projected_points = 0`);
    await snapshots.snapshotSlate('s1', { now: POST_LOCK });

    const [row] = await snapshotRows();
    assert.equal(row.floor, 50.18, 'pre-lock floor kept');
    assert.equal(row.ceiling, 55.76, 'pre-lock ceiling kept');
    assert.equal(row.boom_probability, 2.5, 'pre-lock boom kept');
    assert.equal(row.std_dev, null, 'post-lock ranges never fill the pre-lock range columns');
    assert.equal(row.projected_points, 52.97);
    assert.equal(row.injury_status, null);
    assert.equal(row.site_player_id, '41100', 'missing detail filled');
    assert.equal(row.headshot, 'https://img/luka.jpg', 'missing detail filled');
    assert.equal(row.captured_at, PRE_LOCK.toISOString(), 'capture time stays the pre-lock one');
  });

  test('salary import snapshots carry DK IDs, roster positions and the CSV game time', async () => {
    const { importSalaries } = await import('../src/services/salaryImportService.js');
    const csvText = fs.readFileSync(path.join(fixtureDir, 'DKSalaries.csv'), 'utf8');
    const report = await importSalaries({ csvText, slateId: 'dk-main' });
    const rows = await snapshotRows();
    assert.equal(rows.length, report.total);
    assert.ok(rows.every(r => r.site_player_id && r.roster_positions), 'every row has DK ID + slots');
    const luka = rows.find(r => r.player_key === 'luka doncic');
    assert.match(luka.roster_positions, /UTIL/);
    assert.match(luka.game_start_time, /^2025-10-2\dT\d{2}:\d{2}:00\.000Z$/);
  });
});

describe('legacy pre-lock ranges', () => {
  test('rebuild the pre-outcome-model floor/ceiling/std_dev/boom/bust from raw_data', () => {
    const r = legacy.legacyPreLockRanges({
      projected_points: 52.97, salary: 11000, rostership: 11.8, vegas_spread: -6.5, raw_data: rawFor()
    });
    // stdev of (55.1, 56.7, 61.6, 61.1)
    assert.ok(Math.abs(r.std_dev - 2.7887) < 0.001, `std_dev ${r.std_dev}`);
    assert.ok(Math.abs(r.floor - 50.18) < 0.01);
    assert.ok(Math.abs(r.ceiling - 55.76) < 0.01);
    assert.ok(r.boom_probability >= 0 && r.boom_probability <= 100);
    assert.ok(r.bust_probability > 50, 'needs 55 FP for 5x at $11k');
    assert.ok(Math.abs(r.leverage_score - (r.boom_probability * 100) / 12.8) < 1e-9);
  });

  test('falls back to 15% of projection with fewer than three recent averages', () => {
    const r = legacy.legacyPreLockRanges({
      projected_points: 20, salary: 4000, rostership: 5, vegas_spread: 0,
      raw_data: JSON.stringify({ stats: { avgFpts: { last3: '18' } } })
    });
    assert.equal(r.std_dev, 3);
    assert.equal(r.floor, 17);
    assert.equal(r.ceiling, 23);
  });

  test('applies the old blowout adjustment for 10+ point spreads', () => {
    const base = { projected_points: 30, salary: 6000, rostership: 5, raw_data: rawFor({ last3: 30, last5: 30, last7: 30, season: 30 }) };
    const r = legacy.legacyPreLockRanges({ ...base, vegas_spread: -14 });
    // zero spread in the averages -> 15% default std (4.5); favorite by 14: floor -2, ceiling -0.8
    assert.ok(Math.abs(r.floor - (30 - 4.5 - 2)) < 1e-9);
    assert.ok(Math.abs(r.ceiling - (30 + 4.5 - 0.8)) < 1e-9);
  });
});

describe('backfillSlateSnapshot', () => {
  test('completes a post-lock slate without touching pre-lock values; counts match players', async () => {
    await seedSlate('29805', [
      rwPlayer('1', 'Luka Doncic'),
      rwPlayer('2', 'Stephen Curry', { team: 'GSW', opponent: 'LAL', projectedPoints: 44, salary: 9500,
        floor: 0, ceiling: 0, rawData: rawFor({ last3: 40, last5: 42, last7: 45, season: 44, isHome: false }) }),
      rwPlayer('3', 'Jaren Jackson Jr.', { team: 'MEM', opponent: 'NOP', position: 'PF,C,F,UTIL' })
    ]);
    // Pre-lock snapshot from the old (narrow) schema: only Luka and Curry, no detail columns
    await snapshots.snapshotSlate('29805', { now: PRE_LOCK });
    await db.run(`DELETE FROM slate_player_snapshots WHERE player_key = 'jaren jackson'`);
    const curryPre = legacy.legacyPreLockRanges({ projected_points: 44, salary: 9500, rostership: 11.8, vegas_spread: -6.5,
      raw_data: rawFor({ last3: 40, last5: 42, last7: 45, season: 44 }) });
    await db.run(`UPDATE slate_player_snapshots SET floor = ?, ceiling = ? WHERE player_key = 'stephen curry'`,
      curryPre.floor, curryPre.ceiling);
    for (const c of snapshots.SNAPSHOT_DETAIL_COLUMNS.map(c => c.name)) {
      await db.run(`UPDATE slate_player_snapshots SET ${c} = NULL`);
    }
    // Ranges in players recomputed with the new model after lock
    await db.run(`UPDATE players SET floor = 1, ceiling = 99, std_dev = 30, boom_probability = 50, bust_probability = 5`);

    const report = await backfill.backfillSlateSnapshot('29805', { now: POST_LOCK, legacyRanges: true });
    assert.equal(report.players, 3);
    assert.equal(report.snapshotRows, 3);
    assert.equal(report.complete, true);

    const rows = await snapshotRows();
    assert.equal(rows.length, 3);
    const luka = rows.find(r => r.player_key === 'luka doncic');
    assert.equal(luka.floor, 50.18, 'pre-lock floor untouched');
    assert.ok(Math.abs(luka.std_dev - 2.79) < 0.01, 'pre-lock std_dev rebuilt by the legacy model');
    assert.ok(luka.boom_probability < 50, 'not the post-lock recomputed boom');
    assert.equal(luka.roster_positions, 'PG/G/UTIL');
    assert.equal(luka.game_start_time, '2026-10-22T02:00:00.000Z');
    assert.ok(luka.raw_data);

    const curry = rows.find(r => r.player_key === 'stephen curry');
    assert.ok(Math.abs(curry.std_dev - curryPre.std_dev) < 1e-9);

    // No pre-lock snapshot existed for JJJ: legacy ranges from raw_data fill everything
    const jjj = rows.find(r => r.player_key === 'jaren jackson');
    assert.equal(jjj.salary, 11000);
    assert.equal(jjj.roster_positions, 'PF/C/F/UTIL');
    assert.ok(jjj.std_dev > 0);
    assert.ok(Math.abs(jjj.floor - 50.18) < 0.01, 'floor rebuilt with the legacy model, not the recomputed 1');
    assert.equal(report.rangeSource.legacyVerified, 2);
    assert.equal(report.rangeSource.legacyRebuilt, 1);
  });

  test('is idempotent', async () => {
    await seedSlate('s1', [rwPlayer('1', 'Luka Doncic')]);
    await snapshots.snapshotSlate('s1', { now: PRE_LOCK });
    const first = await backfill.backfillSlateSnapshot('s1', { now: POST_LOCK });
    const before = await snapshotRows();
    const second = await backfill.backfillSlateSnapshot('s1', { now: POST_LOCK });
    assert.deepEqual(await snapshotRows(), before);
    assert.equal(first.complete, true);
    assert.equal(second.complete, true);
  });
});
