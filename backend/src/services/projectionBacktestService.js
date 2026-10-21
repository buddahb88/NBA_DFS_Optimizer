/**
 * PROJECTION BACKTEST SERVICE
 *
 * Measures how good our projections are. Read-only: it never changes
 * projections, it only joins what we projected (slate_player_snapshots, which
 * survive slate resyncs) against what actually happened (the site's
 * historical_games fantasy points column) on (player_key, game_date) and
 * scores it. RotoWire-only fields (rotowire_projection, raw_data, rest/DvP
 * inputs) are not snapshotted; they come from the live players row while the
 * slate is still loaded, so the RotoWire comparison and factor attribution
 * only cover those rows.
 *
 * Metrics:
 *   - MAE, RMSE, bias (mean projected - actual), R^2, Pearson correlation
 *   - Floor/ceiling calibration (pct of actuals below floor / above ceiling)
 *   - Breakdowns by salary tier and position
 *   - Comparison against the raw RotoWire projection (rotowire_projection
 *     column, falling back to raw_data.pts) to see if our adjustments help
 *   - Per-factor attribution for the stateless adjustment factors in
 *     projectionService (defense, dvp, pace, rest, vegas, blowout), plus
 *     dvp_legacy (the old points-allowed DVP) to compare against dvp
 *
 * The pure metric functions are exported separately so they can be unit
 * tested without a database.
 */

import db from '../config/database.js';
import { DEFAULT_SITE, getSiteConfig } from '../config/sites.js';
import projectionService from './projectionService.js';
import { fantasyPointsColumn } from './scoring.js';
import { playerKey } from '../utils/playerKey.js';

// Salary tiers per site. FanDuel and Yahoo break at the same share of the
// cap as DraftKings' 4K/6K/8K on $50K (8%, 12%, 16%): 4.8K/7.2K/9.6K on
// FanDuel's $60K and $16/$24/$32 on Yahoo's $200. A tier runs from its min up
// to the next tier's min.
export const SALARY_TIERS_BY_SITE = Object.freeze({
  draftkings: [
    { label: '<4K', min: 0 },
    { label: '4K-5.9K', min: 4000 },
    { label: '6K-7.9K', min: 6000 },
    { label: '8K+', min: 8000 }
  ],
  fanduel: [
    { label: '<4.8K', min: 0 },
    { label: '4.8K-7.1K', min: 4800 },
    { label: '7.2K-9.5K', min: 7200 },
    { label: '9.6K+', min: 9600 }
  ],
  yahoo: [
    { label: '<$16', min: 0 },
    { label: '$16-23', min: 16 },
    { label: '$24-31', min: 24 },
    { label: '$32+', min: 32 }
  ]
});

export const SALARY_TIERS = SALARY_TIERS_BY_SITE[DEFAULT_SITE];

export const salaryTiers = (site) => SALARY_TIERS_BY_SITE[getSiteConfig(site).key];

export const DK_POSITIONS = ['PG', 'SG', 'SF', 'PF', 'C'];

// A factor's marginal value is only reported as harmful/helpful when it moves
// at least this many player-games and changes MAE by at least this much.
const MIN_FACTOR_SAMPLES = 30;
const MIN_FACTOR_MAE_DELTA = 0.05;

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

const round = (v, d = 3) => (v === null || v === undefined || !Number.isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d);

const toNum = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * Normalize a player name for cross-source matching (diacritics, punctuation,
 * suffixes like Jr./III).
 */
export function normalizePlayerName(name) {
  if (!name) return '';
  return String(name)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[.'’`-]/g, '')
    .replace(/\b(jr|sr|ii|iii|iv|v)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseRawData(raw) {
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

const DATE_RE = /(\d{4}-\d{2}-\d{2})/;

// Azure SQL returns DATE columns as Date objects (UTC midnight)
const toDateStr = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : v ? String(v).slice(0, 10) : null);

/**
 * Determine the game date (YYYY-MM-DD) a players row was projected for.
 * Prefers RotoWire's game.dateTime in raw_data, then game_info, then the
 * slate start_time.
 */
export function resolveGameDate(row, raw = parseRawData(row.raw_data)) {
  const candidates = [
    raw?.game?.dateTime,
    raw?.game?.date,
    row.game_info,
    row.slate_start_time
  ];
  for (const c of candidates) {
    if (!c) continue;
    if (c instanceof Date) return c.toISOString().slice(0, 10);
    const m = String(c).match(DATE_RE);
    if (m) return m[1];
  }
  return null;
}

/**
 * Raw RotoWire projection for a row: rotowire_projection column (set when our
 * adjustments overwrite projected_points), else the original pts in raw_data.
 */
export function resolveRawProjection(row, raw = parseRawData(row.raw_data)) {
  const stored = toNum(row.rotowire_projection);
  if (stored !== null) return stored;
  return toNum(raw?.pts ?? raw?.points ?? raw?.proj);
}

export function salaryTier(salary, site = DEFAULT_SITE) {
  const s = toNum(salary);
  if (s === null || s < 0) return 'unknown';
  return salaryTiers(site).findLast(t => s >= t.min).label;
}

/**
 * Error metrics for a list of { projected, actual } pairs.
 */
export function computeErrorMetrics(pairs) {
  const valid = pairs.filter(p => Number.isFinite(p.projected) && Number.isFinite(p.actual));
  const n = valid.length;
  if (n === 0) {
    return { n: 0, mae: null, rmse: null, bias: null, r2: null, correlation: null, meanProjected: null, meanActual: null };
  }

  let sumAbs = 0, sumSq = 0, sumErr = 0, sumP = 0, sumA = 0;
  for (const { projected, actual } of valid) {
    const err = projected - actual;
    sumAbs += Math.abs(err);
    sumSq += err * err;
    sumErr += err;
    sumP += projected;
    sumA += actual;
  }
  const meanP = sumP / n;
  const meanA = sumA / n;

  let ssTot = 0, cov = 0, varP = 0;
  for (const { projected, actual } of valid) {
    ssTot += (actual - meanA) ** 2;
    cov += (projected - meanP) * (actual - meanA);
    varP += (projected - meanP) ** 2;
  }

  return {
    n,
    mae: round(sumAbs / n),
    rmse: round(Math.sqrt(sumSq / n)),
    bias: round(sumErr / n),
    // Coefficient of determination of the projection as-is (can be negative
    // if the projection is worse than predicting the mean).
    r2: ssTot > 0 ? round(1 - sumSq / ssTot) : null,
    correlation: varP > 0 && ssTot > 0 ? round(cov / Math.sqrt(varP * ssTot)) : null,
    meanProjected: round(meanP),
    meanActual: round(meanA)
  };
}

/**
 * Floor/ceiling calibration: how often actual results land outside the range.
 */
export function computeCalibration(samples) {
  const valid = samples.filter(s => Number.isFinite(s.floor) && Number.isFinite(s.ceiling) && Number.isFinite(s.actual) && s.ceiling >= s.floor);
  const n = valid.length;
  if (n === 0) {
    return { n: 0, pctBelowFloor: null, pctAboveCeiling: null, pctWithinRange: null, avgRangeWidth: null };
  }
  let below = 0, above = 0, width = 0;
  for (const s of valid) {
    if (s.actual < s.floor) below++;
    else if (s.actual > s.ceiling) above++;
    width += s.ceiling - s.floor;
  }
  return {
    n,
    pctBelowFloor: round((below / n) * 100, 1),
    pctAboveCeiling: round((above / n) * 100, 1),
    pctWithinRange: round(((n - below - above) / n) * 100, 1),
    avgRangeWidth: round(width / n, 2)
  };
}

function summarizeGroup(samples) {
  const adjusted = computeErrorMetrics(samples.map(s => ({ projected: s.projected, actual: s.actual })));
  const withRaw = samples.filter(s => Number.isFinite(s.rawProjection));
  const rawMetrics = computeErrorMetrics(withRaw.map(s => ({ projected: s.rawProjection, actual: s.actual })));
  const adjustedSameRows = computeErrorMetrics(withRaw.map(s => ({ projected: s.projected, actual: s.actual })));
  return {
    ...adjusted,
    calibration: computeCalibration(samples),
    rotowire: rawMetrics.n > 0
      ? {
        ...rawMetrics,
        // Positive = our projection has lower MAE than raw RotoWire on the same rows
        maeImprovement: adjustedSameRows.mae !== null ? round(rawMetrics.mae - adjustedSameRows.mae) : null
      }
      : null
  };
}

export function breakdownBy(samples, keyFn, order = null) {
  const groups = new Map();
  for (const s of samples) {
    const keys = [].concat(keyFn(s)).filter(Boolean);
    for (const k of keys) {
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(s);
    }
  }
  const keys = order ? order.filter(k => groups.has(k)).concat([...groups.keys()].filter(k => !order.includes(k))) : [...groups.keys()].sort();
  return keys.map(k => ({ group: k, ...summarizeGroup(groups.get(k)) }));
}

/**
 * DK positions a player is eligible at (e.g. "PG,G,UTIL" -> ['PG']).
 * Multi-eligible players count toward each of their base positions.
 */
export function basePositions(position) {
  if (!position) return [];
  const parts = String(position).split(/[,/]/).map(p => p.trim().toUpperCase());
  const base = parts.filter(p => DK_POSITIONS.includes(p));
  return base.length ? [...new Set(base)] : ['other'];
}

/**
 * Marginal value of each adjustment factor on top of the raw RotoWire
 * projection. For factor f with adjustment a_f:
 *   - maeRaw vs maeWithFactor: does raw + a_f beat raw on rows where a_f != 0?
 *   - correlation of a_f with the raw residual (actual - raw): >0 means the
 *     factor points the right way
 *   - optimalScale: least-squares multiplier k minimising (resid - k*a_f)^2.
 *     ~1 = well weighted, 0..1 = overweighted, <0 = points the wrong way.
 */
export function analyzeFactors(samples, factorNames) {
  const results = [];
  for (const factor of factorNames) {
    const rows = samples.filter(s => Number.isFinite(s.rawProjection) && Number.isFinite(s.factors?.[factor]) && s.factors[factor] !== 0);
    const n = rows.length;
    if (n === 0) {
      results.push({ factor, n: 0, verdict: 'no data' });
      continue;
    }
    let absRaw = 0, absWith = 0, sumAdj = 0, sumRes = 0, sxy = 0, sxx = 0;
    for (const s of rows) {
      const a = s.factors[factor];
      const resid = s.actual - s.rawProjection;
      absRaw += Math.abs(resid);
      absWith += Math.abs(resid - a);
      sumAdj += a;
      sumRes += resid;
      sxy += a * resid;
      sxx += a * a;
    }
    const meanA = sumAdj / n;
    const meanR = sumRes / n;
    let cov = 0, va = 0, vr = 0;
    for (const s of rows) {
      const a = s.factors[factor] - meanA;
      const r = (s.actual - s.rawProjection) - meanR;
      cov += a * r;
      va += a * a;
      vr += r * r;
    }
    const maeRaw = absRaw / n;
    const maeWith = absWith / n;
    const delta = maeRaw - maeWith; // positive = factor helps
    let verdict = 'inconclusive (small sample)';
    if (n >= MIN_FACTOR_SAMPLES) {
      if (delta <= -MIN_FACTOR_MAE_DELTA) verdict = 'harmful';
      else if (delta >= MIN_FACTOR_MAE_DELTA) verdict = 'helpful';
      else verdict = 'neutral';
    }
    results.push({
      factor,
      n,
      meanAdjustment: round(meanA),
      maeRaw: round(maeRaw),
      maeWithFactor: round(maeWith),
      maeImprovement: round(delta),
      correlationWithResidual: va > 0 && vr > 0 ? round(cov / Math.sqrt(va * vr)) : null,
      optimalScale: sxx > 0 ? round(sxy / sxx) : null,
      verdict
    });
  }
  return results;
}

/**
 * Join projection rows to actual results on (player_key, game_date). Rows
 * without player_key / game_date (e.g. plain players rows) fall back to
 * playerKey(name) and the date resolved from raw_data / game_info.
 * @param {Array} playerRows - snapshot rows (optionally merged with live players fields)
 * @param {Array} gameRows - rows from historical_games
 * @param {Object} [options] - { factorFn, pointsColumn = 'dk_fantasy_points' }
 * @returns {{ samples: Array, unmatched: number, skipped: number }}
 */
export function joinProjectionsToActuals(playerRows, gameRows, { factorFn = null, pointsColumn = 'dk_fantasy_points' } = {}) {
  const actualIndex = new Map();
  for (const g of gameRows) {
    const key = `${g.player_key || playerKey(g.player_name)}|${toDateStr(g.game_date)}`;
    if (!actualIndex.has(key)) actualIndex.set(key, []);
    actualIndex.get(key).push(g);
  }

  const samples = [];
  let unmatched = 0, skipped = 0;
  const seen = new Set();

  for (const row of playerRows) {
    const raw = parseRawData(row.raw_data);
    const date = toDateStr(row.game_date) || resolveGameDate(row, raw);
    const projected = toNum(row.projected_points);
    if (!date || projected === null || projected <= 0) {
      skipped++;
      continue;
    }

    // Same player can appear on multiple slates for the same date; score once.
    const dedupeKey = `${row.player_key || playerKey(row.name)}|${date}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    let candidates = actualIndex.get(dedupeKey) || [];
    if (candidates.length > 1 && row.team) {
      const sameTeam = candidates.filter(g => String(g.team).toUpperCase() === String(row.team).toUpperCase());
      if (sameTeam.length) candidates = sameTeam;
    }
    const game = candidates[0];
    const actual = toNum(game?.[pointsColumn]);
    if (!game || actual === null) {
      unmatched++;
      continue;
    }

    samples.push({
      slateId: row.slate_id,
      date,
      name: row.name,
      team: row.team,
      position: row.position,
      salary: toNum(row.salary),
      rostership: toNum(row.rostership),
      projected,
      floor: toNum(row.floor),
      ceiling: toNum(row.ceiling),
      rawProjection: resolveRawProjection(row, raw),
      actual,
      minutes: toNum(game.minutes),
      factors: factorFn ? factorFn(row) : null
    });
  }

  return { samples, unmatched, skipped };
}

/**
 * Build the full report from joined samples.
 */
export function buildReport(samples, { unmatched = 0, skipped = 0, factorNames = [], site = DEFAULT_SITE } = {}) {
  const overall = summarizeGroup(samples);
  const withRaw = samples.filter(s => Number.isFinite(s.rawProjection));
  const adjustedRows = withRaw.filter(s => Math.abs(s.projected - s.rawProjection) > 0.05);
  const dates = [...new Set(samples.map(s => s.date))].sort();

  const factors = factorNames.length ? analyzeFactors(samples, factorNames) : [];

  return {
    sample: {
      playerGames: samples.length,
      slates: new Set(samples.map(s => s.slateId)).size,
      dates: dates.length,
      dateRange: dates.length ? { from: dates[0], to: dates[dates.length - 1] } : null,
      unmatchedProjections: unmatched,
      skippedProjections: skipped,
      withRawRotowire: withRaw.length,
      adjustedFromRaw: adjustedRows.length
    },
    overall,
    // Accuracy restricted to rows where our projection differs from RotoWire:
    // the cleanest read on whether the adjustments themselves help.
    adjustedOnly: adjustedRows.length ? summarizeGroup(adjustedRows) : null,
    bySalaryTier: breakdownBy(samples, s => salaryTier(s.salary, site), salaryTiers(site).map(t => t.label)),
    byPosition: breakdownBy(samples, s => basePositions(s.position), DK_POSITIONS),
    factors,
    insights: buildInsights({ overall, adjustedRows, factors, sampleSize: samples.length })
  };
}

function buildInsights({ overall, adjustedRows, factors, sampleSize }) {
  const out = [];
  if (sampleSize === 0) {
    out.push('No projections could be matched to actual results. Projections come from slate snapshots (taken on every slate sync / salary import), so import a slate, then sync box scores for that date after games finish.');
    return out;
  }
  if (sampleSize < 100) out.push(`Small sample (${sampleSize} player-games); treat results as directional.`);
  if (overall.bias !== null && Math.abs(overall.bias) >= 1) {
    out.push(`Projections are ${overall.bias > 0 ? 'too high' : 'too low'} on average by ${Math.abs(overall.bias).toFixed(2)} FP.`);
  }
  const rw = overall.rotowire;
  if (rw && rw.maeImprovement !== null) {
    if (adjustedRows.length === 0) {
      out.push('Projected points equal the raw RotoWire projection on every matched row, so our adjustments were not applied to these slates.');
    } else if (rw.maeImprovement < 0) {
      out.push(`Our adjustments make projections worse than raw RotoWire (MAE +${Math.abs(rw.maeImprovement).toFixed(3)} FP).`);
    } else {
      out.push(`Our adjustments beat raw RotoWire (MAE -${rw.maeImprovement.toFixed(3)} FP).`);
    }
  }
  const cal = overall.calibration;
  if (cal.n > 0 && cal.pctWithinRange < 50) {
    out.push(`Floor/ceiling range is too narrow: only ${cal.pctWithinRange}% of actuals land inside it (avg width ${cal.avgRangeWidth} FP).`);
  }
  for (const f of factors.filter(f => f.verdict === 'harmful')) {
    out.push(`Factor "${f.factor}" looks harmful: adding it to RotoWire raises MAE by ${Math.abs(f.maeImprovement).toFixed(3)} FP over ${f.n} player-games (optimal scale ${f.optimalScale}).`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Database loading
// ---------------------------------------------------------------------------

export const FACTOR_NAMES = ['defense', 'dvp', 'dvp_legacy', 'pace', 'rest', 'vegas', 'blowout'];

/**
 * Recompute the stateless adjustment factors from stored player fields using
 * projectionService's own functions (no logic duplicated or changed). Note
 * pace and the defense/DVP fallbacks use *current* team defense tables, not
 * point-in-time values.
 */
function computeFactors(row, dvpOptions = {}) {
  return {
    defense: projectionService.getDefenseAdjustment(row.opponent, toNum(row.opp_def_eff)),
    dvp: projectionService.getDvpAdjustment({ ...row, dvp_pts_allowed: toNum(row.dvp_pts_allowed) }, dvpOptions),
    dvp_legacy: projectionService.getLegacyDvpAdjustment(row.opponent, row.position, toNum(row.dvp_pts_allowed)),
    pace: projectionService.getPaceAdjustment(row.opponent, row.team),
    rest: projectionService.getRestAdjustment(toNum(row.rest_days)),
    vegas: projectionService.getVegasAdjustment(toNum(row.vegas_implied_total), toNum(row.vegas_over_under)),
    blowout: projectionService.getBlowoutAdjustment(toNum(row.vegas_spread))
  };
}

/**
 * Run the backtest against the configured database (SQLite or Azure SQL).
 * @param {Object} options
 * @param {string} [options.from] - YYYY-MM-DD inclusive
 * @param {string} [options.to] - YYYY-MM-DD inclusive
 * @param {string} [options.slateId]
 * @param {string} [options.site=draftkings] - scored against that site's points
 * @param {boolean} [options.includeFactors=true]
 * @param {boolean} [options.includeSamples=false]
 */
export async function runProjectionBacktest(options = {}) {
  const { from = null, to = null, slateId = null, includeFactors = true, includeSamples = false } = options;
  const site = getSiteConfig(options.site || DEFAULT_SITE).key;

  const params = [site];
  let where = 's.site = ? AND s.projected_points IS NOT NULL';
  if (from) { where += ' AND s.game_date >= ?'; params.push(from); }
  if (to) { where += ' AND s.game_date <= ?'; params.push(to); }
  if (slateId) { where += ' AND s.slate_id = ?'; params.push(String(slateId)); }

  // Latest capture first: a player on several slates of one date scores once
  const snapshotRows = await db.all(`
    SELECT s.slate_id, s.site, s.game_date, s.player_key, s.player_name AS name, s.team, s.opponent,
           s.position, s.salary, s.projected_points, s.floor, s.ceiling, s.rostership,
           s.vegas_implied_total, s.vegas_spread, s.over_under AS vegas_over_under
    FROM slate_player_snapshots s
    WHERE ${where}
    ORDER BY s.captured_at DESC
  `, ...params);

  // Fields snapshots don't keep, from the live row while the slate is loaded
  const liveRows = await db.all(`
    SELECT slate_id, name, rotowire_projection, rest_days, dvp_pts_allowed, opp_def_eff, game_info, raw_data
    FROM players${slateId ? ' WHERE slate_id = ?' : ''}
  `, ...(slateId ? [String(slateId)] : []));
  const live = new Map(liveRows.map(r => [`${r.slate_id}|${playerKey(r.name)}`, r]));
  const inRange = snapshotRows.map(s => {
    const { slate_id, name, ...extra } = live.get(`${s.slate_id}|${s.player_key}`) || {};
    return { ...extra, ...s };
  });

  const dates = [...new Set(inRange.map(r => toDateStr(r.game_date)))].sort();
  const pointsColumn = fantasyPointsColumn(site);
  let gameRows = [];
  if (dates.length) {
    // Range query keeps the parameter count small on both engines.
    gameRows = await db.all(`
      SELECT player_name, player_key, team, game_date, ${pointsColumn}, minutes
      FROM historical_games
      WHERE game_date >= ? AND game_date <= ? AND ${pointsColumn} IS NOT NULL
    `, dates[0], dates[dates.length - 1]);
  }

  let factorFn = null;
  if (includeFactors) {
    let dvpOptions = {};
    try {
      dvpOptions = await projectionService.loadMatchupData({ site });
    } catch (e) {
      // Tables may be empty/missing; factors that need them evaluate to 0.
    }
    factorFn = (row) => computeFactors(row, dvpOptions);
  }

  const { samples, unmatched, skipped } = joinProjectionsToActuals(inRange, gameRows, { factorFn, pointsColumn });
  const report = buildReport(samples, { unmatched, skipped, factorNames: includeFactors ? FACTOR_NAMES : [], site });
  report.generatedAt = new Date().toISOString();
  report.filters = { from, to, slateId, site };
  if (includeSamples) {
    report.samples = samples.map(({ factors, ...s }) => s);
  }
  return report;
}

export default { runProjectionBacktest };
