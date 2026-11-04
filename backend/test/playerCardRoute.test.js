import { test, describe, vi, beforeAll as before, afterAll as after, beforeEach } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import { buildPlayerPool } from './fixtures/playerPool.js';

// GET /api/players/:slateId/card/:playerId on a temp DB: a saved backtest
// night (as-of, no leakage, actual result), the fade case from the own model
// (mocked, tested in M4), a rookie with no history, and a live slate.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nba-dfs-player-card-'));
process.env.DATABASE_TYPE = 'sqlite';
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');

const own = vi.hoisted(() => ({ fail: false }));
vi.mock('../src/services/modelEval/ownModelService.js', () => ({
  projectSlateOwnModel: async (slateId, { source }) => {
    if (own.fail) throw new Error('model unavailable');
    const { loadSlatePlayers } = await import('../src/services/slateSource.js');
    const players = await loadSlatePlayers(source, { includeZero: true, projectionSource: 'rotowire' });
    return {
      players: players.map(p => {
        const rw = Number(p.projected_points);
        const diff = p.name === 'Player 1' ? -6.5 : 0;
        const ours = rw + diff;
        return {
          id: p.id, name: p.name, rotowire_points: rw, ours_mean: ours, ours_median: ours - 0.5, p10: ours * 0.6, p90: ours * 1.4,
          p_boom: 0.1, boom_at: (p.salary / 1000) * 6, p_dd: 0.2, ours_minutes: 31, p_play: 0.97,
          blend_point: rw + diff / 2, blend_p10: (rw + diff / 2) * 0.6, blend_p90: (rw + diff / 2) * 1.4, blend_p_boom: 0.12,
          disagreement: {
            points_diff: diff, lean: diff <= -6 ? 'lower 6+' : 'agree', history: diff <= -6 ? { n: 77, hitRate: 0.688 } : null,
          },
        };
      }),
    };
  },
}));

const PAST = '2026-10-28';
const PRIOR = ['2026-10-20', '2026-10-22', '2026-10-23', '2026-10-24', '2026-10-25', '2026-10-26', '2026-10-27'];
const FUTURE = '2026-10-30';
let db;
let server;
let baseUrl;
let snapshotId;
let cardService;

const get = async (url) => {
  const res = await fetch(`${baseUrl}${url}`);
  return { status: res.status, body: await res.json() };
};

before(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  db = (await import('../src/config/database.js')).default;
  await (await import('../src/config/schema.js')).createTables(db);
  const playerModel = (await import('../src/models/playerModel.js')).default;
  const snapshots = await import('../src/services/slateSnapshotService.js');
  const { playerKey } = await import('../src/utils/playerKey.js');
  const { seasonForDate } = await import('../src/utils/season.js');
  cardService = await import('../src/services/playerCard/playerCardService.js');

  // Saved 10/28 slate; Player 32 is the rookie (no history)
  const pool = buildPlayerPool();
  const toRow = (p) => ({
    playerId: `rw${p.id}`, name: p.name, team: p.team, opponent: p.opponent, position: p.position,
    salary: p.salary, projectedPoints: p.projected_points, projectedMinutes: 30, floor: p.floor, ceiling: p.ceiling,
    rostership: p.rostership, stdDev: 8, boomProbability: 10, bustProbability: 30, vegasImpliedTotal: 118, vegasSpread: -3,
    injuryStatus: p.name === 'Player 3' ? 'OUT' : null,
    rawData: JSON.stringify({ game: { dateTime: `${PAST} 19:30:00` }, isHome: true }),
  });
  await db.run(`INSERT INTO slates (slate_id, name, sport, start_time, site) VALUES ('past', 'Main', 'NBA', '7:30 PM', 'draftkings')`);
  await playerModel.bulkCreateOrUpdate('past', pool.map(toRow));
  await snapshots.snapshotSlate('past', { now: new Date(`${PAST}T15:00:00Z`) });
  await db.run('DELETE FROM players');
  await db.run('DELETE FROM slates');
  snapshotId = (await db.get(`SELECT id FROM slate_player_snapshots WHERE player_name = 'Player 1' AND game_date = ?`, PAST)).id;

  // Earlier saved slates for Player 1's salary history / track record
  for (const d of PRIOR.slice(-3)) {
    await db.run(`INSERT INTO slate_player_snapshots (snapshot_date, game_date, slate_id, site, player_key, player_name, salary, projected_points)
      VALUES (?, ?, 'old', 'draftkings', ?, 'Player 1', 9000, 40)`, d, d, playerKey('Player 1'));
  }

  // Box scores: before the night, the night itself (actual), and after it (must never show)
  const insertGame = (name, team, opp, date, fp, minutes) => db.run(`INSERT INTO historical_games
    (player_name, player_key, team, opponent, game_date, season, season_type, minutes, points, rebounds, assists, dk_fantasy_points, is_starter)
    VALUES (?, ?, ?, ?, ?, ?, 'regular', ?, 20, 5, 5, ?, 1)`, name, playerKey(name), team, opp, date, seasonForDate(date), minutes, fp);
  for (const p of pool.filter(x => x.name !== 'Player 32')) {
    for (const [i, d] of PRIOR.entries()) await insertGame(p.name, p.team, p.opponent, d, p.projected_points + (i % 3) - 1, 30 + (i % 2));
    await insertGame(p.name, p.team, p.opponent, PAST, p.name === 'Player 1' ? 61.5 : p.projected_points, 33);
    await insertGame(p.name, p.team, p.opponent, FUTURE, 99, 48);
  }

  const app = express();
  app.use(express.json());
  app.use('/api/players', (await import('../src/routes/players.js')).default);
  await new Promise(resolve => { server = app.listen(0, resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  vi.restoreAllMocks();
  await new Promise(resolve => server.close(resolve));
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  own.fail = false;
  cardService.clearPlayerCardCache();
});

describe('GET /api/players/:slateId/card/:playerId (backtest)', () => {
  test('as of the slate date: no game from that night or later in history, actual result shown', async () => {
    const r = await get(`/api/players/past/card/${snapshotId}?slateDate=${PAST}`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const c = r.body;
    assert.equal(c.slate.isBacktest, true);
    assert.equal(c.slate.asOf, PAST);
    assert.equal(c.player.name, 'Player 1');
    assert.equal(c.player.team, 'AAA');
    assert.equal(c.player.is_home, true);

    const dates = c.form.log.map(g => g.date);
    assert.deepEqual(dates, PRIOR, 'game log is the games before the night, oldest first');
    assert.ok(dates.every(d => d < PAST));
    assert.ok(!JSON.stringify(c.form).includes('99'), 'no future fantasy points in form');
    assert.ok(c.trackRecord.recent.every(t => t.date < PAST));
    assert.equal(c.trackRecord.n, 3);

    // Salary of that night on the priced games (9000 -> 45 for 5x)
    const priced = c.form.log.filter(g => g.salary === 9000);
    assert.equal(priced.length, 3);
    assert.equal(priced[0].target, 45);

    assert.equal(c.actual.points, 61.5);
    assert.equal(c.actual.minutes, 33);
    assert.equal(c.actual.status, 'PLAYED');
    assert.equal(typeof c.actual.vs_projection, 'number');
  });

  test('fade case: ours 6.5 below RotoWire -> fade call, verdict reasons cite it', async () => {
    const { body: c } = await get(`/api/players/past/card/${snapshotId}?slateDate=${PAST}`);
    assert.equal(c.projection.fade.points_diff, -6.5);
    assert.equal(c.projection.fade.hit_rate, 0.688);
    assert.ok(c.projection.ours < c.projection.rotowire);
    assert.ok(c.verdict.reasonsAgainst.some(t => /below RotoWire/.test(t)));
    assert.ok(['Pivot', 'Fade', 'Playable'].includes(c.verdict.cash.verdict));
    assert.match(c.verdict.blurb, /trust the fade/);
  });

  test('the card is found by player_id and by player_key too', async () => {
    const byId = await get(`/api/players/past/card/rw1?slateDate=${PAST}`);
    assert.equal(byId.status, 200);
    assert.equal(byId.body.player.name, 'Player 1');
    const byKey = await get(`/api/players/past/card/${encodeURIComponent('player 2')}?slateDate=${PAST}`);
    assert.equal(byKey.body.player.name, 'Player 2');
  });

  test('rookie / no history: empty form and track record, low confidence, still a verdict', async () => {
    const r = await get(`/api/players/past/card/rw32?slateDate=${PAST}`);
    assert.equal(r.status, 200);
    const c = r.body;
    assert.deepEqual(c.form.log, []);
    assert.equal(c.form.l5, null);
    assert.equal(c.trackRecord.n, 0);
    assert.equal(c.role.current, null);
    assert.ok(c.verdict.cash.confidence <= 55);
    assert.ok(c.verdict.blurb.length > 0);
  });

  test('ruled-out player is a Fade; teammates out are listed on his teammates\' cards', async () => {
    const out = await get(`/api/players/past/card/rw3?slateDate=${PAST}`);
    assert.equal(out.body.verdict.cash.verdict, 'Fade');
    const mate = await get(`/api/players/past/card/rw2?slateDate=${PAST}`);
    assert.ok(mate.body.context.teammates_out.some(t => t.name === 'Player 3'));
  });

  test('own model failure degrades to a warning, RotoWire still shown', async () => {
    own.fail = true;
    const r = await get(`/api/players/past/card/${snapshotId}?slateDate=${PAST}`);
    assert.equal(r.status, 200);
    assert.equal(r.body.projection.ours, null);
    assert.ok(r.body.projection.rotowire > 0);
    assert.ok(r.body.meta.warnings.some(w => /own model/.test(w)));
  });

  test('errors: unknown player 404, bad projectionSource 400, no slate 404', async () => {
    assert.equal((await get(`/api/players/past/card/nobody?slateDate=${PAST}`)).status, 404);
    assert.equal((await get(`/api/players/past/card/${snapshotId}?slateDate=${PAST}&projectionSource=nope`)).status, 400);
    assert.equal((await get('/api/players/past/card/1?slateDate=2026-01-01')).status, 404);
  });
});
