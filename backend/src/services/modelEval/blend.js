/**
 * OWN MODEL x ROTOWIRE BLEND (M4). Pure: works on scored harness rows (or the
 * live service's equivalent inputs) and never reads the database.
 *
 * Two kinds of blend, both with the weight w on RotoWire (sanity-adjusted):
 *   points   point = w x RotoWire + (1 - w) x our MEAN (own_mean.dk_points)
 *   minutes  our rates at conditional minutes w x RotoWire + (1 - w) x ours
 *            (own_mean.minutes_blend_means, simulated on a 0.1 grid; linear
 *            in between); our p_play stays.
 * w per segment of a scheme (SEGMENTERS: salary tier, minutes certainty,
 * minutes disagreement, teammate out, role change, or one global w). Weights
 * minimize absolute error incl. DNPs on the training rows; a segment's w is
 * shrunk toward the global w with SHRINK_ROWS pseudo-rows (8 slates are ~880
 * rows: few segments, heavy regularization).
 *
 * crossValidate fits leave-one-slate-out: each slate's blend uses weights fit
 * on the other slates only, so the scored blend never saw its own outcomes.
 *
 * Ranges: our mixture quantiles re-centered on the blended point (scaled by
 * point / our mean, shifted when our mean is under 1 point), then p10 / p90
 * and P(DK >= boom_at) from them; P(double-double) stays ours.
 *
 * disagreement: when ours and RotoWire differ by X+ (DK points or minutes),
 * how often the actual landed on our side of RotoWire (hit rate) and closer to
 * ours than to RotoWire.
 */

import { salaryTier } from '../projectionBacktestService.js';

export const OWN = 'own_mean';
export const ROTOWIRE = 'rotowire_adjusted';
export const POINTS_GRID = Object.freeze(Array.from({ length: 21 }, (_, i) => i / 20));
export const SHRINK_ROWS = 100;
export const UNCERTAIN_P_PLAY = 0.85;
export const ROLE_CHANGE = 0.34;

const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const round = (v, d = 3) => (finite(v) ? Math.round(v * 10 ** d) / 10 ** d : null);

/** Blend inputs of a harness row. */
export function blendInput(row, { own = OWN, rotowire = ROTOWIRE } = {}) {
  return {
    own: row.preds?.[own] ?? null,
    rw: row.preds?.[rotowire] ?? null,
    salary: row.salary ?? null,
    teammateOut: row.tags?.teammateOut ?? null
  };
}

/** Segment key of a blend input per scheme (null: no segment, the global w applies). */
export const SEGMENTERS = Object.freeze({
  global: () => 'all',
  salaryTier: (x) => (x.salary > 0 ? salaryTier(x.salary) : null),
  minutesCertainty: (x) => (finite(x.own?.p_play) ? (x.own.p_play < UNCERTAIN_P_PLAY ? 'uncertain' : 'certain') : null),
  minutesGap: (x) => {
    if (!finite(x.own?.minutes) || !finite(x.rw?.minutes)) return null;
    const gap = Math.abs(x.own.minutes - x.rw.minutes);
    return gap < 3 ? '<3' : gap < 6 ? '3-6' : '6+';
  },
  teammateOut: (x) => x.teammateOut,
  roleChange: (x) => (finite(x.own?.role_shift) ? (Math.abs(x.own.role_shift) >= ROLE_CHANGE ? 'role change' : 'stable') : null)
});

export const SCHEMES = Object.freeze(Object.keys(SEGMENTERS));
export const KINDS = Object.freeze(['points', 'minutes']);

/** Linear interpolation of values on an even grid over [0, 1]. */
function onGrid(values, w) {
  const pos = w * (values.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.min(values.length - 1, lo + 1);
  return values[lo] + (values[hi] - values[lo]) * (pos - lo);
}

/** Blended DK point of an input at weight w, or null when the kind cannot apply. */
export function candidate(kind, x, w) {
  if (!finite(x.own?.dk_points)) return null;
  if (!finite(x.rw?.dk_points)) return w === 0 ? x.own.dk_points : null;
  if (kind === 'points') return w * x.rw.dk_points + (1 - w) * x.own.dk_points;
  const means = x.own.minutes_blend_means;
  return Array.isArray(means) && means.length > 1 ? onGrid(means, w) : null;
}

const gridFor = (kind) => (kind === 'points' ? POINTS_GRID : POINTS_GRID.filter((_, i) => i % 2 === 0));

function bestWeight(kind, samples) {
  let best = null;
  for (const w of gridFor(kind)) {
    let err = 0;
    for (const s of samples) err += Math.abs(candidate(kind, s.x, w) - s.actual);
    if (!best || err < best.err - 1e-9) best = { w, err };
  }
  return best?.w ?? 0;
}

/**
 * Weights of one kind / scheme on samples [{ x: blendInput, actual: DK }].
 * Returns { kind, scheme, n, global, segments: { key: { n, raw, w } }, shrink }.
 */
export function fitWeights(samples, { kind = 'points', scheme = 'global', shrink = SHRINK_ROWS } = {}) {
  const valid = samples.filter(s => finite(s.actual) && finite(candidate(kind, s.x, 1)) && finite(candidate(kind, s.x, 0)));
  const global = valid.length ? bestWeight(kind, valid) : 0;
  const segments = {};
  if (scheme !== 'global') {
    const groups = new Map();
    for (const s of valid) {
      const k = SEGMENTERS[scheme](s.x);
      if (k === null || k === undefined) continue;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(s);
    }
    for (const [k, list] of groups) {
      const raw = bestWeight(kind, list);
      segments[k] = { n: list.length, raw, w: round((list.length * raw + shrink * global) / (list.length + shrink), 4) };
    }
  }
  return { kind, scheme, n: valid.length, global, segments, shrink };
}

/** The weight a blend input gets. */
export function weightFor(weights, x) {
  if (weights.scheme === 'global') return weights.global;
  const k = SEGMENTERS[weights.scheme](x);
  return weights.segments[k]?.w ?? weights.global;
}

/** Linear-interpolated value of quantiles at levels i / (length - 1). */
export function quantileAt(qs, tau) {
  return onGrid(qs, tau);
}

/** P(X >= x) from quantiles at even levels (linear CDF between them). */
export function exceedance(qs, x) {
  const step = 1 / (qs.length - 1);
  for (let i = 0; i < qs.length; i++) {
    if (qs[i] < x) continue;
    if (i === 0) return 1;
    const span = qs[i] - qs[i - 1];
    const cdf = (i - 1) * step + (span > 0 ? (x - qs[i - 1]) / span : 1) * step;
    return Math.max(0, Math.min(1, 1 - cdf));
  }
  return 0;
}

/**
 * Our distribution re-centered on `point`: { p10, p90, p_boom, boom_at, p_dd }.
 * Scaled by point / our mean (DNP mass stays at 0), shifted when our mean < 1.
 */
export function recenter(own, point) {
  const qs = own?.dk_quantiles;
  if (!Array.isArray(qs) || qs.length < 2 || !finite(point)) return {};
  const mean = own.dk_points;
  const scaled = mean >= 1 ? qs.map(v => v * point / mean) : qs.map(v => Math.max(0, v + point - mean));
  return {
    p10: quantileAt(scaled, 0.1),
    p90: quantileAt(scaled, 0.9),
    p_boom: finite(own.boom_at) ? exceedance(scaled, own.boom_at) : null,
    boom_at: own.boom_at ?? null,
    p_dd: own.p_dd ?? null
  };
}

/** Blended prediction of one input (null when ours is missing). */
export function blendPrediction(x, weights) {
  if (!finite(x.own?.dk_points)) return null;
  const hasRw = finite(x.rw?.dk_points);
  let w = hasRw ? weightFor(weights, x) : 0;
  let point = candidate(weights.kind, x, w);
  if (!finite(point)) { w = 0; point = x.own.dk_points; }
  const minutes = finite(x.rw?.minutes) && finite(x.own.minutes) ? w * x.rw.minutes + (1 - w) * x.own.minutes : x.own.minutes ?? null;
  return { dk_points: point, minutes, weight: w, ...recenter(x.own, point) };
}

const blendName = (kind, scheme) => `blend_${kind}_${scheme}`;

/**
 * Leave-one-slate-out blends. rows: scored slate rows with own and RotoWire
 * predictions. Returns { rows (copies with preds[blend_<kind>_<scheme>]),
 * names, folds: { name: [{ slateId, global, segments }] }, full: { name: weights
 * on every row }, stability: { name: { global: { min, max }, segments: { key: { min, max } } } } }.
 */
export function crossValidate(rows, { kinds = KINDS, schemes = SCHEMES, own = OWN, rotowire = ROTOWIRE, shrink = SHRINK_ROWS } = {}) {
  const out = rows.map(r => ({ ...r, preds: { ...r.preds } }));
  const samples = out.map(r => ({ r, x: blendInput(r, { own, rotowire }), actual: r.actual?.dk }));
  const slates = [...new Set(out.map(r => r.slateId))];
  const names = [];
  const folds = {};
  const full = {};
  const stability = {};
  for (const kind of kinds) {
    for (const scheme of schemes) {
      const name = blendName(kind, scheme);
      names.push(name);
      folds[name] = [];
      for (const slateId of slates) {
        const weights = fitWeights(samples.filter(s => s.r.slateId !== slateId), { kind, scheme, shrink });
        folds[name].push({ slateId, global: weights.global, segments: Object.fromEntries(Object.entries(weights.segments).map(([k, v]) => [k, v.w])) });
        for (const s of samples) if (s.r.slateId === slateId) s.r.preds[name] = blendPrediction(s.x, weights);
      }
      full[name] = fitWeights(samples, { kind, scheme, shrink });
      const range = (xs) => ({ min: round(Math.min(...xs), 3), max: round(Math.max(...xs), 3) });
      const keys = new Set(folds[name].flatMap(f => Object.keys(f.segments)));
      stability[name] = {
        global: range(folds[name].map(f => f.global)),
        segments: Object.fromEntries([...keys].map(k => [k, range(folds[name].map(f => f.segments[k]).filter(finite))]))
      };
    }
  }
  return { rows: out, names, folds, full, stability };
}

export const POINT_THRESHOLDS = Object.freeze([2, 4, 6, 8]);
export const MINUTE_THRESHOLDS = Object.freeze([2, 4, 6]);
export const LEAN_EDGES = Object.freeze([2, 4, 6]);

function callStats(list) {
  if (!list.length) return { n: 0, hitRate: null, closerRate: null, meanGap: null, meanEdge: null };
  let hit = 0, closer = 0, gap = 0, edge = 0;
  for (const c of list) {
    if (Math.sign(c.actual - c.rw) === Math.sign(c.ours - c.rw) && c.actual !== c.rw) hit++;
    if (Math.abs(c.ours - c.actual) < Math.abs(c.rw - c.actual)) closer++;
    gap += c.ours - c.rw;
    edge += c.actual - c.rw;
  }
  return { n: list.length, hitRate: round(hit / list.length), closerRate: round(closer / list.length), meanGap: round(gap / list.length, 2), meanEdge: round(edge / list.length, 2) };
}

/** Exclusive lean bucket of a gap (ours - RotoWire): 'higher 6+', 'higher 4-6', ..., 'agree'. */
export function leanBucket(gap, edges = LEAN_EDGES) {
  if (!finite(gap)) return null;
  const a = Math.abs(gap);
  if (a < edges[0]) return 'agree';
  const side = gap > 0 ? 'higher' : 'lower';
  for (let i = edges.length - 1; i >= 0; i--) {
    if (a >= edges[i]) return i === edges.length - 1 ? `${side} ${edges[i]}+` : `${side} ${edges[i]}-${edges[i + 1]}`;
  }
  return 'agree';
}

/**
 * Disagreement calls of ours vs RotoWire on scored rows (DNPs included: 0
 * points / minutes). points: ours = own dk_points (mean); minutes: ours =
 * own minutes (point). Returns { points: { cumulative, buckets, bySegment },
 * minutes: { cumulative, buckets } } where cumulative lists "ours higher /
 * lower by X+" calls and buckets the exclusive lean buckets (leanBucket), each
 * with { n, hitRate, closerRate, meanGap, meanEdge }.
 */
export function disagreement(rows, { own = OWN, rotowire = ROTOWIRE, segmentGap = 4 } = {}) {
  const calls = (field) => rows.map(r => {
    const x = blendInput(r, { own, rotowire });
    const ours = field === 'points' ? x.own?.dk_points : x.own?.minutes;
    const rw = field === 'points' ? x.rw?.dk_points : x.rw?.minutes;
    const actual = field === 'points' ? r.actual?.dk : r.actual?.minutes;
    return finite(ours) && finite(rw) && finite(actual) ? { ours, rw, actual, x } : null;
  }).filter(Boolean);
  const summarize = (list, thresholds) => ({
    // How often the actual lands above / below RotoWire at all: the hit rate a side gets for free
    base: list.length ? { actualAbove: round(list.filter(c => c.actual > c.rw).length / list.length), actualBelow: round(list.filter(c => c.actual < c.rw).length / list.length) } : null,
    cumulative: thresholds.flatMap(t => [
      { call: `ours higher by ${t}+`, threshold: t, side: 'higher', ...callStats(list.filter(c => c.ours - c.rw >= t)) },
      { call: `ours lower by ${t}+`, threshold: t, side: 'lower', ...callStats(list.filter(c => c.rw - c.ours >= t)) }
    ]),
    buckets: Object.fromEntries([...new Set(list.map(c => leanBucket(c.ours - c.rw)))].sort()
      .map(b => [b, callStats(list.filter(c => leanBucket(c.ours - c.rw) === b))]))
  });
  const points = calls('points');
  const big = points.filter(c => Math.abs(c.ours - c.rw) >= segmentGap);
  const bySegment = {};
  for (const scheme of ['salaryTier', 'minutesCertainty', 'teammateOut', 'roleChange']) {
    const keys = [...new Set(big.map(c => SEGMENTERS[scheme](c.x)).filter(k => k !== null && k !== undefined))].sort();
    bySegment[scheme] = Object.fromEntries(keys.map(k => {
      const seg = big.filter(c => SEGMENTERS[scheme](c.x) === k);
      return [k, { higher: callStats(seg.filter(c => c.ours > c.rw)), lower: callStats(seg.filter(c => c.ours < c.rw)) }];
    }));
  }
  return {
    points: { n: points.length, ...summarize(points, POINT_THRESHOLDS), segmentGap, bySegment },
    minutes: { n: calls('minutes').length, ...summarize(calls('minutes'), MINUTE_THRESHOLDS) }
  };
}

export default { blendInput, SEGMENTERS, SCHEMES, KINDS, candidate, fitWeights, weightFor, blendPrediction, recenter, crossValidate, disagreement, leanBucket, exceedance, quantileAt };
