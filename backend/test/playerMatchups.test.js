import { test, describe, beforeAll as before, afterAll as after } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';

// Keep the service off the real DB file
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nba-dfs-player-matchups-'));
let db;
let defense;
let server;
let baseUrl;

before(async () => {
  process.env.DATABASE_TYPE = 'sqlite';
  process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');
  db = (await import('../src/config/database.js')).default;
  await (await import('../src/config/schema.js')).createTables(db);
  defense = await import('../src/services/archetypeDefenseService.js');

  const app = express();
  app.use('/api/players', (await import('../src/routes/players.js')).default);
  await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}/api/players`;
});

after(async () => {
  await new Promise(resolve => server.close(resolve));
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('matchupGrade', () => {
  test('grades by rank among defenses, most generous first', () => {
    assert.equal(defense.matchupGrade(1, 30), 'A');
    assert.equal(defense.matchupGrade(6, 30), 'A');
    assert.equal(defense.matchupGrade(7, 30), 'B');
    assert.equal(defense.matchupGrade(15, 30), 'C');
    assert.equal(defense.matchupGrade(24, 30), 'D');
    assert.equal(defense.matchupGrade(30, 30), 'F');
    assert.equal(defense.matchupGrade(1, 1), 'C');
    assert.equal(defense.matchupGrade(null, 30), null);
  });
});

describe('rankDefenses', () => {
  test('ranks every defense per group by the stat', () => {
    const rows = [
      { team: 'AAA', group_key: 'G', fp_over_expectation: -1 },
      { team: 'BBB', group_key: 'G', fp_over_expectation: 2 },
      { team: 'CCC', group_key: 'C', fp_over_expectation: 0 },
    ];
    const ranks = defense.rankDefenses(rows);
    assert.deepEqual(ranks.get('G').get('BBB'), { rank: 1, teams: 2, row: rows[1] });
    assert.equal(ranks.get('G').get('AAA').rank, 2);
    assert.equal(ranks.get('C').get('CCC').teams, 1);
  });
});

describe('GET /api/players/:slateId with archetype matchups', () => {
  const SEASON = '2025-26';
  const PRIOR = '2024-25';

  before(async () => {
    await db.run(`INSERT INTO slates (slate_id, name, site) VALUES ('s1', 'Main', 'fanduel')`);
    const player = (id, name, team, opp, pos) => db.run(
      `INSERT INTO players (slate_id, player_id, name, team, opponent, position, salary, projected_points)
       VALUES ('s1', ?, ?, ?, ?, ?, 5000, 20)`, id, name, team, opp, pos);
    await player('1', 'Guard One', 'MIA', 'NYK', 'PG');
    await player('2', 'Big Two', 'MIA', 'NYK', 'C');
    await player('3', 'Wing Three Jr.', 'BOS', 'PHO', 'SF');
    await player('4', 'Rookie Four', 'BOS', 'PHO', 'SG');
    await player('5', 'Nobody', 'BOS', 'XXX', 'PG');

    await db.run(`INSERT INTO player_archetypes (season, player_key, archetype) VALUES
      (?, 'guard one', 'scoring_guard'), (?, 'big two', 'unclassified'), (?, 'big two', 'rim_running_big'),
      (?, 'wing three', 'scoring_guard')`, SEASON, SEASON, PRIOR, SEASON);

    const insert = (team, group_by, group_key, fp) => db.run(
      `INSERT INTO team_archetype_defense (season, site, group_by, team, group_key, games, player_games,
        avg_minutes, avg_fp, avg_expected_fp, fp_over_expectation_raw, shrink, fp_over_expectation,
        pts_delta, reb_delta, ast_delta, fg3m_delta, stocks_delta)
       VALUES (?, 'fanduel', ?, ?, ?, 8, 12, 30, 40, 38, ?, 0.5, ?, 0, 0, 0, 0, 0)`,
      SEASON, group_by, team, group_key, fp * 2, fp);
    await insert('NYK', 'archetype', 'scoring_guard', 3);
    await insert('PHX', 'archetype', 'scoring_guard', -2);
    await insert('ATL', 'archetype', 'scoring_guard', 1);
    await insert('NYK', 'archetype', 'rim_running_big', -2);
    await insert('ATL', 'archetype', 'rim_running_big', 1);
    await insert('PHX', 'position', 'G', 0.5);
    await insert('NYK', 'position', 'G', -0.5);
  });

  test('adds archetype and opponent matchup to each player', async () => {
    const res = await fetch(`${baseUrl}/s1?season=${SEASON}`);
    assert.equal(res.status, 200);
    const players = await res.json();
    // Still a plain array of player rows
    assert.ok(Array.isArray(players));
    const by = Object.fromEntries(players.map(p => [p.name, p]));

    const guard = by['Guard One'];
    assert.equal(guard.salary, 5000);
    assert.equal(guard.archetype, 'scoring_guard');
    assert.equal(guard.archetype_label, 'Scoring Guard / Wing');
    assert.deepEqual(guard.matchup, {
      season: SEASON, site: 'fanduel', grouping: 'archetype', group_key: 'scoring_guard', label: 'Scoring Guard / Wing',
      opponent: 'NYK', delta: 3, rank: 1, teams: 3, grade: 'A', games: 8,
      // No projected minutes (0.5 volume) and no last-season profile (x0.85)
      adjusted_edge: 1.275, edge_flags: ['no_history'],
    });

    // Unclassified this season -> last season's archetype
    assert.equal(by['Big Two'].archetype, 'rim_running_big');
    assert.equal(by['Big Two'].matchup.delta, -2);
    assert.equal(by['Big Two'].matchup.grade, 'F');

    // PHO canonicalized to PHX
    assert.equal(by['Wing Three Jr.'].matchup.opponent, 'PHX');
    assert.equal(by['Wing Three Jr.'].matchup.rank, 3);

    // No archetype -> G/F/C position cell
    const rookie = by['Rookie Four'];
    assert.equal(rookie.archetype, null);
    assert.equal(rookie.archetype_label, null);
    assert.equal(rookie.matchup.grouping, 'position');
    assert.equal(rookie.matchup.group_key, 'G');
    assert.equal(rookie.matchup.label, 'Guards');
    assert.equal(rookie.matchup.delta, 0.5);
    assert.equal(rookie.matchup.rank, 1);

    // No defense data for the opponent
    assert.equal(by.Nobody.matchup, null);
  });

  test('a slate without defense data still returns players', async () => {
    const res = await fetch(`${baseUrl}/s1?season=2019-20`);
    assert.equal(res.status, 200);
    const players = await res.json();
    assert.equal(players.length, 5);
    assert.ok(players.every(p => p.matchup === null));
  });
});
