import { test, describe, beforeAll as before } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { buildData, poisonFrom, scheduleDates } from './helpers/modelEvalData.js';

// Services pull in the database module; keep it off the real DB
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nba-dfs-own-model-'));
let featureStore;
let evaluate;
let projectors;
let blend;
let own;

before(async () => {
  process.env.DATABASE_TYPE = 'sqlite';
  process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');
  featureStore = await import('../src/services/modelEval/featureStore.js');
  evaluate = await import('../src/services/modelEval/evaluate.js');
  projectors = await import('../src/services/modelEval/projectors.js');
  blend = await import('../src/services/modelEval/blend.js');
  own = await import('../src/services/modelEval/ownModel.js');
});

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);
const SEASON2 = scheduleDates('2025-11-01', 20);
const D = SEASON2[12];
const OPTIONS = { params: { sims: 200 }, minutesParams: { teamMinutes: 130 } };
const projector = (name = 'own_mean') => ({ ...projectors.createProjector(name, OPTIONS), name });

/** A saved-slate input from the store's box scores on `date` (RotoWire fields given per player). */
function slateFor(store, date, slateFields = () => ({}), slateId = 'main') {
  const day = store.gameDay(date);
  return {
    date, slateId,
    players: day.players.map(p => ({
      key: p.key, name: p.name, team: p.team, opponent: p.opponent, position: p.position, isHome: p.isHome, out: false,
      slate: { salary: 5000, rotowire: 20, rotowireMinutes: 30, adjusted: 20, adjustedMinutes: 30, spread: -3, impliedTotal: 112, ...slateFields(p) },
      outcome: { played: p.played, status: p.status, actual: p.actual, isStarter: p.isStarter }
    }))
  };
}

describe('own_mean projector', () => {
  test('point = mixture mean incl. DNP; quantiles, minutes-blend means, OUT = 0', async () => {
    const store = featureStore.createFeatureStore(buildData());
    const slate = slateFor(store, D, (p) => ({ rotowireMinutes: p.name.endsWith('Deep') ? 0 : 30 }));
    slate.players[0].out = true;
    const { rows } = await evaluate.runSlates(store, [projector(), projector('rates_v1')], [slate]);
    for (const r of rows) {
      const p = r.preds.own_mean;
      if (r.key === slate.players[0].key && r.team === slate.players[0].team) {
        assert.equal(p.dk_points, 0);
        assert.ok(p.minutes_blend_means.every(v => v === 0));
        continue;
      }
      // Same rates and minutes as rates_v1: its point is our median, its dk_mean our point
      close(p.dk_points, r.preds.rates_v1.dk_mean, 1e-9);
      close(p.ours_median, r.preds.rates_v1.dk_points, 1e-9);
      assert.equal(p.dk_quantiles.length, own.QUANTILE_LEVELS.length);
      for (let i = 1; i < p.dk_quantiles.length; i++) assert.ok(p.dk_quantiles[i] >= p.dk_quantiles[i - 1]);
      close(p.dk_quantiles[10], p.p10, 1e-9);
      close(p.dk_quantiles[90], p.p90, 1e-9);
      assert.equal(p.minutes_blend_means.length, own.MINUTES_BLEND_GRID.length);
      close(p.minutes_blend_means[0], p.dk_points, 1e-9);
      if (r.name.endsWith('Deep')) close(p.minutes_blend_means[10], 0, 1e-9); // RotoWire: 0 minutes
      assert.equal(p.boom_at, 30);
    }
  });

  test('no lookahead: projections for D ignore every row on or after D', async () => {
    const data = buildData();
    const clean = featureStore.createFeatureStore(data);
    const poison = poisonFrom(data, D);
    poison.statuses = poison.statuses.filter(r => r.game_date !== D);
    const poisoned = featureStore.createFeatureStore(poison);
    // The slate's players and outcomes come from the clean store: only history may differ
    const slate = slateFor(clean, D);
    const a = await evaluate.runSlates(clean, [projector()], [slate]);
    const b = await evaluate.runSlates(poisoned, [projector()], [slate]);
    assert.ok(a.rows.length >= 20);
    assert.deepEqual(b.rows.map(r => r.preds), a.rows.map(r => r.preds));
    const later = slateFor(clean, SEASON2[15]);
    const c = await evaluate.runSlates(clean, [projector()], [later]);
    const d = await evaluate.runSlates(poisoned, [projector()], [later]);
    assert.notDeepEqual(d.rows.map(r => r.preds), c.rows.map(r => r.preds));
  });

  test('slateDay: a live slate (no box scores yet) gets every team and its pool-inferred OUTs', () => {
    const store = featureStore.createFeatureStore(buildData());
    const day = store.gameDay(D);
    const future = '2026-01-15';
    // AAA's star is missing from the pool: a regular of a team with no game on file for the date
    const players = day.players.filter(p => p.name !== 'AAA Star').map(p => ({
      key: p.key, name: p.name, team: p.team, opponent: p.opponent, position: p.position, isHome: p.isHome, out: false, slate: {}
    }));
    const { day: live, contexts } = evaluate.slateDay(store, { date: future, players });
    assert.deepEqual([...live.teams.keys()].sort(), ['AAA', 'BBB', 'CCC', 'DDD']);
    assert.ok(live.teams.get('AAA').out.some(o => o.name === 'AAA Star'));
    assert.equal(contexts.length, players.length);
    assert.ok(contexts.find(c => c.team === 'AAA').teamOut.some(o => o.name === 'AAA Star'));
  });
});

/** Synthetic blend rows: slate s, RotoWire / ours / actual. */
const row = (slateId, rw, ours, actual, extra = {}) => ({
  slateId, salary: extra.salary ?? 5000, actual: { dk: actual, minutes: extra.actualMinutes ?? 30 }, tags: { teammateOut: 'none out' },
  preds: {
    rotowire_adjusted: { dk_points: rw, minutes: extra.rwMinutes ?? 30 },
    own_mean: {
      dk_points: ours, minutes: extra.ourMinutes ?? 30, p_play: extra.pPlay ?? 0.95, role_shift: 0, boom_at: 30, p_dd: 0.1,
      dk_quantiles: own.QUANTILE_LEVELS.map(t => ours * 2 * t),
      minutes_blend_means: own.MINUTES_BLEND_GRID.map(w => w * rw + (1 - w) * ours)
    }
  }
});

describe('blend', () => {
  test('fitWeights: all RotoWire when it is exact, all ours when ours is; segments shrink to the global w', () => {
    const rwExact = Array.from({ length: 40 }, (_, i) => ({ x: blend.blendInput(row('a', 20 + i, 10 + i, 20 + i)), actual: 20 + i }));
    assert.equal(blend.fitWeights(rwExact, { kind: 'points' }).global, 1);
    assert.equal(blend.fitWeights(rwExact, { kind: 'minutes' }).global, 1);
    const oursExact = rwExact.map(s => ({ ...s, actual: s.x.own.dk_points }));
    assert.equal(blend.fitWeights(oursExact).global, 0);
    // Cheap players: ours exact; expensive: RotoWire exact. Segments pull apart, shrunk toward the global w
    const mixed = [
      ...Array.from({ length: 50 }, (_, i) => ({ x: blend.blendInput(row('a', 20, 10 + i % 3, 10 + i % 3, { salary: 3500 })), actual: 10 + i % 3 })),
      ...Array.from({ length: 50 }, (_, i) => ({ x: blend.blendInput(row('a', 30 + i % 3, 20, 30 + i % 3, { salary: 9000 })), actual: 30 + i % 3 }))
    ];
    const w = blend.fitWeights(mixed, { kind: 'points', scheme: 'salaryTier', shrink: 50 });
    assert.equal(w.segments['<4K'].raw, 0);
    assert.equal(w.segments['8K+'].raw, 1);
    close(w.segments['<4K'].w, (50 * 0 + 50 * w.global) / 100, 1e-4);
    close(w.segments['8K+'].w, (50 * 1 + 50 * w.global) / 100, 1e-4);
    assert.equal(blend.weightFor(w, blend.blendInput(row('a', 1, 1, 1, { salary: 3500 }))), w.segments['<4K'].w);
    // A tier the training rows never saw: the global w
    assert.equal(blend.weightFor(w, blend.blendInput(row('a', 1, 1, 1, { salary: 5000 }))), w.global);
  });

  test('crossValidate: a slate\'s blend uses weights fit on the other slates only', () => {
    const rows = [];
    for (const s of ['s1', 's2', 's3']) for (let i = 0; i < 30; i++) rows.push(row(s, 20 + i % 5, 15 + i % 7, 18 + i % 6));
    const a = blend.crossValidate(rows, { kinds: ['points'], schemes: ['global', 'salaryTier'] });
    assert.deepEqual(a.names, ['blend_points_global', 'blend_points_salaryTier']);
    assert.equal(a.folds.blend_points_global.length, 3);
    assert.ok(rows.every(r => !r.preds.blend_points_global)); // inputs untouched
    // Rewrite s1's outcomes wildly: s1's own blends must not move, the others' must
    const poisoned = rows.map(r => (r.slateId === 's1' ? { ...r, actual: { ...r.actual, dk: r.preds.rotowire_adjusted.dk_points + 50 } } : r));
    const b = blend.crossValidate(poisoned, { kinds: ['points'], schemes: ['global'] });
    const pick = (res, s) => res.rows.filter(r => r.slateId === s).map(r => r.preds.blend_points_global.dk_points);
    assert.deepEqual(pick(b, 's1'), pick(a, 's1'));
    assert.notDeepEqual(pick(b, 's2'), pick(a, 's2'));
    assert.ok(a.stability.blend_points_global.global.min <= a.stability.blend_points_global.global.max);
  });

  test('recenter: identity at our mean, scaled quantiles, boom from the re-centered distribution', () => {
    const o = { dk_points: 20, boom_at: 30, p_dd: 0.2, dk_quantiles: own.QUANTILE_LEVELS.map(t => 40 * t) }; // uniform 0-40
    const same = blend.recenter(o, 20);
    close(same.p10, 4);
    close(same.p90, 36);
    close(same.p_boom, 0.25);
    const up = blend.recenter(o, 30); // x1.5: uniform 0-60
    close(up.p90, 54);
    close(up.p_boom, 0.5);
    assert.equal(up.p_dd, 0.2);
    // Our mean under a point: shifted, not scaled
    const tiny = blend.recenter({ ...o, dk_points: 0.5, dk_quantiles: own.QUANTILE_LEVELS.map(() => 0) }, 10.5);
    close(tiny.p10, 10);
    close(blend.exceedance([0, 10, 20], 5), 0.75);
    assert.equal(blend.exceedance([0, 10, 20], 25), 0);
  });

  test('blendPrediction: points and minutes kinds, missing RotoWire falls back to ours', () => {
    const x = blend.blendInput(row('a', 30, 20, 25, { rwMinutes: 34, ourMinutes: 30 }));
    const p = blend.blendPrediction(x, { kind: 'points', scheme: 'global', global: 0.6, segments: {} });
    close(p.dk_points, 26);
    close(p.minutes, 0.6 * 34 + 0.4 * 30);
    const m = blend.blendPrediction(x, { kind: 'minutes', scheme: 'global', global: 0.35, segments: {} });
    close(m.dk_points, 0.35 * 30 + 0.65 * 20); // the synthetic grid is linear
    const noRw = blend.blendPrediction({ ...x, rw: null }, { kind: 'points', scheme: 'global', global: 0.6, segments: {} });
    assert.equal(noRw.dk_points, 20);
    assert.equal(noRw.weight, 0);
  });

  test('disagreement: hit rate of "ours higher / lower by X" calls', () => {
    const rows = [
      row('a', 20, 26, 30), // ours higher by 6, actual above RotoWire: hit, closer
      row('a', 20, 25, 15), // higher by 5, actual below: miss
      row('a', 20, 14, 10), // lower by 6, actual below: hit
      row('a', 20, 21, 40)  // agree
    ];
    const d = blend.disagreement(rows);
    const call = (name) => d.points.cumulative.find(c => c.call === name);
    assert.deepEqual([call('ours higher by 4+').n, call('ours higher by 4+').hitRate, call('ours higher by 4+').closerRate], [2, 0.5, 0.5]);
    assert.deepEqual([call('ours lower by 6+').n, call('ours lower by 6+').hitRate], [1, 1]);
    assert.equal(call('ours higher by 8+').n, 0);
    assert.equal(d.points.buckets['higher 6+'].n, 1);
    assert.equal(d.points.buckets['higher 4-6'].n, 1);
    assert.equal(d.points.buckets.agree.n, 1);
    assert.equal(blend.leanBucket(-2.5), 'lower 2-4');
    assert.ok(d.points.bySegment.salaryTier['4K-5.9K'].higher.n === 2);
  });
});

describe('own model service output', () => {
  test('playerOutput: blend by the artifact weights, disagreement bucket and its history', async () => {
    const { playerOutput } = await import('../src/services/modelEval/ownModelService.js');
    const weights = {
      blend: { kind: 'points', scheme: 'salaryTier', global: 0.7, segments: { '8K+': { w: 0.8 } } },
      disagreement: { points: { 'lower 4-6': { n: 50, hitRate: 0.7, closerRate: 0.5 } }, minutes: {} }
    };
    const ownPred = row('a', 0, 40, 0).preds.own_mean;
    const entry = { id: 1, key: 'x', name: 'X', team: 'AAA', opponent: 'BBB', position: 'PG', teammateOut: 'none out',
      slate: { salary: 9000, adjusted: 45, rotowire: 46, adjustedMinutes: 33, injuryStatus: null } };
    const out = playerOutput(entry, ownPred, weights);
    close(out.blend_point, 0.8 * 45 + 0.2 * 40, 0.01);
    assert.equal(out.blend_weight, 0.8);
    assert.equal(out.ours_mean, 40);
    assert.equal(out.disagreement.points_diff, -5);
    assert.equal(out.disagreement.lean, 'lower 4-6');
    assert.deepEqual(out.disagreement.history, { n: 50, hitRate: 0.7, closerRate: 0.5 });
    assert.equal(out.disagreement.minutes_diff, -3);
    // No weights file: ours only
    const bare = playerOutput(entry, ownPred, null);
    assert.equal(bare.blend_point, null);
    assert.equal(bare.ours_mean, 40);
    // No RotoWire projection: the blend is ours
    assert.equal(playerOutput({ ...entry, slate: { salary: 9000, adjusted: null } }, ownPred, weights).blend_point, 40);
  });
});
