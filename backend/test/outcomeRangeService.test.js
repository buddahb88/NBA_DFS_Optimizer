/**
 * outcomeRangeService against a temp SQLite DB: game logs -> stored range columns.
 */

import { test, beforeAll as before, afterAll as after } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nba-dfs-ranges-'));
let db;
let svc;

before(async () => {
  process.env.DATABASE_TYPE = 'sqlite';
  process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');
  db = (await import('../src/config/database.js')).default;
  await (await import('../src/config/schema.js')).createTables(db);
  svc = await import('../src/services/variance/outcomeRangeService.js');

  // Veteran: 20 games before the slate, rate 0.8-1.2 at ~32 min
  for (let i = 0; i < 20; i++) {
    const day = String(i + 1).padStart(2, '0');
    const minutes = 30 + (i % 5);
    const fp = minutes * (0.8 + 0.4 * ((i * 7) % 10) / 9);
    await game('Kelly Oubre Jr.', 'kelly oubre', `2026-03-${day}`, minutes, fp, 'F');
  }
  // A monster game ON the slate date must not be read (no lookahead)
  await game('Kelly Oubre Jr.', 'kelly oubre', '2026-10-21', 40, 120, 'F');

  await db.run(`INSERT INTO slates (slate_id, name, site, start_time) VALUES ('S1', 'Main', 'draftkings', '2026-10-21T19:00:00-04:00')`);
  await player('S1', 'p1', 'Kelly Oubre', 'SF,PF', 4700, 27.76, 32, 10);
  await player('S1', 'p2', 'Brand New Rookie', 'PG', 3500, 18, 22, 5);
  await player('S1', 'p3', 'Sits Tonight', 'C', 3000, 0, 0, 0);
});

after(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function game(name, key, date, minutes, dk, position) {
  return db.run(
    `INSERT INTO historical_games (player_name, player_key, espn_player_id, team, opponent, position, game_id, game_date,
       season, season_type, minutes, dk_fantasy_points, fd_fantasy_points)
     VALUES (?, ?, '1', 'PHI', 'BOS', ?, ?, ?, '2025-26', 'regular', ?, ?, ?)`,
    name, key, position, `${key}-${date}`, date, minutes, dk, dk
  );
}

function player(slateId, playerId, name, position, salary, proj, minutes, own) {
  return db.run(
    `INSERT INTO players (slate_id, player_id, name, team, opponent, position, salary, projected_points,
       projected_minutes, rostership, blowout_risk, floor, ceiling)
     VALUES (?, ?, ?, 'PHI', 'BOS', ?, ?, ?, ?, ?, 0, 26.35, 29.17)`,
    slateId, playerId, name, position, salary, proj, minutes, own
  );
}

test('loadGameLogs: regular-season games before the date, most recent first', async () => {
  const logs = await svc.loadGameLogs(['kelly oubre'], { site: 'draftkings', beforeDate: '2026-10-21' });
  const list = logs.get('kelly oubre');
  assert.equal(list.length, 20);
  assert.equal(list[0].game_date, '2026-03-20');
  assert.ok(list.every((g) => g.game_date < '2026-10-21'));
});

test('leverageScore = boom% / (ownership% + 1)', () => {
  assert.equal(svc.leverageScore(30, 5), 5);
  assert.equal(svc.leverageScore(12, 0), 12);
});

test('recomputeSlateRanges writes a wide, consistent range for every player', async () => {
  const updated = await svc.recomputeSlateRanges('S1');
  assert.equal(updated, 3);

  const rows = await db.all(`SELECT * FROM players WHERE slate_id = 'S1' ORDER BY player_id`);
  const [oubre, rookie, out] = rows;

  // Old row was 26.35 - 29.17 around 27.76; even this steady log gets ~4x that width
  assert.ok(oubre.floor < 24 && oubre.ceiling > 32, `Oubre ${oubre.floor}-${oubre.ceiling}`);
  assert.ok(oubre.ceiling - oubre.floor > 3 * (29.17 - 26.35));
  assert.ok(oubre.std_dev > 5);
  assert.ok(Math.abs(oubre.volatility - oubre.std_dev / 27.76) < 1e-9);
  assert.ok(oubre.bust_probability > 10 && oubre.bust_probability < 45);
  assert.ok(oubre.boom_probability > 0 && oubre.boom_probability < 20);
  assert.ok(Math.abs(oubre.leverage_score - svc.leverageScore(oubre.boom_probability, 10)) < 1e-9);

  // Unseen rookie still gets a prior-based range
  assert.ok(rookie.floor > 0 && rookie.floor < 18 && rookie.ceiling > 18);
  assert.ok(rookie.std_dev > 0.2 * 18);

  // Zero projection -> zero range
  assert.equal(out.floor, 0);
  assert.equal(out.ceiling, 0);
  assert.equal(out.std_dev, 0);
});

test('recomputeSlateRanges ignores box scores from the slate date (no lookahead)', async () => {
  const before = await db.get(`SELECT std_dev FROM players WHERE player_id = 'p1'`);
  await db.run(`DELETE FROM historical_games WHERE game_date = '2026-10-21'`);
  await svc.recomputeSlateRanges('S1');
  const after = await db.get(`SELECT std_dev FROM players WHERE player_id = 'p1'`);
  assert.equal(after.std_dev, before.std_dev);
});

test('applyRangesToPlayers fills camelCase fields on synced players', async () => {
  const players = [{
    name: 'Kelly Oubre Jr.', position: 'SF', salary: 4700, projectedPoints: 27.76, projectedMinutes: 32,
    rostership: 10, blowoutRisk: 0, rawData: JSON.stringify({ game: { dateTime: '2026-10-21 19:00:00' } })
  }];
  await svc.applyRangesToPlayers(players, { site: 'draftkings' });
  const [p] = players;
  assert.ok(p.floor < 24 && p.ceiling > 32, `${p.floor}-${p.ceiling}`);
  for (const k of ['stdDev', 'volatility', 'boomProbability', 'bustProbability', 'leverageScore']) {
    assert.ok(Number.isFinite(p[k]), k);
  }
});
