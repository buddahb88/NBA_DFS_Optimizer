import { test, describe, beforeAll as before } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { buildData, nameOf, poisonFrom, scheduleDates } from './helpers/modelEvalData.js';

// Services pull in the database module; keep it off the real DB
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nba-dfs-rates-v1-'));
let featureStore;
let evaluate;
let projectors;
let metrics;
let rates;
let playerKey;

before(async () => {
  process.env.DATABASE_TYPE = 'sqlite';
  process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');
  featureStore = await import('../src/services/modelEval/featureStore.js');
  evaluate = await import('../src/services/modelEval/evaluate.js');
  projectors = await import('../src/services/modelEval/projectors.js');
  metrics = await import('../src/services/modelEval/metrics.js');
  rates = await import('../src/services/modelEval/ratesV1.js');
  ({ playerKey } = await import('../src/utils/playerKey.js'));
});

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);
const SEASON2 = scheduleDates('2025-11-01', 20);
const D = SEASON2[12];
// The seeded teams play ~130 minutes (5 players), not 240
const MINUTES = { teamMinutes: 130 };
const SIMS = { sims: 200 };
const DK = () => ({ pts: 1, reb: 1.25, ast: 1.5, stl: 2, blk: 2, tov: -0.5, tpm: 0.5, doubleDouble: 1.5, tripleDouble: 3, bonusesStack: true });
const keyOf = (team, role) => playerKey(nameOf(team, role));

const projector = (name = 'rates_v1', options = {}) => ({ ...projectors.createProjector(name, { params: SIMS, minutesParams: MINUTES, ...options }), name });
const runDate = async (store, date, proj) => {
  const { rows } = await evaluate.runReplay(store, [proj], { from: date, to: date });
  return new Map(rows.map(r => [`${r.key}|${r.team}`, r.preds[proj.name]]));
};
const dateCtx = (store, date) => {
  const view = store.asOf(date);
  const day = store.gameDay(date);
  return { view, day: { teams: day.teams }, players: day.players.map(p => ({ ...evaluate.contextPlayer(p, view, day), slate: null })) };
};
const unfitted = () => projectors.createProjector('rates_v1', { params: SIMS }).model();

describe('rates_v1: no lookahead', () => {
  test('projections for D ignore every row on or after D (unfitted and fitted)', async () => {
    const data = buildData();
    const clean = featureStore.createFeatureStore(data);
    const poison = poisonFrom(data, D);
    // D's listings are same-day information and stay
    poison.statuses = poison.statuses.filter(r => r.game_date !== D);
    const poisoned = featureStore.createFeatureStore(poison);
    const a = await runDate(clean, D, projector());
    const b = await runDate(poisoned, D, projector());
    assert.ok(a.size >= 20);
    assert.deepEqual([...b], [...a]);

    // Fitted on each store's rows before D: same coefficients and projections
    const fit = (s) => rates.fitRatesV1(s.restrictTo(D), { params: { ...rates.DEFAULT_PARAMS, ...SIMS }, contextPlayer: evaluate.contextPlayer });
    const fitA = fit(clean);
    const fitB = fit(poisoned);
    assert.ok(fitA.fitInfo.rows > 200);
    assert.deepEqual(fitB.coef, fitA.coef);
    assert.deepEqual(fitB.dispersion, fitA.dispersion);
    const fa = await runDate(clean, D, projector('rates_v1', { model: fitA }));
    const fb = await runDate(poisoned, D, projector('rates_v1', { model: fitB }));
    assert.deepEqual([...fb], [...fa]);
    // The poison has teeth: a later date changes
    const later = SEASON2[15];
    assert.notDeepEqual([...await runDate(poisoned, later, projector())], [...await runDate(clean, later, projector())]);
  });

  test('every new feature reads history before the date only', () => {
    const data = buildData();
    const clean = featureStore.createFeatureStore(data);
    const poisoned = featureStore.createFeatureStore(poisonFrom(data, D));
    const ctxA = dateCtx(clean, D);
    const ctxB = dateCtx(poisoned, D);
    const out = [{ key: keyOf('AAA', 'Star'), expectedMinutes: 36 }];
    for (const [v, ctx] of [[clean.asOf(D), ctxA], [poisoned.asOf(D), ctxB]]) ctx.out = out;
    // archetype defense (per-stat deltas), base rates, environment, usage / splits
    assert.deepEqual(poisoned.asOf(D).archetypeDefense().rows, clean.asOf(D).archetypeDefense().rows);
    const key = keyOf('BBB', 'Wing');
    assert.deepEqual(rates.baseRates(poisoned.asOf(D), key, { team: 'BBB' }), rates.baseRates(clean.asOf(D), key, { team: 'BBB' }));
    assert.deepEqual(rates.gameEnvironment(poisoned.asOf(D), 'AAA', 'BBB'), rates.gameEnvironment(clean.asOf(D), 'AAA', 'BBB'));
    const usage = (s, ctx) => {
      const view = s.asOf(D);
      const baseOf = (k, team) => ({ ...rates.baseRates(view, k, { team }), archetype: 'x' });
      return rates.usageFeatures(view, 'AAA', ctx.players.filter(p => p.team === 'AAA' && p.key !== out[0].key), out, ctx.players, baseOf);
    };
    assert.deepEqual([...usage(poisoned, ctxB)], [...usage(clean, ctxA)]);
    const pa = rates.projectRates(ctxA, unfitted());
    const pb = rates.projectRates(ctxB, unfitted());
    assert.deepEqual([...pb].map(([k, v]) => [k, v.rates, v.features]), [...pa].map(([k, v]) => [k, v.rates, v.features]));
  });
});

describe('rates_v1: base rates', () => {
  const view = (data, date = D) => featureStore.createFeatureStore(data).asOf(date);
  const recent = (date) => SEASON2.indexOf(date) >= SEASON2.indexOf(D) - 5 && date < D;

  test('a hot shooting stretch barely moves the points rate; more shots move it (the Rui problem)', () => {
    const key = keyOf('AAA', 'Wing');
    const base = rates.baseRates(view(buildData()), key, { team: 'AAA' });
    // Same shots, 60% more points in the last 5 games
    const hot = buildData();
    for (const g of hot.games) if (g.player_key === key && recent(g.game_date)) g.points = Math.round(g.points * 1.6);
    const h = rates.baseRates(view(hot), key, { team: 'AAA' });
    // 60% more shots and points
    const volume = buildData();
    for (const g of volume.games) {
      if (g.player_key !== key || !recent(g.game_date)) continue;
      g.points = Math.round(g.points * 1.6);
      g.fg_attempted = Math.round(g.fg_attempted * 1.6);
    }
    const v = rates.baseRates(view(volume), key, { team: 'AAA' });
    const hotGain = h.rates.pts / base.rates.pts - 1;
    const volumeGain = v.rates.pts / base.rates.pts - 1;
    // Both are diluted by a long history; shooting less than volume, and the regression sees the two apart
    assert.ok(hotGain > 0 && hotGain < 0.1, `hot shooting moved the base ${hotGain}`);
    assert.ok(volumeGain > 1.5 * hotGain, `volume ${volumeGain} vs hot ${hotGain}`);
    // and the shooting form is visible to the regression separately from volume
    assert.ok(h.form.ptsEff > base.form.ptsEff + 0.1);
    close(h.form.tsa, base.form.tsa);
    assert.ok(v.form.tsa > base.form.tsa + 0.1);
  });

  test('small samples shrink to the prior; last season counts through the discount', () => {
    const prior = { tsa: 0.2, fg3a: 0.1, reb: 1, ast: 0.1, stl: 0.03, blk: 0.02, tov: 0.05, ts: 0.55, fg3pct: 0.35 };
    const s = featureStore.createFeatureStore(buildData());
    const key = keyOf('AAA', 'Deep');
    // Opening night of season 2: only last season (discounted), so the prior's pull is stronger than mid-season
    const early = rates.baseRates(s.asOf(SEASON2[0]), key, { team: 'AAA', prior });
    const later = rates.baseRates(s.asOf(D), key, { team: 'AAA', prior });
    const none = rates.baseRates(s.asOf(SEASON2[0]), key, { team: 'AAA', prior }, { ...rates.DEFAULT_PARAMS, seasonDiscount: 0 });
    assert.ok(early.minutes < later.minutes);
    close(none.minutes, 0);
    close(none.rates.reb, 1); // no games count: the prior
    assert.ok(early.rates.reb < 1 && early.rates.reb > 0.1);
    // A rookie is the prior
    const rookie = rates.baseRates(s.asOf(D), 'nobody', { prior });
    close(rookie.rates.reb, 1);
    assert.equal(rookie.games, 0);
  });

  test('team change and role change are flagged', () => {
    const data = buildData();
    const key = keyOf('AAA', 'Sixth');
    for (const g of data.games) if (g.player_key === key && recent(g.game_date)) g.is_starter = 1;
    const s = featureStore.createFeatureStore(data);
    const b = rates.baseRates(s.asOf(D), key, { team: 'CCC' });
    assert.equal(b.teamChanged, 1);
    assert.equal(b.role, 1);
    assert.ok(b.roleShift > 0.7);
  });
});

describe('rates_v1: context', () => {
  test('pace and scoring environment from as-of ratings; the implied total overrides scoring', () => {
    const s = featureStore.createFeatureStore(buildData());
    const view = s.asOf(D);
    // AAA plays 6 possessions faster than everyone
    const fast = rates.gameEnvironment(view, 'AAA', 'BBB');
    const slow = rates.gameEnvironment(view, 'CCC', 'DDD');
    assert.ok(fast.logPace > slow.logPace);
    const vegas = rates.gameEnvironment(view, 'CCC', 'DDD', 140);
    assert.ok(vegas.logEnv > slow.logEnv + 0.1);
    close(vegas.logPace, slow.logPace);
  });

  test('OUT teammate: freed usage goes to those who play, in proportion to their rate; splits measured', () => {
    const out = new Set(SEASON2.slice(4, 10));
    const star = keyOf('AAA', 'Star');
    const data = buildData({ skip: (name, date) => (name === nameOf('AAA', 'Star') && out.has(date) ? 'missing' : null) });
    // Without the star, the Sixth man scored twice as much per minute
    for (const g of data.games) if (g.player_name === nameOf('AAA', 'Sixth') && out.has(g.game_date)) g.points *= 2;
    const s = featureStore.createFeatureStore(data);
    const view = s.asOf(D);
    const ctx = dateCtx(s, D);
    const todays = ctx.players.filter(p => p.team === 'AAA' && p.key !== star);
    const baseOf = (k, team) => rates.baseRates(view, k, { team });
    const u = rates.usageFeatures(view, 'AAA', todays, [{ key: star, expectedMinutes: 36 }], ctx.players, baseOf);
    const sixth = u.get(keyOf('AAA', 'Sixth'));
    const wing = u.get(keyOf('AAA', 'Wing'));
    assert.ok(sixth.usage.pts > 0.05, `usage ${sixth.usage.pts}`);
    // Proportional to rate x minutes: the same relative bump for everyone (sameGroupWeight 1)
    close(sixth.usage.reb, wing.usage.reb, 1e-9);
    // log(2) x presence (the star played 4 of the team's last 10), shrunk
    assert.ok(sixth.split.pts > 0.1 && sixth.split.pts < 0.4 * Math.log(2), `split ${sixth.split.pts}`);
    assert.ok(Math.abs(wing.split.pts) < 0.1);
    // An OUT player who has not played lately frees nothing (his absence is in everyone's recent games)
    const gone = buildData({ skip: (name, date) => (name === nameOf('AAA', 'Star') && date >= SEASON2[2] ? 'missing' : null) });
    const g = featureStore.createFeatureStore(gone);
    const gv = g.asOf(D);
    const none = rates.usageFeatures(gv, 'AAA', todays, [{ key: star, expectedMinutes: 36 }], ctx.players, (k, team) => rates.baseRates(gv, k, { team }));
    assert.equal(none.size, 0);
  });

  test('opponent defense: allowing more of a stat to the archetype raises it', () => {
    const s = featureStore.createFeatureStore(buildData());
    const view = s.asOf(D);
    const model = unfitted();
    const ctx = dateCtx(s, D);
    const preds = rates.projectRates(ctx, model);
    // The as-of table holds per-stat deltas the features read
    const rows = view.archetypeDefense().rows;
    assert.ok(rows.length > 0 && rows.every(r => 'pts_delta' in r && 'stocks_delta' in r));
    const defense = [...preds.values()].map(p => p.features.defense.pts);
    assert.ok(defense.some(v => v !== 0));
    assert.ok(defense.every(v => Math.abs(v) <= Math.log(1.4) + 1e-9));
  });
});

describe('rates_v1: distributions', () => {
  test('DK points with stacking double- / triple-double bonuses', () => {
    const line = { pts: 20, reb: 10, ast: 10, stl: 1, blk: 0, tov: 3, fg3m: 2 };
    close(rates.fantasyPoints(line, DK()), 20 + 12.5 + 15 + 2 - 1.5 + 1 + 1.5 + 3);
    close(rates.fantasyPoints({ ...line, ast: 9 }, DK()), 20 + 12.5 + 13.5 + 2 - 1.5 + 1 + 1.5);
    close(rates.fantasyPoints({ ...line, ast: 9 }, { ...DK(), bonusesStack: false }), 20 + 12.5 + 13.5 + 2 - 1.5 + 1 + 1.5);
  });

  test('samplers: Poisson and gamma means', () => {
    const rand = metrics.mulberry32(3);
    const pois = (l) => Array.from({ length: 4000 }, () => rates.poisson(rand, l)).reduce((s, v) => s + v, 0) / 4000;
    close(pois(0.4), 0.4, 0.05);
    close(pois(8), 8, 0.2);
    close(pois(45), 45, 0.5);
    const gam = Array.from({ length: 4000 }, () => rates.gamma(rand, 0.5)).reduce((s, v) => s + v, 0) / 4000;
    close(gam, 0.5, 0.05);
  });

  test('simulation: means follow rates x minutes, seeded, DD probability rises with the rates', () => {
    const r = { pts: 0.7, reb: 0.3, ast: 0.2, stl: 0.03, blk: 0.02, tov: 0.06, fg3m: 0.08 };
    const disp = rates.defaultDispersion();
    const a = rates.simulate(r, disp, () => 34, { sims: 3000, seed: 5, scoring: DK() });
    const b = rates.simulate(r, disp, () => 34, { sims: 3000, seed: 5, scoring: DK() });
    assert.deepEqual(a, b);
    close(a.stats.pts, 0.7 * 34, 0.6);
    close(a.stats.reb, 0.3 * 34, 0.3);
    const big = rates.simulate({ ...r, reb: 0.45 }, disp, () => 34, { sims: 3000, seed: 5, scoring: DK() });
    assert.ok(big.dd > a.dd + 0.1);
    // DNP draws score 0
    const dnp = rates.simulate(r, disp, () => 0, { sims: 50, seed: 1, scoring: DK() });
    assert.ok(dnp.dk.every(v => v === 0));
  });

  test('minutes elasticity: rates scale with minutes vs typical', () => {
    const r = { pts: 0.5, reb: 0.2, ast: 0.1, stl: 0.03, blk: 0.02, tov: 0.05, fg3m: 0.05 };
    const e = { pts: 0.2, reb: 0, ast: 0, stl: 0, blk: 0, tov: 0, fg3m: 0 };
    close(rates.ratesAt(r, 30, e, 30).pts, 0.5);
    close(rates.ratesAt(r, 40, e, 20).pts, 0.5 * 2 ** 0.2);
    close(rates.ratesAt(r, 40, e, 20).reb, 0.2);
    assert.equal(rates.ratesAt(r, 40, null, 20), r);
  });

  test('fitPoisson recovers coefficients with an offset', () => {
    const rand = metrics.mulberry32(11);
    const X = [], y = [], off = [];
    for (let i = 0; i < 3000; i++) {
      const x = rand() * 2 - 1;
      const m = 10 + rand() * 30;
      X.push([1, x]);
      off.push(Math.log(m));
      y.push(rates.poisson(rand, m * Math.exp(-1 + 0.5 * x)));
    }
    const b = rates.fitPoisson(X, y, off);
    close(b[0], -1, 0.05);
    close(b[1], 0.5, 0.05);
  });
});

describe('rates_v1: projector', () => {
  test('replay: every field; ranges ordered; OUT projects 0; boom threshold', async () => {
    const s = featureStore.createFeatureStore(buildData());
    const preds = await runDate(s, D, projector());
    for (const p of preds.values()) {
      assert.ok(p.p10 <= p.dk_points + 1e-9 && p.dk_points <= p.p90 + 1e-9, JSON.stringify(p));
      assert.ok(p.p_play > 0 && p.p_play < 1);
      assert.ok(p.p_dd >= 0 && p.p_dd <= 1 && p.p_td <= p.p_dd);
      assert.equal(p.boom_at, rates.DEFAULT_PARAMS.boomPoints);
      assert.ok(p.p_boom >= 0 && p.p_boom <= 1);
      assert.ok(Object.keys(p.stats).length === 7 && Object.keys(p.rates).length === 7);
      assert.ok(Number.isFinite(p.fppm) && p.typical_minutes > 0);
    }
    // The point: the DK median at minutes_v2's point minutes (same seed)
    const model = unfitted();
    for (const [k, p] of preds) {
      const at = p.minutes > 0 ? rates.atMinutes(p.rates, model.dispersion, p.minutes, { sims: SIMS.sims, seed: rates.seedOf(`${D}|${k.split('|')[0]}`), scoring: DK(), typical: p.typical_minutes }).median : 0;
      close(p.dk_points, at, 1e-9);
    }
    const proj = projector();
    const ctx = { ...dateCtx(s, D), shared: new Map(), mode: 'replay', date: D, site: 'draftkings' };
    await proj.prepareDate(ctx);
    const out = await proj.project({ ...ctx, player: { ...ctx.players[0], out: true } });
    assert.equal(out.dk_points, 0);
  });

  test('slates: RotoWire minutes variant uses those minutes; boom = 6x salary', async () => {
    const s = featureStore.createFeatureStore(buildData());
    const day = s.gameDay(D);
    const slate = {
      date: D, slateId: 'main',
      players: day.players.map(p => ({
        key: p.key, name: p.name, team: p.team, opponent: p.opponent, position: p.position, isHome: p.isHome, out: false,
        slate: { salary: 5000, rotowire: 20, rotowireMinutes: p.name.endsWith('Deep') ? 0 : 30, spread: -3, impliedTotal: 112 },
        outcome: { played: p.played, status: p.status, actual: p.actual, isStarter: p.isStarter }
      }))
    };
    const { rows } = await evaluate.runSlates(s, [projector('rates_v1_rotowire_minutes'), projector('rates_v1')], [slate]);
    for (const r of rows) {
      const p = r.preds.rates_v1_rotowire_minutes;
      assert.equal(p.boom_at, 30);
      if (r.name.endsWith('Deep')) { assert.equal(p.dk_points, 0); continue; }
      assert.equal(p.minutes, 30);
      assert.ok(p.dk_points > 0 && p.p10 <= p.p90);
      assert.equal(r.preds.rates_v1.boom_at, 30);
    }
  });

  test('rateQuality scores the rates at actual minutes against projectFppm x actual minutes', async () => {
    const s = featureStore.createFeatureStore(buildData());
    const proj = projector();
    await proj.fit({ store: s.restrictTo('2025-07-01'), seasons: ['2024-25'] });
    const { rows } = await evaluate.runReplay(s, [proj], { from: SEASON2[5], to: SEASON2[10] });
    const a = proj.analyze(rows, { name: 'rates_v1', site: 'draftkings', cluster: r => r.date, iterations: 50 });
    const q = a.rateQuality;
    assert.equal(q.n, rows.filter(r => r.played).length);
    assert.deepEqual(q.leaderboard.map(r => r.projector), ['rates', 'rates_flat', 'fppm', 'naive']);
    for (const r of q.leaderboard) assert.ok(r.mae > 0 && r.perMinuteError > 0);
    // fppm leaderboard row is exactly pred.fppm x actual minutes
    const fppmMae = rows.filter(r => r.played).reduce((t, r) => t + Math.abs(r.preds.rates_v1.fppm * r.actual.minutes - r.actual.dk), 0) / q.n;
    close(q.leaderboard[2].mae, Math.round(fppmMae * 1000) / 1000, 1e-9);
    assert.ok(q.stats.pts.rates > 0 && q.stats.pts.naive > 0);
    assert.ok(q.doubles.ddPredicted >= 0);
    assert.equal(q.paired[0].vs, 'fppm');
  });
});

describe('harness additions', () => {
  test('probability calibration buckets, Brier and base rate', () => {
    const samples = [{ p: 0.02, hit: false }, { p: 0.04, hit: true }, { p: 0.6, hit: true }, { p: 0.7, hit: false }, { p: null, hit: true }];
    const c = metrics.probabilityCalibration(samples);
    assert.equal(c.n, 4);
    assert.equal(c.observed, 2);
    close(c.brier, (0.02 ** 2 + 0.96 ** 2 + 0.4 ** 2 + 0.7 ** 2) / 4, 1e-4);
    assert.deepEqual(c.buckets.map(b => [b.bucket, b.n, b.observed]), [['0-0.05', 2, 0.5], ['0.5-1', 2, 0.5]]);
    assert.equal(metrics.probabilityCalibration([]), null);
  });

  test('scoreProjector: boom against the prediction\'s threshold, DD from the stat line', () => {
    const rows = [
      { actual: { dk: 45, pts: 30, reb: 12, ast: 3, stl: 0, blk: 0 }, preds: { p: { dk_points: 30, p_boom: 0.4, boom_at: 40, p_dd: 0.5, p_td: 0 } } },
      { actual: { dk: 20, pts: 10, reb: 3, ast: 3, stl: 0, blk: 0 }, preds: { p: { dk_points: 25, p_boom: 0.1, boom_at: 40, p_dd: 0.1, p_td: 0 } } }
    ];
    const s = metrics.scoreProjector(rows, 'p');
    assert.equal(s.boom.observed, 1);
    close(s.boom.predicted, 0.5);
    assert.equal(s.doubleDouble.observed, 1);
    assert.equal(s.tripleDouble.observed, 0);
  });

  test('pace tag and extra paired comparisons', async () => {
    const s = featureStore.createFeatureStore(buildData());
    const { rows } = await evaluate.runReplay(s, [projector(), { ...projectors.createProjector('season_avg'), name: 'season_avg' }], { from: D, to: D });
    assert.ok(rows.every(r => evaluate.PACE_BUCKETS.includes(r.tags.pace)));
    // AAA's games are fast (AAA plays 6 possessions faster)
    assert.ok(rows.filter(r => r.team === 'AAA' || r.team === 'BBB').every(r => r.tags.pace !== 'slow'));
    const summary = evaluate.summarizeRows(rows, ['rates_v1', 'season_avg'], { iterations: 20, comparisons: [['rates_v1', 'season_avg'], ['rates_v1', 'missing']] });
    assert.deepEqual(summary.withDnp.paired.map(p => [p.projector, p.vs]), [['rates_v1', 'season_avg']]);
    assert.ok(summary.withDnp.breakdowns.pace.length > 0);
  });
});
