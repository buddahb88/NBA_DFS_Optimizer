/**
 * BLEND CALIBRATION BACKTEST (npm run backtest:blend-calibration). Read-only on
 * the database.
 *
 *   1. Samples: the live own-model service (ownModelService, injury tag on,
 *      calibration off) on every saved DK slate with results - main slates
 *      first, then side slates' player-nights not already on that night's main
 *      slate (one row per player per night). OUT players are skipped; a player
 *      without a box score row counts as a DNP (0).
 *   2. blendCalibration.crossValidate: leave-one-date-out predictions.
 *   3. Before / after on the same rows: point MAE / RMSE / bias (overall, by
 *      minutes band, by salary tier), p10 / p90 coverage, boom buckets + Brier,
 *      and the Monte Carlo check: the share of hindsight-optimal players (top
 *      1 and the union of the top 10 lineups by actual DK points per main
 *      slate) whose actual reached p90.
 * paramsArtifact(report) is what the live service reads
 * (blendCalibrationParams.json): fit on every row, `live` only when the
 * out-of-sample calibration won on point MAE and boom Brier and brought p90
 * coverage closer to 10%.
 */

import db from '../../config/database.js';
import { resolveSlate } from '../slateSource.js';
import { solveWithHighs } from '../optimizer/solvers/highs.js';
import { projectSlateOwnModel } from './ownModelService.js';
import { crossValidate, evaluate, fitCalibration, rawPrediction, PARAMS_VERSION } from './blendCalibration.js';

const SLOTS = ['PG', 'SG', 'SF', 'PF', 'C', 'G', 'F', 'UTIL'];
const SALARY_CAP = 50000;
const TOP_LINEUPS = 10;

const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const isOut = (s) => /^(OUT|O)$/i.test(String(s ?? '').trim());

/** DK slots a position string fills. */
export function eligibleSlots(position) {
  const b = new Set(String(position ?? '').split(/[,/]/).map(s => s.trim()));
  const slots = ['PG', 'SG', 'SF', 'PF', 'C'].filter(x => b.has(x));
  if (b.has('PG') || b.has('SG')) slots.push('G');
  if (b.has('SF') || b.has('PF')) slots.push('F');
  slots.push('UTIL');
  return slots;
}

/** Saved DK slates with results (box scores for the date), main first per date. */
export async function savedSlates({ from = null, to = null, site = 'draftkings' } = {}) {
  return db.all(`
    SELECT c.game_date AS date, c.slate_id AS slateId, c.games, c.is_main AS main
    FROM slate_catalog c
    WHERE c.site = ? AND (? IS NULL OR c.game_date >= ?) AND (? IS NULL OR c.game_date <= ?)
      AND EXISTS (SELECT 1 FROM slate_player_snapshots s WHERE s.slate_id = c.slate_id)
      AND EXISTS (SELECT 1 FROM historical_games h WHERE h.game_date = c.game_date)
    ORDER BY c.game_date, c.is_main DESC, c.games DESC`, site, from, from, to, to);
}

/** Calibration samples from the own-model service on saved slates (see header). */
export async function buildSamples({ from = null, to = null, log = () => {} } = {}) {
  const slates = await savedSlates({ from, to });
  const samples = [];
  const seen = new Set();
  const used = [];
  for (const s of slates) {
    let source;
    try {
      source = await resolveSlate({ slateId: String(s.slateId), slateDate: s.date, site: 'draftkings' });
    } catch (e) {
      log(`skip ${s.date} ${s.slateId}: ${e.message}`);
      continue;
    }
    const res = await projectSlateOwnModel(String(s.slateId), { source, withQuantiles: true, calibration: false });
    let added = 0;
    for (const p of res.players) {
      if (!finite(p.blend_point) || !(p.blend_point > 0) || isOut(p.injury_status) || !Array.isArray(p.blend_quantiles)) continue;
      const key = `${s.date}|${p.player_key}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const a = await db.get('SELECT dk_fantasy_points AS dk, minutes FROM historical_games WHERE player_key = ? AND game_date = ?', p.player_key, s.date);
      samples.push({
        date: s.date, slateId: String(s.slateId), main: Boolean(s.main), key: p.player_key, name: p.name, position: p.position,
        salary: p.salary, minutes: p.ours_minutes, point: p.blend_point, p10: p.blend_p10, p90: p.blend_p90, pBoom: p.blend_p_boom,
        boomAt: p.boom_at, qs: p.blend_quantiles, tagApplied: p.tag_applied,
        actual: finite(a?.dk) ? a.dk : 0, actualMinutes: finite(a?.minutes) ? a.minutes : 0
      });
      added++;
    }
    used.push({ date: s.date, slateId: String(s.slateId), main: Boolean(s.main), games: s.games, rows: added });
    log(`${s.date} ${s.slateId} ${s.main ? 'main' : 'side'} ${s.games}g: ${added} rows`);
  }
  return { samples, slates: used };
}

/** Top-N distinct lineups by actual DK points (no-good cuts), as sample indexes. */
export function hindsightLineups(rows, { top = TOP_LINEUPS, solve = solveWithHighs } = {}) {
  const lineups = [];
  for (let k = 0; k < top; k++) {
    const m = { optimize: 'v', opType: 'max', constraints: { sal: { max: SALARY_CAP } }, variables: {}, ints: {} };
    for (const sl of SLOTS) m.constraints[`s_${sl}`] = { equal: 1 };
    rows.forEach((p, i) => {
      m.constraints[`p${i}`] = { max: 1 };
      for (const sl of eligibleSlots(p.position)) {
        const v = `x${i}_${sl}`;
        const o = { v: p.actual, sal: p.salary, [`s_${sl}`]: 1, [`p${i}`]: 1 };
        lineups.forEach((L, c) => { if (L.includes(i)) o[`cut${c}`] = 1; });
        m.variables[v] = o;
        m.ints[v] = 1;
      }
    });
    lineups.forEach((_, c) => { m.constraints[`cut${c}`] = { max: 7 }; });
    const r = solve(m);
    const ids = [];
    for (const [name, v] of Object.entries(r)) {
      const mm = /^x(\d+)_/.exec(name);
      if (mm && v > 0.5) ids.push(Number(mm[1]));
    }
    if (ids.length !== SLOTS.length) break;
    lineups.push(ids.sort((a, b) => a - b));
  }
  return lineups;
}

/** Share of hindsight-optimal players (top 1, top-N union) whose actual reached p90, per prediction set. */
export function optimalAboveP90(samples, predictionSets, { top = TOP_LINEUPS, solve } = {}) {
  const top1 = new Set(), topN = new Set();
  for (const slateId of [...new Set(samples.filter(s => s.main).map(s => s.slateId))]) {
    const idx = samples.map((s, i) => i).filter(i => samples[i].main && samples[i].slateId === slateId);
    const lineups = hindsightLineups(idx.map(i => samples[i]), { top, solve });
    lineups[0]?.forEach(j => top1.add(idx[j]));
    lineups.forEach(L => L.forEach(j => topN.add(idx[j])));
  }
  const share = (set, preds) => {
    const list = [...set].filter(i => finite(preds[i]?.p90));
    return list.length ? Math.round(1e4 * list.filter(i => samples[i].actual >= preds[i].p90).length / list.length) / 1e4 : null;
  };
  return Object.fromEntries(Object.entries(predictionSets).map(([name, preds]) => [name, {
    top1: { n: top1.size, aboveP90: share(top1, preds) },
    [`top${top}`]: { n: topN.size, aboveP90: share(topN, preds) }
  }]));
}

/** The whole backtest on samples: { rows, dates, before, after, mainBefore, mainAfter, optimal, folds, full }. */
export function runCalibration(samples, { solve, top = TOP_LINEUPS, shrink } = {}) {
  const raw = samples.map(rawPrediction);
  const cv = crossValidate(samples, shrink ? { shrink } : {});
  const main = samples.map((s, i) => i).filter(i => samples[i].main);
  const pick = (arr) => main.map(i => arr[i]);
  const mainSamples = main.map(i => samples[i]);
  const range = (xs) => ({ min: Math.min(...xs), max: Math.max(...xs) });
  return {
    rows: samples.length,
    mainRows: main.length,
    dates: [...new Set(samples.map(s => s.date))].length,
    before: evaluate(samples, raw),
    after: evaluate(samples, cv.predictions),
    mainBefore: evaluate(mainSamples, pick(raw)),
    mainAfter: evaluate(mainSamples, pick(cv.predictions)),
    optimal: optimalAboveP90(samples, { before: raw, after: cv.predictions }, { top, solve }),
    stability: {
      global: range(cv.folds.map(f => f.params.point.global)),
      boomB: range(cv.folds.map(f => f.params.boom.b)),
      h10: range(cv.folds.map(f => f.params.pit.H[2])),
      h90: range(cv.folds.map(f => f.params.pit.H[18]))
    },
    full: fitCalibration(samples, shrink ? { shrink } : {})
  };
}

/**
 * The live artifact: the fit on every row plus how it scored out of sample.
 * live when after beat before on point MAE and boom Brier and p90 coverage
 * moved closer to 0.10.
 */
export function paramsArtifact(report, { slates = [], generatedAt = new Date().toISOString() } = {}) {
  const b = report.before, a = report.after;
  const live = a.point.all.mae < b.point.all.mae && a.boom.brier < b.boom.brier
    && Math.abs(a.coverage.aboveP90 - 0.1) < Math.abs(b.coverage.aboveP90 - 0.1);
  return {
    version: PARAMS_VERSION,
    generatedAt,
    live,
    rows: report.rows,
    slates: slates.map(s => `${s.date}:${s.slateId}${s.main ? '' : ':side'}`),
    ...report.full,
    loo: {
      before: { mae: b.point.all.mae, rmse: b.point.all.rmse, bias: b.point.all.bias, belowP10: b.coverage.belowP10, aboveP90: b.coverage.aboveP90, brier: b.boom.brier },
      after: { mae: a.point.all.mae, rmse: a.point.all.rmse, bias: a.point.all.bias, belowP10: a.coverage.belowP10, aboveP90: a.coverage.aboveP90, brier: a.boom.brier }
    }
  };
}

export default { savedSlates, buildSamples, hindsightLineups, optimalAboveP90, runCalibration, paramsArtifact, eligibleSlots };
