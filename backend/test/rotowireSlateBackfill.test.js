import { test, describe, beforeAll as before, beforeEach, afterAll as after } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nba-dfs-rotowire-backfill-'));
process.env.DATABASE_TYPE = 'sqlite';
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');

let db;
let backfill;
let espn;
let source;
let valueBacktest;

before(async () => {
  db = (await import('../src/config/database.js')).default;
  await (await import('../src/config/schema.js')).createTables(db);
  backfill = await import('../src/services/rotowireSlateBackfillService.js');
  espn = await import('../src/services/espnBoxScoreService.js');
  source = await import('../src/services/slateSource.js');
  valueBacktest = await import('../src/services/agentValueBacktest.js');
});

after(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(async () => {
  for (const t of ['slates', 'players', 'slate_player_snapshots', 'slate_catalog']) await db.run(`DELETE FROM ${t}`);
});

// RotoWire players.php entry for a past slate: current-season stats and null odds
const rw = (rwID, first, last, {
  pos = ['PG', 'G', 'UTIL'], team = 'LAL', opp = 'GSW', isHome = true, dateTime = '2026-10-23 22:00:00',
  salary = 6000, pts = '30.00', minutes = 30, rostership = 12.5, injuryStatus = null
} = {}) => ({
  slateID: 1671,
  rwID,
  firstName: first,
  lastName: last,
  rotoPos: pos[0],
  pos,
  injuryStatus,
  isHome,
  imageURL: `https://img/${rwID}.jpg`,
  team: { abbr: team },
  opponent: { team: opp },
  game: { dateTime },
  salary,
  pts,
  rostership,
  minutes,
  lineup: { slot: 'Yes', isConfirmed: true },
  odds: { moneyline: null, overUnder: null, spread: null, impliedPts: null, impliedWinProb: null },
  stats: {
    season: { games: 3, minutes: '33.0' },
    advanced: { per: '25.1', usage: '31.0', rest: '1' },
    avgFpts: { last3: '51.0', last5: '50.0', last7: '50.0', last14: '50.0', season: '50.0' }
  }
});

// Two DK classic games on 10/23 (LAL@GSW late, BOS@NYK early)
const classicPlayers = () => [
  rw(1, 'Luka', 'Doncic', { salary: 11000, pts: '52.00', minutes: 36 }),
  rw(2, 'Stephen', 'Curry', { pos: ['PG', 'SG', 'G', 'UTIL'], team: 'GSW', opp: 'LAL', isHome: false, salary: 9000, pts: '44.00', minutes: 34 }),
  rw(3, 'Jayson', 'Tatum', { pos: ['SF', 'PF', 'F', 'UTIL'], team: 'BOS', opp: 'NYK', isHome: false, dateTime: '2026-10-23 19:30:00', salary: 9500, pts: '47.00', minutes: 36 }),
  rw(4, 'Karl-Anthony', 'Towns', { pos: ['PF', 'F', 'C', 'UTIL'], team: 'NYK', opp: 'BOS', dateTime: '2026-10-23 19:30:00', salary: 8800, pts: '45.00', minutes: 35 }),
  rw(5, 'Out', 'Player', { team: 'NYK', opp: 'BOS', dateTime: '2026-10-23 19:30:00', salary: 4000, pts: '0.00', minutes: 0, injuryStatus: 'OUT' })
];

describe('classifySlate', () => {
  test('DK classic: DK slot pattern, DK salary scale, date and first lock from game.dateTime (ET)', () => {
    const slate = backfill.classifySlate('29850', classicPlayers());
    assert.equal(slate.site, 'draftkings');
    assert.equal(slate.contestType, 'classic');
    assert.equal(slate.gameDate, '2026-10-23');
    assert.equal(slate.games, 2);
    assert.equal(slate.players, 5);
    assert.equal(slate.firstGameTime, '2026-10-23T23:30:00.000Z');
  });

  test('showdown, non-DK slot patterns, Yahoo salaries and empty slates are not DK classic', () => {
    const showdown = [rw(1, 'A', 'B', { pos: ['CPTN', 'UTIL'] }), rw(2, 'C', 'D', { pos: ['UTIL'] })];
    assert.equal(backfill.classifySlate('1', showdown).contestType, 'showdown');
    const otherSite = classicPlayers().map(p => ({ ...p, pos: ['PG', 'G', 'F', 'UTIL'] }));
    assert.equal(backfill.classifySlate('2', otherSite).site, null);
    const yahoo = classicPlayers().map(p => ({ ...p, salary: 30 }));
    assert.equal(backfill.classifySlate('3', yahoo).site, null);
    assert.equal(backfill.classifySlate('4', []).contestType, 'empty');
  });
});

describe('markMainSlates', () => {
  test('main slate per date: most games, then earliest lock', () => {
    const slates = [
      { slateId: '10', gameDate: '2026-10-23', site: 'draftkings', contestType: 'classic', games: 3, firstGameTime: '2026-10-23T23:00:00.000Z' },
      { slateId: '11', gameDate: '2026-10-23', site: 'draftkings', contestType: 'classic', games: 12, firstGameTime: '2026-10-23T23:30:00.000Z' },
      { slateId: '12', gameDate: '2026-10-23', site: 'draftkings', contestType: 'classic', games: 12, firstGameTime: '2026-10-23T23:00:00.000Z' },
      { slateId: '13', gameDate: '2026-10-24', site: 'draftkings', contestType: 'classic', games: 2, firstGameTime: '2026-10-24T23:00:00.000Z' }
    ];
    const marked = backfill.markMainSlates(slates);
    assert.deepEqual(marked.filter(s => s.isMain).map(s => s.slateId), ['12', '13']);
  });
});

describe('parseGameOdds (ESPN pickcenter)', () => {
  test('team-perspective spread, over/under and implied totals', () => {
    const summary = { pickcenter: [{ provider: { name: 'DraftKings' }, spread: -2.5, overUnder: 233.5 }] };
    const odds = espn.parseGameOdds(summary, { home_team: 'ORL', away_team: 'ATL' });
    assert.deepEqual(odds.get('ORL'), { vegas_implied_total: 118, vegas_spread: -2.5, over_under: 233.5 });
    assert.deepEqual(odds.get('ATL'), { vegas_implied_total: 115.5, vegas_spread: 2.5, over_under: 233.5 });
  });

  test('no pickcenter line: empty map', () => {
    assert.equal(espn.parseGameOdds({ pickcenter: [] }, { home_team: 'ORL', away_team: 'ATL' }).size, 0);
  });
});

describe('snapshotPlayersFromRotowire', () => {
  const odds = new Map([
    ['LAL', { vegas_implied_total: 121, vegas_spread: -12, over_under: 230 }],
    ['GSW', { vegas_implied_total: 109, vegas_spread: 12, over_under: 230 }]
  ]);

  test('keeps pre-game fields and drops the current-season stats blocks (no lookahead)', () => {
    const players = backfill.snapshotPlayersFromRotowire(classicPlayers(), { odds });
    const luka = players.find(p => p.name === 'Luka Doncic');
    assert.equal(luka.salary, 11000);
    assert.equal(luka.projected_points, 52);
    assert.equal(luka.projected_minutes, 36);
    assert.equal(luka.rostership, 12.5);
    assert.equal(luka.position, 'PG,G,UTIL');
    assert.equal(luka.lineup_confirmed, 1);
    assert.equal(luka.headshot, 'https://img/1.jpg');
    for (const col of ['fpts_last3', 'fpts_last5', 'fpts_last7', 'fpts_last14', 'per', 'usage', 'rest_days', 'value', 'value_gpp', 'dvp_pts_allowed', 'opp_def_eff']) {
      assert.equal(luka[col], null, col);
    }
    assert.equal(JSON.parse(luka.raw_data).stats, undefined);
    assert.equal(JSON.parse(luka.raw_data).game.dateTime, '2026-10-23 22:00:00');
  });

  test('Vegas from ESPN odds by team, blowout risk from the spread; no line leaves Vegas null', () => {
    const players = backfill.snapshotPlayersFromRotowire(classicPlayers(), { odds });
    const luka = players.find(p => p.name === 'Luka Doncic');
    assert.equal(luka.vegas_implied_total, 121);
    assert.equal(luka.vegas_spread, -12);
    assert.equal(luka.vegas_over_under, 230);
    assert.ok(Math.abs(luka.blowout_risk - 0.2) < 1e-9);
    const tatum = players.find(p => p.name === 'Jayson Tatum');
    assert.equal(tatum.vegas_implied_total, null);
    assert.equal(tatum.vegas_spread, null);
  });

  test('players RotoWire projects for 0 points or 0 minutes are left out, as in a live sync', () => {
    const players = backfill.snapshotPlayersFromRotowire(classicPlayers(), { odds });
    assert.deepEqual(players.map(p => p.name).sort(), ['Jayson Tatum', 'Karl-Anthony Towns', 'Luka Doncic', 'Stephen Curry']);
  });
});

describe('backfillRotowireSlates', () => {
  // slate id -> payload; 29850 and 29851 are 2-game DK classics (29850 has more players), 29852 a showdown
  const payloads = () => ({
    29850: classicPlayers(),
    29851: [
      rw(3, 'Jayson', 'Tatum', { pos: ['SF', 'PF', 'F', 'UTIL'], team: 'BOS', opp: 'NYK', isHome: false, dateTime: '2026-10-23 19:30:00', salary: 9500, pts: '47.00' }),
      rw(4, 'Karl-Anthony', 'Towns', { pos: ['PF', 'F', 'C', 'UTIL'], team: 'NYK', opp: 'BOS', dateTime: '2026-10-23 19:30:00', salary: 8800, pts: '45.00' }),
      rw(6, 'Jalen', 'Brunson', { team: 'NYK', opp: 'BOS', dateTime: '2026-10-23 19:30:00', salary: 8000, pts: '40.00' }),
      rw(7, 'Bam', 'Adebayo', { pos: ['C', 'UTIL'], team: 'MIA', opp: 'CHI', isHome: false, dateTime: '2026-10-23 20:00:00', salary: 7500, pts: '38.00' })
    ],
    29852: [rw(1, 'Luka', 'Doncic', { pos: ['CPTN', 'UTIL'] })]
  });
  const fetchSlate = async (id) => payloads()[id] ?? [];
  const fetchOdds = async (date) => (date === '2026-10-23'
    ? new Map([['LAL', { vegas_implied_total: 121, vegas_spread: -12, over_under: 230 }],
      ['GSW', { vegas_implied_total: 109, vegas_spread: 12, over_under: 230 }]])
    : new Map());
  const run = (opts = {}) => backfill.backfillRotowireSlates({
    from: '2026-10-23', to: '2026-10-23', slateIds: ['29850', '29851', '29852'], fetchSlate, fetchOdds,
    now: new Date('2026-10-27T15:00:00Z'), ...opts
  });

  test('writes complete snapshots for every DK classic slate and catalogs them with the main flag', async () => {
    const report = await run();
    const rows = await db.all(`SELECT * FROM slate_player_snapshots WHERE slate_id = '29850' ORDER BY player_key`);
    assert.equal(rows.length, 4);
    const luka = rows.find(r => r.player_key === 'luka doncic');
    assert.equal(luka.game_date, '2026-10-23');
    assert.equal(luka.site, 'draftkings');
    assert.equal(luka.roster_positions, 'PG/G/UTIL');
    assert.equal(luka.game_start_time, '2026-10-24T02:00:00.000Z');
    assert.equal(luka.headshot, 'https://img/1.jpg');
    assert.equal(luka.player_id, '1');
    assert.equal(luka.is_home, 1);
    assert.equal(luka.vegas_implied_total, 121);
    assert.equal(luka.over_under, 230);
    assert.equal(luka.capture_source, 'rotowire_backfill');
    assert.equal(luka.fpts_last3, null);
    assert.equal(luka.floor, null, 'no pre-lock range: recompute-snapshot-ranges fills the *_model columns');
    assert.equal((await db.get(`SELECT COUNT(*) n FROM slate_player_snapshots WHERE slate_id = '29851'`)).n, 4);
    assert.equal((await db.get(`SELECT COUNT(*) n FROM slate_player_snapshots WHERE slate_id = '29852'`)).n, 0);

    const catalog = await db.all(`SELECT * FROM slate_catalog ORDER BY slate_id`);
    assert.deepEqual(catalog.map(c => [c.slate_id, c.game_date, c.games, c.is_main]), [['29850', '2026-10-23', 2, 1], ['29851', '2026-10-23', 2, 0]]);
    assert.equal(catalog[0].first_game_time, '2026-10-23T23:30:00.000Z');
    assert.match(catalog[0].name, /Main/);
    assert.equal(report.dates['2026-10-23'].mainSlateId, '29850');
    assert.equal((await db.get(`SELECT COUNT(*) n FROM slates`)).n, 0, 'the live slates table is left alone');
  });

  test('dry run writes nothing; a re-run is idempotent', async () => {
    const dry = await run({ dryRun: true });
    assert.equal(dry.dates['2026-10-23'].slates.length, 2);
    assert.equal((await db.get(`SELECT COUNT(*) n FROM slate_player_snapshots`)).n, 0);
    assert.equal((await db.get(`SELECT COUNT(*) n FROM slate_catalog`)).n, 0);
    await run();
    await run();
    assert.equal((await db.get(`SELECT COUNT(*) n FROM slate_player_snapshots`)).n, 8);
    assert.equal((await db.get(`SELECT COUNT(*) n FROM slate_catalog`)).n, 2);
  });

  test('a slate captured live keeps its pre-lock values; only NULL details are filled unless force', async () => {
    await db.run(`INSERT INTO slate_player_snapshots (snapshot_date, game_date, slate_id, site, player_key, player_name, team, opponent,
      position, salary, projected_points, projected_minutes, rostership, floor, ceiling)
      VALUES ('2026-10-23', '2026-10-23', '29850', 'draftkings', 'luka doncic', 'Luka Doncic', 'LAL', 'GSW', 'PG,G,UTIL', 10800, 50.5, 35, 20, 40, 60)`);
    const report = await run();
    assert.equal(report.dates['2026-10-23'].slates.find(s => s.slateId === '29850').mode, 'fill');
    const rows = await db.all(`SELECT * FROM slate_player_snapshots WHERE slate_id = '29850'`);
    assert.equal(rows.length, 1, 'no players added to a live capture');
    assert.equal(rows[0].salary, 10800);
    assert.equal(rows[0].projected_points, 50.5);
    assert.equal(rows[0].floor, 40);
    assert.equal(rows[0].capture_source, null);
    assert.equal(rows[0].game_start_time, '2026-10-24T02:00:00.000Z');
    assert.equal(rows[0].vegas_implied_total, 121, 'missing Vegas filled');

    await run({ force: true });
    const forced = await db.all(`SELECT * FROM slate_player_snapshots WHERE slate_id = '29850'`);
    assert.equal(forced.length, 4);
    assert.equal(forced.find(r => r.player_key === 'luka doncic').salary, 11000);
  });
});

describe('main slate preference', () => {
  const seed = async (slateId, keys) => {
    for (const k of keys) {
      await db.run(`INSERT INTO slate_player_snapshots (snapshot_date, game_date, slate_id, site, player_key, player_name, salary, projected_points)
        VALUES ('2026-10-23', '2026-10-23', ?, 'draftkings', ?, ?, 5000, 25)`, slateId, k, k);
    }
  };

  test('a date resolves to the catalog main slate even when another slate saved more players', async () => {
    await seed('29850', ['a', 'b']);
    await seed('29851', ['a', 'b', 'c']);
    await db.run(`INSERT INTO slate_catalog (site, slate_id, game_date, name, contest_type, games, players, first_game_time, is_main, source, updated_at)
      VALUES ('draftkings', '29850', '2026-10-23', 'Main', 'classic', 12, 2, '2026-10-23T23:00:00.000Z', 1, 'rotowire', '2026-10-27'),
             ('draftkings', '29851', '2026-10-23', 'Late', 'classic', 3, 3, '2026-10-24T02:00:00.000Z', 0, 'rotowire', '2026-10-27')`);
    const now = new Date('2026-10-27T15:00:00Z');
    assert.equal((await source.resolveSlate({ slateDate: '2026-10-23', now })).slateId, '29850');
    const list = await source.listBacktestSlates({ now });
    assert.deepEqual(list.map(s => [s.slateId, s.isMain, s.name]), [['29850', true, 'Main'], ['29851', false, 'Late']]);
    assert.deepEqual(await valueBacktest.backtestDates('draftkings'), [{ date: '2026-10-23', slateId: '29850' }]);
  });

  test('without a catalog entry the largest saved slate still wins', async () => {
    await seed('29850', ['a', 'b']);
    await seed('29851', ['a', 'b', 'c']);
    const now = new Date('2026-10-27T15:00:00Z');
    assert.equal((await source.resolveSlate({ slateDate: '2026-10-23', now })).slateId, '29851');
  });
});

describe('cachedSlateFetcher', () => {
  test('fetches each slate id once and serves repeats from the disk cache', async () => {
    const cacheDir = path.join(tmpDir, 'rw-cache');
    const calls = [];
    const fetchRaw = async (id) => { calls.push(id); return [{ rwID: Number(id) }]; };
    const first = backfill.cachedSlateFetcher({ cacheDir, delayMs: 0, fetchRaw });
    assert.deepEqual(await first('29850'), [{ rwID: 29850 }]);
    const second = backfill.cachedSlateFetcher({ cacheDir, delayMs: 0, fetchRaw });
    assert.deepEqual(await second('29850'), [{ rwID: 29850 }]);
    assert.deepEqual(calls, ['29850']);
    assert.ok(fs.existsSync(path.join(cacheDir, '29850.json')));
  });
});
