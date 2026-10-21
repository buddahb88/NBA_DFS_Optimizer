import { test, describe, beforeAll as before, afterAll as after } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';

// Keep the service off the real DB file
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nba-dfs-archetype-defense-'));
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

// Stored and served values are rounded to 3 decimals
const close = (actual, expected, msg) => assert.ok(Math.abs(actual - expected) < 1e-3, `${msg ?? ''} ${actual} != ${expected}`);

// Small sample thresholds so hand-computed cases stay short
const CONFIG = { baselinePriorMinutes: 100, minBaselineMinutes: 30, priorGames: 10 };

let nextId = 1;
const game = (o) => ({
  id: nextId++, game_id: `${o.game_date}-${o.opponent}`, player_key: 'a', player_name: 'A', team: 'BOS', opponent: 'NYK',
  position: 'G', minutes: 30, points: 0, rebounds: 0, assists: 0, fg3_made: 0, steals: 0, blocks: 0,
  dk_fantasy_points: 0, fd_fantasy_points: 0, yahoo_fantasy_points: 0, ...o,
});

describe('dvpPosition', () => {
  test('maps ESPN and DK positions to G / F / C', () => {
    const cases = [['G', 'G'], ['PG', 'G'], ['SG', 'G'], ['F', 'F'], ['SF', 'F'], ['PF', 'F'], ['C', 'C'],
      ['PG/SG', 'G'], ['PF/C', 'F'], ['C/UTIL', 'C'], ['PG,G,UTIL', 'G'], ['sf', 'F'], [null, null], ['', null], ['UTIL', null]];
    for (const [pos, bucket] of cases) assert.equal(defense.dvpPosition(pos), bucket, pos);
  });
});

describe('computeExpectations', () => {
  test('baseline is season-to-date FPPM x actual minutes, from earlier games only', () => {
    const rows = [
      game({ game_date: '2026-01-01', minutes: 30, dk_fantasy_points: 30, points: 15 }),
      game({ game_date: '2026-01-03', minutes: 30, dk_fantasy_points: 60, points: 30 }),
      game({ game_date: '2026-01-05', minutes: 20, dk_fantasy_points: 10, points: 4 }),
    ];
    const out = defense.computeExpectations(rows, {}, CONFIG);

    // Game 1 has no prior minutes (and no prior season) -> no baseline, excluded
    assert.deepEqual(out.map(g => g.game_date), ['2026-01-03', '2026-01-05']);
    close(out[0].expected.dk, 30, 'game 2: 1.0 FPPM x 30');
    close(out[0].expected.pts, 15);
    close(out[1].expected.dk, 30, 'game 3: (30+60)/60 = 1.5 FPPM x 20');
    close(out[1].expected.pts, 15, 'game 3: 45/60 x 20');
    assert.equal(out[1].actual.dk, 10);
  });

  test('no lookahead: changing a later game never changes an earlier expectation', () => {
    const base = [
      game({ game_date: '2026-01-01', dk_fantasy_points: 30 }),
      game({ game_date: '2026-01-03', dk_fantasy_points: 45 }),
      game({ game_date: '2026-01-05', dk_fantasy_points: 20 }),
    ];
    const changed = base.map(r => (r.game_date === '2026-01-05' ? { ...r, dk_fantasy_points: 500, minutes: 48 } : r));
    const a = defense.computeExpectations(base, {}, CONFIG);
    const b = defense.computeExpectations(changed, {}, CONFIG);
    close(a[0].expected.dk, b[0].expected.dk);
    // The changed game's own rate only uses earlier games (its minutes changed, so compare per minute)
    close(a[1].expected.dk / a[1].minutes, b[1].expected.dk / b[1].minutes);
  });

  test('games on the same date never feed each other', () => {
    const rows = [
      game({ game_date: '2026-01-01', dk_fantasy_points: 30 }),
      game({ game_date: '2026-01-02', dk_fantasy_points: 90, game_id: 'x1' }),
      game({ game_date: '2026-01-02', dk_fantasy_points: 0, game_id: 'x2' }),
    ];
    const out = defense.computeExpectations(rows, {}, CONFIG);
    close(out[0].expected.dk, 30);
    close(out[1].expected.dk, 30);
  });

  test('blends the prior season rate in with baselinePriorMinutes of weight', () => {
    const rows = [
      game({ game_date: '2026-01-01', minutes: 20, dk_fantasy_points: 20 }),
      game({ game_date: '2026-01-03', minutes: 20, dk_fantasy_points: 20 }),
    ];
    const prior = new Map([['a', { minutes: 1000, dk: 2000, fd: 1500, yahoo: 1500, pts: 1000, reb: 0, ast: 0, fg3m: 0, stocks: 0 }]]);
    const out = defense.computeExpectations(rows, { priorTotals: prior }, CONFIG);
    close(out[0].expected.dk, 40, 'first game: prior-season 2.0 FPPM x 20');
    close(out[0].expected.fd, 30);
    close(out[1].expected.dk, ((20 + 100 * 2) / (20 + 100)) * 20, 'second game blends 20 earlier minutes');
  });

  test('archetype comes from the season, falling back to the prior season when unclassified or missing', () => {
    const rows = [
      game({ game_date: '2026-01-01', player_key: 'a' }), game({ game_date: '2026-01-02', player_key: 'a' }),
      game({ game_date: '2026-01-01', player_key: 'b' }), game({ game_date: '2026-01-02', player_key: 'b' }),
      game({ game_date: '2026-01-01', player_key: 'c' }), game({ game_date: '2026-01-02', player_key: 'c' }),
      game({ game_date: '2026-01-01', player_key: 'd' }), game({ game_date: '2026-01-02', player_key: 'd' }),
    ];
    const out = defense.computeExpectations(rows, {
      archetypes: new Map([['a', 'stretch_big'], ['b', 'unclassified']]),
      priorArchetypes: new Map([['a', 'role_player'], ['b', 'primary_creator'], ['c', 'shooter']]),
    }, CONFIG);
    const by = Object.fromEntries(out.map(g => [g.player_key, g.archetype]));
    assert.deepEqual(by, { a: 'stretch_big', b: 'primary_creator', c: 'shooter', d: 'unclassified' });
  });
});

describe('aggregateDefense', () => {
  // Hand-built expectation rows: actual / expected per site and stat
  const row = (o) => ({
    game_id: o.game_id ?? `${o.game_date}-${o.defense}`, game_date: o.game_date, player_key: o.player_key ?? 'p',
    player_name: 'P', team: 'X', defense: o.defense ?? 'NYK', position_group: o.position_group ?? 'G',
    archetype: o.archetype ?? 'shooter', minutes: 30,
    actual: { dk: o.dk, fd: o.dk, yahoo: o.dk, pts: o.pts ?? 0, reb: 0, ast: 0, fg3m: 0, stocks: o.stocks ?? 0 },
    expected: { dk: o.exp, fd: o.exp, yahoo: o.exp, pts: o.expPts ?? 0, reb: 0, ast: 0, fg3m: 0, stocks: 0 },
  });

  const games = [
    row({ game_date: '2026-01-01', player_key: 'p1', dk: 40, exp: 30, pts: 20, expPts: 14, stocks: 2 }),
    row({ game_date: '2026-01-01', player_key: 'p2', dk: 30, exp: 30, pts: 10, expPts: 10 }),
    row({ game_date: '2026-01-05', player_key: 'p1', dk: 35, exp: 30, pts: 16, expPts: 14 }),
    row({ game_date: '2026-01-05', player_key: 'p3', dk: 20, exp: 30, position_group: 'C', archetype: 'rim_running_big' }),
    row({ game_date: '2026-01-07', player_key: 'p1', dk: 50, exp: 30, defense: 'BOS' }),
  ];

  test('averages per player-game and shrinks deltas toward 0 by distinct games', () => {
    const rows = defense.aggregateDefense(games, { site: 'draftkings', grouping: 'archetype' }, CONFIG);
    const nyk = rows.find(r => r.team === 'NYK' && r.group_key === 'shooter');
    assert.equal(nyk.games, 2);
    assert.equal(nyk.player_games, 3);
    close(nyk.avg_fp, 35);
    close(nyk.avg_expected_fp, 30);
    close(nyk.fp_over_expectation_raw, 5);
    const shrink = 2 / (2 + CONFIG.priorGames);
    close(nyk.shrink, shrink);
    close(nyk.fp_over_expectation, 5 * shrink);
    close(nyk.pts_delta, ((6 + 0 + 2) / 3) * shrink);
    close(nyk.stocks_delta, (2 / 3) * shrink);

    const big = rows.find(r => r.team === 'NYK' && r.group_key === 'rim_running_big');
    assert.equal(big.games, 1);
    close(big.fp_over_expectation, -10 * (1 / 11));
    assert.ok(rows.find(r => r.team === 'BOS' && r.group_key === 'shooter'));
  });

  test('more games means less shrinkage for the same raw delta', () => {
    const many = Array.from({ length: 30 }, (_, i) => row({ game_date: `2026-01-${String(i + 1).padStart(2, '0')}`, dk: 35, exp: 30 }));
    const [r] = defense.aggregateDefense(many, { site: 'draftkings', grouping: 'archetype' }, CONFIG);
    close(r.fp_over_expectation, 5 * (30 / 40));
  });

  test('groups by G / F / C position', () => {
    const rows = defense.aggregateDefense(games, { site: 'draftkings', grouping: 'position' }, CONFIG);
    const keys = rows.filter(r => r.team === 'NYK').map(r => r.group_key).sort();
    assert.deepEqual(keys, ['C', 'G']);
    assert.equal(rows.find(r => r.team === 'NYK' && r.group_key === 'G').player_games, 3);
  });

  test('date window and lastNGames (the defense\'s own last N games)', () => {
    const windowed = defense.aggregateDefense(games, { site: 'draftkings', grouping: 'archetype', startDate: '2026-01-02' }, CONFIG);
    assert.equal(windowed.find(r => r.team === 'NYK' && r.group_key === 'shooter').player_games, 1);

    const lastOne = defense.aggregateDefense(games, { site: 'draftkings', grouping: 'archetype', lastNGames: 1 }, CONFIG);
    const nyk = lastOne.filter(r => r.team === 'NYK');
    assert.deepEqual(nyk.map(r => r.group_key).sort(), ['rim_running_big', 'shooter']);
    assert.equal(nyk.find(r => r.group_key === 'shooter').player_games, 1);
    // BOS's last game is its only game
    assert.equal(lastOne.find(r => r.team === 'BOS').player_games, 1);

    const ended = defense.aggregateDefense(games, { site: 'draftkings', grouping: 'archetype', lastNGames: 1, endDate: '2026-01-04' }, CONFIG);
    assert.equal(ended.find(r => r.team === 'NYK' && r.group_key === 'shooter').player_games, 2);
    assert.equal(ended.find(r => r.team === 'BOS'), undefined);
  });
});

describe('database + routes', () => {
  // Season 2025-26: four players vs NYK / BOS. Prior season gives 'g1' a baseline from game 1.
  const SEASON = '2025-26';
  const seed = async () => {
    const insert = (o) => db.run(`INSERT INTO historical_games (player_name, player_key, team, opponent, game_date, game_id,
      season, season_type, position, minutes, points, rebounds, assists, fg3_made, steals, blocks,
      dk_fantasy_points, fd_fantasy_points, yahoo_fantasy_points)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    o.name, o.key, o.team, o.opp, o.date, o.gid, o.season ?? SEASON, o.type ?? 'regular', o.pos, o.min,
    o.pts ?? 0, o.reb ?? 0, o.ast ?? 0, o.fg3 ?? 0, o.stl ?? 0, o.blk ?? 0, o.dk, o.fd ?? o.dk, o.yahoo ?? o.dk);

    // Prior season: g1 averaged 1.0 DK FPPM
    await insert({ name: 'Guard One', key: 'g1', team: 'MIA', opp: 'ATL', date: '2025-03-01', gid: 'p1', season: '2024-25', pos: 'G', min: 300, dk: 300, pts: 150 });
    // 2025-26 regular season
    await insert({ name: 'Guard One', key: 'g1', team: 'MIA', opp: 'NYK', date: '2025-11-01', gid: 'm1', pos: 'G', min: 30, dk: 45, pts: 25 });
    await insert({ name: 'Guard One', key: 'g1', team: 'MIA', opp: 'BOS', date: '2025-11-03', gid: 'm2', pos: 'G', min: 30, dk: 30, pts: 15 });
    await insert({ name: 'Guard One', key: 'g1', team: 'MIA', opp: 'NYK', date: '2025-11-05', gid: 'm3', pos: 'G', min: 30, dk: 50, pts: 28 });
    await insert({ name: 'Big Two', key: 'c2', team: 'MIA', opp: 'ATL', date: '2025-10-28', gid: 'm0', pos: 'C', min: 30, dk: 30, reb: 10 });
    await insert({ name: 'Big Two', key: 'c2', team: 'MIA', opp: 'NYK', date: '2025-11-01', gid: 'm1', pos: 'C', min: 30, dk: 30, reb: 10 });
    await insert({ name: 'Big Two', key: 'c2', team: 'MIA', opp: 'NYK', date: '2025-11-05', gid: 'm3', pos: 'C', min: 30, dk: 24, reb: 8 });
    // A DNP and a playoff game are ignored
    await insert({ name: 'Bench', key: 'b9', team: 'MIA', opp: 'NYK', date: '2025-11-05', gid: 'm3', pos: 'F', min: 0, dk: 0 });
    await insert({ name: 'Guard One', key: 'g1', team: 'MIA', opp: 'NYK', date: '2026-04-25', gid: 'po1', type: 'playoffs', pos: 'G', min: 40, dk: 90 });

    await db.run(`INSERT INTO player_archetypes (season, player_key, archetype) VALUES (?, 'g1', 'scoring_guard'), (?, 'c2', 'rim_running_big')`, SEASON, SEASON);
  };

  before(async () => {
    await seed();
    await defense.refreshSeasonDefense(SEASON);
  });

  test('refresh stores every site x grouping in team_archetype_defense', async () => {
    const rows = await db.all('SELECT * FROM team_archetype_defense WHERE season = ? ORDER BY site, group_by, team, group_key', SEASON);
    assert.deepEqual([...new Set(rows.map(r => r.site))], ['draftkings', 'fanduel', 'yahoo']);
    const g = rows.find(r => r.site === 'draftkings' && r.group_by === 'archetype' && r.team === 'NYK' && r.group_key === 'scoring_guard');
    // g1 vs NYK: game m1 expected 1.0 x 30 = 30 (prior season only) -> +15;
    // m3 expected (45 + 30 + 100) / (60 + 100) x 30 = 32.8125 -> +17.1875
    assert.equal(g.games, 2);
    assert.equal(g.player_games, 2);
    close(g.avg_fp, 47.5);
    close(g.fp_over_expectation_raw, (15 + 17.1875) / 2);
    close(g.fp_over_expectation, ((15 + 17.1875) / 2) * (2 / 12));
    // c2 has no prior season and only 30 earlier minutes before m1 (< minBaselineMinutes 60)
    // -> only m3 counts: 60 FP / 60 min x 30 = 30 -> -6
    const c = rows.find(r => r.site === 'draftkings' && r.group_by === 'position' && r.team === 'NYK' && r.group_key === 'C');
    assert.equal(c.player_games, 1);
    close(c.fp_over_expectation_raw, -6);
    // Re-running replaces rather than duplicates
    await defense.refreshSeasonDefense(SEASON);
    assert.equal((await db.get('SELECT COUNT(*) AS n FROM team_archetype_defense WHERE season = ?', SEASON)).n, rows.length);
  });

  test('GET /defense serves the precomputed table with labels', async () => {
    const res = await fetch(`${baseUrl}/defense?season=${SEASON}&site=dk&team=NYK`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.source, 'precomputed');
    assert.equal(body.site, 'draftkings');
    assert.equal(body.grouping, 'archetype');
    const g = body.rows.find(r => r.group_key === 'scoring_guard');
    assert.equal(g.label, 'Scoring Guard / Wing');
    assert.ok(body.rows.every(r => r.team === 'NYK'));
    assert.ok(body.rows[0].fp_over_expectation >= body.rows.at(-1).fp_over_expectation, 'sorted best matchup first');
  });

  test('GET /defense with a window computes live', async () => {
    const res = await fetch(`${baseUrl}/defense?season=${SEASON}&grouping=position&team=NYK&lastNGames=1`);
    const body = await res.json();
    assert.equal(body.source, 'live');
    const g = body.rows.find(r => r.group_key === 'G');
    assert.equal(g.player_games, 1);
    close(g.fp_over_expectation_raw, 17.1875);
  });

  test('GET /defense/:team/:archetype/games lists the games behind a cell', async () => {
    const res = await fetch(`${baseUrl}/defense/NYK/scoring_guard/games?season=${SEASON}&site=draftkings`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.games.map(g => g.game_date), ['2025-11-05', '2025-11-01']);
    const [latest] = body.games;
    assert.equal(latest.player_name, 'Guard One');
    close(latest.fp, 50);
    close(latest.expected_fp, 32.8125);
    close(latest.fp_over_expectation, 17.1875);
    close(latest.pts_delta, 28 - ((25 + 15 + 50) / 160) * 30);
    assert.equal(body.summary.player_games, 2);

    const pos = await (await fetch(`${baseUrl}/defense/NYK/C/games?season=${SEASON}`)).json();
    assert.equal(pos.grouping, 'position');
    assert.deepEqual(pos.games.map(g => g.player_key), ['c2']);
  });

  test('validates query params', async () => {
    for (const qs of ['site=espn', 'season=2025', 'grouping=team', 'lastNGames=0', 'startDate=nope']) {
      const res = await fetch(`${baseUrl}/defense?${qs}`);
      assert.equal(res.status, 400, qs);
    }
  });
});
