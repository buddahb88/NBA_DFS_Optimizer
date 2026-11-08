import { test, describe } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  bandOf, minutesBand, salaryTier, cdfRange, pitBelow, pointFactor, fitPointFactors, fitPitMap, pitInverse, pitMap,
  fitPlatt, platt, applyCalibration, fitCalibration, crossValidate, evaluate, rawPrediction, readCalibrationParams,
  writeCalibrationParams, PARAMS_VERSION, PIT_KNOTS
} from '../src/services/modelEval/blendCalibration.js';
import { eligibleSlots, hindsightLineups, paramsArtifact } from '../src/services/modelEval/blendCalibrationBacktest.js';
import { calibrated } from '../src/services/modelEval/ownModelService.js';

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);
const grid = (fn) => Array.from({ length: 101 }, (_, i) => fn(i / 100));
// A uniform(0, 2m) distribution: mean m
const uniform = (m) => grid(t => 2 * m * t);
// Deterministic pseudo-random in [0, 1)
const rng = (seed) => () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;

describe('bands', () => {
  test('minutes bands and salary tiers', () => {
    assert.equal(minutesBand(10), '<15');
    assert.equal(minutesBand(15), '15-24');
    assert.equal(minutesBand(33.9), '30-34');
    assert.equal(minutesBand(34), '34+');
    assert.equal(minutesBand(null), null);
    assert.equal(salaryTier(3900), '<4K');
    assert.equal(salaryTier(5500), '4K-6K');
    assert.equal(salaryTier(8000), '8K+');
    assert.equal(bandOf(5, [10]), '<10');
  });
});

describe('cdfRange / PIT', () => {
  test('a continuous outcome is a point; an outcome on the DNP mass spans it', () => {
    const qs = uniform(10); // 0..20
    const [lo, hi] = cdfRange(qs, 5);
    close(lo, 0.25); close(hi, 0.25);
    // 30% DNP mass at 0, then linear
    const dnp = grid(t => (t <= 0.3 ? 0 : (t - 0.3) * 40));
    const r0 = cdfRange(dnp, 0);
    close(r0[0], 0); close(r0[1], 0.3);
    close(pitBelow(r0, 0.1), 1 / 3);
    assert.equal(pitBelow([0.5, 0.5], 0.4), 0);
    assert.equal(pitBelow([0.5, 0.5], 0.5), 1);
    // Beyond the grid
    assert.deepEqual(cdfRange(qs, 25), [1, 1]);
  });

  test('calibrated outcomes give an identity map; too-wide ranges pull the tails in', () => {
    const next = rng(7);
    const calibratedRows = Array.from({ length: 4000 }, () => ({ qs: uniform(10), actual: 20 * next() }));
    const H = fitPitMap(calibratedRows);
    assert.equal(H.length, PIT_KNOTS.length);
    for (let i = 0; i < H.length; i++) close(H[i], PIT_KNOTS[i], 0.03);
    // Actuals only on 5..15: our 10th percentile (2) is beaten every time
    const narrow = Array.from({ length: 4000 }, () => ({ qs: uniform(10), actual: 5 + 10 * next() }));
    const Hn = fitPitMap(narrow);
    close(Hn[2], 0, 1e-9); // H(0.10) = 0
    assert.ok(pitInverse(Hn, 0.1) > 0.25 && pitInverse(Hn, 0.1) < 0.35); // calibrated p10 near our 30th pct (6)
    assert.ok(pitInverse(Hn, 0.9) > 0.65 && pitInverse(Hn, 0.9) < 0.75);
    // monotone, inverse of the map
    for (let i = 1; i < Hn.length; i++) assert.ok(Hn[i] >= Hn[i - 1]);
    close(pitMap(Hn, pitInverse(Hn, 0.5)), 0.5, 1e-6);
  });
});

describe('point factors', () => {
  test('a global bias comes out as the global factor; bands stay ~1', () => {
    const rows = [];
    for (let i = 0; i < 600; i++) rows.push({ point: 20, actual: 18, minutes: 10 + (i % 30), salary: 3000 + (i % 7) * 1000 });
    const f = fitPointFactors(rows, { shrink: 0 });
    close(f.global, 0.9, 1e-4);
    for (const v of [...Object.values(f.minutes), ...Object.values(f.salary)]) close(v, 1, 1e-3);
    close(pointFactor(f, { minutes: 20, salary: 5000 }), 0.9, 1e-3);
  });

  test('a minutes-band bias lands on that band; shrinkage pulls a small band toward 1', () => {
    const rows = [];
    for (let i = 0; i < 400; i++) rows.push({ point: 20, actual: 20, minutes: 25, salary: 5000 });
    for (let i = 0; i < 100; i++) rows.push({ point: 40, actual: 36, minutes: 36, salary: 5000 });
    const free = fitPointFactors(rows, { shrink: 0 });
    close(free.global * free.minutes['34+'] * free.salary['4K-6K'], 0.9, 1e-3);
    close(free.global * free.minutes['24-30'] * free.salary['4K-6K'], 1, 1e-3);
    const shrunk = fitPointFactors(rows, { shrink: 100 });
    assert.ok(Math.abs(shrunk.minutes['34+'] - 1) < Math.abs(free.minutes['34+'] - 1));
    // A missing band / tier gets factor 1 (only the global applies)
    close(pointFactor(free, { minutes: null, salary: null }), free.global, 1e-9);
  });
});

describe('Platt', () => {
  test('recovers an overconfident probability scale', () => {
    const next = rng(11);
    const ps = [], ys = [];
    for (let i = 0; i < 6000; i++) {
      const p = 0.02 + 0.5 * next();
      const truth = 1 / (1 + Math.exp(-(0.75 * Math.log(p / (1 - p)) - 0.4)));
      ps.push(p);
      ys.push(next() < truth ? 1 : 0);
    }
    const m = fitPlatt(ps, ys);
    assert.ok(Math.abs(m.b - 0.75) < 0.12, `b ${m.b}`);
    assert.ok(Math.abs(m.a + 0.4) < 0.25, `a ${m.a}`);
    assert.ok(platt(m, 0.4) < 0.4);
    assert.equal(platt(null, 0.3), 0.3);
  });
});

describe('applyCalibration', () => {
  test('identity params leave the blend as is', () => {
    const identity = { point: { global: 1, minutes: {}, salary: {} }, pit: { H: PIT_KNOTS.slice() }, boom: { a: 0, b: 1 } };
    const qs = uniform(10);
    const c = applyCalibration({ point: 10, qs, boomAt: 15, minutes: 28, salary: 5000 }, identity);
    close(c.point, 10); close(c.p10, 2); close(c.p90, 18); close(c.p_boom, 0.25, 1e-3); close(c.factor, 1);
  });

  test('the factor scales point and ranges; no params is a no-op factor', () => {
    const params = { point: { global: 0.9, minutes: { '34+': 0.95 }, salary: {} }, pit: { H: PIT_KNOTS.slice() }, boom: null };
    const c = applyCalibration({ point: 40, qs: uniform(40), boomAt: 60, minutes: 36, salary: 9000 }, params);
    close(c.factor, 0.855); close(c.point, 34.2); close(c.p90, 0.9 * 80 * 0.855);
    const none = applyCalibration({ point: 10, qs: null, minutes: 20, salary: 5000 }, null);
    assert.equal(none.factor, 1); assert.equal(none.p10, null);
  });
});

// Synthetic nights: the blend projects 10% high and its range is too wide
function syntheticSamples(seed = 3) {
  const next = rng(seed);
  const samples = [];
  for (let d = 0; d < 8; d++) {
    for (let i = 0; i < 150; i++) {
      const m = 10 + 30 * next();
      const truth = 0.9 * m;
      const actual = truth * (0.6 + 0.8 * next()); // uniform(0.6, 1.4) x truth
      samples.push({ date: `2026-10-${String(10 + d)}`, slateId: `s${d}`, main: true, point: m, qs: uniform(m), p10: 0.2 * m, p90: 1.8 * m, pBoom: 0.2, boomAt: 1.2 * m, minutes: 12 + (i % 25), salary: 3500 + (i % 6) * 1000, actual });
    }
  }
  return samples;
}

describe('fit / cross-validate / evaluate', () => {
  test('leave-one-date-out removes the bias and fixes coverage', () => {
    const samples = syntheticSamples();
    const cv = crossValidate(samples);
    assert.equal(cv.folds.length, 8);
    const before = evaluate(samples, samples.map(rawPrediction));
    const after = evaluate(samples, cv.predictions);
    assert.ok(before.point.all.bias < -1);
    assert.ok(Math.abs(after.point.all.bias) < 0.3, `bias ${after.point.all.bias}`);
    assert.ok(after.point.all.mae < before.point.all.mae);
    assert.ok(before.coverage.belowP10 < 0.02 && before.coverage.aboveP90 < 0.02);
    close(after.coverage.belowP10, 0.1, 0.03);
    close(after.coverage.aboveP90, 0.1, 0.03);
    assert.ok(after.boom.brier <= before.boom.brier);
    assert.ok(Object.keys(after.point.byMinutes)[0] === '<15');
    const full = fitCalibration(samples);
    close(full.point.global, 0.9, 0.02);
  });

  test('paramsArtifact goes live only when the calibration won out of sample', () => {
    const mk = (mae, brier, above) => ({ point: { all: { mae, rmse: 1, bias: 0 } }, coverage: { belowP10: 0.1, aboveP90: above }, boom: { brier } });
    const report = { rows: 10, before: mk(7.6, 0.141, 0.07), after: mk(7.5, 0.139, 0.1), full: { point: {}, pit: { H: [] }, boom: {} } };
    const a = paramsArtifact(report, { slates: [{ date: '2026-10-20', slateId: '1', main: true }, { date: '2026-10-20', slateId: '2', main: false }] });
    assert.equal(a.live, true);
    assert.equal(a.version, PARAMS_VERSION);
    assert.deepEqual(a.slates, ['2026-10-20:1', '2026-10-20:2:side']);
    assert.equal(paramsArtifact({ ...report, after: mk(7.7, 0.139, 0.1) }).live, false);
    assert.equal(paramsArtifact({ ...report, after: mk(7.5, 0.142, 0.1) }).live, false);
  });

  test('params file round trip (other versions are ignored)', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'blend-cal-')), 'p.json');
    writeCalibrationParams({ version: PARAMS_VERSION, live: true, point: { global: 1 }, pit: { H: [0, 1] } }, file);
    assert.equal(readCalibrationParams(file).live, true);
    writeCalibrationParams({ version: '0', point: {}, pit: { H: [] } }, file);
    assert.equal(readCalibrationParams(file), null);
    assert.equal(readCalibrationParams(path.join(os.tmpdir(), 'missing-blend-cal.json')), null);
  });
});

describe('live service hook (ownModelService.calibrated)', () => {
  const own = { dk_points: 20, dk_quantiles: uniform(20), boom_at: 30, minutes: 36 };
  const params = { point: { global: 0.9, minutes: {}, salary: {} }, pit: { H: PIT_KNOTS.slice() }, boom: null };
  test('scales point, if_plays and untagged; ranges from the calibrated grid', () => {
    const b = { dk_points: 20, p10: 4, p90: 36, p_boom: 0.25, if_plays: 21, untagged: 22, weight: 0.45 };
    const c = calibrated(b, own, 6000, params);
    close(c.dk_points, 18); close(c.if_plays, 18.9); close(c.untagged, 19.8);
    close(c.p10, 3.6); close(c.p90, 32.4); close(c.factor, 0.9);
    assert.equal(c.weight, 0.45);
  });
  test('no params / no blend: unchanged', () => {
    const b = { dk_points: 20 };
    assert.equal(calibrated(b, own, 6000, null), b);
    assert.equal(calibrated(null, own, 6000, params), null);
  });
});

describe('hindsight lineups', () => {
  test('eligible slots', () => {
    assert.deepEqual(eligibleSlots('PG/SF'), ['PG', 'SF', 'G', 'F', 'UTIL']);
    assert.deepEqual(eligibleSlots('C'), ['C', 'UTIL']);
  });
  test('top lineups by actual with no-good cuts (stub solver)', () => {
    const rows = Array.from({ length: 9 }, (_, i) => ({ position: 'PG', salary: 1000, actual: i }));
    let calls = 0;
    // Stub: picks 8 rows not excluded by a cut (first call: 1..8, then 0..7)
    const solve = (m) => {
      calls++;
      const pick = calls === 1 ? [1, 2, 3, 4, 5, 6, 7, 8] : [0, 1, 2, 3, 4, 5, 6, 7];
      return Object.fromEntries(pick.map((i, k) => [`x${i}_${['PG', 'SG', 'SF', 'PF', 'C', 'G', 'F', 'UTIL'][k]}`, 1]));
    };
    const L = hindsightLineups(rows, { top: 2, solve });
    assert.equal(L.length, 2);
    assert.deepEqual(L[0], [1, 2, 3, 4, 5, 6, 7, 8]);
  });
});
