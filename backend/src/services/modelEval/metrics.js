/**
 * Metrics for the model evaluation harness. Pure.
 *
 * Rows: { actual: { dk, minutes, pts, ... }, preds: { [projector]: Prediction | null }, ... }
 * Prediction: { dk_points, minutes?, stats?: { pts, reb, ... }, p10?, p90? }
 *
 * Point metrics reuse projectionBacktestService.computeErrorMetrics (MAE,
 * RMSE, bias, R^2, correlation).
 */

import { computeErrorMetrics } from '../projectionBacktestService.js';

const round = (v, d = 3) => (v === null || v === undefined || !Number.isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d);
const finite = (v) => typeof v === 'number' && Number.isFinite(v);

/** Linear-interpolated quantile of an ascending array. */
export function quantile(sorted, q) {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/** p10 / p90 calibration: % of actuals below p10, above p90 (target 10 / 10), within (80). */
export function coverage(samples) {
  const valid = samples.filter(s => finite(s.p10) && finite(s.p90) && finite(s.actual) && s.p90 >= s.p10);
  if (!valid.length) return { n: 0, belowP10: null, aboveP90: null, within: null, avgWidth: null };
  let below = 0, above = 0, width = 0;
  for (const s of valid) {
    if (s.actual < s.p10) below++;
    else if (s.actual > s.p90) above++;
    width += s.p90 - s.p10;
  }
  const pct = (x) => round((100 * x) / valid.length, 1);
  return { n: valid.length, belowP10: pct(below), aboveP90: pct(above), within: pct(valid.length - below - above), avgWidth: round(width / valid.length, 2) };
}

export const STATS = ['pts', 'reb', 'ast', 'stl', 'blk', 'tov', 'fg3m'];

/** Metrics of one projector over rows (rows it returned null for are skipped). */
export function scoreProjector(rows, name) {
  const withPred = rows.filter(r => finite(r.preds[name]?.dk_points));
  const points = computeErrorMetrics(withPred.map(r => ({ projected: r.preds[name].dk_points, actual: r.actual.dk })));
  const minuteRows = withPred.filter(r => finite(r.preds[name].minutes));
  const stats = {};
  for (const s of STATS) {
    const statRows = withPred.filter(r => finite(r.preds[name].stats?.[s]) && finite(r.actual[s]));
    if (statRows.length) {
      const m = computeErrorMetrics(statRows.map(r => ({ projected: r.preds[name].stats[s], actual: r.actual[s] })));
      stats[s] = { n: m.n, mae: m.mae, bias: m.bias };
    }
  }
  return {
    ...points,
    minutes: minuteRows.length
      ? computeErrorMetrics(minuteRows.map(r => ({ projected: r.preds[name].minutes, actual: r.actual.minutes })))
      : null,
    coverage: coverage(withPred.map(r => ({ p10: r.preds[name].p10, p90: r.preds[name].p90, actual: r.actual.dk }))),
    minutesCoverage: coverage(withPred.map(r => ({ p10: r.preds[name].minutes_p10, p90: r.preds[name].minutes_p90, actual: r.actual.minutes }))),
    stats: Object.keys(stats).length ? stats : null
  };
}

/** Small seeded PRNG (mulberry32) so bootstrap CIs are reproducible. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Paired MAE difference of projector a minus b (negative = a better) on rows
 * both project (field: 'dk' points or 'minutes'), with a percentile bootstrap 95% CI. cluster(row) resamples
 * whole groups (e.g. dates: player-games on one night are correlated).
 * Returns { n, clusters, diff, ci: [lo, hi], pBetter (share of resamples with a better) }.
 */
export function pairedBootstrap(rows, a, b, { iterations = 1000, seed = 1, cluster = null, field = 'dk' } = {}) {
  const pred = field === 'minutes' ? (r, name) => r.preds[name]?.minutes : (r, name) => r.preds[name]?.dk_points;
  const actual = field === 'minutes' ? (r) => r.actual.minutes : (r) => r.actual.dk;
  const both = rows.filter(r => finite(pred(r, a)) && finite(pred(r, b)));
  if (!both.length) return { n: 0, clusters: 0, diff: null, ci: [null, null], pBetter: null };
  const groups = new Map();
  both.forEach((r, i) => {
    const k = cluster ? cluster(r) : i;
    let g = groups.get(k);
    if (!g) groups.set(k, (g = { sum: 0, n: 0 }));
    g.sum += Math.abs(pred(r, a) - actual(r)) - Math.abs(pred(r, b) - actual(r));
    g.n += 1;
  });
  const list = [...groups.values()];
  const total = list.reduce((s, g) => s + g.sum, 0) / both.length;
  const rand = mulberry32(seed);
  const draws = [];
  for (let it = 0; it < iterations; it++) {
    let sum = 0, cnt = 0;
    for (let j = 0; j < list.length; j++) {
      const g = list[Math.floor(rand() * list.length)];
      sum += g.sum;
      cnt += g.n;
    }
    draws.push(sum / cnt);
  }
  draws.sort((x, y) => x - y);
  return {
    n: both.length,
    clusters: list.length,
    diff: round(total),
    ci: [round(quantile(draws, 0.025)), round(quantile(draws, 0.975))],
    pBetter: round(draws.filter(d => d < 0).length / draws.length)
  };
}

/**
 * Of the top `top` players by projected value (points per $1K) in each group
 * (slate), how many reached `multiple` x salary / 1000.
 * Returns { groups, picks, hits, rate, avgActualValue }.
 */
export function valueHitRate(rows, name, { top = 20, multiple = 5, group = r => r.slateId } = {}) {
  const byGroup = new Map();
  for (const r of rows) {
    const p = r.preds[name]?.dk_points;
    if (!finite(p) || !(r.salary > 0)) continue;
    const k = group(r);
    if (!byGroup.has(k)) byGroup.set(k, []);
    byGroup.get(k).push({ r, value: p / (r.salary / 1000) });
  }
  let picks = 0, hits = 0, actualValue = 0;
  for (const list of byGroup.values()) {
    for (const { r } of list.sort((x, y) => y.value - x.value).slice(0, top)) {
      picks++;
      const v = r.actual.dk / (r.salary / 1000);
      actualValue += v;
      if (v >= multiple) hits++;
    }
  }
  return { groups: byGroup.size, picks, hits, rate: picks ? round(hits / picks) : null, avgActualValue: picks ? round(actualValue / picks, 2) : null };
}

/** Share of all rows (with a salary) that reached the multiple: the value-hit base rate. */
export function baseHitRate(rows, { multiple = 5 } = {}) {
  const valid = rows.filter(r => r.salary > 0);
  return valid.length ? round(valid.filter(r => r.actual.dk / (r.salary / 1000) >= multiple).length / valid.length) : null;
}

/**
 * MAE / bias per group for each projector, points and minutes:
 * [{ group, n, mae: {name}, bias: {name}, minutesMae: {name}, minutesBias: {name} }].
 * order: preferred group order (others after, sorted).
 */
export function breakdown(rows, keyFn, names, order = null) {
  const groups = new Map();
  for (const r of rows) {
    const k = keyFn(r);
    if (k === null || k === undefined) continue;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  const keys = [...groups.keys()].sort((x, y) => {
    const ix = order ? order.indexOf(x) : -1;
    const iy = order ? order.indexOf(y) : -1;
    if (ix !== -1 || iy !== -1) return (ix === -1 ? Infinity : ix) - (iy === -1 ? Infinity : iy);
    return String(x) < String(y) ? -1 : 1;
  });
  return keys.map(k => {
    const list = groups.get(k);
    const mae = {};
    const bias = {};
    const minutesMae = {};
    const minutesBias = {};
    for (const name of names) {
      const m = computeErrorMetrics(list.map(r => ({ projected: r.preds[name]?.dk_points, actual: r.actual.dk })));
      mae[name] = m.mae;
      bias[name] = m.bias;
      const withMinutes = list.filter(r => finite(r.preds[name]?.minutes) && finite(r.actual.minutes));
      const mm = withMinutes.length ? computeErrorMetrics(withMinutes.map(r => ({ projected: r.preds[name].minutes, actual: r.actual.minutes }))) : null;
      minutesMae[name] = mm?.mae ?? null;
      minutesBias[name] = mm?.bias ?? null;
    }
    return { group: k, n: list.length, mae, bias, minutesMae, minutesBias };
  });
}

export default { quantile, coverage, scoreProjector, pairedBootstrap, valueHitRate, baseHitRate, breakdown, mulberry32 };
