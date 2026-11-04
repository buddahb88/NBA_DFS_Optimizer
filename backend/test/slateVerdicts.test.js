import { test, describe, vi, beforeAll as before, afterAll as after, beforeEach } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import { buildPlayerPool } from './fixtures/playerPool.js';

// GET /api/players/:slateId/verdicts on a temp DB (same fixture as the player
// card route test): every player's verdict equals his card's, backtests are as
// of the date (no leakage), the cache follows the data version and is cleared
// on a box-score sync, and a live slate agrees with its cards too.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nba-dfs-slate-verdicts-'));
process.env.DATABASE_TYPE = 'sqlite';
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');

const own = vi.hoisted(() => ({ fail: false, calls: 0 }));
vi.mock('../src/services/modelEval/ownModelService.js', () => ({
  projectSlateOwnModel: async (slateId, { source }) => {
    own.calls += 1;
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
const LIVE = '2026-11-05';
const LIVE_NOW = new Date(`${LIVE}T15:00:00Z`);
let db;
let server;
let baseUrl;
let cardService;
let verdictService;
let pool;

const get = async (url) => {
  const res = await fetch(`${baseUrl}${url}`);
  return { status: res.status, body: await res.json() };
};
const pick = (v) => ({ verdict: v.verdict, score: v.score, confidence: v.confidence });

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
  verdictService = await import('../src/services/playerCard/slateVerdicts.js');

  pool = buildPlayerPool();
  const toRow = (date) => (p) => ({
    playerId: `rw${p.id}`, name: p.name, team: p.team, opponent: p.opponent, position: p.position,
    salary: p.salary, projectedPoints: p.projected_points, projectedMinutes: 30, floor: p.floor, ceiling: p.ceiling,
    rostership: p.rostership, stdDev: 8, boomProbability: 10, bustProbability: 30, vegasImpliedTotal: 118, vegasSpread: -3,
    injuryStatus: p.name === 'Player 3' ? 'OUT' : null,
    rawData: JSON.stringify({ game: { dateTime: `${date} 19:30:00` }, isHome: true }),
  });
  // Saved 10/28 slate (backtest)
  await db.run(`INSERT INTO slates (slate_id, name, sport, start_time, site) VALUES ('past', 'Main', 'NBA', '7:30 PM', 'draftkings')`);
  await playerModel.bulkCreateOrUpdate('past', pool.map(toRow(PAST)));
  await snapshots.snapshotSlate('past', { now: new Date(`${PAST}T15:00:00Z`) });
  await db.run('DELETE FROM players');
  await db.run('DELETE FROM slates');

  // Earlier saved slates for Player 1's salary history / track record
  for (const d of PRIOR.slice(-3)) {
    await db.run(`INSERT INTO slate_player_snapshots (snapshot_date, game_date, slate_id, site, player_key, player_name, salary, projected_points)
      VALUES (?, ?, 'old', 'draftkings', ?, 'Player 1', 9000, 40)`, d, d, playerKey('Player 1'));
  }

  // Box scores: before the night, the night itself, and after it
  const insertGame = (name, team, opp, date, fp, minutes) => db.run(`INSERT INTO historical_games
    (player_name, player_key, team, opponent, game_date, season, season_type, minutes, points, rebounds, assists, dk_fantasy_points, is_starter)
    VALUES (?, ?, ?, ?, ?, ?, 'regular', ?, 20, 5, 5, ?, 1)`, name, playerKey(name), team, opp, date, seasonForDate(date), minutes, fp);
  for (const p of pool.filter(x => x.name !== 'Player 32')) {
    for (const [i, d] of PRIOR.entries()) await insertGame(p.name, p.team, p.opponent, d, p.projected_points + (i % 3) - 1, 30 + (i % 2));
    await insertGame(p.name, p.team, p.opponent, PAST, p.name === 'Player 1' ? 61.5 : p.projected_points, 33);
    // After the backtest night: big minutes jumps that would move the minutes / consistency rules
    await insertGame(p.name, p.team, p.opponent, FUTURE, 99, 44);
    await insertGame(p.name, p.team, p.opponent, '2026-11-01', 95, 44);
  }

  // Live slate (no player_key on the rows: the history key comes from the name)
  await db.run(`INSERT INTO slates (slate_id, name, sport, start_time, site) VALUES ('live', 'Main', 'NBA', '7:30 PM', 'draftkings')`);
  await playerModel.bulkCreateOrUpdate('live', pool.map(toRow(LIVE)));

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
  verdictService.clearSlateVerdictCache();
});

describe('GET /api/players/:slateId/verdicts (backtest)', () => {
  test('one entry per slate player, keyed by slate row id, with cash / gpp / headline', async () => {
    const r = await get(`/api/players/past/verdicts?slateDate=${PAST}`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const b = r.body;
    assert.equal(b.slateId, 'past');
    assert.equal(b.slateDate, PAST);
    assert.equal(b.isBacktest, true);
    assert.ok(b.generatedAt);
    const entries = Object.entries(b.players);
    assert.equal(entries.length, pool.length);
    for (const [id, e] of entries) {
      assert.equal(String(e.id), id);
      for (const mode of ['cash', 'gpp']) {
        assert.ok(['Core play', 'Playable', 'Pivot', 'Fade'].includes(e[mode].verdict));
        assert.equal(typeof e[mode].score, 'number');
        assert.equal(typeof e[mode].confidence, 'number');
      }
      assert.equal(typeof e.headline, 'string');
      assert.equal(e.rules, undefined, 'compact by default');
    }
    const out = Object.values(b.players).find(e => e.name === 'Player 3');
    assert.equal(out.cash.verdict, 'Fade');
    assert.match(out.headline, /will not play/);
  });

  test('consistency: every player\'s verdict equals his player card\'s', async () => {
    const { body } = await get(`/api/players/past/verdicts?slateDate=${PAST}`);
    for (const [id, e] of Object.entries(body.players)) {
      const card = await get(`/api/players/past/card/${id}?slateDate=${PAST}`);
      assert.equal(card.status, 200);
      assert.deepEqual({ cash: e.cash, gpp: e.gpp }, { cash: pick(card.body.verdict.cash), gpp: pick(card.body.verdict.gpp) }, e.name);
    }
  });

  test('consistency holds when the own model fails (both degrade the same way)', async () => {
    own.fail = true;
    const { body } = await get(`/api/players/past/verdicts?slateDate=${PAST}`);
    assert.ok(body.warnings.some(w => /own model/.test(w)));
    const p1 = Object.values(body.players).find(e => e.name === 'Player 1');
    const card = await get(`/api/players/past/card/${p1.id}?slateDate=${PAST}`);
    assert.deepEqual({ cash: p1.cash, gpp: p1.gpp }, { cash: pick(card.body.verdict.cash), gpp: pick(card.body.verdict.gpp) });
  });

  test('as of the date: games on or after the night never change a backtest verdict', async () => {
    const before = (await get(`/api/players/past/verdicts?slateDate=${PAST}&detail=true`)).body;
    const saved = await db.all('SELECT * FROM historical_games WHERE game_date >= ?', PAST);
    assert.ok(saved.length > 0);
    await db.run('DELETE FROM historical_games WHERE game_date >= ?', PAST);
    try {
      const without = (await get(`/api/players/past/verdicts?slateDate=${PAST}&detail=true`)).body;
      assert.equal(without.cached, false, 'data changed -> recomputed');
      assert.notEqual(without.dataVersion, before.dataVersion);
      for (const [id, e] of Object.entries(before.players)) {
        assert.deepEqual(without.players[id].rules, e.rules, e.name);
        assert.deepEqual(without.players[id].cash, e.cash, e.name);
        assert.deepEqual(without.players[id].gpp, e.gpp, e.name);
      }
    } finally {
      const cols = Object.keys(saved[0]);
      for (const row of saved) {
        await db.run(`INSERT INTO historical_games (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, ...cols.map(c => row[c]));
      }
    }
  });

  test('detail=true adds projection numbers and the rule list', async () => {
    const { body } = await get(`/api/players/past/verdicts?slateDate=${PAST}&detail=true`);
    const p1 = Object.values(body.players).find(e => e.name === 'Player 1');
    assert.equal(p1.projection.rotowire - p1.projection.ours, 6.5);
    assert.ok(p1.rules.some(r => r.key === 'fade'));
  });

  test('errors: bad projectionSource 400, no saved slate 404', async () => {
    assert.equal((await get(`/api/players/past/verdicts?slateDate=${PAST}&projectionSource=nope`)).status, 400);
    assert.equal((await get('/api/players/past/verdicts?slateDate=2026-01-01')).status, 404);
  });
});

describe('slate verdict cache', () => {
  test('second request is served from the cache, computed once', async () => {
    const first = await get(`/api/players/past/verdicts?slateDate=${PAST}`);
    const calls = own.calls;
    const second = await get(`/api/players/past/verdicts?slateDate=${PAST}`);
    assert.equal(first.body.cached, false);
    assert.equal(second.body.cached, true);
    assert.equal(own.calls, calls, 'no recompute');
    assert.deepEqual(second.body.players, first.body.players);
  });

  test('concurrent requests share one computation', async () => {
    const calls = own.calls;
    const [a, b] = await Promise.all([
      verdictService.getSlateVerdicts({ slateId: 'past', slateDate: PAST }),
      verdictService.getSlateVerdicts({ slateId: 'past', slateDate: PAST }),
    ]);
    assert.equal(own.calls - calls, 1);
    assert.deepEqual(a.players, b.players);
  });

  test('a projection source is its own cache entry', async () => {
    const rw = await get(`/api/players/past/verdicts?slateDate=${PAST}&projectionSource=rotowire`);
    const blend = await get(`/api/players/past/verdicts?slateDate=${PAST}&projectionSource=blend`);
    assert.equal(rw.body.projectionSource, 'rotowire');
    assert.equal(blend.body.projectionSource, 'blend');
    assert.equal(blend.body.cached, false);
  });

  test('new box scores change the data version: the next request recomputes', async () => {
    const first = await get(`/api/players/past/verdicts?slateDate=${PAST}`);
    const { playerKey } = await import('../src/utils/playerKey.js');
    await db.run(`INSERT INTO historical_games (player_name, player_key, team, opponent, game_date, season, season_type, minutes, dk_fantasy_points)
      VALUES ('Someone', ?, 'ZZZ', 'YYY', '2026-11-02', '2026-27', 'regular', 10, 5)`, playerKey('Someone'));
    const second = await get(`/api/players/past/verdicts?slateDate=${PAST}`);
    assert.equal(second.body.cached, false);
    assert.notEqual(second.body.dataVersion, first.body.dataVersion);
  });

  test('clearSlateVerdictCache and a finished box-score sync drop the cache', async () => {
    await get(`/api/players/past/verdicts?slateDate=${PAST}`);
    verdictService.clearSlateVerdictCache();
    assert.equal((await get(`/api/players/past/verdicts?slateDate=${PAST}`)).body.cached, false);
    assert.equal((await get(`/api/players/past/verdicts?slateDate=${PAST}`)).body.cached, true);
    const syncRuns = (await import('../src/services/syncRunService.js')).default;
    const id = await syncRuns.start({ source: 'test' });
    await syncRuns.finish(id, { gamesInserted: 0 });
    assert.equal((await get(`/api/players/past/verdicts?slateDate=${PAST}`)).body.cached, false);
  });
});

describe('live slate', () => {
  test('every live player\'s verdict equals his card\'s, history read by name key', async () => {
    const r = await verdictService.getSlateVerdicts({ slateId: 'live', now: LIVE_NOW, detail: true });
    assert.equal(r.isBacktest, false);
    assert.equal(Object.keys(r.players).length, pool.length);
    const p1 = Object.values(r.players).find(e => e.name === 'Player 1');
    assert.ok(p1.rules.some(rule => rule.key === 'minutes_trend'), 'history found for live rows (the 44-minute games)');
    for (const [id, e] of Object.entries(r.players)) {
      const card = await cardService.getPlayerCard({ slateId: 'live', playerId: id, now: LIVE_NOW });
      assert.deepEqual({ cash: e.cash, gpp: e.gpp }, { cash: pick(card.verdict.cash), gpp: pick(card.verdict.gpp) }, e.name);
    }
  });
});
