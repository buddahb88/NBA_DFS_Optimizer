import { test, describe, beforeAll as before } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { buildData, nameOf, poisonFrom, scheduleDates } from './helpers/modelEvalData.js';

// Services pull in the database module; keep it off the real DB
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nba-dfs-minutes-v2-'));
let featureStore;
let evaluate;
let projectors;
let v2;
let playerKey;

before(async () => {
  process.env.DATABASE_TYPE = 'sqlite';
  process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');
  featureStore = await import('../src/services/modelEval/featureStore.js');
  evaluate = await import('../src/services/modelEval/evaluate.js');
  projectors = await import('../src/services/modelEval/projectors.js');
  v2 = await import('../src/services/modelEval/minutesV2.js');
  ({ playerKey } = await import('../src/utils/playerKey.js'));
});

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);
const SEASON1 = scheduleDates('2024-11-01', 20);
const SEASON2 = scheduleDates('2025-11-01', 20);
const D = SEASON2[12];
// The seeded teams play ~130 minutes (5 players), not 240
const PARAMS = { teamMinutes: 130 };

const runDate = async (store, date, projector) => {
  const { rows } = await evaluate.runReplay(store, [projector], { from: date, to: date });
  return new Map(rows.map(r => [`${r.key}|${r.team}`, r.preds[projector.name]]));
};
const projector = (options = {}) => ({ ...projectors.createProjector('minutes_v2', { params: PARAMS, ...options }), name: 'minutes_v2' });
const dateCtx = (store, date, players = null) => {
  const view = store.asOf(date);
  const day = store.gameDay(date);
  return { view, day: { teams: day.teams }, players: players ?? day.players.map(p => ({ ...evaluate.contextPlayer(p, view, day), slate: null })) };
};

describe('minutes_v2: no lookahead', () => {
  test('projections for D ignore every row on or after D (unfitted and fitted)', async () => {
    const data = buildData();
    const clean = featureStore.createFeatureStore(data);
    // Outcomes on D and every row after it; D's listings are same-day information and stay
    const poison = poisonFrom(data, D);
    poison.statuses = poison.statuses.filter(r => r.game_date !== D);
    const poisoned = featureStore.createFeatureStore(poison);
    const a = await runDate(clean, D, projector());
    const b = await runDate(poisoned, D, projector());
    assert.ok(a.size >= 20);
    assert.deepEqual([...b], [...a]);

    // Fitted on the training window of each store: identical too (fit sees rows before D only)
    const fitA = v2.fitMinutesV2(clean.restrictTo(D), { params: { ...v2.DEFAULT_PARAMS, ...PARAMS } });
    const fitB = v2.fitMinutesV2(poisoned.restrictTo(D), { params: { ...v2.DEFAULT_PARAMS, ...PARAMS } });
    assert.deepEqual(fitB.cond, fitA.cond);
    const fa = await runDate(clean, D, projector({ model: fitA }));
    const fb = await runDate(poisoned, D, projector({ model: fitB }));
    assert.deepEqual([...fb], [...fa]);
    // The poison has teeth: a later date does change
    const later = SEASON2[15];
    assert.notDeepEqual([...await runDate(poisoned, later, projector())], [...await runDate(clean, later, projector())]);
  });

  test('features read only history before the date', () => {
    const store = featureStore.createFeatureStore(buildData());
    const view = store.asOf(D);
    const key = playerKey(nameOf('AAA', 'Star'));
    const f = v2.playerFeatures(view, { key, team: 'AAA', isB2B: false, isHome: true, seasonType: 'regular' });
    assert.equal(f.gamesCur, SEASON2.indexOf(D));
    assert.equal(f.games, SEASON1.length + SEASON2.indexOf(D));
  });
});

describe('minutes_v2: features', () => {
  const store = () => featureStore.createFeatureStore(buildData());
  const ctx = (name, team) => ({ key: playerKey(nameOf(team, name)), team, isB2B: false, isHome: true, seasonType: 'regular' });

  test('first game of a season: last season regular-season average; then this season takes over', () => {
    const s = store();
    const key = playerKey(nameOf('AAA', 'Wing'));
    const last = s.asOf(SEASON2[0]).playerGames(key).filter(g => g.season === '2024-25');
    const avg = last.reduce((t, g) => t + g.minutes, 0) / last.length;
    const f0 = v2.playerFeatures(s.asOf(SEASON2[0]), ctx('Wing', 'AAA'));
    close(f0.ewmL, avg);
    assert.equal(f0.gamesCur, 0);
    // Later: mostly this season's games (prior counts as priorSeasonGames games)
    const view = s.asOf(D);
    const cur = view.playerGames(key, { seasons: 'current' });
    const f = v2.playerFeatures(view, ctx('Wing', 'AAA'), {}, { ...v2.DEFAULT_PARAMS, priorSeasonGames: 0 });
    const w = cur.map((_, i) => 0.5 ** (i / v2.DEFAULT_PARAMS.halfLife));
    close(f.ewmL, cur.reduce((t, g, i) => t + w[i] * g.minutes, 0) / w.reduce((t, x) => t + x, 0));
  });

  test('role change: a bench player starting his last games shows st3 = 1 and a role shift, and projects more minutes', () => {
    const promoted = new Set(SEASON2.slice(9, 12));
    const data = buildData();
    for (const g of data.games) {
      if (g.player_name === nameOf('AAA', 'Sixth') && promoted.has(g.game_date)) Object.assign(g, { is_starter: 1, minutes: 34 });
    }
    const s = featureStore.createFeatureStore(data);
    const f = v2.playerFeatures(s.asOf(D), ctx('Sixth', 'AAA'));
    assert.equal(f.st3, 1);
    assert.ok(f.roleShift > 0.9);
    assert.ok(f.roleEst > 30, `start-conditional minutes ${f.roleEst}`);
    const before = featureStore.createFeatureStore(buildData());
    const a = v2.projectDate(dateCtx(s, D), { params: { ...v2.DEFAULT_PARAMS, ...PARAMS, normalization: 0 }, cond: fallbackCond(), play: fallbackPlay() });
    const b = v2.projectDate(dateCtx(before, D), { params: { ...v2.DEFAULT_PARAMS, ...PARAMS, normalization: 0 }, cond: fallbackCond(), play: fallbackPlay() });
    const k = `${playerKey(nameOf('AAA', 'Sixth'))}|AAA`;
    assert.ok(a.get(k).conditional_minutes > b.get(k).conditional_minutes + 5);
  });

  test('missed games, DNP listings and the appearance rate', () => {
    const missed = new Set(SEASON2.slice(8, 12));
    const s = featureStore.createFeatureStore(buildData({ skip: (name, date) => (name === nameOf('AAA', 'Deep') && missed.has(date) ? 'dnp' : null) }));
    const f = v2.playerFeatures(s.asOf(D), ctx('Deep', 'AAA'));
    assert.equal(f.missed, 4);
    assert.equal(f.returning, 1);
    close(f.dnp10, 0.4);
    close(f.appear10, 0.6);
    assert.equal(f.lastDnp, 1);
  });

  test('blowout risk: |expected margin| from the spread, else ratings', () => {
    const s = store();
    const f = v2.playerFeatures(s.asOf(D), ctx('Star', 'AAA'), { margin: s.asOf(D).expectedMargin('AAA', 'BBB', true, -14) });
    assert.equal(f.absMargin, 14);
  });
});

// Unfitted model: the projector's fallback coefficients
const fallbackCond = () => projectors.createProjector('minutes_v2').model().cond;
const fallbackPlay = () => projectors.createProjector('minutes_v2').model().play;

describe('minutes_v2: team minutes', () => {
  test('normalizeTeam hands the gap out by variance; p_play-weighted change equals the gap', () => {
    const params = { ...v2.DEFAULT_PARAMS, teamMinutes: 70, normalization: 1, splitWeight: 0 };
    const entries = [
      { cond: 30, pPlay: 1, sigma: 3 },
      { cond: 20, pPlay: 1, sigma: 3 },
      { cond: 10, pPlay: 0.5, sigma: 9 }
    ];
    const out = v2.normalizeTeam(entries, params);
    const gap = 70 - (30 + 20 + 5);
    close(entries.reduce((t, e, i) => t + e.pPlay * (out[i] - e.cond), 0), gap, 1e-9);
    // The uncertain player absorbs the most
    assert.ok(out[2] - 10 > out[0] - 30 && out[2] - 10 > out[1] - 20);
    // No normalization: unchanged
    assert.deepEqual(v2.normalizeTeam(entries, { ...params, normalization: 0 }), [30, 20, 10]);
    // A team over its total is cut, nobody below zero
    const cut = v2.normalizeTeam(entries, { ...params, teamMinutes: 40 });
    assert.ok(cut.every((m, i) => m <= entries[i].cond && m >= 0));
  });

  test('with/without splits steer the gap to whoever played more without the OUT player', () => {
    const out = new Set(SEASON2.slice(4, 10));
    const data = buildData({ skip: (name, date) => (name === nameOf('AAA', 'Star') && out.has(date) ? 'missing' : null) });
    for (const g of data.games) if (g.player_name === nameOf('AAA', 'Sixth') && out.has(g.game_date)) g.minutes = 36;
    const s = featureStore.createFeatureStore(data);
    const view = s.asOf(D);
    const cands = ['Wing', 'Big', 'Sixth', 'Deep'].map(r => ({ key: playerKey(nameOf('AAA', r)) }));
    const { gains, confidence } = v2.splitGains(view, 'AAA', cands, [{ key: playerKey(nameOf('AAA', 'Star')), expectedMinutes: 36 }]);
    assert.ok(gains.get(playerKey(nameOf('AAA', 'Sixth'))) > 8);
    assert.ok(gains.get(playerKey(nameOf('AAA', 'Wing'))) < 2);
    assert.ok(confidence > 0.5);
  });

  test('candidates: today\'s players, plus recent players who are not OUT or elsewhere; never last season\'s roster', () => {
    const s = featureStore.createFeatureStore(buildData({ skip: (name, date) => (name === nameOf('AAA', 'Deep') && date === D ? 'missing' : null) }));
    const view = s.asOf(D);
    const day = s.gameDay(D);
    const todays = day.players.filter(p => p.team === 'AAA');
    const deep = playerKey(nameOf('AAA', 'Deep'));
    const star = playerKey(nameOf('AAA', 'Star'));
    let keys = v2.teamCandidates(view, 'AAA', todays, new Set(), new Set()).map(c => c.key);
    assert.ok(keys.includes(deep), 'recent player not in the box score is a candidate');
    keys = v2.teamCandidates(view, 'AAA', todays, new Set([star, deep]), new Set()).map(c => c.key);
    assert.ok(!keys.includes(star) && !keys.includes(deep), 'OUT players are not');
    keys = v2.teamCandidates(view, 'AAA', todays.filter(p => p.key !== star), new Set(), new Set([star, deep])).map(c => c.key);
    assert.ok(!keys.includes(deep), 'playing for another team today');
    // Opening night: no games this season, so nobody from last season's roster is added
    const opener = s.asOf(SEASON2[0]);
    assert.deepEqual(v2.teamCandidates(opener, 'AAA', [], new Set(), new Set()), []);
  });

  test('slates: a regular missing from the pool is OUT and his teammates gain minutes', async () => {
    const day = (s) => s.gameDay(D);
    const s = featureStore.createFeatureStore(buildData());
    const slateFor = (drop) => ({
      date: D, slateId: 'main',
      players: day(s).players.filter(p => p.name !== drop).map((p, i) => ({
        key: p.key, name: p.name, team: p.team, opponent: p.opponent, position: p.position, isHome: p.isHome, out: false,
        slate: { salary: 4000 + 300 * i, rotowire: 20, rotowireMinutes: 30, spread: -3 },
        outcome: { played: p.played, status: p.status, actual: p.actual, isStarter: p.isStarter }
      }))
    });
    const run = async (drop) => {
      const { rows } = await evaluate.runSlates(s, [projector()], [slateFor(drop)]);
      return new Map(rows.map(r => [r.name, r.preds.minutes_v2]));
    };
    const full = await run(null);
    const without = await run(nameOf('AAA', 'Star'));
    assert.ok(without.get(nameOf('AAA', 'Wing')).conditional_minutes > full.get(nameOf('AAA', 'Wing')).conditional_minutes + 1);
    close(without.get(nameOf('CCC', 'Wing')).conditional_minutes, full.get(nameOf('CCC', 'Wing')).conditional_minutes, 1e-9);
  });
});

describe('minutes_v2: output', () => {
  test('mixture quantiles: DNP mass at 0, conditional above it', () => {
    const z = null;
    assert.equal(v2.mixtureQuantile(0.5, 0.4, 20, 5, z), 0);
    close(v2.mixtureQuantile(0.5, 1, 20, 5, z), 20, 0.01);
    assert.ok(v2.mixtureQuantile(0.5, 0.8, 20, 5, z) < 20);
    assert.ok(v2.mixtureQuantile(0.9, 1, 20, 5, z) > 25);
  });

  test('every field, ranges ordered, DK = minutes x FPPM; OUT projects 0', async () => {
    const s = featureStore.createFeatureStore(buildData());
    const preds = await runDate(s, D, projector());
    for (const p of preds.values()) {
      assert.ok(p.p_play > 0 && p.p_play < 1);
      assert.ok(p.minutes_p10 <= p.minutes && p.minutes <= p.minutes_p90 + 1e-9);
      assert.ok(p.p10 <= p.dk_points + 1e-9 && p.dk_points <= p.p90 + 1e-9);
      close(p.dk_points, p.minutes * p.fppm, 1e-9);
      close(p.expected_minutes, p.p_play * p.conditional_minutes, 1e-9);
      assert.equal(p.features, undefined);
    }
    const proj = projector();
    const ctx = { ...dateCtx(s, D), shared: new Map() };
    const player = { ...ctx.players[0], out: true };
    assert.deepEqual((await proj.project({ ...ctx, player })).minutes, 0);
  });

  test('slates: a player without history leans on the salary prior', () => {
    const s = featureStore.createFeatureStore(buildData());
    const ctx = dateCtx(s, D);
    const rookie = { key: 'new guy', name: 'New Guy', team: 'AAA', opponent: 'BBB', isHome: true, isB2B: false, seasonType: 'regular', out: false, slate: { salary: 8000, spread: -2 } };
    const players = [...ctx.players.map(p => ({ ...p, slate: { salary: 5000, spread: p.team === 'AAA' ? -2 : 2 } })), rookie];
    const preds = v2.projectDate({ ...ctx, players }, { params: { ...v2.DEFAULT_PARAMS, ...PARAMS, normalization: 0 }, cond: fallbackCond(), play: fallbackPlay() });
    close(preds.get('new guy|AAA').conditional_minutes, v2.salaryMinutes(8000), 1e-9);
    assert.equal(v2.salaryMinutes(8000), 30);
  });

  test('fit: coefficients and quantiles from training rows only', () => {
    // A player who never scores has FPPM 0, so a zero DK sigma: his residual must not poison the quantiles
    const data = buildData();
    for (const g of data.games) if (g.player_name === nameOf('DDD', 'Deep')) Object.assign(g, { dk_fantasy_points: 0, fd_fantasy_points: 0, yahoo_fantasy_points: 0 });
    const s = featureStore.createFeatureStore(data);
    const model = v2.fitMinutesV2(s.restrictTo('2025-07-01'), { params: { ...v2.DEFAULT_PARAMS, ...PARAMS } });
    assert.equal(model.fitInfo.dates, SEASON1.length);
    assert.equal(model.cond.length, v2.condVector(v2.playerFeatures(s.asOf(D), { key: 'x', team: 'AAA' })).length);
    assert.equal(model.zMinutes.length, 99);
    for (const zs of [model.zMinutes, model.zDk]) assert.ok(zs.every((z, i) => Number.isFinite(z) && (i === 0 || z >= zs[i - 1])), 'monotone quantiles');
  });

  test('fitLad recovers a median line; fitLogistic separates', () => {
    const X = [], y = [];
    for (let i = 0; i < 200; i++) { X.push([1, i / 10]); y.push(2 + 3 * (i / 10) + (i % 10 === 0 ? 50 : 0)); }
    const b = v2.fitLad(X, y);
    close(b[0], 2, 0.2);
    close(b[1], 3, 0.05);
    const Xl = [], yl = [];
    for (let i = 0; i < 200; i++) { Xl.push([1, (i - 100) / 20]); yl.push(i > 100 + ((i * 7) % 30) - 15 ? 1 : 0); }
    const l = v2.fitLogistic(Xl, yl);
    assert.ok(l[1] > 1);
  });
});
