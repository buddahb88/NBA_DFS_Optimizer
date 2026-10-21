import { test, describe, beforeAll as before, afterAll as after } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Keep the replay off the real DB file
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nba-dfs-replay-dvp-'));
let db;
let replay;
let defense;

const SEASON = '2025-26';
// Every other day from Nov 1: MIA guards vs BOS bigs, home team alternating
const DATES = Array.from({ length: 10 }, (_, i) => `2025-11-${String(1 + i * 2).padStart(2, '0')}`);
const PLAYERS = [
  { name: 'Guard One', team: 'MIA', opp: 'BOS', pos: 'G', archetype: 'scoring_guard', min: 34 },
  { name: 'Guard Two', team: 'MIA', opp: 'BOS', pos: 'G', archetype: 'scoring_guard', min: 30 },
  { name: 'Wing One', team: 'MIA', opp: 'BOS', pos: 'F', archetype: 'three_and_d_wing', min: 28 },
  { name: 'Big One', team: 'BOS', opp: 'MIA', pos: 'C', archetype: 'rim_running_big', min: 32 },
  { name: 'Big Two', team: 'BOS', opp: 'MIA', pos: 'C', archetype: 'rim_running_big', min: 26 },
  { name: 'Forward One', team: 'BOS', opp: 'MIA', pos: 'F', archetype: 'unclassified', min: 30 },
];

before(async () => {
  process.env.DATABASE_TYPE = 'sqlite';
  process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');
  db = (await import('../src/config/database.js')).default;
  await (await import('../src/config/schema.js')).createTables(db);
  replay = await import('../src/services/projectionReplayBacktest.js');
  defense = await import('../src/services/archetypeDefenseService.js');
  const { playerKey } = await import('../src/utils/playerKey.js');

  const insert = db.sqliteDb.prepare(`INSERT INTO historical_games (player_name, player_key, team, opponent, game_date, game_id,
    season, season_type, position, minutes, points, rebounds, assists, fg3_made, steals, blocks, turnovers,
    dk_fantasy_points, fd_fantasy_points, yahoo_fantasy_points, is_home, is_back_to_back)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'regular', ?, ?, ?, ?, ?, 1, 1, 1, 2, ?, ?, ?, ?, 0)`);
  DATES.forEach((date, d) => {
    PLAYERS.forEach((p, i) => {
      // Uneven, rising scoring so actual vs expectation is non-zero
      const pts = 10 + i * 2 + d + (d % 3) * 4;
      const reb = 3 + (i % 3) + (d % 2) * 2;
      const ast = 2 + ((i + d) % 4);
      const dk = pts + 1.25 * reb + 1.5 * ast + 3 * 1.5 - 1;
      insert.run(p.name, playerKey(p.name), p.team, p.opp, date, `g${d}`, SEASON, p.pos, p.min,
        pts, reb, ast, dk, dk, dk, (p.team === 'MIA') === (d % 2 === 0) ? 1 : 0);
    });
  });
  const archetype = db.sqliteDb.prepare('INSERT INTO player_archetypes (season, player_key, archetype) VALUES (?, ?, ?)');
  for (const p of PLAYERS) archetype.run(SEASON, playerKey(p.name), p.archetype);
});

after(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const close = (actual, expected, msg) => assert.ok(Math.abs(actual - expected) < 1e-9, `${msg ?? ''} ${actual} != ${expected}`);
const dayBefore = (date) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
};

describe('createDvpContexts (point-in-time archetype defense)', () => {
  test('a date only sees games before it', async () => {
    const contextFor = await replay.createDvpContexts('draftkings');
    const games = await defense.loadSeasonExpectations(SEASON);
    for (const date of [DATES[5], DATES[9]]) {
      const ctx = await contextFor(date);
      assert.equal(ctx.season, SEASON);
      const expected = defense.GROUPINGS.flatMap(grouping =>
        defense.aggregateDefense(games, { site: 'draftkings', grouping, endDate: dayBefore(date) }));
      assert.ok(expected.length > 0);
      assert.equal(ctx.cells.size, expected.length);
      for (const r of expected) close(ctx.cells.get(`${r.group_by}|${r.team}|${r.group_key}`), r.fp_over_expectation, `${date} ${r.team} ${r.group_key}`);
    }
    // Games on later dates change the numbers, so the earlier context excluded them
    const early = await contextFor(DATES[5]);
    const late = await contextFor(DATES[9]);
    assert.ok([...early.cells].some(([k, v]) => late.cells.get(k) !== v));
  });

  test('before the first game it falls back to the prior season (empty here)', async () => {
    const contextFor = await replay.createDvpContexts('draftkings');
    const ctx = await contextFor(DATES[0]);
    assert.equal(ctx.season, '2024-25');
    assert.equal(ctx.cells.size, 0);
  });
});

describe('runReplayBacktest dvpVariants', () => {
  const VARIANTS = [
    { label: 'off', mode: 'off' },
    { label: 'legacy', mode: 'legacy' },
    { label: 'arch w=0', mode: 'archetype', weight: 0 },
    { label: 'arch w=1', mode: 'archetype', weight: 1, cap: 5 },
    { label: 'arch capped', mode: 'archetype', weight: 1, cap: 0.1 },
  ];
  let report;

  before(async () => {
    report = await replay.runReplayBacktest({ from: DATES[4], dvpVariants: VARIANTS });
  });

  test('reports one metrics row per variant over every scored player-game', () => {
    assert.ok(report.sample.playerGames > 0);
    assert.deepEqual(report.dvpVariants.map(v => v.label), VARIANTS.map(v => v.label));
    for (const v of report.dvpVariants) {
      assert.equal(v.n, report.sample.playerGames, v.label);
      assert.ok(Number.isFinite(v.mae), v.label);
    }
  });

  test('off and weight 0 make no DVP adjustment and score the same', () => {
    const [off, , zero] = report.dvpVariants;
    assert.equal(off.adjusted, 0);
    assert.equal(off.meanAbsAdjustment, 0);
    assert.equal(zero.adjusted, 0);
    assert.equal(zero.mae, off.mae);
  });

  test('legacy DVP has no Hashtag data in the fixture, so it matches off', () => {
    const [off, legacy] = report.dvpVariants;
    assert.equal(legacy.adjusted, 0);
    assert.equal(legacy.mae, off.mae);
  });

  test('archetype variants adjust rows, within the cap', () => {
    const full = report.dvpVariants[3];
    const capped = report.dvpVariants[4];
    assert.ok(full.adjusted > 0);
    assert.ok(full.meanAbsAdjustment > 0.1, 'fixture should produce adjustments larger than the cap');
    assert.ok(capped.adjusted > 0);
    // Adjustments are rounded to 0.1 FP in the projection output
    assert.ok(capped.meanAbsAdjustment <= 0.1 + 1e-9);
    assert.notEqual(full.mae, report.dvpVariants[0].mae);
  });

  test('no variants unless asked, and none without the legacy model', async () => {
    const plain = await replay.runReplayBacktest({ from: DATES[8] });
    assert.deepEqual(plain.dvpVariants, []);
    const noLegacy = await replay.runReplayBacktest({ from: DATES[8], legacy: false, dvpVariants: VARIANTS });
    assert.deepEqual(noLegacy.dvpVariants, []);
  });
});
