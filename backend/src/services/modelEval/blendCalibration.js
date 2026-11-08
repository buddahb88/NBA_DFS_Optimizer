/**
 * BLEND CALIBRATION (outcome distributions of the own-model blend). Pure: works
 * on samples / predictions and never reads the database. Fit by npm run
 * backtest:blend-calibration (blendCalibrationBacktest.js), applied by the live
 * service (ownModelService.playerOutput) when blendCalibrationParams.json is
 * `live`.
 *
 * Three small steps on top of the blend (its weights stay as fit):
 *
 *   1. point     blend point x global x minutes-band x salary-tier factor.
 *                The factors are main effects raked on the training rows
 *                (sum actual / sum projected incl. DNP), each band / tier
 *                shrunk toward 1 with SHRINK_ROWS pseudo-rows. The quantile
 *                grid scales with the point (as blend.recenter).
 *   2. ranges    a probability-integral-transform map H: H(v) = how often the
 *                actual landed at or below our v-quantile (ties at the DNP mass
 *                spread uniformly over it). Calibrated quantile at level t =
 *                our quantile at H^-1(t), so p10 / p90 cover 10% / 10% on the
 *                training rows. One curve on PIT_KNOTS (0, 0.05, ..., 1).
 *   3. p_boom    P(DK >= boom_at) from the mapped distribution, then Platt:
 *                sigmoid(a + b x logit(p)) - b < 1 pulls the extremes in
 *                (the ranking was right, the top was overconfident).
 *
 * crossValidate fits leave-one-DATE-out (main and side slates on one night
 * share player-games), so a scored prediction never saw its own night.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PARAMS_FILE = path.join(__dirname, 'blendCalibrationParams.json');
export const PARAMS_VERSION = '1';
export const MINUTES_EDGES = Object.freeze([15, 24, 30, 34]);
export const SALARY_EDGES = Object.freeze([4000, 6000, 8000]);
export const SHRINK_ROWS = 150;
export const PIT_KNOTS = Object.freeze(Array.from({ length: 21 }, (_, i) => i / 20));
export const BOOM_BUCKETS = Object.freeze([[0, 0.05], [0.05, 0.1], [0.1, 0.15], [0.15, 0.2], [0.2, 0.3], [0.3, 1]]);
const RAKE_ITERATIONS = 20;

const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const round = (v, d = 4) => (finite(v) ? Math.round(v * 10 ** d) / 10 ** d : null);
const mean = (xs) => (xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : null);
const clamp01 = (v) => Math.max(0, Math.min(1, v));
const sigmoid = (z) => 1 / (1 + Math.exp(-z));
const logit = (p) => {
  const q = Math.min(1 - 1e-4, Math.max(1e-4, p));
  return Math.log(q / (1 - q));
};

/** Band label of a value on ascending edges: '<15', '15-24', ..., '34+' (null when not finite). */
export function bandOf(value, edges, fmt = (v) => String(v)) {
  if (!finite(value)) return null;
  if (value < edges[0]) return `<${fmt(edges[0])}`;
  for (let i = 1; i < edges.length; i++) if (value < edges[i]) return `${fmt(edges[i - 1])}-${fmt(edges[i])}`;
  return `${fmt(edges.at(-1))}+`;
}
const kFmt = (v) => `${v / 1000}K`;
export const minutesBand = (m) => bandOf(m, MINUTES_EDGES);
export const salaryTier = (s) => bandOf(s, SALARY_EDGES, kFmt);

/** Linear interpolation of an even grid over [0, 1] at t. */
export function onGrid(values, t) {
  const pos = clamp01(t) * (values.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.min(values.length - 1, lo + 1);
  return values[lo] + (values[hi] - values[lo]) * (pos - lo);
}

/**
 * [F(x-), F(x)] of a quantile grid at even levels (linear CDF between knots):
 * equal unless x sits on a flat stretch (the DNP mass at 0).
 */
export function cdfRange(qs, x) {
  const n = qs.length - 1;
  const at = (hit) => {
    for (let i = 0; i <= n; i++) {
      if (!hit(qs[i])) continue;
      if (i === 0) return 0;
      return (i - 1 + clamp01((x - qs[i - 1]) / (qs[i] - qs[i - 1]))) / n;
    }
    return 1;
  };
  return [at(q => q >= x), at(q => q > x)];
}

/** P(PIT <= v) of one outcome whose PIT is uniform on [lo, hi] (a point when lo = hi). */
export function pitBelow([lo, hi], v) {
  if (hi - lo < 1e-9) return v >= hi ? 1 : 0;
  return clamp01((v - lo) / (hi - lo));
}

// ---------- step 1: point factors ----------

/** The point factor of a player: global x minutes band x salary tier (1 where a band is missing). */
export function pointFactor(point, { minutes = null, salary = null } = {}) {
  if (!point) return 1;
  const b = point.minutes?.[minutesBand(minutes)] ?? 1;
  const t = point.salary?.[salaryTier(salary)] ?? 1;
  return (point.global ?? 1) * b * t;
}

/**
 * Raked main effects on samples [{ point, actual, minutes, salary }]: global =
 * sum actual / sum point, then band and tier factors alternately (each shrunk
 * toward 1 with `shrink` pseudo-rows). Returns { global, minutes, salary, n, shrink }.
 */
export function fitPointFactors(samples, { shrink = SHRINK_ROWS } = {}) {
  const rows = samples.filter(s => finite(s.point) && s.point > 0 && finite(s.actual));
  const sumA = rows.reduce((s, r) => s + r.actual, 0);
  const sumP = rows.reduce((s, r) => s + r.point, 0);
  const global = sumP > 0 ? sumA / sumP : 1;
  const minutes = {}, salary = {};
  const B = (r) => minutesBand(r.minutes), T = (r) => salaryTier(r.salary);
  const group = (key) => {
    const m = new Map();
    for (const r of rows) {
      const k = key(r);
      if (k === null) continue;
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(r);
    }
    return m;
  };
  const byBand = group(B), byTier = group(T);
  const rake = (groups, out, other, otherKey) => {
    for (const [k, list] of groups) {
      const a = list.reduce((s, r) => s + r.actual, 0);
      const p = list.reduce((s, r) => s + r.point * global * (other[otherKey(r)] ?? 1), 0);
      const raw = p > 0 ? a / p : 1;
      out[k] = (list.length * raw + shrink) / (list.length + shrink);
    }
  };
  for (let it = 0; it < RAKE_ITERATIONS; it++) {
    rake(byBand, minutes, salary, T);
    rake(byTier, salary, minutes, B);
  }
  const r4 = (o) => Object.fromEntries(Object.entries(o).sort().map(([k, v]) => [k, round(v)]));
  return { global: round(global), minutes: r4(minutes), salary: r4(salary), n: rows.length, shrink };
}

// ---------- step 2: PIT map ----------

/** H on PIT_KNOTS from samples [{ qs (already scaled), actual }]; monotone, H(0) = 0, H(1) = 1. */
export function fitPitMap(samples, knots = PIT_KNOTS) {
  const ranges = samples.filter(s => Array.isArray(s.qs) && finite(s.actual)).map(s => cdfRange(s.qs, s.actual));
  if (!ranges.length) return knots.slice();
  const H = knots.map(v => mean(ranges.map(r => pitBelow(r, v))));
  H[0] = 0;
  H[H.length - 1] = 1;
  for (let i = 1; i < H.length; i++) H[i] = Math.max(H[i], H[i - 1]);
  return H.map(v => round(v));
}

/** H(v): the calibrated level of our v-quantile. */
export const pitMap = (H, v) => onGrid(H, v);

/** H^-1(t): our quantile level that the actual falls at or below t of the time. */
export function pitInverse(H, t) {
  const n = H.length - 1;
  for (let i = 1; i <= n; i++) {
    if (H[i] < t) continue;
    const span = H[i] - H[i - 1];
    return (i - 1 + (span > 0 ? (t - H[i - 1]) / span : 0)) / n;
  }
  return 1;
}

// ---------- step 3: Platt on p_boom ----------

/** Logistic fit of ys (0/1) on logit(ps): { a, b } (Newton, light ridge toward a = 0, b = 1). */
export function fitPlatt(ps, ys, { ridge = 1e-3, iterations = 50 } = {}) {
  let a = 0, b = 1;
  const xs = ps.map(logit);
  for (let it = 0; it < iterations; it++) {
    let ga = ridge * a, gb = ridge * (b - 1), haa = ridge, hab = 0, hbb = ridge;
    for (let i = 0; i < xs.length; i++) {
      const p = sigmoid(a + b * xs[i]);
      const e = p - ys[i];
      const w = p * (1 - p);
      ga += e; gb += e * xs[i];
      haa += w; hab += w * xs[i]; hbb += w * xs[i] * xs[i];
    }
    const det = haa * hbb - hab * hab;
    if (!(Math.abs(det) > 1e-12)) break;
    const da = (hbb * ga - hab * gb) / det;
    const db = (haa * gb - hab * ga) / det;
    a -= da; b -= db;
    if (Math.abs(da) + Math.abs(db) < 1e-9) break;
  }
  return { a: round(a), b: round(b) };
}

export const platt = (boom, p) => (boom && finite(p) ? sigmoid(boom.a + boom.b * logit(p)) : p);

// ---------- apply ----------

/**
 * Calibrated blend of one player. x: { point (blend point), qs (blend quantile
 * grid re-centered on point), boomAt, minutes (ours), salary }. Returns
 * { point, p10, p90, p_boom, factor } (p_boom null without boomAt; ranges null
 * without qs).
 */
export function applyCalibration(x, params) {
  const factor = params?.point ? pointFactor(params.point, x) : 1;
  const point = finite(x.point) ? x.point * factor : null;
  const qs = Array.isArray(x.qs) && x.qs.length > 1 ? x.qs.map(v => v * factor) : null;
  if (!qs) return { point, p10: null, p90: null, p_boom: null, factor };
  const H = params?.pit?.H ?? null;
  const level = (t) => (H ? pitInverse(H, t) : t);
  let pBoom = null;
  if (finite(x.boomAt)) {
    const [lo, hi] = cdfRange(qs, x.boomAt);
    const below = (lo + hi) / 2;
    pBoom = platt(params?.boom, clamp01(1 - (H ? pitMap(H, below) : below)));
  }
  return { point, p10: onGrid(qs, level(0.1)), p90: onGrid(qs, level(0.9)), p_boom: pBoom, factor };
}

/**
 * Fit all three steps on samples [{ point, qs, boomAt, minutes, salary, actual }].
 * Returns params { point, pit: { knots, H }, boom: { a, b } }.
 */
export function fitCalibration(samples, { shrink = SHRINK_ROWS } = {}) {
  const point = fitPointFactors(samples, { shrink });
  const scaled = samples.filter(s => Array.isArray(s.qs) && finite(s.actual)).map(s => {
    const f = pointFactor(point, s);
    return { ...s, qs: s.qs.map(v => v * f) };
  });
  const H = fitPitMap(scaled);
  const boomRows = samples.filter(s => finite(s.boomAt) && Array.isArray(s.qs) && finite(s.actual));
  const mapped = boomRows.map(s => applyCalibration(s, { point, pit: { H } }).p_boom);
  const boom = fitPlatt(mapped, boomRows.map(s => (s.actual >= s.boomAt ? 1 : 0)));
  return { point, pit: { knots: PIT_KNOTS.slice(), H }, boom };
}

/** Uncalibrated prediction of a sample (the blend as served before this step). */
export const rawPrediction = (s) => ({ point: s.point, p10: s.p10, p90: s.p90, p_boom: s.pBoom, factor: 1 });

/**
 * Leave-one-date-out: each date's samples calibrated with params fit on the
 * other dates. Returns { predictions (aligned with samples), folds: [{ date, params }] }.
 */
export function crossValidate(samples, options = {}) {
  const dates = [...new Set(samples.map(s => s.date))].sort();
  const predictions = new Array(samples.length);
  const folds = [];
  for (const date of dates) {
    const params = fitCalibration(samples.filter(s => s.date !== date), options);
    folds.push({ date, params });
    samples.forEach((s, i) => { if (s.date === date) predictions[i] = applyCalibration(s, params); });
  }
  return { predictions, folds };
}

// ---------- evaluation ----------

function pointStats(list) {
  if (!list.length) return { n: 0, mae: null, rmse: null, bias: null };
  const e = list.map(([s, p]) => s.actual - p.point);
  return { n: list.length, mae: round(mean(e.map(Math.abs)), 3), rmse: round(Math.sqrt(mean(e.map(v => v * v))), 3), bias: round(mean(e), 3) };
}

/**
 * Metrics of predictions [{ point, p10, p90, p_boom }] against samples:
 * point (overall, by minutes band, by salary tier), coverage (at / below p10,
 * strictly below p10, at / above p90, and tie-aware rates where an outcome on
 * the DNP mass counts by the share of that mass beyond the line), boom
 * calibration buckets and Brier.
 */
export function evaluate(samples, predictions) {
  const pairs = samples.map((s, i) => [s, predictions[i]]).filter(([s, p]) => p && finite(p.point) && finite(s.actual));
  const by = (key) => {
    const groups = new Map();
    for (const pr of pairs) {
      const k = key(pr[0]);
      if (k === null) continue;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(pr);
    }
    return Object.fromEntries([...groups].sort(([a], [b]) => order(a) - order(b)).map(([k, list]) => [k, pointStats(list)]));
  };
  const ranged = pairs.filter(([, p]) => finite(p.p10) && finite(p.p90));
  const rate = (f) => (ranged.length ? round(mean(ranged.map(f)), 4) : null);
  // Tie-aware: P(actual below the line) with a tie on a flat stretch split by where the line sits in it
  const tieBelow = (s, line) => {
    const [lo, hi] = cdfRange(s.qs, s.actual);
    const at = cdfRange(s.qs, line);
    return hi - lo < 1e-9 ? (s.actual <= line ? 1 : 0) : pitBelow([lo, hi], (at[0] + at[1]) / 2);
  };
  const coverage = {
    n: ranged.length,
    belowP10: rate(([s, p]) => (s.actual <= p.p10 ? 1 : 0)),
    strictlyBelowP10: rate(([s, p]) => (s.actual < p.p10 ? 1 : 0)),
    aboveP90: rate(([s, p]) => (s.actual >= p.p90 ? 1 : 0)),
    tieAwareBelowP10: rate(([s, p]) => (Array.isArray(s.qs) ? tieBelow({ ...s, qs: s.qs.map(v => v * (p.factor ?? 1)) }, p.p10) : (s.actual <= p.p10 ? 1 : 0))),
    meanWidth: rate(([, p]) => p.p90 - p.p10)
  };
  const coverageBy = (key) => {
    const groups = new Map();
    for (const pr of ranged) {
      const k = key(pr[0]);
      if (k === null) continue;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(pr);
    }
    return Object.fromEntries([...groups].sort(([a], [b]) => order(a) - order(b)).map(([k, list]) => [k, {
      n: list.length,
      belowP10: round(mean(list.map(([s, p]) => (s.actual <= p.p10 ? 1 : 0))), 4),
      aboveP90: round(mean(list.map(([s, p]) => (s.actual >= p.p90 ? 1 : 0))), 4)
    }]));
  };
  const boomed = pairs.filter(([s, p]) => finite(p.p_boom) && finite(s.boomAt));
  const hit = ([s]) => (s.actual >= s.boomAt ? 1 : 0);
  const boom = {
    n: boomed.length,
    predicted: boomed.length ? round(mean(boomed.map(([, p]) => p.p_boom))) : null,
    actual: boomed.length ? round(mean(boomed.map(hit))) : null,
    brier: boomed.length ? round(mean(boomed.map(pr => (pr[1].p_boom - hit(pr)) ** 2)), 5) : null,
    buckets: BOOM_BUCKETS.map(([lo, hi], i) => {
      const last = i === BOOM_BUCKETS.length - 1;
      const list = boomed.filter(([, p]) => p.p_boom >= lo && (last ? p.p_boom <= hi : p.p_boom < hi));
      return { range: `${lo}-${hi}`, n: list.length, predicted: list.length ? round(mean(list.map(([, p]) => p.p_boom))) : null, actual: list.length ? round(mean(list.map(hit))) : null };
    })
  };
  return {
    point: { all: pointStats(pairs), byMinutes: by(s => minutesBand(s.minutes)), bySalary: by(s => salaryTier(s.salary)) },
    coverage: { ...coverage, byMinutes: coverageBy(s => minutesBand(s.minutes)), bySalary: coverageBy(s => salaryTier(s.salary)) },
    boom
  };
}

// '<15' < '15-24' < ... < '34+'; '<4K' < '4K-6K' < ... < '8K+'
function order(label) {
  const m = /^(<)?([\d.]+)/.exec(String(label));
  return m ? Number(m[2]) - (m[1] ? 1e-3 : 0) : Infinity;
}

// ---------- artifact ----------

/** The params artifact (null when unreadable / another version). */
export function readCalibrationParams(file = PARAMS_FILE) {
  try {
    const p = JSON.parse(fs.readFileSync(file, 'utf8'));
    return p?.version === PARAMS_VERSION && p.point && p.pit?.H ? p : null;
  } catch {
    return null;
  }
}

export function writeCalibrationParams(params, file = PARAMS_FILE) {
  fs.writeFileSync(file, `${JSON.stringify(params, null, 2)}\n`);
  return file;
}

export default {
  bandOf, minutesBand, salaryTier, onGrid, cdfRange, pitBelow, pointFactor, fitPointFactors, fitPitMap, pitMap, pitInverse,
  fitPlatt, platt, applyCalibration, fitCalibration, rawPrediction, crossValidate, evaluate, readCalibrationParams, writeCalibrationParams,
  PARAMS_FILE, PARAMS_VERSION, MINUTES_EDGES, SALARY_EDGES, SHRINK_ROWS, PIT_KNOTS, BOOM_BUCKETS
};
