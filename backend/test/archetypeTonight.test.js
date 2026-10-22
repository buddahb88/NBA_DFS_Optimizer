import { test, describe, beforeAll as before, afterAll as after } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';

// Keep the service off the real DB file
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nba-dfs-archetype-tonight-'));
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
  app.use('/api/archetypes', (await import('../src/routes/archetypes.js')).default);
  await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}/api/archetypes`;
});

after(async () => {
  await new Promise(resolve => server.close(resolve));
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const row = (team, group_key, fp, extra = {}) => ({
  team, group_key, games: 5, player_games: 5, fp_over_expectation: fp,
  pts_delta: 0, reb_delta: 0, ast_delta: 0, fg3m_delta: 0, ...extra,
});

describe('weakTiers', () => {
  test('top third of defenses per group by the stat, positive deltas only', () => {
    const rows = [
      row('AAA', 'scoring_guard', 4), row('BBB', 'scoring_guard', 2), row('CCC', 'scoring_guard', 1),
      row('DDD', 'scoring_guard', -1), row('EEE', 'scoring_guard', -2), row('FFF', 'scoring_guard', -3),
      row('AAA', 'rim_running_big', -1), row('BBB', 'rim_running_big', -2), row('CCC', 'rim_running_big', 3),
    ];
    const tiers = defense.weakTiers(rows, 'fp');
    // 6 teams -> tier of 2; 3 teams -> tier of 1
    assert.deepEqual([...tiers.get('scoring_guard').keys()], ['AAA', 'BBB']);
    assert.deepEqual(tiers.get('scoring_guard').get('BBB'), { rank: 2, teams: 6, row: rows[1] });
    assert.deepEqual([...tiers.get('rim_running_big').keys()], ['CCC']);
  });

  test('ranks by the selected per-stat delta', () => {
    const rows = [row('AAA', 'G', 5, { reb_delta: -1 }), row('BBB', 'G', -5, { reb_delta: 2 }), row('CCC', 'G', 0, { reb_delta: 1 })];
    assert.deepEqual([...defense.weakTiers(rows, 'reb').get('G').keys()], ['BBB']);
  });

  test('a tier never includes a defense that allows less than expected', () => {
    const rows = [row('AAA', 'G', -0.5), row('BBB', 'G', -1), row('CCC', 'G', -2)];
    assert.equal(defense.weakTiers(rows, 'fp').get('G').size, 0);
  });
});

describe('GET /tonight', () => {
  const SEASON = '2025-26';
  const PRIOR = '2024-25';

  before(async () => {
    await db.run(`INSERT INTO slates (slate_id, name, site) VALUES ('s1', 'Main', 'fanduel')`);
    const player = (id, name, team, opp, pos, salary, proj) => db.run(
      `INSERT INTO players (slate_id, player_id, name, team, opponent, position, salary, projected_points)
       VALUES ('s1', ?, ?, ?, ?, ?, ?, ?)`, id, name, team, opp, pos, salary, proj);
    await player('1', 'Guard One', 'MIA', 'NYK', 'PG', 8000, 40);
    await player('2', 'Big Two', 'MIA', 'NYK', 'C', 7000, 35);
    await player('3', 'Wing Three Jr.', 'BOS', 'PHO', 'SF', 6000, 30);
    await player('4', 'Nobody', 'BOS', 'PHO', 'PG', 3000, 5);

    await db.run(`INSERT INTO player_archetypes (season, player_key, archetype) VALUES
      (?, 'guard one', 'scoring_guard'), (?, 'big two', 'unclassified'), (?, 'big two', 'rim_running_big'),
      (?, 'wing three', 'scoring_guard')`, SEASON, SEASON, PRIOR, SEASON);

    // Stored defense rows: NYK and PHX are weak vs scoring guards, NYK strong vs bigs
    const insert = (team, group_by, group_key, fp, pts = fp, site = 'fanduel') => db.run(
      `INSERT INTO team_archetype_defense (season, site, group_by, team, group_key, games, player_games,
        avg_minutes, avg_fp, avg_expected_fp, fp_over_expectation_raw, shrink, fp_over_expectation,
        pts_delta, reb_delta, ast_delta, fg3m_delta, stocks_delta)
       VALUES (?, ?, ?, ?, ?, 8, 12, 30, 40, 38, ?, 0.5, ?, ?, 0.5, 0.25, 0.1, 0)`,
      SEASON, site, group_by, team, group_key, fp * 2, fp, pts);
    await insert('NYK', 'archetype', 'scoring_guard', 3);
    await insert('PHX', 'archetype', 'scoring_guard', 2);
    await insert('ATL', 'archetype', 'scoring_guard', -1);
    await insert('BOS', 'archetype', 'scoring_guard', -2);
    await insert('LAL', 'archetype', 'scoring_guard', -3);
    await insert('DEN', 'archetype', 'scoring_guard', -4);
    await insert('NYK', 'archetype', 'rim_running_big', -2);
    await insert('ATL', 'archetype', 'rim_running_big', 1);
    // Ranked by points: ATL allows the most FP but fewer points than expected
    await insert('NYK', 'position', 'G', 2.5, 1.5);
    await insert('ATL', 'position', 'G', 4, -1);
    await insert('BOS', 'position', 'G', -1.5);
  });

  test('lists slate players facing a weak-tier defense for their archetype, best matchup first', async () => {
    const res = await fetch(`${baseUrl}/tonight?slateId=s1&season=${SEASON}`);
    assert.equal(res.status, 200);
    const body = await res.json();
    // Site falls back to the slate's
    assert.equal(body.site, 'fanduel');
    assert.equal(body.grouping, 'archetype');
    assert.equal(body.stat, 'fp');
    assert.equal(body.slatePlayers, 4);
    assert.equal(body.matchedPlayers, 3);
    assert.equal(body.fallback, null);
    // Big Two's 2025-26 row is unclassified -> prior season's rim_running_big; NYK is strong there
    assert.deepEqual(body.players.map(p => p.name), ['Guard One', 'Wing Three Jr.']);
    const [guard, wing] = body.players;
    assert.equal(guard.salary, 8000);
    assert.equal(guard.projected_points, 40);
    assert.equal(guard.archetype, 'scoring_guard');
    assert.equal(guard.label, 'Scoring Guard / Wing');
    assert.equal(guard.matchup_delta, 3);
    assert.equal(guard.rank, 1);
    assert.equal(guard.teams, 6);
    // RotoWire's PHO is canonicalized to the historical PHX
    assert.equal(wing.opponent, 'PHX');
    assert.equal(wing.matchup_delta, 2);
  });

  test('position grouping and per-stat ranking', async () => {
    const body = await (await fetch(`${baseUrl}/tonight?slateId=s1&season=${SEASON}&grouping=position&stat=pts`)).json();
    assert.equal(body.stat, 'pts');
    assert.deepEqual(body.players.map(p => [p.name, p.group_key, p.matchup_delta]), [['Guard One', 'G', 1.5]]);
  });

  test('adjusted edge: minutes, new team and crowding, best adjusted first', async () => {
    await db.run(`INSERT INTO slates (slate_id, name, site) VALUES ('s3', 'Edge', 'fanduel')`);
    const player = (id, name, minutes) => db.run(
      `INSERT INTO players (slate_id, player_id, name, team, opponent, position, salary, projected_points, projected_minutes)
       VALUES ('s3', ?, ?, 'MIL', 'NYK', 'PG', 6000, 30, ?)`, id, name, minutes);
    await player('1', 'Bench Guard', 20);
    await player('2', 'New Guard', 33);
    await player('3', 'Steady Guard', 34);
    await db.run(`INSERT INTO player_archetypes (season, player_key, archetype) VALUES
      (?, 'bench guard', 'scoring_guard'), (?, 'new guard', 'scoring_guard'), (?, 'steady guard', 'scoring_guard')`,
    SEASON, SEASON, SEASON);
    // Last season (relative to the archetype season) profiles
    await db.run(`INSERT INTO player_season_profiles (season, player_key, player_name, team, games, minutes_pg) VALUES
      (?, 'bench guard', 'Bench Guard', 'MIL', 60, 28), (?, 'new guard', 'New Guard', 'MIA', 60, 31),
      (?, 'steady guard', 'Steady Guard', 'MIL', 70, 33)`, PRIOR, PRIOR, PRIOR);
    // Minutes so far this season count only before `date`
    await db.run(`INSERT INTO historical_games (game_id, game_date, season, season_type, player_key, player_name, team, opponent, minutes)
      VALUES ('g1', '2026-01-02', ?, 'regular', 'steady guard', 'Steady Guard', 'MIL', 'BOS', 35),
             ('g2', '2026-01-04', ?, 'regular', 'steady guard', 'Steady Guard', 'MIL', 'BOS', 35),
             ('g3', '2026-01-09', ?, 'regular', 'steady guard', 'Steady Guard', 'MIL', 'BOS', 10)`, SEASON, SEASON, SEASON);

    const body = await (await fetch(`${baseUrl}/tonight?slateId=s3&season=${SEASON}&date=2026-01-08`)).json();
    assert.deepEqual(body.players.map(p => p.name), ['Steady Guard', 'New Guard', 'Bench Guard']);
    assert.equal(body.edgeConfig.fullMinutes, 32);
    const by = Object.fromEntries(body.players.map(p => [p.name, p]));

    const steady = by['Steady Guard'];
    assert.equal(steady.matchup_delta, 3);
    assert.equal(steady.minutes.current, 35);
    assert.equal(steady.minutes.current_games, 2);
    assert.equal(steady.crowding.count, 2);
    assert.deepEqual(steady.flags, ['crowded']);
    assert.equal(steady.components.crowding_factor, 0.667);
    assert.equal(steady.adjusted_edge, 2.001);

    assert.equal(by['New Guard'].new_team, true);
    assert.equal(by['New Guard'].last_team, 'MIA');
    assert.deepEqual(by['New Guard'].flags, ['new_team', 'crowded']);

    const bench = by['Bench Guard'];
    assert.equal(bench.role, 'role_down');
    assert.equal(bench.minutes.change, -8);
    assert.equal(bench.components.minutes_confidence, 0.5);
    assert.ok(bench.adjusted_edge < by['New Guard'].adjusted_edge);
  });

  test('validates params', async () => {
    assert.equal((await fetch(`${baseUrl}/tonight?season=${SEASON}`)).status, 400);
    assert.equal((await fetch(`${baseUrl}/tonight?slateId=s1&stat=blk`)).status, 400);
    assert.equal((await fetch(`${baseUrl}/tonight?slateId=missing`)).status, 404);
  });
});

describe('GET /tonight thin-season fallback', () => {
  // Relative to the real clock so the default (current) season is the thin one
  let CURRENT;
  let PRIOR;
  const TEAMS = Array.from({ length: 24 }, (_, i) => `T${String(i).padStart(2, '0')}`);

  before(async () => {
    const { getCurrentSeason } = await import('../src/utils/season.js');
    CURRENT = getCurrentSeason();
    PRIOR = defense.previousSeason(CURRENT);
    await db.run(`INSERT INTO slates (slate_id, name, site) VALUES ('s2', 'Thin', 'yahoo')`);
    await db.run(`INSERT INTO players (slate_id, player_id, name, team, opponent, position, salary, projected_points)
      VALUES ('s2', '1', 'Fallback Guard', 'MIA', 'T00', 'PG', 20, 30)`);
    // Classified only in the prior season, as early in a season
    await db.run(`INSERT INTO player_archetypes (season, player_key, archetype) VALUES (?, 'fallback guard', 'scoring_guard')`, PRIOR);

    const insert = (season, team, games, fp) => db.run(
      `INSERT INTO team_archetype_defense (season, site, group_by, team, group_key, games, player_games,
        avg_minutes, avg_fp, avg_expected_fp, fp_over_expectation_raw, shrink, fp_over_expectation,
        pts_delta, reb_delta, ast_delta, fg3m_delta, stocks_delta)
       VALUES (?, 'yahoo', 'archetype', ?, 'scoring_guard', ?, ?, 30, 40, 38, ?, 0.5, ?, 0, 0, 0, 0, 0)`,
      season, team, games, games, fp, fp);
    // Current: one night in -> T00 is soft on 1 game; T01 tops the tier
    for (const [i, team] of TEAMS.slice(0, 6).entries()) await insert(CURRENT, team, 1, i === 1 ? 9 : 5 - i);
    // Prior: a full season, T00 the softest of 24
    for (const [i, team] of TEAMS.entries()) await insert(PRIOR, team, 41, 4 - i * 0.25);
  });

  test('without a season, a thin current season falls back to last season', async () => {
    const body = await (await fetch(`${baseUrl}/tonight?slateId=s2`)).json();
    assert.equal(body.season, PRIOR);
    assert.deepEqual(body.fallback, { from: CURRENT, qualifiedDefenses: 0, minDefenses: 20, minGames: 10 });
    assert.deepEqual(body.players.map(p => [p.name, p.rank, p.teams]), [['Fallback Guard', 1, 24]]);
    // Archetypes still come from the requested season (falling back per player)
    assert.equal(body.players[0].archetype, 'scoring_guard');
  });

  test('GET /defense falls back the same way only when asked to', async () => {
    const auto = await (await fetch(`${baseUrl}/defense?site=yahoo&seasonFallback=true`)).json();
    assert.equal(auto.season, PRIOR);
    assert.deepEqual(auto.fallback, { from: CURRENT, qualifiedDefenses: 0, minDefenses: 20, minGames: 10 });
    assert.equal(auto.rows.length, 24);

    // Default contract unchanged: current season, no fallback
    const plain = await (await fetch(`${baseUrl}/defense?site=yahoo`)).json();
    assert.equal(plain.season, CURRENT);
    assert.equal(plain.fallback, null);
    assert.equal(plain.rows.length, 6);

    // An explicit season wins over seasonFallback
    const pinned = await (await fetch(`${baseUrl}/defense?site=yahoo&season=${CURRENT}&seasonFallback=true`)).json();
    assert.equal(pinned.season, CURRENT);
    assert.equal(pinned.fallback, null);
  });

  test('an explicit season is never replaced', async () => {
    const body = await (await fetch(`${baseUrl}/tonight?slateId=s2&season=${CURRENT}`)).json();
    assert.equal(body.season, CURRENT);
    assert.equal(body.fallback, null);
    assert.equal(body.players[0].rank, 2);
    assert.equal(body.players[0].teams, 6);
  });
});

describe('GET /definitions', () => {
  test('serves every archetype with its description', async () => {
    const body = await (await fetch(`${baseUrl}/definitions`)).json();
    const { ALL_ARCHETYPES } = await import('../src/config/archetypes.js');
    assert.deepEqual(body.archetypes.map(a => a.key), ALL_ARCHETYPES.map(a => a.key));
    assert.ok(body.archetypes.every(a => a.label && a.description));
    assert.deepEqual(body.positions.map(p => p.key), ['G', 'F', 'C']);
  });
});
