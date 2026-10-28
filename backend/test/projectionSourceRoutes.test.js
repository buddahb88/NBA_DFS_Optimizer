import { test, describe, vi, beforeAll as before, afterAll as after, beforeEach } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import { buildPlayerPool } from './fixtures/playerPool.js';

// The projection source over HTTP: GET / PUT /api/projections/source (Lineup
// Studio control) with per-slate counts, the players table and optimizer
// following it (or a per-request override), input validation, and
// POST /api/optimizer/compare-sources on a backtest night (lineup actuals,
// projection MAE per source). The own model is mocked (tested in M4).
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nba-dfs-source-routes-'));
process.env.DATABASE_TYPE = 'sqlite';
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');

const own = vi.hoisted(() => ({ impl: null, calls: 0 }));
vi.mock('../src/services/modelEval/ownModelService.js', () => ({
  projectSlateOwnModel: async (slateId, options) => {
    own.calls += 1;
    return own.impl(slateId, options);
  }
}));

const PAST = '2026-10-21';
let db;
let setting;
let slateSource;
let server;
let baseUrl;

const call = async (method, url, body) => {
  const res = await fetch(`${baseUrl}${url}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { status: res.status, body: await res.json() };
};

// Ours: the "PG" of team AAA (Player 1) projected 12 below RotoWire, everyone else -1
const delta = (p) => (p.name === 'Player 1' ? -12 : -1);
function ownFor(players) {
  return {
    cached: false,
    players: players.map(p => {
      const rw = Number(p.projected_points);
      const ours = rw + delta(p);
      const diff = ours - rw;
      return {
        id: p.id, name: p.name, rotowire_points: rw, ours_minutes: 30, p_play: 0.98, ours_mean: ours, p10: ours * 0.6, p90: ours * 1.4,
        p_boom: 0.1, blend_point: rw + diff / 2, blend_p10: (rw + diff / 2) * 0.6, blend_p90: (rw + diff / 2) * 1.4, blend_p_boom: 0.12,
        disagreement: { points_diff: diff, lean: diff <= -6 ? 'lower 6+' : 'agree', history: diff <= -6 ? { n: 77, hitRate: 0.688 } : null }
      };
    })
  };
}

before(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  db = (await import('../src/config/database.js')).default;
  await (await import('../src/config/schema.js')).createTables(db);
  setting = await import('../src/config/projectionSource.js');
  slateSource = await import('../src/services/slateSource.js');
  const playerModel = (await import('../src/models/playerModel.js')).default;
  const snapshots = await import('../src/services/slateSnapshotService.js');
  const { playerKey } = await import('../src/utils/playerKey.js');

  // A saved 10/21 slate with box scores (actual = RotoWire - 3, Player 1 scores 20)
  const pool = buildPlayerPool();
  await db.run(`INSERT INTO slates (slate_id, name, sport, start_time, site) VALUES ('past', 'Main', 'NBA', '7:30 PM', 'draftkings')`);
  await playerModel.bulkCreateOrUpdate('past', pool.map(p => ({
    playerId: `rw${p.id}`, name: p.name, team: p.team, opponent: p.opponent, position: p.position,
    salary: p.salary, projectedPoints: p.projected_points, projectedMinutes: 30, floor: p.floor, ceiling: p.ceiling,
    rostership: p.rostership, stdDev: 8, boomProbability: 10, bustProbability: 30,
    rawData: JSON.stringify({ game: { dateTime: `${PAST} 19:30:00` }, isHome: true })
  })));
  await snapshots.snapshotSlate('past', { now: new Date(`${PAST}T15:00:00Z`) });
  await db.run('DELETE FROM players');
  await db.run('DELETE FROM slates');
  for (const p of pool) {
    const actual = p.name === 'Player 1' ? 20 : p.projected_points - 3;
    await db.run(`INSERT INTO historical_games (player_name, player_key, team, opponent, game_date, minutes, points, dk_fantasy_points)
      VALUES (?, ?, ?, ?, ?, 30, 10, ?)`, p.name, playerKey(p.name), p.team, p.opponent, PAST, actual);
  }

  const app = express();
  app.use(express.json());
  app.use('/api/projections', (await import('../src/routes/projections.js')).default);
  app.use('/api/players', (await import('../src/routes/players.js')).default);
  app.use('/api/optimizer', (await import('../src/routes/optimizer.js')).default);
  await new Promise(resolve => { server = app.listen(0, resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  vi.restoreAllMocks();
  await new Promise(resolve => server.close(resolve));
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(async () => {
  setting.setProjectionSource(null);
  (await import('../src/services/projections/sourceService.js')).clearSourceSummaries();
  own.calls = 0;
  own.impl = async (slateId, { source }) => {
    const players = await slateSource.loadSlatePlayers(source, { includeZero: true, projectionSource: 'rotowire' });
    return ownFor(players);
  };
});

describe('GET / PUT /api/projections/source', () => {
  test('reports the setting (env pins rotowire in tests) and switches it', async () => {
    let r = await call('GET', '/api/projections/source');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { source: 'rotowire', origin: 'env', default: 'rotowire', options: ['rotowire', 'ours', 'blend'] });
    r = await call('PUT', '/api/projections/source', { source: 'Blend' });
    assert.equal(r.status, 200);
    assert.equal(r.body.source, 'blend');
    assert.equal(r.body.origin, 'runtime');
    r = await call('PUT', '/api/projections/source', { source: null });
    assert.equal(r.body.source, 'rotowire');
  });

  test('rejects an unknown or missing source', async () => {
    for (const body of [{ source: 'espn' }, {}, { source: 3 }]) {
      const r = await call('PUT', '/api/projections/source', body);
      assert.equal(r.status, 400);
      assert.match(r.body.error, /rotowire, ours, blend/);
    }
    assert.equal(setting.projectionSource(), 'rotowire');
  });

  test('with a slate: counts of players on the own model / kept on RotoWire, and the load time', async () => {
    setting.setProjectionSource('ours');
    const r = await call('GET', `/api/projections/source?slateDate=${PAST}`);
    assert.equal(r.status, 200);
    assert.equal(r.body.slate.source, 'ours');
    assert.equal(r.body.slate.slateDate, PAST);
    assert.equal(r.body.slate.players, 32);
    assert.equal(r.body.slate.applied, 32);
    assert.equal(r.body.slate.fallback, 0);
    assert.equal(r.body.slate.fades, 1);
    assert.ok(Number.isFinite(r.body.slate.loadMs));

    own.impl = async () => { throw new Error('no fit'); };
    (await import('../src/services/projections/sourceService.js')).clearSourceSummaries();
    const failed = await call('GET', `/api/projections/source?slateDate=${PAST}`);
    assert.equal(failed.status, 200);
    assert.equal(failed.body.slate.fallback, 32);
    assert.equal(failed.body.slate.error, 'no fit');
  });

  test('unknown slate date: 404', async () => {
    const r = await call('GET', '/api/projections/source?slateDate=2026-01-02');
    assert.equal(r.status, 404);
  });
});

describe('players table and optimizer follow the source', () => {
  test('GET /api/players: the setting, or ?projectionSource for one request; fade on the player', async () => {
    let r = await call('GET', `/api/players/past?slateDate=${PAST}`);
    const p1rw = r.body.find(p => p.name === 'Player 1');
    assert.equal(p1rw.projection_source, undefined);
    assert.equal(own.calls, 0);

    r = await call('GET', `/api/players/past?slateDate=${PAST}&projectionSource=ours`);
    assert.equal(r.status, 200);
    const p1 = r.body.find(p => p.name === 'Player 1');
    assert.equal(p1.projection_source, 'ours');
    assert.equal(p1.projected_points, Number((p1rw.projected_points - 12).toFixed(2)));
    assert.equal(p1.projection_rotowire, p1rw.projected_points);
    assert.equal(p1.projection_fade.points_diff, -12);
    assert.equal(p1.projection_fade.hit_rate, 0.688);
    assert.equal(p1.actualPoints, 20);
    assert.ok(r.body.filter(p => p.projection_fade).length === 1);

    const bad = await call('GET', `/api/players/past?slateDate=${PAST}&projectionSource=nope`);
    assert.equal(bad.status, 400);
  });

  test('POST /api/optimizer/generate: projectionSource validated, counts in the response', async () => {
    const bad = await call('POST', '/api/optimizer/generate', { slateDate: PAST, projectionSource: 'model' });
    assert.equal(bad.status, 400);
    assert.match(bad.body.error, /projectionSource/);

    const rw = await call('POST', '/api/optimizer/generate', { slateDate: PAST, mode: 'cash' });
    assert.equal(rw.status, 200);
    assert.equal(rw.body.projectionSource, undefined);
    const ours = await call('POST', '/api/optimizer/generate', { slateDate: PAST, mode: 'cash', projectionSource: 'ours' });
    assert.equal(ours.status, 200);
    assert.equal(ours.body.projectionSource.applied, 32);
    const names = (b) => b.lineups[0].players.map(s => s.player.name);
    assert.ok(names(rw.body).includes('Player 1'));
    assert.ok(!names(ours.body).includes('Player 1'));
  });
});

describe('POST /api/optimizer/compare-sources', () => {
  test('one row per source: lineup actuals and projection MAE on the backtest night', async () => {
    const r = await call('POST', '/api/optimizer/compare-sources', { slateDate: PAST, mode: 'cash', numLineups: 1 });
    assert.equal(r.status, 200);
    assert.equal(r.body.isBacktest, true);
    assert.deepEqual(r.body.sources.map(s => s.source), ['rotowire', 'ours', 'blend']);
    const [rw, ours, blend] = r.body.sources;
    assert.equal(rw.summary.applied, 0);
    assert.equal(ours.summary.applied, 32);
    for (const s of r.body.sources) {
      assert.equal(s.lineups, 1);
      assert.equal(s.accuracy.n, 32);
      assert.equal(s.topLineup.players.length, 8);
      assert.equal(s.bestActual, s.topLineup.actual);
    }
    // RotoWire: every player 3 high, Player 1 (47 -> 20) 27 high; ours: 2 high, Player 1 (35) 15 high
    assert.ok(Math.abs(rw.accuracy.mae - (31 * 3 + 27) / 32) < 0.01);
    assert.ok(Math.abs(ours.accuracy.mae - (31 * 2 + 15) / 32) < 0.01);
    assert.ok(blend.accuracy.mae < rw.accuracy.mae && blend.accuracy.mae > ours.accuracy.mae);
    // Fading Player 1 pays: ours' lineup beats RotoWire's in actual points
    assert.ok(ours.bestActual > rw.bestActual);
  });

  test('validates the source list', async () => {
    const r = await call('POST', '/api/optimizer/compare-sources', { slateDate: PAST, sources: ['ours', 'x'] });
    assert.equal(r.status, 400);
  });
});
