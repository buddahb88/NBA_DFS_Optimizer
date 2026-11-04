/**
 * MINUTES CORRECTION + MINUTES UPSIDE BACKTEST (Q2; npm run
 * backtest:minutes-correction). Read-only on the database.
 *
 *   1. own_mean on the saved main slates (harness, slate mode): our
 *      conditional minutes, RotoWire's posted minutes and the outcomes.
 *   2. Correction factors (minutesCorrection.js) fit leave-one-slate-out.
 *   3. own_mean_mincorr scored with each slate's out-of-fold factors, head to
 *      head with own_mean: MAE incl. DNP and played, minutes MAE, paired
 *      bootstrap (by row and by slate), by salary band and gap bucket.
 *   4. The minutes upside score (minutesUpside.js, on own_mean's rows): how
 *      well it ranks minutes spikes (actual >= our minutes + 8) and 6x games,
 *      all players and under $5K, against RotoWire's gap alone.
 * paramsArtifact(report) is what the live service reads
 * (minutesCorrectionParams.json): the factors fit on every slate, `live` only
 * when the corrected model won on both MAEs.
 */

import { runModelEval } from './modelEvalService.js';
import { summarizeRows } from './evaluate.js';
import { pairedBootstrap } from './metrics.js';
import { crossValidateCorrection, gapBucket, gapBuckets, salaryBand, SALARY_BANDS } from './minutesCorrection.js';
import { HIGH_UPSIDE, SPIKE_MINUTES } from './minutesUpside.js';

export const OWN = 'own_mean';
export const CORRECTED = 'own_mean_mincorr';
export const PROJECTORS = Object.freeze(['rotowire_raw', 'rotowire_adjusted', OWN]);
export const SCORE_BUCKETS = Object.freeze([[0, 25, '0-24'], [25, 50, '25-49'], [50, 75, '50-74'], [75, 101, '75+']]);
export const CHEAP = 5000;

const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const round = (v, d = 3) => (finite(v) ? Math.round(v * 10 ** d) / 10 ** d : null);
const mean = (xs) => (xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : null);

/** Correction samples from scored rows (own_mean + RotoWire's posted minutes). */
export function correctionSamples(rows, { own = OWN } = {}) {
  return rows.filter(r => r.preds?.[own] && finite(r.slate?.rotowireMinutes)).map(r => ({
    slateId: r.slateId,
    cond: r.preds[own].conditional_minutes,
    rotowire: r.slate.rotowireMinutes,
    salary: r.salary ?? r.slate?.salary ?? null,
    actual: r.actual?.minutes,
    played: r.played
  }));
}

/** Area under the ROC curve of scores for binary labels (ties count half); null without both classes. */
export function auc(scores, labels) {
  const pos = [], neg = [];
  scores.forEach((s, i) => (labels[i] ? pos : neg).push(s));
  if (!pos.length || !neg.length) return null;
  const all = [...pos.map(s => [s, 1]), ...neg.map(s => [s, 0])].sort((a, b) => a[0] - b[0]);
  // Mann-Whitney with average ranks
  let rankSum = 0;
  for (let i = 0; i < all.length;) {
    let j = i;
    while (j < all.length && all[j][0] === all[i][0]) j++;
    const avg = (i + j + 1) / 2;
    for (let k = i; k < j; k++) if (all[k][1]) rankSum += avg;
    i = j;
  }
  return (rankSum - pos.length * (pos.length + 1) / 2) / (pos.length * neg.length);
}

/**
 * Minutes upside evaluation on scored rows (own_mean predictions with
 * minutes_upside / rw_minutes_gap). Spike: actual minutes >= our point minutes
 * + SPIKE_MINUTES (DNP = 0: no spike); 6x: DK >= 6 x salary / 1000.
 */
export function upsideEvaluation(rows, { own = OWN, spike = SPIKE_MINUTES, high = HIGH_UPSIDE } = {}) {
  const scored = rows.filter(r => r.preds?.[own] && finite(r.preds[own].minutes_upside) && r.salary > 0 && !(r.preds[own].p_play === 0));
  const evaluate = (list) => {
    const isSpike = list.map(r => r.actual.minutes >= r.preds[own].minutes + spike);
    const isSix = list.map(r => r.actual.dk >= 6 * r.salary / 1000);
    const score = list.map(r => r.preds[own].minutes_upside);
    const gap = list.map(r => (finite(r.preds[own].rw_minutes_gap) ? r.preds[own].rw_minutes_gap : 0));
    const rate = (flags, idx) => (idx.length ? round(idx.filter(i => flags[i]).length / idx.length) : null);
    const all = list.map((_, i) => i);
    const order = [...all].sort((a, b) => score[b] - score[a]);
    const top = order.slice(0, Math.max(1, Math.round(list.length / 10)));
    const hi = all.filter(i => score[i] >= high);
    return {
      n: list.length,
      spikes: isSpike.filter(Boolean).length,
      sixX: isSix.filter(Boolean).length,
      base: { spike: rate(isSpike, all), sixX: rate(isSix, all) },
      auc: {
        spike: { score: round(auc(score, isSpike)), gap: round(auc(gap, isSpike)) },
        sixX: { score: round(auc(score, isSix)), gap: round(auc(gap, isSix)) }
      },
      topDecile: { n: top.length, spike: rate(isSpike, top), sixX: rate(isSix, top) },
      high: { threshold: high, n: hi.length, spike: rate(isSpike, hi), sixX: rate(isSix, hi) },
      buckets: SCORE_BUCKETS.map(([lo, hiEdge, label]) => {
        const idx = all.filter(i => score[i] >= lo && score[i] < hiEdge);
        return { bucket: label, n: idx.length, spike: rate(isSpike, idx), sixX: rate(isSix, idx) };
      }),
      // Of the spikes / 6x games, the share the score flagged (>= high)
      recall: {
        spike: isSpike.some(Boolean) ? round(hi.filter(i => isSpike[i]).length / isSpike.filter(Boolean).length) : null,
        sixX: isSix.some(Boolean) ? round(hi.filter(i => isSix[i]).length / isSix.filter(Boolean).length) : null
      }
    };
  };
  return { all: evaluate(scored), cheap: evaluate(scored.filter(r => r.salary < CHEAP)) };
}

/** MAE incl. DNP of a projector over rows (rows it covers). */
function mae(rows, name, field = 'dk') {
  const valid = rows.filter(r => finite(field === 'dk' ? r.preds[name]?.dk_points : r.preds[name]?.minutes));
  if (!valid.length) return null;
  const pred = (r) => (field === 'dk' ? r.preds[name].dk_points : r.preds[name].minutes);
  return round(mean(valid.map(r => Math.abs(pred(r) - (field === 'dk' ? r.actual.dk : r.actual.minutes)))));
}

/** MAE / minutes MAE of each projector by a row key (salary band, gap bucket, slate). */
function breakdown(rows, names, keyOf, order = null) {
  const groups = new Map();
  for (const r of rows) {
    const k = keyOf(r);
    if (k === null || k === undefined) continue;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  const keys = order ? order.filter(k => groups.has(k)) : [...groups.keys()].sort();
  return keys.map(k => ({
    key: k,
    n: groups.get(k).length,
    mae: Object.fromEntries(names.map(n => [n, mae(groups.get(k), n)])),
    minutesMae: Object.fromEntries(names.map(n => [n, mae(groups.get(k), n, 'minutes')]))
  }));
}

/**
 * Run the Q2 backtest. options: { iterations = 1000, cache = true, slateDates, onProgress }.
 */
export async function runMinutesCorrectionBacktest(options = {}) {
  const { iterations = 1000, cache = true, slateDates = null, onProgress = () => {} } = options;
  const t0 = Date.now();
  const base = await runModelEval({
    mode: 'slate', projectors: [...PROJECTORS], slateBaseline: 'rotowire_adjusted', comparisons: [], includeRows: true,
    iterations: 1, cache, slateDates, onProgress
  });
  const timings = { baseMs: Date.now() - t0 };
  const samples = correctionSamples(base.slate.rows);
  const cv = crossValidateCorrection(samples);

  let t = Date.now();
  const names = [...PROJECTORS, CORRECTED];
  const evalReport = await runModelEval({
    mode: 'slate', projectors: names, slateBaseline: 'rotowire_adjusted', comparisons: [[CORRECTED, OWN]], includeRows: true,
    projectorOptions: { [CORRECTED]: { correction: { bySlate: cv.bySlate } } },
    iterations, cache, slateDates, onProgress
  });
  timings.evalMs = Date.now() - t;
  const rows = evalReport.slate.rows;
  const common = rows.filter(r => names.every(n => r.preds[n]));
  const summary = summarizeRows(common, names, { baseline: OWN, iterations });
  const pick = (board) => board.map(b => ({ projector: b.projector, n: b.n, mae: b.mae, bias: b.bias, minutesMae: b.minutes?.mae ?? null }));
  const vsOwn = (subset, field) => pairedBootstrap(subset, CORRECTED, OWN, { iterations, field });
  const vsOwnBySlate = (subset, field) => pairedBootstrap(subset, CORRECTED, OWN, { iterations, field, cluster: r => r.slateId });
  const played = common.filter(r => r.played);
  const leaderboard = {
    common: common.length,
    withDnp: pick(summary.withDnp.leaderboard),
    played: pick(summary.played.leaderboard),
    paired: {
      withDnp: { rows: vsOwn(common), slates: vsOwnBySlate(common) },
      played: { rows: vsOwn(played), slates: vsOwnBySlate(played) },
      minutesPlayed: { rows: vsOwn(played, 'minutes'), slates: vsOwnBySlate(played, 'minutes') }
    }
  };
  const gapOf = (r) => gapBucket(r.preds[OWN]?.rw_minutes_gap);
  const breakdowns = {
    salaryBand: breakdown(common, names, r => salaryBand(r.salary), SALARY_BANDS),
    gapBucket: breakdown(common, names, gapOf, gapBuckets()),
    cheapGapBucket: breakdown(common.filter(r => r.salary < CHEAP), names, gapOf, gapBuckets()),
    slate: breakdown(common, [OWN, CORRECTED, 'rotowire_adjusted'], r => r.date)
  };
  const ownBoard = (b) => b.find(x => x.projector === OWN);
  const corrBoard = (b) => b.find(x => x.projector === CORRECTED);
  const wins = corrBoard(leaderboard.withDnp).mae < ownBoard(leaderboard.withDnp).mae
    && corrBoard(leaderboard.played).mae < ownBoard(leaderboard.played).mae;

  const report = {
    generatedAt: new Date().toISOString(),
    signature: evalReport.signature,
    site: evalReport.site,
    slates: evalReport.slate.slates.map(s => ({ date: s.date, slateId: s.slateId, players: s.players, played: s.played })),
    notes: [
      'Correction factors fit leave-one-slate-out on played rows (absolute minutes error): each slate is scored with factors from the other slates.',
      `Minutes upside: spike = actual minutes >= our (own_mean) point minutes + ${SPIKE_MINUTES}; 6x = DK >= 6 x salary / 1000; DNP = 0.`,
      'RotoWire minutes = the posted (raw) minutes; players ruled OUT and RotoWire at 0 minutes are not corrected.'
    ],
    correction: { samples: samples.filter(s => s.played && s.actual > 0).length, full: cv.full, stability: cv.stability, folds: cv.bySlate },
    leaderboard,
    breakdowns,
    wins,
    upside: upsideEvaluation(rows),
    timings
  };
  timings.totalMs = Date.now() - t0;
  return report;
}

/** The params file content (minutesCorrectionParams.json) from a report. */
export function paramsArtifact(report) {
  const board = (b, n) => b.find(x => x.projector === n);
  return {
    ...report.correction.full,
    live: Boolean(report.wins),
    generatedAt: report.generatedAt,
    signature: report.signature,
    slates: report.slates.map(s => `${s.date}:${s.slateId}`),
    looMae: {
      withDnp: { [OWN]: board(report.leaderboard.withDnp, OWN)?.mae, [CORRECTED]: board(report.leaderboard.withDnp, CORRECTED)?.mae },
      played: { [OWN]: board(report.leaderboard.played, OWN)?.mae, [CORRECTED]: board(report.leaderboard.played, CORRECTED)?.mae },
      minutesPlayed: { [OWN]: board(report.leaderboard.played, OWN)?.minutesMae, [CORRECTED]: board(report.leaderboard.played, CORRECTED)?.minutesMae }
    },
    stability: report.correction.stability
  };
}

export default { runMinutesCorrectionBacktest, paramsArtifact, upsideEvaluation, correctionSamples, auc };
