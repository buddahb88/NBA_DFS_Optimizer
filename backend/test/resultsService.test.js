/**
 * Tests for the results service and GET /api/results: slate_player_snapshots
 * joined to historical_games on (player_key, game_date), seeded in SQLite.
 */

import { test, describe, beforeAll as before, afterAll as after } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nba-dfs-results-'));
process.env.DATABASE_TYPE = 'sqlite';
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');

let db;
let results;
let server;
let baseUrl;

// [slate, site, date, name, team, opp, position, salary, proj, projMin, captured, injury]
const SNAPSHOTS = [
  ['s1', 'draftkings', '2025-11-02', 'Luka Dončić', 'LAL', 'MEM', 'PG', 10000, 50, 36, '2025-11-02T15:00:00Z', null],
  ['s1', 'draftkings', '2025-11-02', 'Jaren Jackson Jr.', 'MEM', 'LAL', 'PF/C', 7000, 35, 32, '2025-11-02T15:00:00Z', null],
  ['s1', 'draftkings', '2025-11-02', 'Bench Guy', 'MEM', 'LAL', 'SG', 4000, 15, 18, '2025-11-02T15:00:00Z', null],
  ['s1', 'draftkings', '2025-11-02', 'Coach Guy', 'MEM', 'LAL', 'SF', 3500, 10, 15, '2025-11-02T15:00:00Z', null],
  ['s1', 'draftkings', '2025-11-02', 'Hurt Guy', 'LAL', 'MEM', 'C', 5000, 20, 24, '2025-11-02T15:00:00Z', 'GTD'],
  ['s1', 'draftkings', '2025-11-02', 'Zero Guy', 'LAL', 'MEM', 'SF', 3000, 8, 10, '2025-11-02T15:00:00Z', null],
  ['s1', 'draftkings', '2025-11-02', 'Out Guy', 'MEM', 'LAL', 'PG', 6000, 25, 28, '2025-11-02T15:00:00Z', 'OUT'],
  // Same player on a second DK slate that day (turbo): scored once, latest capture wins
  ['s1b', 'draftkings', '2025-11-02', 'Luka Doncic', 'LAL', 'MEM', 'PG', 10200, 51, 36, '2025-11-02T20:00:00Z', null],
  // FanDuel slate the same day scores FanDuel points
  ['s3', 'fanduel', '2025-11-02', 'Luka Dončić', 'LAL', 'MEM', 'PG', 11000, 52, 36, '2025-11-02T15:00:00Z', null],
  // Tomorrow's game has no box score yet
  ['s2', 'draftkings', '2025-11-03', 'Future Guy', 'BOS', 'NYK', 'SF', 6000, 30, 30, '2025-11-03T15:00:00Z', null]
];

// [name, team, opp, date, minutes, dk, fd, yahoo]
const GAMES = [
  ['Luka Doncic', 'LAL', 'MEM', '2025-11-02', 36, 60, 58, 57],
  ['Jaren Jackson Jr.', 'MEM', 'LAL', '2025-11-02', 30, 21, 22.5, 22.5],
  ['Bench Guy', 'MEM', 'LAL', '2025-11-02', 20, 22, 20.1, 20.1],
  ['Zero Guy', 'LAL', 'MEM', '2025-11-02', 0, 0, 0, 0],
  // Different date for a snapshot player must not match
  ['Bench Guy', 'MEM', 'BOS', '2025-11-04', 30, 99, 99, 99]
];

before(async () => {
  db = (await import('../src/config/database.js')).default;
  const { createTables } = await import('../src/config/schema.js');
  const { playerKey } = await import('../src/utils/playerKey.js');
  await createTables(db);
  results = await import('../src/services/resultsService.js');

  for (const [slate, site, date, name, team, opp, pos, salary, proj, projMin, captured, injury] of SNAPSHOTS) {
    await db.run(
      `INSERT INTO slate_player_snapshots (snapshot_date, game_date, slate_id, site, player_key, player_name, team, opponent,
         position, salary, projected_points, projected_minutes, floor, ceiling, rostership, injury_status, captured_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 10, ?, ?)`,
      date, date, slate, site, playerKey(name), name, team, opp, pos, salary, proj, projMin, proj * 0.7, proj * 1.3, injury, captured
    );
  }
  for (const [name, team, opp, date, minutes, dk, fd, yahoo] of GAMES) {
    await db.run(
      `INSERT INTO historical_games (player_name, player_key, team, opponent, game_date, minutes, points,
         dk_fantasy_points, fd_fantasy_points, yahoo_fantasy_points)
       VALUES (?, ?, ?, ?, ?, ?, 10, ?, ?, ?)`,
      name, playerKey(name), team, opp, date, minutes, dk, fd, yahoo
    );
  }
  for (const [team, opp] of [['LAL', 'MEM'], ['MEM', 'LAL']]) {
    await db.run(`INSERT INTO team_game_stats (game_id, game_date, team, opponent, pts) VALUES ('g1', '2025-11-02', ?, ?, 110)`, team, opp);
  }
  await db.run(`INSERT INTO game_player_status (game_id, game_date, team, player_key, player_name, status, reason)
    VALUES ('g1', '2025-11-02', 'MEM', 'coach guy', 'Coach Guy', 'DNP', 'COACH''S DECISION')`);
  await db.run(`INSERT INTO game_player_status (game_id, game_date, team, player_key, player_name, status, reason)
    VALUES ('g1', '2025-11-02', 'MEM', 'out guy', 'Out Guy', 'INACTIVE', 'Ankle')`);

  const app = express();
  app.use('/api/results', (await import('../src/routes/results.js')).default);
  await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}/api/results`;
});

after(async () => {
  await new Promise(resolve => server.close(resolve));
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const byName = (rows) => Object.fromEntries(rows.map(r => [r.name, r]));

describe('getPlayerResults', () => {
  test('joins snapshots to box scores on player_key and game_date with per-player errors', async () => {
    const rows = byName(await results.getPlayerResults({ from: '2025-11-02', to: '2025-11-02' }));

    const luka = rows['Luka Doncic']; // latest capture (s1b) wins the dedupe
    assert.equal(luka.slateId, 's1b');
    assert.equal(luka.status, 'PLAYED');
    assert.equal(luka.actualMinutes, 36);
    assert.deepEqual(luka.actualPoints, { draftkings: 60, fanduel: 58, yahoo: 57 });
    assert.equal(luka.actual, 60);
    assert.equal(luka.projectionError, -9); // 51 - 60
    assert.equal(luka.minutesError, 0);
    assert.equal(luka.value, 5.882); // 60 / 10.2
    assert.deepEqual(luka.hits, { '3x': true, '5x': true, '6x': false });

    const jjj = rows['Jaren Jackson Jr.'];
    assert.equal(jjj.projectionError, 14);
    assert.equal(jjj.minutesError, 2);
    assert.equal(jjj.value, 3);
    assert.deepEqual(jjj.hits, { '3x': true, '5x': false, '6x': false });
  });

  test('several slates on a date: the main slate wins, then a live capture over a later RotoWire backfill', async () => {
    const insert = (slate, name, proj, captured, source) => db.run(
      `INSERT INTO slate_player_snapshots (snapshot_date, game_date, slate_id, site, player_key, player_name, team, opponent,
         position, salary, projected_points, captured_at, capture_source)
       VALUES ('2025-12-01', '2025-12-01', ?, 'draftkings', ?, ?, 'LAL', 'MEM', 'PG', 6000, ?, ?, ?)`,
      slate, name.toLowerCase(), name, proj, captured, source);
    await insert('main', 'Main Guy', 30, '2025-12-01T15:00:00Z', null);
    await insert('late', 'Main Guy', 33, '2025-12-02T15:00:00Z', 'rotowire_backfill');
    await insert('early', 'Live Guy', 20, '2025-12-01T15:00:00Z', null);
    await insert('late', 'Live Guy', 22, '2025-12-02T15:00:00Z', 'rotowire_backfill');
    await db.run(`INSERT INTO slate_catalog (site, slate_id, game_date, is_main) VALUES ('draftkings', 'main', '2025-12-01', 1),
      ('draftkings', 'late', '2025-12-01', 0)`);
    try {
      const rows = byName(await results.getPlayerResults({ from: '2025-12-01', to: '2025-12-01' }));
      assert.equal(rows['Main Guy'].slateId, 'main');
      assert.equal(rows['Live Guy'].slateId, 'early');
    } finally {
      await db.run(`DELETE FROM slate_player_snapshots WHERE game_date = '2025-12-01'`);
      await db.run(`DELETE FROM slate_catalog`);
    }
  });

  test('marks players missing from the box score as DNP / INACTIVE', async () => {
    const rows = byName(await results.getPlayerResults({ from: '2025-11-02', to: '2025-11-02' }));
    assert.equal(rows['Coach Guy'].status, 'DNP');
    assert.equal(rows['Coach Guy'].statusReason, "COACH'S DECISION");
    assert.equal(rows['Out Guy'].status, 'INACTIVE');
    assert.equal(rows['Out Guy'].statusReason, 'Ankle');
    // Listed with 0 minutes counts as a DNP
    assert.equal(rows['Zero Guy'].status, 'DNP');
    // Team played but the player is nowhere in the box score
    assert.equal(rows['Hurt Guy'].status, 'INACTIVE');
    assert.equal(rows['Hurt Guy'].statusReason, 'Not in box score');
    for (const name of ['Coach Guy', 'Out Guy', 'Zero Guy', 'Hurt Guy']) {
      assert.equal(rows[name].projectionError, null, name);
      assert.equal(rows[name].value, null, name);
    }
  });

  test('a game without a box score yet is PENDING, not DNP', async () => {
    const [future] = await results.getPlayerResults({ from: '2025-11-03', to: '2025-11-03' });
    assert.equal(future.name, 'Future Guy');
    assert.equal(future.status, 'PENDING');
    assert.equal(future.actual, null);
  });

  test('site filter scores that site\'s points', async () => {
    const [luka] = await results.getPlayerResults({ site: 'fanduel' });
    assert.equal(luka.slateId, 's3');
    assert.equal(luka.actual, 58);
    assert.equal(luka.projectionError, -6);
    assert.equal(luka.value, 5.273); // 58 / 11
  });

  test('salary tiers follow the site salary scale', async () => {
    const report = await results.getResults({ site: 'fanduel' });
    // $11,000 is 8K+ on DraftKings but 9.6K+ on FanDuel's $60K cap
    assert.deepEqual(report.bySalaryTier.map(t => [t.group, t.players]), [['9.6K+', 1]]);
  });

  test('slateId and status filters', async () => {
    const s1 = await results.getPlayerResults({ slateId: 's1' });
    assert.equal(s1.length, 7);
    assert.equal(s1.find(r => r.playerKey === 'luka doncic').projectionError, -10);
    const dnps = await results.getPlayerResults({ status: 'DNP' });
    assert.deepEqual(dnps.map(r => r.name).sort(), ['Coach Guy', 'Zero Guy']);
  });
});

describe('getResults aggregates', () => {
  test('overall, salary tier, position and date breakdowns over played players', async () => {
    const report = await results.getResults({ slateId: 's1' });
    const o = report.overall;
    assert.equal(o.players, 7);
    assert.equal(o.played, 3);
    assert.equal(o.dnp, 2);
    assert.equal(o.inactive, 2);
    assert.equal(o.pending, 0);
    // errors -10, +14, -7
    assert.equal(o.projection.n, 3);
    assert.equal(o.projection.mae, 10.333);
    assert.equal(o.projection.bias, -1);
    // minutes errors 0, +2, -2
    assert.equal(o.minutes.mae, 1.333);
    assert.equal(o.minutes.bias, 0);
    // values 6, 3, 5.5
    assert.equal(o.avgValue, 4.833);
    assert.deepEqual(o.hitRates, { '3x': 100, '5x': 66.7, '6x': 33.3 });

    const tier = Object.fromEntries(report.bySalaryTier.map(t => [t.group, t]));
    assert.equal(tier['8K+'].played, 1);
    assert.equal(tier['6K-7.9K'].players, 2); // JJJ + Out Guy
    assert.equal(tier['6K-7.9K'].played, 1);
    assert.equal(tier['<4K'].dnp, 2);
    assert.equal(tier['<4K'].played, 0);
    assert.equal(tier['<4K'].projection.mae, null);
    assert.deepEqual(report.bySalaryTier.map(t => t.group), ['<4K', '4K-5.9K', '6K-7.9K', '8K+']);

    const pos = Object.fromEntries(report.byPosition.map(p => [p.group, p]));
    assert.equal(pos.PG.players, 2);
    assert.equal(pos.C.players, 2); // JJJ (PF/C) + Hurt Guy
    assert.equal(pos.PF.played, 1);

    assert.deepEqual(report.byDate.map(d => d.group), ['2025-11-02']);
  });

  test('date range covers multiple dates and counts pending games', async () => {
    const report = await results.getResults({ from: '2025-11-01', to: '2025-11-03' });
    assert.equal(report.overall.players, 8); // 7 deduped DK on 11-02 + Future Guy
    assert.equal(report.overall.pending, 1);
    assert.deepEqual(report.byDate.map(d => [d.group, d.players]), [['2025-11-02', 7], ['2025-11-03', 1]]);
    assert.deepEqual(report.filters, { from: '2025-11-01', to: '2025-11-03', site: 'draftkings', slateId: null });
  });
});

describe('GET /api/results', () => {
  test('returns aggregates', async () => {
    const res = await fetch(`${baseUrl}?slateId=s1`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.overall.played, 3);
    assert.ok(Array.isArray(body.bySalaryTier));
  });

  test('/players returns per-player rows with filters', async () => {
    const res = await fetch(`${baseUrl}/players?from=2025-11-02&to=2025-11-02&status=INACTIVE`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.players.map(p => p.name).sort(), ['Hurt Guy', 'Out Guy']);
    assert.equal(body.count, 2);
  });

  test('rejects bad dates, sites and statuses', async () => {
    assert.equal((await fetch(`${baseUrl}?from=11/02/2025`)).status, 400);
    assert.equal((await fetch(`${baseUrl}?site=bovada`)).status, 400);
    assert.equal((await fetch(`${baseUrl}/players?status=MAYBE`)).status, 400);
  });
});
