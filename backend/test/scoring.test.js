/**
 * Tests for per-site fantasy scoring, the historical_games FD/Yahoo migration
 * and backfill, and site-aware projection history queries.
 * Run: npm test (uses vitest, an in-memory SQLite database)
 */

import { test, beforeAll as before, afterAll as after } from 'vitest';
import assert from 'node:assert/strict';

// Must be set before database.js is imported so tests never touch real data
process.env.DATABASE_TYPE = 'sqlite';
process.env.DATABASE_PATH = ':memory:';

const {
  computeFantasyPoints, computeAllSitePoints, fantasyPointsColumn, fantasyPointsSql
} = await import('../src/services/scoring.js');
const { default: db } = await import('../src/config/database.js');
const { createTables } = await import('../src/config/schema.js');
const { backfillSiteFantasyPoints } = await import('../src/config/scoringMigrations.js');
const { default: projectionService } = await import('../src/services/projectionService.js');

// Known stat lines and their expected points on each site
const STAT_LINES = [
  {
    label: 'no bonus',
    // 25 pts, 3 3PM, 8 reb, 6 ast, 2 stl, 1 blk, 3 tov
    stats: { points: 25, fg3_made: 3, rebounds: 8, assists: 6, steals: 2, blocks: 1, turnovers: 3 },
    // DK: 25 + 1.5 + 10 + 9 + 4 + 2 - 1.5     FD/Yahoo: 25 + 9.6 + 9 + 6 + 3 - 3
    expected: { draftkings: 50, fanduel: 49.6, yahoo: 49.6 }
  },
  {
    label: 'double-double (pts/reb)',
    stats: { points: 10, fg3_made: 0, rebounds: 10, assists: 2, steals: 0, blocks: 2, turnovers: 1 },
    // DK: 10 + 12.5 + 3 + 4 - 0.5 + 1.5 DD    FD/Yahoo: 10 + 12 + 3 + 6 - 1
    expected: { draftkings: 30.5, fanduel: 30, yahoo: 30 }
  },
  {
    label: 'triple-double',
    stats: { points: 20, fg3_made: 1, rebounds: 12, assists: 11, steals: 1, blocks: 0, turnovers: 4 },
    // DK: 20 + 0.5 + 15 + 16.5 + 2 - 2 + 1.5 DD + 3 TD    FD/Yahoo: 20 + 14.4 + 16.5 + 3 - 4
    expected: { draftkings: 56.5, fanduel: 49.9, yahoo: 49.9 }
  },
  {
    label: 'double-double from blocks',
    stats: { points: 12, fg3_made: 0, rebounds: 7, assists: 0, steals: 0, blocks: 10, turnovers: 0 },
    // DK: 12 + 8.75 + 20 + 1.5 DD    FD/Yahoo: 12 + 8.4 + 30
    expected: { draftkings: 42.25, fanduel: 50.4, yahoo: 50.4 }
  },
  {
    label: 'quarter-point DK rebound',
    stats: { points: 0, rebounds: 1 },
    expected: { draftkings: 1.25, fanduel: 1.2, yahoo: 1.2 }
  },
  {
    label: 'DNP (empty line)',
    stats: {},
    expected: { draftkings: 0, fanduel: 0, yahoo: 0 }
  }
];

test('computeFantasyPoints: known stat lines per site', () => {
  for (const { label, stats, expected } of STAT_LINES) {
    for (const [site, points] of Object.entries(expected)) {
      assert.equal(computeFantasyPoints(stats, site), points, `${label} on ${site}`);
    }
  }
});

test('computeFantasyPoints: defaults to DraftKings, null stats count as 0, bad site throws', () => {
  assert.equal(computeFantasyPoints(STAT_LINES[0].stats), 50);
  assert.equal(computeFantasyPoints({ points: 10, rebounds: null, steals: undefined }, 'fanduel'), 10);
  assert.equal(computeFantasyPoints({ points: 10 }, 'FanDuel'), 10);
  assert.throws(() => computeFantasyPoints({ points: 10 }, 'superdraft'), /Unknown DFS site/);
});

test('computeAllSitePoints / fantasyPointsColumn', () => {
  assert.deepEqual(computeAllSitePoints(STAT_LINES[2].stats), {
    dk_fantasy_points: 56.5, fd_fantasy_points: 49.9, yahoo_fantasy_points: 49.9
  });
  assert.equal(fantasyPointsColumn(), 'dk_fantasy_points');
  assert.equal(fantasyPointsColumn('fanduel'), 'fd_fantasy_points');
  assert.equal(fantasyPointsColumn('yahoo'), 'yahoo_fantasy_points');
  assert.throws(() => fantasyPointsColumn('x; DROP TABLE historical_games'), /Unknown DFS site/);
});

let gameId = 0;
const insertGame = (name, team, opponent, date, stats, dk) => db.run(`
  INSERT INTO historical_games (player_name, team, opponent, game_date, is_home, is_back_to_back,
    points, fg3_made, rebounds, assists, steals, blocks, turnovers, dk_fantasy_points, game_id)
  VALUES (?, ?, ?, ?, 1, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`, name, team, opponent, date, stats.points ?? null, stats.fg3_made ?? null, stats.rebounds ?? null,
  stats.assists ?? null, stats.steals ?? null, stats.blocks ?? null, stats.turnovers ?? null, dk, `g${++gameId}`);

before(async () => {
  // Pre-migration historical_games (no fd/yahoo columns) with some games already in it
  db.sqliteDb.exec(`
    CREATE TABLE historical_games (
      id INTEGER PRIMARY KEY AUTOINCREMENT, player_id TEXT, player_name TEXT NOT NULL, team TEXT NOT NULL,
      opponent TEXT NOT NULL, position TEXT, game_id TEXT, game_date DATE NOT NULL, season TEXT,
      is_home INTEGER DEFAULT 0, minutes REAL, points INTEGER, rebounds INTEGER, assists INTEGER,
      steals INTEGER, blocks INTEGER, turnovers INTEGER, fouls INTEGER, fg_made INTEGER, fg_attempted INTEGER,
      fg_pct REAL, fg3_made INTEGER, fg3_attempted INTEGER, fg3_pct REAL, ft_made INTEGER, ft_attempted INTEGER,
      ft_pct REAL, oreb INTEGER, dreb INTEGER, plus_minus INTEGER, ts_pct REAL, efg_pct REAL, three_par REAL,
      ftr REAL, orb_pct REAL, drb_pct REAL, trb_pct REAL, ast_pct REAL, stl_pct REAL, blk_pct REAL,
      tov_pct REAL, usg_pct REAL, off_rtg REAL, def_rtg REAL, bpm REAL, dk_fantasy_points REAL,
      rest_days INTEGER, is_back_to_back INTEGER DEFAULT 0, created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(player_name, team, game_date)
    )
  `);
  // dk values are what the box score loader stored (rounded to 0.1); the
  // migration must leave them alone
  await insertGame('Test Guard', 'BOS', 'NYK', '2025-11-01', STAT_LINES[0].stats, 50);
  await insertGame('Test Guard', 'BOS', 'MIA', '2025-11-03', STAT_LINES[2].stats, 56.5);
  await insertGame('Test Guard', 'BOS', 'NYK', '2025-11-05', STAT_LINES[3].stats, 42.3);
  await insertGame('Test Guard', 'BOS', 'NYK', '2025-11-07', STAT_LINES[1].stats, 30.5);
  await insertGame('No Stats', 'BOS', 'NYK', '2025-11-07', {}, null);

  await createTables(db);
});

after(() => db.close());

test('migration adds fd/yahoo columns and backfills from box scores; DK untouched', async () => {
  const rows = await db.all(`
    SELECT player_name, dk_fantasy_points, fd_fantasy_points, yahoo_fantasy_points
    FROM historical_games ORDER BY id
  `);
  assert.deepEqual(rows.map(r => ({ ...r })), [
    { player_name: 'Test Guard', dk_fantasy_points: 50, fd_fantasy_points: 49.6, yahoo_fantasy_points: 49.6 },
    { player_name: 'Test Guard', dk_fantasy_points: 56.5, fd_fantasy_points: 49.9, yahoo_fantasy_points: 49.9 },
    { player_name: 'Test Guard', dk_fantasy_points: 42.3, fd_fantasy_points: 50.4, yahoo_fantasy_points: 50.4 },
    { player_name: 'Test Guard', dk_fantasy_points: 30.5, fd_fantasy_points: 30, yahoo_fantasy_points: 30 },
    { player_name: 'No Stats', dk_fantasy_points: null, fd_fantasy_points: null, yahoo_fantasy_points: null }
  ]);
});

test('migration is idempotent; backfill only fills NULLs unless forced', async () => {
  await createTables(db);
  await db.run(`UPDATE historical_games SET fd_fantasy_points = 1 WHERE game_date = '2025-11-01'`);
  assert.equal(await backfillSiteFantasyPoints(db), 0);
  assert.equal((await db.get(`SELECT fd_fantasy_points FROM historical_games WHERE game_date = '2025-11-01'`)).fd_fantasy_points, 1);

  await backfillSiteFantasyPoints(db, { force: true });
  assert.equal((await db.get(`SELECT fd_fantasy_points FROM historical_games WHERE game_date = '2025-11-01'`)).fd_fantasy_points, 49.6);
});

test('fantasyPointsSql matches computeFantasyPoints for every site', async () => {
  for (const { label, stats, expected } of STAT_LINES) {
    for (const site of Object.keys(expected)) {
      const row = await db.get(`
        SELECT ${fantasyPointsSql(site)} AS pts FROM (
          SELECT ? AS points, ? AS fg3_made, ? AS rebounds, ? AS assists, ? AS steals, ? AS blocks, ? AS turnovers
        )
      `, stats.points ?? null, stats.fg3_made ?? null, stats.rebounds ?? null, stats.assists ?? null,
      stats.steals ?? null, stats.blocks ?? null, stats.turnovers ?? null);
      assert.equal(row.pts, computeFantasyPoints(stats, site), `${label} on ${site}`);
    }
  }
});

test('new rows inserted after startup get fd/yahoo points from the box score loader', async () => {
  const { default: nbaStatsService } = await import('../src/services/nbaStatsService.js');
  const inserted = await nbaStatsService.insertGameFromBoxScore({
    player_name: 'Blob Player', team: 'LAL', opponent: 'GSW', game_date: '2025-11-08', is_home: 0,
    ...STAT_LINES[2].stats
  });
  assert.equal(inserted, true);
  const row = await db.get(`SELECT dk_fantasy_points, fd_fantasy_points, yahoo_fantasy_points FROM historical_games WHERE player_name = 'Blob Player'`);
  assert.deepEqual({ ...row }, { dk_fantasy_points: 56.5, fd_fantasy_points: 49.9, yahoo_fantasy_points: 49.9 });
});

test('projection history defaults to DK and accepts a site', async () => {
  projectionService.clearCache?.();
  const dk = await projectionService.getPlayerHistoricalStats('Test Guard', '2025-11-06');
  // Games before 11-06: DK 50, 56.5, 42.3
  assert.equal(dk.seasonGames, 3);
  assert.equal(Math.round(dk.seasonAvg * 100) / 100, 49.6);
  assert.equal(dk.ceiling, 56.5);

  const fd = await projectionService.getPlayerHistoricalStats('Test Guard', '2025-11-06', 'fanduel');
  // FD 49.6, 49.9, 50.4 (cached DK result must not be reused)
  assert.equal(Math.round(fd.seasonAvg * 100) / 100, 49.97);
  assert.equal(fd.floor, 49.6);
  assert.equal(fd.ceiling, 50.4);

  const dkMatchup = await projectionService.getMatchupHistory('Test Guard', 'NYK', '2025-11-06');
  const yahooMatchup = await projectionService.getMatchupHistory('Test Guard', 'NYK', '2025-11-06', 'yahoo');
  assert.equal(Math.round(dkMatchup.avgDk * 100) / 100, 46.15);
  assert.equal(Math.round(yahooMatchup.avgDk * 100) / 100, 50);

  await assert.rejects(() => projectionService.getPlayerHistoricalStats('Test Guard', null, 'nope'), /Unknown DFS site/);
});
