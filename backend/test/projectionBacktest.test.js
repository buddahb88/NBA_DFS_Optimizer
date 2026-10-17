/**
 * Tests for the projection accuracy backtest.
 * Run: npm test (or npm run test:accuracy) (uses node:test, an in-memory SQLite database)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

// Must be set before database.js is imported so tests never touch real data
process.env.DATABASE_TYPE = 'sqlite';
process.env.DATABASE_PATH = ':memory:';

const svc = await import('../src/services/projectionBacktestService.js');
const { default: db } = await import('../src/config/database.js');
const { createTables } = await import('../src/config/schema.js');

test('computeErrorMetrics: MAE, RMSE, bias, R^2', () => {
  const m = svc.computeErrorMetrics([
    { projected: 10, actual: 12 },
    { projected: 20, actual: 18 },
    { projected: 30, actual: 30 },
    { projected: 40, actual: 44 }
  ]);
  assert.equal(m.n, 4);
  assert.equal(m.mae, 2); // (2+2+0+4)/4
  assert.equal(m.rmse, Math.round(Math.sqrt((4 + 4 + 0 + 16) / 4) * 1000) / 1000);
  assert.equal(m.bias, -1); // (-2+2+0-4)/4
  // actual mean 26, ssTot = 196+64+16+324 = 600, ssRes = 24
  assert.equal(m.r2, 0.96);
  assert.ok(m.correlation > 0.98);
});

test('computeErrorMetrics: empty input', () => {
  const m = svc.computeErrorMetrics([]);
  assert.equal(m.n, 0);
  assert.equal(m.mae, null);
});

test('computeCalibration counts below floor / above ceiling', () => {
  const c = svc.computeCalibration([
    { floor: 10, ceiling: 20, actual: 5 },
    { floor: 10, ceiling: 20, actual: 15 },
    { floor: 10, ceiling: 20, actual: 25 },
    { floor: 10, ceiling: 20, actual: 19 }
  ]);
  assert.equal(c.pctBelowFloor, 25);
  assert.equal(c.pctAboveCeiling, 25);
  assert.equal(c.pctWithinRange, 50);
  assert.equal(c.avgRangeWidth, 10);
});

test('helpers: names, dates, tiers, positions, raw projection', () => {
  assert.equal(svc.normalizePlayerName('Luka Dončić'), 'luka doncic');
  assert.equal(svc.normalizePlayerName('Jaren Jackson Jr.'), 'jaren jackson');
  assert.equal(svc.normalizePlayerName("De'Aaron Fox"), 'deaaron fox');
  assert.equal(svc.resolveGameDate({ raw_data: '{"game":{"dateTime":"2025-11-02 19:30:00"}}' }), '2025-11-02');
  assert.equal(svc.resolveGameDate({ game_info: 'BOS@NYK 2025-11-03T00:00:00' }), '2025-11-03');
  assert.equal(svc.resolveGameDate({}), null);
  assert.equal(svc.salaryTier(3500), '<4K');
  assert.equal(svc.salaryTier(6000), '6K-7.9K');
  assert.equal(svc.salaryTier(9200), '8K+');
  assert.deepEqual(svc.basePositions('PG,SG,G,UTIL'), ['PG', 'SG']);
  assert.equal(svc.resolveRawProjection({ rotowire_projection: 30, raw_data: '{"pts":"25"}' }), 30);
  assert.equal(svc.resolveRawProjection({ rotowire_projection: null, raw_data: '{"pts":"25.5"}' }), 25.5);
});

test('analyzeFactors flags a factor pointing the wrong way as harmful', () => {
  const samples = [];
  for (let i = 0; i < 40; i++) {
    // raw is perfect; factor adds +/-3 noise -> harmful
    samples.push({ rawProjection: 20, actual: 20, factors: { good: 0, bad: i % 2 ? 3 : -3 } });
  }
  for (let i = 0; i < 40; i++) {
    // raw is 2 low; factor corrects it exactly -> helpful
    samples.push({ rawProjection: 20, actual: 22, factors: { good: 2, bad: 0 } });
  }
  const [good, bad] = svc.analyzeFactors(samples, ['good', 'bad']);
  assert.equal(good.verdict, 'helpful');
  assert.equal(good.optimalScale, 1);
  assert.equal(bad.verdict, 'harmful');
});

test('runProjectionBacktest end to end against SQLite', async () => {
  await createTables(db);
  await db.run(`INSERT INTO slates (slate_id, name) VALUES ('s1', 'Main')`);

  const players = [
    // name, team, pos, salary, proj, floor, ceil, rotowire_projection, raw pts, actual
    ['Luka Dončić', 'LAL', 'PG,G,UTIL', 10500, 52, 40, 64, 50, '50', 58],
    ['Nikola Jokic', 'DEN', 'C,UTIL', 11000, 58, 46, 70, null, '58', 61],
    ['Jaren Jackson Jr.', 'MEM', 'PF,C,F,UTIL', 7000, 34, 26, 42, 36, '36', 20],
    ['Bench Guy', 'MEM', 'SG,G,UTIL', 3500, 12, 6, 18, null, '12', 15],
    ['DNP Guy', 'MEM', 'SF,F,UTIL', 3000, 8, 4, 12, null, '8', null]
  ];
  for (const [i, [name, team, pos, salary, proj, floor, ceil, rw, pts]] of players.entries()) {
    await db.run(
      `INSERT INTO players (slate_id, player_id, name, team, opponent, position, salary, projected_points, floor, ceiling, rostership, rotowire_projection, raw_data)
       VALUES ('s1', ?, ?, ?, 'BOS', ?, ?, ?, ?, ?, 10, ?, ?)`,
      `p${i}`, name, team, pos, salary, proj, floor, ceil, rw,
      JSON.stringify({ pts, game: { dateTime: '2025-11-02 19:30:00' } })
    );
  }
  for (const [name, team, , , , , , , , actual] of players) {
    if (actual === null) continue;
    await db.run(
      `INSERT INTO historical_games (player_name, team, opponent, game_date, dk_fantasy_points, minutes)
       VALUES (?, ?, 'BOS', '2025-11-02', ?, 30)`,
      // historical source spells names without diacritics/suffix punctuation
      name.replace('č', 'c').replace('ć', 'c').replace('Jr.', 'Jr'), team, actual
    );
  }
  // Different date for same player must not match
  await db.run(`INSERT INTO historical_games (player_name, team, opponent, game_date, dk_fantasy_points) VALUES ('Bench Guy', 'MEM', 'BOS', '2025-11-04', 99)`);

  const report = await svc.runProjectionBacktest();
  assert.equal(report.sample.playerGames, 4);
  assert.equal(report.sample.unmatchedProjections, 1);
  assert.equal(report.sample.adjustedFromRaw, 2); // Luka (+2) and JJJ (-2)
  // errors: +-6, -3, +14, -3 -> MAE 6.5
  assert.equal(report.overall.mae, 6.5);
  assert.equal(report.overall.bias, 0.5);
  // raw RotoWire errors: -8, -3, +16, -3 -> MAE 7.5, so we improved by 1
  assert.equal(report.overall.rotowire.mae, 7.5);
  assert.equal(report.overall.rotowire.maeImprovement, 1);
  assert.equal(report.overall.calibration.pctBelowFloor, 25); // JJJ 20 < 26
  assert.equal(report.bySalaryTier.find(t => t.group === '8K+').n, 2);
  assert.equal(report.byPosition.find(p => p.group === 'C').n, 2); // Jokic + JJJ
  assert.ok(report.factors.length > 0);

  const filtered = await svc.runProjectionBacktest({ from: '2025-11-03' });
  assert.equal(filtered.sample.playerGames, 0);
  assert.ok(filtered.insights[0].startsWith('No projections'));
});
