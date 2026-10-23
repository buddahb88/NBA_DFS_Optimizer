import { test, describe, vi, beforeAll as before, beforeEach, afterAll as after } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { buildPlayerPool } from './fixtures/playerPool.js';

// Live players table vs saved snapshots: same shape, read-only past slates,
// separate player settings, actual points for backtests.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nba-dfs-slate-source-'));
process.env.DATABASE_TYPE = 'sqlite';
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');

const PAST = '2026-10-21';
const TODAY = '2026-10-23';
let db;
let source;
let snapshots;
let playerModel;
let playerSettingsModel;
let playerKey;

const raw = (date) => JSON.stringify({ game: { dateTime: `${date} 19:30:00` }, isHome: true });

async function seedLiveSlate(slateId, date, pool = buildPlayerPool()) {
  await db.run(`INSERT INTO slates (slate_id, name, sport, start_time, site) VALUES (?, 'Main', 'NBA', '7:30 PM', 'draftkings')`, slateId);
  await playerModel.bulkCreateOrUpdate(slateId, pool.map(p => ({
    playerId: `rw${p.id}`, name: p.name, team: p.team, opponent: p.opponent, position: p.position,
    salary: p.salary, projectedPoints: p.projected_points, projectedMinutes: 30, floor: p.floor, ceiling: p.ceiling,
    rostership: p.rostership, stdDev: 8, boomProbability: 10, bustProbability: 30, rawData: raw(date)
  })));
}

before(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  db = (await import('../src/config/database.js')).default;
  await (await import('../src/config/schema.js')).createTables(db);
  source = await import('../src/services/slateSource.js');
  snapshots = await import('../src/services/slateSnapshotService.js');
  playerModel = (await import('../src/models/playerModel.js')).default;
  playerSettingsModel = (await import('../src/models/playerSettingsModel.js')).default;
  ({ playerKey } = await import('../src/utils/playerKey.js'));
});

after(() => {
  vi.restoreAllMocks();
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const NOW = new Date(`${TODAY}T16:00:00Z`);

beforeEach(async () => {
  for (const t of ['players', 'slates', 'slate_player_snapshots', 'player_settings', 'historical_games']) {
    await db.run(`DELETE FROM ${t}`);
  }
  // 10/21 slate captured pre-lock, then tonight's slate synced over it
  await seedLiveSlate('past', PAST);
  await snapshots.snapshotSlate('past', { now: new Date(`${PAST}T15:00:00Z`) });
  await db.run(`DELETE FROM players`);
  await db.run(`DELETE FROM slates`);
  await seedLiveSlate('tonight', TODAY);
});

describe('resolveSlate', () => {
  test('a past date resolves to the saved snapshot slate', async () => {
    const s = await source.resolveSlate({ slateDate: PAST, now: NOW });
    assert.equal(s.mode, 'backtest');
    assert.equal(s.isBacktest, true);
    assert.equal(s.slateId, 'past');
    assert.equal(s.slateDate, PAST);
    assert.equal(s.site, 'draftkings');
    assert.equal(s.settingsKey, `backtest:${PAST}:past`);
    assert.match(s.label, /Backtest 2026-10-21/);
  });

  test('no arguments, the live slate id or today resolve to the live slate', async () => {
    for (const req of [{}, { slateId: 'tonight' }, { slateDate: TODAY }]) {
      const s = await source.resolveSlate({ ...req, now: NOW });
      assert.equal(s.mode, 'live');
      assert.equal(s.slateId, 'tonight');
      assert.equal(s.slateDate, TODAY);
      assert.equal(s.settingsKey, 'tonight');
    }
  });

  test('a slate id that is no longer live resolves to its latest snapshot', async () => {
    const s = await source.resolveSlate({ slateId: 'past', now: NOW });
    assert.equal(s.mode, 'backtest');
    assert.equal(s.slateDate, PAST);
  });

  test('unknown dates and bad input are errors', async () => {
    await assert.rejects(() => source.resolveSlate({ slateDate: '2026-10-01', now: NOW }), e => e.status === 404);
    await assert.rejects(() => source.resolveSlate({ slateDate: '2026-10-25', now: NOW }), e => e.status === 404);
    await assert.rejects(() => source.resolveSlate({ slateDate: '10/21', now: NOW }), e => e.status === 400);
  });
});

describe('loadSlatePlayers parity', () => {
  test('snapshot players have every players-table column, with the same values', async () => {
    const live = await source.loadSlatePlayers(await source.resolveSlate({ now: NOW }));
    const past = await source.loadSlatePlayers(await source.resolveSlate({ slateDate: PAST, now: NOW }));
    assert.equal(past.length, live.length);

    for (const key of Object.keys(live[0])) {
      assert.ok(key in past[0], `snapshot player lacks ${key}`);
    }
    const byName = new Map(live.map(p => [p.name, p]));
    for (const p of past) {
      const l = byName.get(p.name);
      for (const k of ['team', 'opponent', 'position', 'salary', 'projected_points', 'projected_minutes', 'floor',
        'ceiling', 'rostership', 'std_dev', 'boom_probability', 'bust_probability', 'roster_positions']) {
        assert.deepEqual(p[k], l[k], `${p.name}.${k}`);
      }
      assert.equal(typeof p.id, 'number');
      assert.equal(p.player_key, playerKey(p.name));
      assert.equal(p.game_date, PAST);
    }
    // Same ordering contract as playerModel.getBySlateId
    assert.deepEqual(past.map(p => p.name), live.map(p => p.name));
  });

  test('older snapshots without roster_positions derive them from position', async () => {
    await db.run(`UPDATE slate_player_snapshots SET roster_positions = NULL`);
    const past = await source.loadSlatePlayers(await source.resolveSlate({ slateDate: PAST, now: NOW }));
    const pg = past.find(p => p.position === 'PG');
    assert.equal(pg.roster_positions, 'PG/G/UTIL');
  });

  test('filters work like getBySlateId and players projected 0 are left out', async () => {
    await db.run(`UPDATE slate_player_snapshots SET projected_points = 0 WHERE id = (SELECT MIN(id) FROM slate_player_snapshots)`);
    const s = await source.resolveSlate({ slateDate: PAST, now: NOW });
    const all = await source.loadSlatePlayers(s);
    assert.equal(all.length, buildPlayerPool().length - 1);
    const cheap = await source.loadSlatePlayers(s, { filters: { maxSalary: 5000, position: 'C' } });
    assert.ok(cheap.length > 0);
    assert.ok(cheap.every(p => p.salary <= 5000 && p.position.includes('C')));
  });

  test('reading a backtest slate never writes to players', async () => {
    const before = await db.all(`SELECT * FROM players ORDER BY id`);
    await source.loadSlatePlayers(await source.resolveSlate({ slateDate: PAST, now: NOW }));
    assert.deepEqual(await db.all(`SELECT * FROM players ORDER BY id`), before);
  });
});

describe('player settings', () => {
  test('backtest settings are stored under their own key and never reach the live slate', async () => {
    const past = await source.resolveSlate({ slateDate: PAST, now: NOW });
    const live = await source.resolveSlate({ now: NOW });
    await playerSettingsModel.upsert(past.settingsKey, '1', { lock: true });
    assert.equal((await playerSettingsModel.getBySlateId(past.settingsKey)).length, 1);
    assert.equal((await playerSettingsModel.getBySlateId(live.settingsKey)).length, 0);
    assert.equal((await playerSettingsModel.getBySlateId('past')).length, 0);
  });
});

describe('actual results', () => {
  test('backtest players and lineups carry actual DK points; DNP scores 0', async () => {
    const s = await source.resolveSlate({ slateDate: PAST, now: NOW });
    const players = await source.loadSlatePlayers(s);
    const [a, b] = players;
    await db.run(`INSERT INTO historical_games (player_name, player_key, team, opponent, game_date, minutes, points, dk_fantasy_points)
      VALUES (?, ?, ?, ?, ?, 34, 20, 41.5)`, a.name, a.player_key, a.team, a.opponent, PAST);
    await db.run(`INSERT INTO historical_games (player_name, player_key, team, opponent, game_date, minutes, points, dk_fantasy_points)
      VALUES (?, ?, ?, ?, ?, 0, 0, 0)`, b.name, b.player_key, b.team, b.opponent, PAST);

    const scored = await source.withActuals(s, players);
    assert.equal(scored.find(p => p.id === a.id).actualPoints, 41.5);
    assert.equal(scored.find(p => p.id === a.id).resultStatus, 'PLAYED');
    assert.equal(scored.find(p => p.id === b.id).actualPoints, 0);
    assert.equal(scored.find(p => p.id === b.id).resultStatus, 'DNP');

    const [lineup] = await source.scoreLineups(s, [{ players: [{ position: 'PG', player: a }, { position: 'SG', player: b }] }], players);
    assert.equal(lineup.players[0].player.actualPoints, 41.5);
    assert.equal(lineup.actualPoints, 41.5);
  });

  test('players trimmed of player_key still get actuals (key falls back to the name)', async () => {
    const s = await source.resolveSlate({ slateDate: PAST, now: NOW });
    const [a] = await source.loadSlatePlayers(s);
    await db.run(`INSERT INTO historical_games (player_name, player_key, team, opponent, game_date, minutes, points, dk_fantasy_points)
      VALUES (?, ?, ?, ?, ?, 36, 30, 46.25)`, a.name, playerKey(a.name), a.team, a.opponent, PAST);
    const { player_key, ...trimmed } = a;
    const actuals = await source.loadActuals(s, [trimmed]);
    assert.deepEqual(actuals.get(a.id), { actualPoints: 46.25, actualMinutes: 36, resultStatus: 'PLAYED' });
  });

  test('live slates get no actuals', async () => {
    const s = await source.resolveSlate({ now: NOW });
    const players = await source.loadSlatePlayers(s);
    assert.deepEqual(await source.withActuals(s, players), players);
  });
});

describe('listBacktestSlates', () => {
  test('lists past saved slates newest first, not tonight', async () => {
    await snapshots.snapshotSlate('tonight', { now: NOW });
    const list = await source.listBacktestSlates({ now: NOW });
    assert.deepEqual(list.map(s => [s.slateDate, s.slateId]), [[PAST, 'past']]);
    assert.equal(list[0].players, buildPlayerPool().length);
  });
});

describe('GET /api/slates/backtests and /api/slates/source', () => {
  test('list past slates and resolve a request', async () => {
    const express = (await import('express')).default;
    const app = express();
    app.use('/api/slates', (await import('../src/routes/slates.js')).default);
    const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const base = `http://127.0.0.1:${server.address().port}/api/slates`;
    try {
      // Real clock: PAST is before today
      const list = await (await fetch(`${base}/backtests`)).json();
      assert.ok(list.some(s => s.slateDate === PAST && s.slateId === 'past'));

      const resolved = await (await fetch(`${base}/source?slateDate=${PAST}`)).json();
      assert.equal(resolved.isBacktest, true);
      assert.equal(resolved.slateId, 'past');
      assert.equal(resolved.settingsKey, `backtest:${PAST}:past`);

      const missing = await fetch(`${base}/source?slateDate=2020-01-01`);
      assert.equal(missing.status, 404);
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  });
});
