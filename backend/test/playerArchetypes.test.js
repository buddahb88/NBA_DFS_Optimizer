import { test, describe, beforeAll as before, afterAll as after } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';

// Keep the service off the real DB file
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nba-dfs-archetypes-'));
let db;
let archetypes;
let config;
let server;
let baseUrl;

before(async () => {
  process.env.DATABASE_TYPE = 'sqlite';
  process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');
  db = (await import('../src/config/database.js')).default;
  await (await import('../src/config/schema.js')).createTables(db);
  archetypes = await import('../src/services/archetypeService.js');
  config = await import('../src/config/archetypes.js');

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

// A league-average-ish rotation player; each archetype case overrides what defines it
const BASE = {
  season: '2025-26', position: 'F', games: 60, starts: 30, minutes: 1500, minutes_pg: 25,
  usg_pct: 0.18, ast_pct: 0.12, oreb_pct: 0.04, dreb_pct: 0.13, reb_pct: 0.09,
  stl_pct: 0.014, blk_pct: 0.012, three_pa_rate: 0.30, ft_rate: 0.22, ts_pct: 0.57,
  dk_fppm: 0.9, fd_fppm: 0.85, pts_per36: 15, reb_per36: 6, ast_per36: 3, fg3m_per36: 1.2,
};
const profile = (key, overrides = {}) => ({ ...BASE, player_key: key, player_name: key, ...overrides });

const PROFILES = {
  creator: profile('creator', { position: 'G', minutes_pg: 35, usg_pct: 0.33, ast_pct: 0.40 }),
  pointForward: profile('pointforward', { minutes_pg: 32, usg_pct: 0.22, ast_pct: 0.26, reb_pct: 0.14 }),
  scoringGuard: profile('scoringguard', { position: 'G', minutes_pg: 33, usg_pct: 0.29, ast_pct: 0.16, pts_per36: 26 }),
  benchScorer: profile('benchscorer', { position: 'G', minutes_pg: 17, usg_pct: 0.27, ast_pct: 0.15, pts_per36: 22 }),
  stretchBig: profile('stretchbig', { position: 'C', minutes_pg: 28, reb_pct: 0.15, blk_pct: 0.03, three_pa_rate: 0.45 }),
  rimRunner: profile('rimrunner', { position: 'C', minutes_pg: 26, reb_pct: 0.20, blk_pct: 0.045, three_pa_rate: 0.02 }),
  threeAndD: profile('threeandd', { position: 'F', usg_pct: 0.15, ast_pct: 0.09, three_pa_rate: 0.58,
    stl_pct: 0.021, fg3m_per36: 2.6 }),
  shooter: profile('shooter', { position: 'G', usg_pct: 0.19, ast_pct: 0.10, three_pa_rate: 0.70,
    stl_pct: 0.011, blk_pct: 0.004, fg3m_per36: 3.4 }),
  rolePlayer: profile('roleplayer'),
  tinySample: profile('tinysample', { games: 4, minutes: 60, minutes_pg: 15, usg_pct: 0.35, ast_pct: 0.4 }),
};

describe('classifyProfile', () => {
  const cases = [
    ['creator', 'primary_creator'],
    ['pointForward', 'point_forward'],
    ['scoringGuard', 'scoring_guard'],
    ['benchScorer', 'bench_scorer'],
    ['stretchBig', 'stretch_big'],
    ['rimRunner', 'rim_running_big'],
    ['threeAndD', 'three_and_d_wing'],
    ['shooter', 'spot_up_shooter'],
    ['rolePlayer', 'role_player'],
    ['tinySample', 'unclassified'],
  ];
  for (const [name, expected] of cases) {
    test(`${name} profile -> ${expected}`, () => {
      assert.equal(archetypes.classifyProfile(PROFILES[name]).archetype, expected);
    });
  }

  test('secondary archetype is the next matching rule in priority order', () => {
    // A 3-and-D wing who also clears the spot-up shooter bar
    const result = archetypes.classifyProfile(PROFILES.threeAndD);
    assert.equal(result.secondary_archetype, 'spot_up_shooter');
    // A creator big who also passes like a point forward
    const jokic = profile('jokic', { position: 'C', minutes_pg: 35, usg_pct: 0.30, ast_pct: 0.45, reb_pct: 0.19,
      three_pa_rate: 0.20 });
    const big = archetypes.classifyProfile(jokic);
    assert.equal(big.archetype, 'primary_creator');
    assert.equal(big.secondary_archetype, 'point_forward');
  });

  test('scoring forwards count as scoring guard/wing; centers do not', () => {
    const wing = profile('wing', { position: 'F', minutes_pg: 36, usg_pct: 0.27, ast_pct: 0.20 });
    assert.equal(archetypes.classifyProfile(wing).archetype, 'scoring_guard');
    const center = profile('center', { position: 'C', minutes_pg: 31, usg_pct: 0.26, reb_pct: 0.21, three_pa_rate: 0.30 });
    assert.equal(archetypes.classifyProfile(center).archetype, 'stretch_big');
  });

  test('guards who rebound like bigs are not bigs', () => {
    const hart = profile('hart', { position: 'G', usg_pct: 0.17, ast_pct: 0.21, reb_pct: 0.14, three_pa_rate: 0.41 });
    const result = archetypes.classifyProfile(hart);
    assert.notEqual(result.archetype, 'stretch_big');
    assert.notEqual(result.secondary_archetype, 'stretch_big');
  });

  test('role players and unclassified players have no secondary', () => {
    assert.equal(archetypes.classifyProfile(PROFILES.rolePlayer).secondary_archetype, null);
    assert.equal(archetypes.classifyProfile(PROFILES.tinySample).secondary_archetype, null);
  });

  test('rule trace records the sample check and every condition with actual values', () => {
    const { rule_trace: trace } = archetypes.classifyProfile(PROFILES.creator);
    assert.equal(trace.sample.pass, true);
    assert.deepEqual(trace.sample.games, { value: 60, min: config.MIN_SAMPLE.games, pass: true });

    const creator = trace.rules.find(r => r.archetype === 'primary_creator');
    assert.equal(creator.matched, true);
    const usg = creator.conditions.find(c => c.stat === 'usg_pct');
    assert.deepEqual(usg, { stat: 'usg_pct', op: '>=', value: 0.26, actual: 0.33, pass: true });
    assert.match(trace.reason, /Primary Creator/);
    assert.match(trace.reason, /usg_pct 0\.330 >= 0\.26/);
  });

  test('failed sample explains itself and skips rule evaluation', () => {
    const { rule_trace: trace } = archetypes.classifyProfile(PROFILES.tinySample);
    assert.equal(trace.sample.pass, false);
    assert.deepEqual(trace.rules, []);
    assert.match(trace.reason, /games 4 < 10/);
  });

  test('missing stats fail their condition instead of throwing', () => {
    const result = archetypes.classifyProfile(profile('nostats', { usg_pct: null, ast_pct: null }));
    assert.equal(result.archetype, 'role_player');
  });

  test('a custom config can be passed in', () => {
    const custom = {
      MIN_SAMPLE: { games: 1, minutes: 1 },
      ARCHETYPES: [{ key: 'gunner', label: 'Gunner', description: 'x', rules: [{ stat: 'usg_pct', op: '>=', value: 0.15 }] }],
      DEFAULT_ARCHETYPE: { key: 'role_player', label: 'Role Player', description: 'y' },
    };
    assert.equal(archetypes.classifyProfile(PROFILES.rolePlayer, custom).archetype, 'gunner');
  });

  test('every configured archetype has a label and description for the UI', () => {
    for (const a of [...config.ARCHETYPES, config.DEFAULT_ARCHETYPE, config.UNCLASSIFIED_ARCHETYPE]) {
      assert.ok(a.key && a.label && a.description, `incomplete archetype ${a.key}`);
    }
  });
});

describe('refreshSeasonArchetypes / GET /api/archetypes/players', () => {
  const COLUMNS = Object.keys(PROFILES.creator);

  before(async () => {
    for (const p of Object.values(PROFILES)) {
      await db.run(`INSERT INTO player_season_profiles (${COLUMNS.join(', ')})
        VALUES (${COLUMNS.map(c => `@${c}`).join(', ')})`, p);
    }
    await db.run(`INSERT INTO player_season_profiles (${COLUMNS.join(', ')})
      VALUES (${COLUMNS.map(c => `@${c}`).join(', ')})`, { ...PROFILES.shooter, season: '2024-25' });
  });

  test('stores one row per profile with JSON rule trace and returns the distribution', async () => {
    const result = await archetypes.refreshSeasonArchetypes('2025-26');
    assert.equal(result.players, Object.keys(PROFILES).length);
    assert.equal(result.distribution.primary_creator, 1);
    assert.equal(result.distribution.unclassified, 1);

    const row = await db.get(`SELECT * FROM player_archetypes WHERE season = '2025-26' AND player_key = 'threeandd'`);
    assert.equal(row.archetype, 'three_and_d_wing');
    assert.equal(row.secondary_archetype, 'spot_up_shooter');
    assert.equal(JSON.parse(row.rule_trace).sample.pass, true);

    // Refreshing replaces rather than duplicates
    await archetypes.refreshSeasonArchetypes('2025-26');
    const { n } = await db.get(`SELECT COUNT(*) AS n FROM player_archetypes WHERE season = '2025-26'`);
    assert.equal(n, Object.keys(PROFILES).length);
  });

  test('endpoint returns players with labels, parsed traces, distribution and definitions', async () => {
    const res = await fetch(`${baseUrl}/players?season=2025-26`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.season, '2025-26');
    assert.equal(body.players.length, Object.keys(PROFILES).length);

    const creator = body.players.find(p => p.player_key === 'creator');
    assert.equal(creator.archetype, 'primary_creator');
    assert.equal(creator.archetype_label, 'Primary Creator');
    assert.equal(creator.player_name, 'creator');
    assert.equal(creator.position, 'G');
    assert.equal(creator.rule_trace.sample.pass, true);

    assert.equal(body.distribution.find(d => d.archetype === 'unclassified').count, 1);
    assert.ok(body.archetypes.some(a => a.key === 'stretch_big' && a.description));
  });

  test('endpoint only returns the requested season', async () => {
    await archetypes.refreshSeasonArchetypes('2024-25');
    const body = await (await fetch(`${baseUrl}/players?season=2024-25`)).json();
    assert.deepEqual(body.players.map(p => p.player_key), ['shooter']);
  });

  test('endpoint rejects malformed seasons', async () => {
    assert.equal((await fetch(`${baseUrl}/players?season=2025`)).status, 400);
  });
});
