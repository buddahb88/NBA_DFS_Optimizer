import { test, describe, vi, beforeAll as before, afterAll as after, beforeEach } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import { buildPlayerPool } from './fixtures/playerPool.js';

// The injury-tag discount on slate reads: loadSlatePlayers applies it after
// the source (RotoWire here), live slates with the committed table, backtests
// with a table calibrated only from nights before the slate (as-of), the
// injuryRisk: false opt-out (model inputs), and GET / PUT
// /api/projections/injury-risk.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nba-dfs-injury-'));
process.env.DATABASE_TYPE = 'sqlite';
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');

const OLD = '2026-10-19';
const PAST = '2026-10-21';
const TODAY = '2026-10-23';

let db;
let slateSource;
let setting;
let riskService;
let playerModel;
let snapshots;
let server;
let baseUrl;

const raw = (date) => JSON.stringify({ game: { dateTime: `${date} 19:30:00` }, isHome: true });

async function seedLiveSlate(slateId, date, pool) {
  await db.run(`INSERT INTO slates (slate_id, name, sport, start_time, site) VALUES (?, 'Main', 'NBA', '7:30 PM', 'draftkings')`, slateId);
  await playerModel.bulkCreateOrUpdate(slateId, pool.map(p => ({
    playerId: `rw${p.id}`, name: p.name, team: p.team, opponent: p.opponent, position: p.position,
    salary: p.salary, projectedPoints: p.projected_points, projectedMinutes: 30, floor: p.floor, ceiling: p.ceiling,
    rostership: p.rostership, stdDev: 8, boomProbability: 10, bustProbability: 30, rawData: raw(date),
    injuryStatus: p.injury_status ?? null
  })));
}

async function seedPast(slateId, date, pool) {
  await seedLiveSlate(slateId, date, pool);
  await snapshots.snapshotSlate(slateId, { now: new Date(`${date}T15:00:00Z`) });
  await db.run('DELETE FROM players');
  await db.run('DELETE FROM slates');
}

const call = async (method, url, body) => {
  const res = await fetch(`${baseUrl}${url}`, {
    method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { status: res.status, body: await res.json() };
};

// Every pool player QUES on the old night; only Player 1 played (a box score
// for every team so the night counts)
const tagged = (pool, tag, ids) => pool.map(p => (ids.includes(p.id) ? { ...p, injury_status: tag } : p));

before(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  db = (await import('../src/config/database.js')).default;
  await (await import('../src/config/schema.js')).createTables(db);
  slateSource = await import('../src/services/slateSource.js');
  setting = await import('../src/config/injuryRisk.js');
  riskService = await import('../src/services/projections/injuryRiskService.js');
  playerModel = (await import('../src/models/playerModel.js')).default;
  snapshots = await import('../src/services/slateSnapshotService.js');
  (await import('../src/config/projectionSource.js')).setProjectionSource('rotowire');
  (await import('../src/config/projectionSanity.js')).setProjectionSanity(false);
  const router = (await import('../src/routes/projections.js')).default;
  const app = express();
  app.use(express.json());
  app.use('/api/projections', router);
  server = app.listen(0);
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server?.close();
  vi.restoreAllMocks();
  (await import('../src/config/projectionSource.js')).setProjectionSource(null);
  (await import('../src/config/projectionSanity.js')).setProjectionSanity(null);
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(async () => {
  setting.setInjuryRiskEnabled(null);
  riskService.clearInjuryRiskCache();
  for (const t of ['players', 'slates', 'slate_player_snapshots', 'historical_games']) await db.run(`DELETE FROM ${t}`);
  const pool = buildPlayerPool();
  // Old night: 20 QUES players at $5K+ ... only 2 played -> as-of QUES 5k+ rate well below the fallback
  const quesIds = pool.filter(p => p.salary >= 5000).map(p => p.id);
  await seedPast('old', OLD, tagged(pool, 'QUES', quesIds));
  const played = new Set([...pool.filter(p => !quesIds.includes(p.id)).map(p => p.id), quesIds[0], quesIds[1]]);
  for (const p of pool) {
    if (!played.has(p.id)) continue;
    await db.run(`INSERT INTO historical_games (player_name, player_key, team, opponent, game_date, minutes, season)
      VALUES (?, ?, ?, ?, ?, 30, '2026-27')`, p.name, p.name.toLowerCase(), p.team, p.opponent, OLD);
  }
  // Backtest night: Player 1 QUES, Player 2 DOUBT
  await seedPast('past', PAST, tagged(tagged(pool, 'QUES', [1]), 'DOUBT', [2]));
  await seedLiveSlate('tonight', TODAY, tagged(pool, 'QUES', [1]));
});

describe('loadSlatePlayers with the injury discount', () => {
  test('calibration rows: one per player-night, played from box scores', async () => {
    const rows = await riskService.calibrationRows({ before: PAST });
    assert.equal(rows.length, 32);
    const ques = rows.filter(r => r.tag === 'QUES');
    assert.ok(ques.length >= 16);
    assert.equal(ques.filter(r => r.played).length, 2);
  });

  test('backtest: as-of table (nights before the slate only)', async () => {
    const source = await slateSource.resolveSlate({ slateDate: PAST, now: new Date(`${TODAY}T16:00:00Z`) });
    let summary = null;
    const players = await slateSource.loadSlatePlayers(source, { onInjuryRisk: (s) => { summary = s; } });
    const p1 = players.find(p => p.name === 'Player 1');
    const table = await riskService.tableFor(source);
    assert.equal(table.before, PAST);
    const expected = table.tags.QUES.bands['5k+'].p_play;
    assert.ok(expected < 0.68, 'the old night pulled QUES below the fallback');
    assert.equal(p1.injury_play_prob, expected);
    assert.ok(Math.abs(p1.projected_points - p1.projection_if_plays * expected) < 0.02);
    assert.equal(players.find(p => p.name === 'Player 2').injury_tag, 'DOUBT');
    assert.equal(summary.tagged, 2);
    assert.equal(summary.table, `as of ${PAST}`);
    // The old night itself has no earlier history: fallback rates
    const oldTable = await riskService.tableFor({ ...source, slateDate: OLD });
    assert.equal(oldTable.rows, 0);
  });

  test('live: committed table; off -> untouched', async () => {
    const source = await slateSource.resolveSlate({ slateId: 'tonight' });
    const on = (await slateSource.loadSlatePlayers(source)).find(p => p.name === 'Player 1');
    assert.equal(on.injury_tag, 'QUES');
    assert.ok(on.projected_points < on.projection_if_plays);
    const off = (await slateSource.loadSlatePlayers(source, { injuryRisk: false })).find(p => p.name === 'Player 1');
    assert.equal(off.projected_points, on.projection_if_plays);
    assert.equal(off.injury_risk, undefined);
    setting.setInjuryRiskEnabled(false);
    const viaSetting = (await slateSource.loadSlatePlayers(source)).find(p => p.name === 'Player 1');
    assert.equal(viaSetting.projected_points, on.projection_if_plays);
  });
});

describe('GET / PUT /api/projections/injury-risk', () => {
  test('status, per-slate counts, toggle and reset', async () => {
    const r = await call('GET', '/api/projections/injury-risk');
    assert.equal(r.status, 200);
    assert.equal(r.body.enabled, true);
    assert.ok(r.body.table.playProbability.QUES.all > 0);
    const slate = await call('GET', '/api/projections/injury-risk?slateId=tonight');
    assert.equal(slate.body.slate.tagged, 1);
    assert.equal(slate.body.slate.table, 'committed');
    assert.equal((await call('PUT', '/api/projections/injury-risk', { enabled: false })).body.enabled, false);
    assert.equal((await call('GET', '/api/projections/injury-risk?slateId=tonight')).body.slate.enabled, false);
    assert.equal((await call('PUT', '/api/projections/injury-risk', { enabled: 'maybe' })).status, 400);
    const reset = await call('PUT', '/api/projections/injury-risk', { enabled: null });
    assert.equal(reset.body.enabled, true);
    assert.equal(reset.body.origin, 'default');
  });
});
