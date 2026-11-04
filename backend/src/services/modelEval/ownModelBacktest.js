/**
 * OWN MODEL x ROTOWIRE BACKTEST (M4; npm run backtest:own-model). Read-only
 * on the database.
 *
 *   1. The saved main slates through the harness (runModelEval, slate mode):
 *      RotoWire raw / adjusted, rates_v1, own_mean (our mean) and, when the
 *      minutes correction is live (Q2), own_mean_mincorr with its factors fit
 *      leave-one-slate-out: the blends' "ours" is then the corrected model,
 *      as in the live service.
 *   2. Blends (blend.js), every kind x scheme, leave-one-slate-out: the
 *      leaderboard incl. DNP and played with paired bootstrap CIs vs
 *      rotowire_adjusted (by row, and by slate clusters), weight stability
 *      across folds; every candidate vs the current live weights (fixed) and
 *      vs the live scheme refit LOSO; bias by salary tier; a LOSO per tier
 *      bias correction on top of every blend (+tierBias). The chosen blend is
 *      the lowest LOO MAE incl. DNP (a selection among the candidates on the
 *      same rows: mildly optimistic).
 *   3. Disagreement calls (ours vs RotoWire): hit rates.
 *   4. Lineups (lineupBacktest.js) per slate for RotoWire raw / adjusted,
 *      ours, the live weights, the live scheme and the chosen blend
 *      (out-of-fold predictions).
 *   5. Optional replay check (options.replay): rates_v1's mean (dk_mean) vs its
 *      median point by season, from the cached predictions.
 * weightsArtifact(report) is what ownModelService reads (ownModelWeights.json):
 * the chosen blend's weights fit on every slate, and the disagreement buckets.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { computeErrorMetrics, salaryTier } from '../projectionBacktestService.js';
import { runModelEval, DEFAULT_CACHE_DIR } from './modelEvalService.js';
import { segmentBySeason, summarizeRows } from './evaluate.js';
import { pairedBootstrap, valueHitRate } from './metrics.js';
import { blendInput, blendPrediction, crossValidate, disagreement, OWN, ROTOWIRE } from './blend.js';
import { runLineupBacktest } from './lineupBacktest.js';
import { crossValidateCorrection, readCorrectionParams } from './minutesCorrection.js';
import { CORRECTED, correctionSamples } from './minutesCorrectionBacktest.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const WEIGHTS_FILE = path.join(__dirname, 'ownModelWeights.json');
export const WEIGHTS_VERSION = '1';
export const BASE_PROJECTORS = Object.freeze(['rotowire_raw', 'rotowire_adjusted', 'rates_v1', 'own_mean']);
/** The fixed weights currently in ownModelWeights.json, applied to the blend's "ours" (what the live service does). */
export const LIVE = 'live_weights';
export const TIER_BIAS_SHRINK = 100;

const round = (v, d = 3) => (Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d : null);

function slateMae(rows, names) {
  const bySlate = new Map();
  for (const r of rows) {
    if (!bySlate.has(r.slateId)) bySlate.set(r.slateId, []);
    bySlate.get(r.slateId).push(r);
  }
  return [...bySlate].map(([slateId, list]) => ({
    slateId,
    date: list[0].date,
    rows: list.length,
    mae: Object.fromEntries(names.map(n => {
      const valid = list.filter(r => r.preds[n]);
      return [n, valid.length ? round(valid.reduce((t, r) => t + Math.abs(r.preds[n].dk_points - r.actual.dk), 0) / valid.length) : null];
    }))
  }));
}

/** rates_v1 mean vs median in replay (by season / role), cached predictions. */
async function replayMeanCheck(options) {
  const report = await runModelEval({ ...options, mode: 'replay', projectors: ['rates_v1'], includeRows: true });
  return segmentBySeason(report.replay.rows, { train: ['2024-25'], validation: ['2025-26'] }).map(seg => {
    const score = (rows, field) => computeErrorMetrics(rows.filter(r => r.preds.rates_v1).map(r => ({ projected: r.preds.rates_v1[field], actual: r.actual.dk })));
    const pick = (m) => ({ n: m.n, mae: m.mae, bias: m.bias });
    const played = seg.rows.filter(r => r.played);
    return {
      season: seg.season, role: seg.role,
      median: { withDnp: pick(score(seg.rows, 'dk_points')), played: pick(score(played, 'dk_points')) },
      mean: { withDnp: pick(score(seg.rows, 'dk_mean')), played: pick(score(played, 'dk_mean')) }
    };
  });
}

/**
 * Per salary tier additive bias correction of a projector, leave-one-slate-out:
 * each slate's offset per tier = the median (stat 'median': MAE-optimal) or
 * mean (stat 'mean': removes the bias, keeps a mean point) residual (actual -
 * point) on the other slates' rows of that tier, shrunk toward 0 with
 * `shrink` pseudo-rows. Adds preds[`${name}+tierBias`] ('+tierMean' for the
 * mean) to rows (in place); returns { name, full }.
 */
export function tierBiasCorrection(rows, name, { shrink = TIER_BIAS_SHRINK, stat = 'median' } = {}) {
  const out = `${name}${stat === 'mean' ? '+tierMean' : '+tierBias'}`;
  const tierOf = (r) => (r.salary > 0 ? salaryTier(r.salary) : null);
  const center = (xs) => (stat === 'mean' ? (xs.length ? xs.reduce((t, v) => t + v, 0) / xs.length : 0) : median(xs));
  const median = (xs) => {
    const v = [...xs].sort((a, b) => a - b);
    if (!v.length) return 0;
    return v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2;
  };
  const fit = (subset) => {
    const groups = new Map();
    for (const r of subset) {
      const k = tierOf(r);
      if (!k || !Number.isFinite(r.preds[name]?.dk_points)) continue;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(r.actual.dk - r.preds[name].dk_points);
    }
    return Object.fromEntries([...groups].map(([k, res]) => [k, { n: res.length, offset: round(center(res) * res.length / (res.length + shrink)) }]));
  };
  for (const slateId of new Set(rows.map(r => r.slateId))) {
    const offsets = fit(rows.filter(r => r.slateId !== slateId));
    for (const r of rows) {
      if (r.slateId !== slateId || !r.preds[name]) continue;
      const off = offsets[tierOf(r)]?.offset ?? 0;
      r.preds[out] = { ...r.preds[name], dk_points: Math.max(0, r.preds[name].dk_points + off) };
    }
  }
  return { name: out, full: fit(rows) };
}

function readWeightsFile(file = WEIGHTS_FILE) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Run the M4 backtest. options: { iterations = 1000, cache = true, slateDates,
 * lineups = true, gpp = true, gppSeeds = 1, fieldSize, replay = false, onProgress,
 * own: the blend's "ours" (default own_mean_mincorr when minutesCorrectionParams.json
 * is live - as the live service - else own_mean), liveWeights: the weights file
 * content to compare against (default ownModelWeights.json; null: none),
 * lineupSources: extra lineup sources, tierBias: residual stats of the per tier
 * correction (default ['median']; [] skips it) }.
 * With own_mean_mincorr the correction factors are fit leave-one-slate-out
 * too (each slate corrected with factors from the other slates).
 */
export async function runOwnModelBacktest(options = {}) {
  const { iterations = 1000, cache = true, slateDates = null, lineups = true, gpp = true, gppSeeds = 1, fieldSize, replay = false, onProgress = () => {} } = options;
  const own = options.own ?? (readCorrectionParams()?.live ? CORRECTED : OWN);
  const liveWeights = options.liveWeights === undefined ? readWeightsFile() : options.liveWeights;
  const t0 = Date.now();
  let projectorOptions = {};
  let correction = null;
  if (own === CORRECTED) {
    const base = await runModelEval({
      mode: 'slate', projectors: [ROTOWIRE, OWN], slateBaseline: ROTOWIRE, comparisons: [], includeRows: true,
      iterations: 1, cache, slateDates, onProgress
    });
    const cvc = crossValidateCorrection(correctionSamples(base.slate.rows));
    projectorOptions = { [CORRECTED]: { correction: { bySlate: cvc.bySlate } } };
    correction = { loso: true, global: cvc.full.global, stability: cvc.stability };
  }
  const projectors = [...BASE_PROJECTORS, ...(own === OWN ? [] : [own])];
  const evalReport = await runModelEval({
    mode: 'slate', projectors, slateBaseline: ROTOWIRE, comparisons: [], includeRows: true,
    projectorOptions, iterations, cache, slateDates, onProgress
  });
  const rows = evalReport.slate.rows;
  const timings = { evalMs: Date.now() - t0 };

  let t = Date.now();
  const cv = crossValidate(rows, { own });
  // The current live weights (fixed, not refit) on the same "ours": in-sample on the slates they were fit on
  const live = liveWeights?.blend ?? null;
  if (live) {
    for (const r of cv.rows) {
      const p = blendPrediction(blendInput(r, { own }), live);
      if (p) r.preds[LIVE] = p;
    }
  }
  const liveScheme = live ? `blend_${live.kind}_${live.scheme}` : null;
  const names = [...projectors, ...(live ? [LIVE] : []), ...cv.names];
  // Per tier bias correction (LOSO) on top of every blend
  const tierBias = {};
  for (const stat of options.tierBias ?? ['median']) {
    for (const n of cv.names) {
      const tb = tierBiasCorrection(cv.rows, n, { stat });
      tierBias[tb.name] = tb.full;
      names.push(tb.name);
    }
  }
  const summary = summarizeRows(cv.rows, names, { baseline: ROTOWIRE, iterations });
  const common = cv.rows.filter(r => names.every(n => r.preds[n]));
  // Slate-clustered bootstrap (honest about night-to-night correlation)
  const bySlate = (subset, vs = ROTOWIRE) => names.filter(n => n !== vs)
    .map(n => ({ projector: n, vs, ...pairedBootstrap(subset, n, vs, { iterations, cluster: r => r.slateId }) }));
  const loo = { withDnp: summary.withDnp.leaderboard, played: summary.played.leaderboard };
  const blendBoard = summary.withDnp.leaderboard.filter(b => cv.names.includes(b.projector));
  const chosen = blendBoard[0]?.projector ?? null;
  // Every candidate vs the live weights and vs the live scheme refit LOSO
  const fitSlates = new Set(liveWeights?.slates ?? []);
  const unseen = common.filter(r => !fitSlates.has(`${r.date}:${r.slateId}`));
  const versus = (vs) => (vs && names.includes(vs) ? {
    vs,
    withDnp: bySlate(common, vs),
    played: bySlate(common.filter(r => r.played), vs),
    rows: names.filter(n => n !== vs).map(n => ({ projector: n, ...pairedBootstrap(common, n, vs, { iterations }) })),
    unseen: { rows: unseen.length, slates: new Set(unseen.map(r => r.slateId)).size, withDnp: bySlate(unseen, vs) }
  } : null);
  timings.blendMs = Date.now() - t;

  const tierTable = (b) => b?.map(g => ({ tier: g.group, n: g.n, mae: g.mae, bias: g.bias }));
  const report = {
    generatedAt: new Date().toISOString(),
    signature: evalReport.signature,
    site: evalReport.site,
    own,
    correction,
    slates: evalReport.slate.slates.map(s => ({ date: s.date, slateId: s.slateId, players: s.players, played: s.played })),
    notes: [
      ...evalReport.notes,
      `Blends on ${own}${own === CORRECTED ? ' (correction factors fit leave-one-slate-out; a blend fold\'s training slates carry factors that saw the held-out slate: mildly optimistic)' : ''}.`,
      'Blends: weights fit leave-one-slate-out (each slate scored with weights from the other slates); segment weights shrunk toward the global weight.',
      `Chosen blend = lowest LOO MAE incl. DNP among ${cv.names.length} candidates on the same rows (selection is mildly optimistic).`,
      live ? `${LIVE} = the current ownModelWeights.json (${live.name}, fit on ${fitSlates.size} slates) applied unchanged: in-sample on those slates; "unseen" = the other slates.` : 'No live weights file.',
      `+tierBias / +tierMean = the blend plus a per salary tier offset (median / mean residual on the other slates, shrunk with ${TIER_BIAS_SHRINK} pseudo-rows).`,
      'Lineups: ours / blend use out-of-fold predictions; ownership is the snapshot projection for every source.'
    ],
    leaderboard: {
      common: common.length,
      withDnp: loo.withDnp,
      played: loo.played,
      paired: { withDnp: summary.withDnp.paired, played: summary.played.paired },
      pairedBySlate: { withDnp: bySlate(common), played: bySlate(common.filter(r => r.played)) },
      vsLive: versus(live ? LIVE : null),
      vsLiveScheme: versus(liveScheme),
      breakdowns: { salaryTier: summary.withDnp.breakdowns.salaryTier, teammateOut: summary.withDnp.breakdowns.teammateOut },
      tiers: { withDnp: tierTable(summary.withDnp.breakdowns.salaryTier), played: tierTable(summary.played.breakdowns.salaryTier) },
      perSlate: slateMae(common, names),
      valueHit: names.map(n => ({ projector: n, ...valueHitRate(common, n) })).sort((a, b) => (b.rate ?? -1) - (a.rate ?? -1)),
      calibration: Object.fromEntries([...new Set([own, ...(chosen ? [chosen] : []), ...(live ? [LIVE] : []), ROTOWIRE])].map(n => {
        const s = summary.withDnp.leaderboard.find(b => b.projector === n);
        return [n, { coverage: s?.coverage, boom: s?.boom ? { n: s.boom.n, predicted: s.boom.predicted, observed: s.boom.observed, brier: s.boom.brier } : null }];
      }))
    },
    blend: {
      chosen,
      live: live ? { name: live.name, generatedAt: liveWeights.generatedAt, slates: liveWeights.slates } : null,
      weights: Object.fromEntries(cv.names.map(n => [n, cv.full[n]])),
      folds: cv.folds,
      stability: cv.stability,
      tierBias
    },
    disagreement: disagreement(rows, { own }),
    timings
  };

  if (lineups) {
    t = Date.now();
    const sources = [...new Set(['rotowire_raw', ROTOWIRE, own, ...(live ? [LIVE] : []), ...(liveScheme ? [liveScheme] : []), ...(chosen ? [chosen] : []), ...(options.lineupSources ?? [])])]
      .filter(n => names.includes(n));
    report.lineups = runLineupBacktest(cv.rows, sources, { gpp, gppSeeds, fieldSize, onSlate: s => onProgress(`lineups ${s.date} (${s.slateId})`) });
    timings.lineupsMs = Date.now() - t;
  }
  if (replay) {
    t = Date.now();
    report.replayMean = await replayMeanCheck({ iterations, cache, onProgress });
    timings.replayMs = Date.now() - t;
  }
  timings.totalMs = Date.now() - t0;
  return report;
}

/** The live service's weights file content from a backtest report. */
export function weightsArtifact(report, name = report.blend.chosen) {
  const own = report.own ?? OWN;
  return {
    version: WEIGHTS_VERSION,
    generatedAt: report.generatedAt,
    signature: report.signature,
    slates: report.slates.map(s => `${s.date}:${s.slateId}`),
    rotowire: ROTOWIRE,
    own,
    blend: name ? { name, ...report.blend.weights[name], stability: report.blend.stability[name] } : null,
    looMae: report.leaderboard.withDnp.filter(b => [name, ROTOWIRE, own].includes(b.projector)).map(b => ({ projector: b.projector, mae: b.mae })),
    disagreement: { points: report.disagreement.points.buckets, minutes: report.disagreement.minutes.buckets }
  };
}

export function writeWeights(report, file = WEIGHTS_FILE, name = report.blend.chosen) {
  fs.writeFileSync(file, `${JSON.stringify(weightsArtifact(report, name), null, 2)}\n`);
  return file;
}

export function writeOwnModelReport(report, file = null) {
  const out = file ?? path.join(DEFAULT_CACHE_DIR, 'reports', `own-model-${report.generatedAt.replace(/[:.]/g, '-')}.json`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(report, null, 2));
  return out;
}

export default { runOwnModelBacktest, weightsArtifact, writeWeights, writeOwnModelReport };
