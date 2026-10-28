/**
 * OWN MODEL x ROTOWIRE BACKTEST (M4; npm run backtest:own-model). Read-only
 * on the database.
 *
 *   1. The saved main slates through the harness (runModelEval, slate mode):
 *      RotoWire raw / adjusted, rates_v1, own_mean (our mean).
 *   2. Blends (blend.js), every kind x scheme, leave-one-slate-out: the
 *      leaderboard incl. DNP and played with paired bootstrap CIs vs
 *      rotowire_adjusted (by row, and by slate: 8 clusters), weight stability
 *      across folds. The chosen blend is the lowest LOO MAE incl. DNP (a
 *      selection among the candidates on the same rows: mildly optimistic).
 *   3. Disagreement calls (ours vs RotoWire): hit rates.
 *   4. Lineups (lineupBacktest.js) per slate for RotoWire raw / adjusted,
 *      ours and the chosen blend (out-of-fold predictions).
 *   5. Optional replay check (options.replay): rates_v1's mean (dk_mean) vs its
 *      median point by season, from the cached predictions.
 * weightsArtifact(report) is what ownModelService reads (ownModelWeights.json):
 * the chosen blend's weights fit on every slate, and the disagreement buckets.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { computeErrorMetrics } from '../projectionBacktestService.js';
import { runModelEval, DEFAULT_CACHE_DIR } from './modelEvalService.js';
import { segmentBySeason, summarizeRows } from './evaluate.js';
import { pairedBootstrap, valueHitRate } from './metrics.js';
import { crossValidate, disagreement, OWN, ROTOWIRE } from './blend.js';
import { runLineupBacktest } from './lineupBacktest.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const WEIGHTS_FILE = path.join(__dirname, 'ownModelWeights.json');
export const WEIGHTS_VERSION = '1';
export const BASE_PROJECTORS = Object.freeze(['rotowire_raw', 'rotowire_adjusted', 'rates_v1', 'own_mean']);

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
 * Run the M4 backtest. options: { iterations = 1000, cache = true, slateDates,
 * lineups = true, gpp = true, gppSeeds = 1, fieldSize, replay = false, onProgress }.
 */
export async function runOwnModelBacktest(options = {}) {
  const { iterations = 1000, cache = true, slateDates = null, lineups = true, gpp = true, gppSeeds = 1, fieldSize, replay = false, onProgress = () => {} } = options;
  const t0 = Date.now();
  const evalReport = await runModelEval({
    mode: 'slate', projectors: [...BASE_PROJECTORS], slateBaseline: ROTOWIRE, comparisons: [], includeRows: true,
    iterations, cache, slateDates, onProgress
  });
  const rows = evalReport.slate.rows;
  const timings = { evalMs: Date.now() - t0 };

  let t = Date.now();
  const cv = crossValidate(rows);
  const names = [...BASE_PROJECTORS, ...cv.names];
  const summary = summarizeRows(cv.rows, names, { baseline: ROTOWIRE, iterations });
  const common = cv.rows.filter(r => names.every(n => r.preds[n]));
  // 8 slates: a slate-clustered bootstrap too (coarse, but honest about night-to-night correlation)
  const bySlate = (subset) => names.filter(n => n !== ROTOWIRE)
    .map(n => ({ projector: n, vs: ROTOWIRE, ...pairedBootstrap(subset, n, ROTOWIRE, { iterations, cluster: r => r.slateId }) }));
  const loo = { withDnp: summary.withDnp.leaderboard, played: summary.played.leaderboard };
  const blendBoard = summary.withDnp.leaderboard.filter(b => cv.names.includes(b.projector));
  const chosen = blendBoard[0]?.projector ?? null;
  timings.blendMs = Date.now() - t;

  const report = {
    generatedAt: new Date().toISOString(),
    signature: evalReport.signature,
    site: evalReport.site,
    slates: evalReport.slate.slates.map(s => ({ date: s.date, slateId: s.slateId, players: s.players, played: s.played })),
    notes: [
      ...evalReport.notes,
      'Blends: weights fit leave-one-slate-out (each slate scored with weights from the other slates); segment weights shrunk toward the global weight.',
      `Chosen blend = lowest LOO MAE incl. DNP among ${cv.names.length} candidates on the same rows (selection is mildly optimistic).`,
      'Lineups: ours / blend use out-of-fold predictions; ownership is the snapshot projection for every source.'
    ],
    leaderboard: {
      common: common.length,
      withDnp: loo.withDnp,
      played: loo.played,
      paired: { withDnp: summary.withDnp.paired, played: summary.played.paired },
      pairedBySlate: { withDnp: bySlate(common), played: bySlate(common.filter(r => r.played)) },
      breakdowns: { salaryTier: summary.withDnp.breakdowns.salaryTier, teammateOut: summary.withDnp.breakdowns.teammateOut },
      perSlate: slateMae(common, names),
      valueHit: names.map(n => ({ projector: n, ...valueHitRate(common, n) })).sort((a, b) => (b.rate ?? -1) - (a.rate ?? -1)),
      calibration: Object.fromEntries([OWN, ...(chosen ? [chosen] : []), 'rotowire_adjusted'].map(n => {
        const s = summary.withDnp.leaderboard.find(b => b.projector === n);
        return [n, { coverage: s?.coverage, boom: s?.boom ? { n: s.boom.n, predicted: s.boom.predicted, observed: s.boom.observed, brier: s.boom.brier } : null }];
      }))
    },
    blend: {
      chosen,
      weights: Object.fromEntries(cv.names.map(n => [n, cv.full[n]])),
      folds: cv.folds,
      stability: cv.stability
    },
    disagreement: disagreement(rows),
    timings
  };

  if (lineups) {
    t = Date.now();
    const sources = ['rotowire_raw', 'rotowire_adjusted', OWN, ...(chosen ? [chosen] : [])];
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
export function weightsArtifact(report) {
  const name = report.blend.chosen;
  return {
    version: WEIGHTS_VERSION,
    generatedAt: report.generatedAt,
    signature: report.signature,
    slates: report.slates.map(s => `${s.date}:${s.slateId}`),
    rotowire: ROTOWIRE,
    blend: name ? { name, ...report.blend.weights[name], stability: report.blend.stability[name] } : null,
    looMae: report.leaderboard.withDnp.filter(b => [name, ROTOWIRE, OWN].includes(b.projector)).map(b => ({ projector: b.projector, mae: b.mae })),
    disagreement: { points: report.disagreement.points.buckets, minutes: report.disagreement.minutes.buckets }
  };
}

export function writeWeights(report, file = WEIGHTS_FILE) {
  fs.writeFileSync(file, `${JSON.stringify(weightsArtifact(report), null, 2)}\n`);
  return file;
}

export function writeOwnModelReport(report, file = null) {
  const out = file ?? path.join(DEFAULT_CACHE_DIR, 'reports', `own-model-${report.generatedAt.replace(/[:.]/g, '-')}.json`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(report, null, 2));
  return out;
}

export default { runOwnModelBacktest, weightsArtifact, writeWeights, writeOwnModelReport };
