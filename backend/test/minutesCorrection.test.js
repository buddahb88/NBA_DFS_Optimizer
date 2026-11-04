import { test, describe, beforeAll as before } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { buildData, scheduleDates } from './helpers/modelEvalData.js';

// Services pull in the database module; keep it off the real DB
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nba-dfs-min-corr-'));
let mc;
let up;
let bt;
let featureStore;
let evaluate;
let projectors;

before(async () => {
  process.env.DATABASE_TYPE = 'sqlite';
  process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');
  mc = await import('../src/services/modelEval/minutesCorrection.js');
  up = await import('../src/services/modelEval/minutesUpside.js');
  bt = await import('../src/services/modelEval/minutesCorrectionBacktest.js');
  featureStore = await import('../src/services/modelEval/featureStore.js');
  evaluate = await import('../src/services/modelEval/evaluate.js');
  projectors = await import('../src/services/modelEval/projectors.js');
});

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

/** Params with one factor everywhere. */
const flat = (f) => ({
  version: '1', gapEdges: [3, 6], salaryEdge: 5000, global: f,
  buckets: Object.fromEntries(['rw lower 6+', 'rw lower 3-6', 'close', 'rw higher 3-6', 'rw higher 6+']
    .map(b => [b, { n: 10, raw: f, f, bands: { '<5K': { n: 5, raw: f, f }, '5K+': { n: 5, raw: f, f } } }]))
});

describe('minutes correction math', () => {
  test('gap buckets and salary bands', () => {
    assert.equal(mc.gapBucket(0), 'close');
    assert.equal(mc.gapBucket(2.99), 'close');
    assert.equal(mc.gapBucket(-2.99), 'close');
    assert.equal(mc.gapBucket(3), 'rw higher 3-6');
    assert.equal(mc.gapBucket(6), 'rw higher 6+');
    assert.equal(mc.gapBucket(-4), 'rw lower 3-6');
    assert.equal(mc.gapBucket(-9), 'rw lower 6+');
    assert.equal(mc.gapBucket(null), null);
    assert.deepEqual(mc.gapBuckets(), ['rw lower 6+', 'rw lower 3-6', 'close', 'rw higher 3-6', 'rw higher 6+']);
    assert.equal(mc.salaryBand(4900), '<5K');
    assert.equal(mc.salaryBand(5000), '5K+');
    assert.equal(mc.salaryBand(0), null);
  });

  test('factorFor: the cell, else the bucket, else the global factor', () => {
    const p = flat(0.5);
    p.buckets['rw higher 6+'].bands['<5K'].f = 0.8;
    delete p.buckets['rw higher 3-6'].bands['5K+'];
    assert.equal(mc.factorFor(p, { gap: 7, salary: 4000 }), 0.8);
    assert.equal(mc.factorFor(p, { gap: 7, salary: 6000 }), 0.5);
    p.buckets['rw higher 3-6'].f = 0.3;
    assert.equal(mc.factorFor(p, { gap: 4, salary: 6000 }), 0.3);
    assert.equal(mc.factorFor(null, { gap: 4, salary: 6000 }), 0);
  });

  test('correctConditional: cond + f x (RotoWire - cond); nothing without RotoWire minutes', () => {
    const p = flat(0.6);
    const c = mc.correctConditional({ cond: 20, rotowire: 30, salary: 4000 }, p);
    close(c.cond, 26);
    assert.equal(c.applied, true);
    assert.equal(c.factor, 0.6);
    assert.equal(c.gap, 10);
    assert.equal(c.bucket, 'rw higher 6+');
    assert.equal(c.band, '<5K');
    close(mc.correctConditional({ cond: 30, rotowire: 25, salary: 8000 }, p).cond, 27);
    // RotoWire at 0 (ruled out) / missing, our cond at 0, or no params: unchanged
    for (const x of [{ cond: 20, rotowire: 0 }, { cond: 20, rotowire: null }, { cond: 0, rotowire: 20 }]) {
      const r = mc.correctConditional({ ...x, salary: 4000 }, p);
      assert.equal(r.applied, false);
      assert.equal(r.cond, x.cond);
    }
    assert.equal(mc.correctConditional({ cond: 20, rotowire: 30, salary: 4000 }, null).cond, 20);
    // Capped at 48
    assert.equal(mc.correctConditional({ cond: 40, rotowire: 60, salary: 4000 }, flat(1)).cond, mc.MAX_MINUTES);
  });
});

/** Synthetic samples: actual = cond + truth x gap (played), per slate. */
function samples(truth, { slates = ['a', 'b', 'c'], perSlate = 40, salary = 4000 } = {}) {
  const out = [];
  for (const slateId of slates) {
    for (let i = 0; i < perSlate; i++) {
      const cond = 15 + (i % 10);
      const gap = [-8, -4, 0, 4, 8][i % 5];
      const f = truth(gap, slateId);
      out.push({ slateId, cond, rotowire: cond + gap, salary, actual: cond + f * gap, played: true });
    }
  }
  return out;
}

describe('minutes correction fit', () => {
  test('fitCorrection recovers per-bucket factors; DNPs / zero RotoWire are not fit on', () => {
    const s = samples((gap) => (gap > 0 ? 0.7 : 0.4));
    s.push({ slateId: 'a', cond: 20, rotowire: 30, salary: 4000, actual: 0, played: false });
    s.push({ slateId: 'a', cond: 20, rotowire: 0, salary: 4000, actual: 25, played: true });
    const p = mc.fitCorrection(s, { shrink: 0 });
    assert.equal(p.n, 120);
    assert.equal(p.buckets['rw higher 6+'].raw, 0.7);
    assert.equal(p.buckets['rw higher 3-6'].raw, 0.7);
    assert.equal(p.buckets['rw lower 6+'].raw, 0.4);
    assert.equal(p.buckets['rw higher 6+'].bands['<5K'].f, 0.7);
    // No 5K+ rows: the band takes the bucket's factor
    assert.equal(p.buckets['rw higher 6+'].bands['5K+'].n, 0);
    assert.equal(p.buckets['rw higher 6+'].bands['5K+'].f, p.buckets['rw higher 6+'].f);
  });

  test('shrinkage pulls a small bucket toward the global factor', () => {
    const s = samples(() => 0.5, { perSlate: 50 }).filter(x => x.rotowire - x.cond < 6);
    // The bucket is a handful of rows where RotoWire is 6+ higher and exactly right
    for (let i = 0; i < 6; i++) s.push({ slateId: 'a', cond: 20, rotowire: 30, salary: 4000, actual: 30, played: true });
    const raw = mc.fitCorrection(s, { shrink: 0 });
    const shrunk = mc.fitCorrection(s, { shrink: 30 });
    assert.ok(raw.buckets['rw higher 6+'].f > shrunk.buckets['rw higher 6+'].f);
    assert.ok(shrunk.buckets['rw higher 6+'].f > shrunk.global - 1e-9);
  });

  test('crossValidateCorrection: each slate gets factors fit without it', () => {
    // On slates b and c RotoWire is exactly right when higher; on a it is halfway
    const s = samples((gap, slate) => (slate !== 'a' && gap > 0 ? 1 : 0.5), { perSlate: 50 });
    const cv = mc.crossValidateCorrection(s, { shrink: 0 });
    assert.deepEqual(Object.keys(cv.bySlate).sort(), ['a', 'b', 'c']);
    assert.equal(cv.bySlate.a.buckets['rw higher 6+'].raw, 1);
    assert.equal(cv.bySlate.c.buckets['rw higher 6+'].raw, 0.5);
    assert.deepEqual(cv.bySlate.a, mc.fitCorrection(s.filter(x => x.slateId !== 'a'), { shrink: 0 }));
    assert.ok(cv.stability.cells['rw higher 6+|<5K'].max > cv.stability.cells['rw higher 6+|<5K'].min);
    assert.equal(cv.full.n, s.length);
  });

  test('params file: read / write round trip; another version or missing reads null', () => {
    const file = path.join(tmpDir, 'params.json');
    const p = { ...mc.fitCorrection(samples(() => 0.6)), live: true };
    mc.writeCorrectionParams(p, file);
    assert.deepEqual(mc.readCorrectionParams(file), p);
    fs.writeFileSync(file, JSON.stringify({ ...p, version: '0' }));
    assert.equal(mc.readCorrectionParams(file), null);
    assert.equal(mc.readCorrectionParams(path.join(tmpDir, 'missing.json')), null);
  });
});

describe('minutes upside score', () => {
  test('weighted components, 0-100, reasons', () => {
    const none = up.minutesUpside({ gap: 0, sigma: 3, teammateOut: false, roleShift: 0 });
    assert.equal(none.score, 0);
    assert.deepEqual(none.reasons, []);
    const full = up.minutesUpside({ gap: 10, sigma: 12, teammateOut: true, roleShift: 1 });
    assert.equal(full.score, 100);
    assert.deepEqual(full.reasons, ['RotoWire +10.0 min', 'volatile minutes', 'teammate out', 'moving into the starting five']);
    const half = up.minutesUpside({ gap: 4, sigma: 4 });
    assert.equal(half.score, 30);
    close(half.components.gap, 0.5);
    // RotoWire below ours and missing RotoWire add nothing; OUT is 0
    assert.equal(up.minutesUpside({ gap: -6 }).score, 0);
    assert.equal(up.minutesUpside({ gap: null, sigma: 7 }).score, 8);
    assert.equal(up.minutesUpside({ gap: 10, out: true }).score, 0);
    assert.equal(Object.values(up.WEIGHTS).reduce((s, w) => s + w, 0), 100);
  });

  test('auc: ranks, ties count half, null without both classes', () => {
    assert.equal(bt.auc([1, 2, 3, 4], [false, false, true, true]), 1);
    assert.equal(bt.auc([1, 2, 3, 4], [true, true, false, false]), 0);
    assert.equal(bt.auc([1, 1, 1, 1], [true, false, true, false]), 0.5);
    assert.equal(bt.auc([1, 2], [true, true]), null);
  });

  test('upsideEvaluation: spikes (actual >= ours + 8) and 6x by score bucket', () => {
    const r = (score, ours, actualMin, dk, salary = 4000) => ({
      salary, played: actualMin > 0, actual: { minutes: actualMin, dk },
      preds: { own_mean: { minutes: ours, p_play: 0.9, minutes_upside: score, rw_minutes_gap: score / 10 } }
    });
    const rows = [r(80, 20, 30, 30), r(60, 20, 29, 10), r(10, 20, 20, 10), r(0, 20, 0, 0), r(5, 20, 21, 25, 6000)];
    const e = bt.upsideEvaluation(rows);
    assert.equal(e.all.n, 5);
    assert.equal(e.all.spikes, 2);
    assert.equal(e.all.sixX, 1);
    assert.equal(e.all.auc.spike.score, 1);
    assert.equal(e.all.high.n, 2);
    assert.equal(e.all.high.spike, 1);
    assert.equal(e.all.recall.spike, 1);
    assert.equal(e.cheap.n, 4);
    assert.deepEqual(e.all.buckets.map(b => b.n), [3, 0, 1, 1]);
  });

  test('correctionSamples: own_mean conditional minutes vs RotoWire posted minutes', () => {
    const rows = [
      { slateId: 's', salary: 4000, played: true, actual: { minutes: 25 }, slate: { rotowireMinutes: 28 }, preds: { own_mean: { conditional_minutes: 20 } } },
      { slateId: 's', salary: 4000, played: true, actual: { minutes: 25 }, slate: { rotowireMinutes: null }, preds: { own_mean: { conditional_minutes: 20 } } },
      { slateId: 's', salary: 4000, played: true, actual: { minutes: 25 }, slate: { rotowireMinutes: 28 }, preds: {} }
    ];
    assert.deepEqual(bt.correctionSamples(rows), [{ slateId: 's', cond: 20, rotowire: 28, salary: 4000, actual: 25, played: true }]);
  });
});

const SEASON2 = scheduleDates('2025-11-01', 20);
const D = SEASON2[12];
const OPTIONS = { params: { sims: 200 }, minutesParams: { teamMinutes: 130 } };

function slateFor(store, date, rwMinutes, slateId = 'main') {
  const day = store.gameDay(date);
  return {
    date, slateId,
    players: day.players.map(p => ({
      key: p.key, name: p.name, team: p.team, opponent: p.opponent, position: p.position, isHome: p.isHome, out: false,
      slate: { salary: 4000, rotowire: 20, rotowireMinutes: rwMinutes(p), adjusted: 20, adjustedMinutes: 30, spread: -3, impliedTotal: 112 },
      outcome: { played: p.played, status: p.status, actual: p.actual, isStarter: p.isStarter }
    }))
  };
}

describe('own_mean_mincorr projector', () => {
  test('f = 1 moves conditional minutes onto RotoWire; points / ranges follow; raw minutes kept', async () => {
    const store = featureStore.createFeatureStore(buildData());
    const slate = slateFor(store, D, (p) => (p.name.endsWith('Deep') ? null : 34));
    slate.players[0].out = true;
    const ownMean = { ...projectors.createProjector('own_mean', OPTIONS), name: 'own_mean' };
    const corrected = { ...projectors.createProjector('own_mean_mincorr', { ...OPTIONS, correction: flat(1) }), name: 'own_mean_mincorr' };
    const { rows } = await evaluate.runSlates(store, [ownMean, corrected], [slate]);
    let moved = 0;
    for (const r of rows) {
      const a = r.preds.own_mean;
      const b = r.preds.own_mean_mincorr;
      if (r.key === slate.players[0].key && r.team === slate.players[0].team) {
        assert.equal(b.dk_points, 0);
        assert.equal(b.minutes_upside, 0);
        continue;
      }
      assert.ok(Number.isFinite(a.minutes_upside) && a.minutes_upside >= 0 && a.minutes_upside <= 100);
      assert.equal(a.minutes_correction, undefined);
      if (r.name.endsWith('Deep')) {
        // No RotoWire minutes: nothing to correct toward
        close(b.dk_points, a.dk_points, 1e-9);
        assert.equal(b.minutes_correction.applied, false);
        assert.equal(a.rw_minutes_gap, null);
        continue;
      }
      close(b.conditional_minutes, 34, 1e-9);
      close(b.conditional_minutes_raw, a.conditional_minutes, 1e-9);
      close(b.minutes_raw, a.minutes, 1e-9);
      close(a.rw_minutes_gap, 34 - a.conditional_minutes, 1e-9);
      assert.equal(b.minutes_correction.factor, 1);
      // The upside signal is on our UNcorrected minutes in both
      assert.equal(b.minutes_upside, a.minutes_upside);
      for (let i = 1; i < b.dk_quantiles.length; i++) assert.ok(b.dk_quantiles[i] >= b.dk_quantiles[i - 1]);
      if (34 - a.conditional_minutes > 2) {
        moved++;
        assert.ok(b.dk_points > a.dk_points, `${r.name}: more minutes, more points`);
        assert.ok(b.minutes > a.minutes);
      }
    }
    assert.ok(moved >= 3);
  });

  test('bySlate: each slate uses its own factors; f = 0 is own_mean', async () => {
    const store = featureStore.createFeatureStore(buildData());
    const s1 = slateFor(store, D, () => 34, 's1');
    const s2 = slateFor(store, D, () => 34, 's2');
    const ownMean = { ...projectors.createProjector('own_mean', OPTIONS), name: 'own_mean' };
    const corrected = { ...projectors.createProjector('own_mean_mincorr', { ...OPTIONS, correction: { bySlate: { s1: flat(0), s2: flat(1) } } }), name: 'own_mean_mincorr' };
    const { rows } = await evaluate.runSlates(store, [ownMean, corrected], [s1, s2]);
    for (const r of rows.filter(x => x.slateId === 's1')) close(r.preds.own_mean_mincorr.dk_points, r.preds.own_mean.dk_points, 1e-9);
    assert.ok(rows.filter(x => x.slateId === 's2').some(r => Math.abs(r.preds.own_mean_mincorr.dk_points - r.preds.own_mean.dk_points) > 0.5));
  });

  test('registered as a slate-only, uncached projector', () => {
    const meta = projectors.listProjectors().find(p => p.name === 'own_mean_mincorr');
    assert.deepEqual(meta.modes, ['slate']);
    assert.equal(meta.cacheable, false);
  });
});
