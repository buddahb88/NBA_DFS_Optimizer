/**
 * MINUTES GAP CORRECTION (Q2). Pure: never reads the database except
 * readCorrectionParams (a JSON file).
 *
 * When RotoWire's projected minutes differ from ours, the actual minutes land
 * between the two (14 saved DK main slates: with RotoWire 3+ higher, about 2/3
 * of the way toward RotoWire). The correction moves our CONDITIONAL minutes
 * (minutes if he plays, minutes_v2's cond) toward RotoWire's posted minutes:
 *
 *   cond' = cond + f x (rotowire - cond),   f = factor(gap bucket, salary band)
 *
 * gap = rotowire - cond, bucketed by GAP_EDGES on each side ('rw higher 6+',
 * 'rw higher 3-6', 'close', 'rw lower 3-6', 'rw lower 6+'); salary band by
 * SALARY_EDGE ('<5K' / '5K+'). Our p_play is untouched; RotoWire at 0 / missing
 * minutes means no correction (OUT handling belongs to the injury layer).
 *
 * Fit (fitCorrection): per bucket, the f on FACTOR_GRID minimizing the
 * absolute minutes error of the PLAYED rows (cond is conditional on playing);
 * a bucket's f shrinks toward the global f and a cell's (bucket x band) toward
 * its bucket's, with SHRINK_ROWS pseudo-rows each. crossValidateCorrection
 * fits leave-one-slate-out (each slate's factors come from the other slates).
 *
 * Params ({ version, gapEdges, salaryEdge, global, buckets: { bucket: { n, raw,
 * f, bands: { band: { n, raw, f } } } }, live }) live in
 * minutesCorrectionParams.json, written by npm run backtest:minutes-correction
 * -- --write-params; `live` is true only when the corrected model beat own_mean
 * leave-one-slate-out (the live service applies the correction only then).
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PARAMS_FILE = path.join(__dirname, 'minutesCorrectionParams.json');
export const PARAMS_VERSION = '1';
export const GAP_EDGES = Object.freeze([3, 6]);
export const SALARY_EDGE = 5000;
export const FACTOR_GRID = Object.freeze(Array.from({ length: 21 }, (_, i) => i / 20));
export const SHRINK_ROWS = 30;
export const MAX_MINUTES = 48;
export const SALARY_BANDS = Object.freeze(['<5K', '5K+']);

const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const round = (v, d = 4) => (finite(v) ? Math.round(v * 10 ** d) / 10 ** d : null);

/** Gap bucket of rotowire - ours (null when not finite). */
export function gapBucket(gap, edges = GAP_EDGES) {
  if (!finite(gap)) return null;
  const a = Math.abs(gap);
  if (a < edges[0]) return 'close';
  const side = gap > 0 ? 'rw higher' : 'rw lower';
  return a >= edges[1] ? `${side} ${edges[1]}+` : `${side} ${edges[0]}-${edges[1]}`;
}

export const gapBuckets = (edges = GAP_EDGES) => [
  `rw lower ${edges[1]}+`, `rw lower ${edges[0]}-${edges[1]}`, 'close', `rw higher ${edges[0]}-${edges[1]}`, `rw higher ${edges[1]}+`
];

/** Salary band ('<5K' / '5K+'), null without a salary. */
export function salaryBand(salary, edge = SALARY_EDGE) {
  return finite(salary) && salary > 0 ? (salary < edge ? '<5K' : '5K+') : null;
}

/** The factor toward RotoWire for a { gap, salary } under params (0: no params / unknown). */
export function factorFor(params, { gap, salary }) {
  if (!params?.buckets) return 0;
  const bucket = params.buckets[gapBucket(gap, params.gapEdges ?? GAP_EDGES)];
  if (!bucket) return params.global ?? 0;
  const band = bucket.bands?.[salaryBand(salary, params.salaryEdge ?? SALARY_EDGE)];
  return band?.f ?? bucket.f ?? params.global ?? 0;
}

/**
 * Corrected conditional minutes of one player.
 * x: { cond (our conditional minutes), rotowire (posted minutes), salary }.
 * Returns { cond, applied, factor, gap, bucket, band } (cond unchanged when
 * there is nothing to correct toward).
 */
export function correctConditional(x, params) {
  const { cond, rotowire, salary } = x;
  const none = { cond, applied: false, factor: 0, gap: finite(rotowire) && finite(cond) ? rotowire - cond : null, bucket: null, band: salaryBand(salary) };
  if (!params?.buckets || !finite(cond) || !(cond > 0) || !finite(rotowire) || !(rotowire > 0)) return none;
  const gap = rotowire - cond;
  const factor = factorFor(params, { gap, salary });
  const corrected = Math.max(0, Math.min(MAX_MINUTES, cond + factor * gap));
  return { cond: corrected, applied: factor !== 0, factor, gap, bucket: gapBucket(gap, params.gapEdges ?? GAP_EDGES), band: salaryBand(salary, params.salaryEdge ?? SALARY_EDGE) };
}

function bestFactor(samples, grid = FACTOR_GRID) {
  let best = null;
  for (const f of grid) {
    let err = 0;
    for (const s of samples) err += Math.abs(s.cond + f * (s.rotowire - s.cond) - s.actual);
    if (!best || err < best.err - 1e-9) best = { f, err };
  }
  return best?.f ?? 0;
}

const shrunk = (n, raw, toward, k) => (n + k > 0 ? round((n * raw + k * toward) / (n + k)) : toward);

/** Samples a fit can use: played, positive conditional and RotoWire minutes, finite actual minutes. */
export const usable = (s) => s.played !== false && finite(s.actual) && s.actual > 0 && finite(s.cond) && s.cond > 0 && finite(s.rotowire) && s.rotowire > 0;

/**
 * Fit factors on samples [{ cond, rotowire, salary, actual, played }].
 * Returns params (without `live`).
 */
export function fitCorrection(samples, { gapEdges = GAP_EDGES, salaryEdge = SALARY_EDGE, shrink = SHRINK_ROWS, grid = FACTOR_GRID } = {}) {
  const valid = samples.filter(usable);
  const global = valid.length ? bestFactor(valid, grid) : 0;
  const buckets = {};
  for (const b of gapBuckets(gapEdges)) {
    const list = valid.filter(s => gapBucket(s.rotowire - s.cond, gapEdges) === b);
    const raw = list.length ? bestFactor(list, grid) : global;
    const f = shrunk(list.length, raw, global, shrink);
    const bands = {};
    for (const band of SALARY_BANDS) {
      const sub = list.filter(s => salaryBand(s.salary, salaryEdge) === band);
      const rawBand = sub.length ? bestFactor(sub, grid) : f;
      bands[band] = { n: sub.length, raw: rawBand, f: shrunk(sub.length, rawBand, f, shrink) };
    }
    buckets[b] = { n: list.length, raw, f, bands };
  }
  return { version: PARAMS_VERSION, gapEdges: [...gapEdges], salaryEdge, shrink, n: valid.length, global, buckets };
}

/**
 * Leave-one-slate-out factors. samples carry slateId. Returns { bySlate:
 * { slateId: params fit without that slate }, full: params on every slate,
 * stability: { global: { min, max }, cells: { 'bucket|band': { min, max } } } }.
 */
export function crossValidateCorrection(samples, options = {}) {
  const slates = [...new Set(samples.map(s => s.slateId))];
  const bySlate = {};
  for (const id of slates) bySlate[id] = fitCorrection(samples.filter(s => s.slateId !== id), options);
  const folds = Object.values(bySlate);
  const range = (xs) => ({ min: round(Math.min(...xs), 3), max: round(Math.max(...xs), 3) });
  const full = fitCorrection(samples, options);
  const cells = {};
  for (const [b, v] of Object.entries(full.buckets)) {
    for (const band of Object.keys(v.bands)) cells[`${b}|${band}`] = range(folds.map(p => p.buckets[b].bands[band].f));
  }
  return { bySlate, full, stability: { global: range(folds.map(p => p.global)), cells } };
}

/** Params from the JSON file, or null when missing / unreadable / another version. */
export function readCorrectionParams(file = PARAMS_FILE) {
  try {
    const p = JSON.parse(fs.readFileSync(file, 'utf8'));
    return p?.version === PARAMS_VERSION && p.buckets ? p : null;
  } catch {
    return null;
  }
}

export function writeCorrectionParams(params, file = PARAMS_FILE) {
  fs.writeFileSync(file, `${JSON.stringify(params, null, 2)}\n`);
  return file;
}

export default {
  gapBucket, gapBuckets, salaryBand, factorFor, correctConditional, fitCorrection, crossValidateCorrection,
  readCorrectionParams, writeCorrectionParams, PARAMS_FILE, GAP_EDGES, SALARY_EDGE, FACTOR_GRID, SHRINK_ROWS
};
