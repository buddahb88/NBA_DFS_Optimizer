/**
 * OPPORTUNITY RADAR SERVICE
 *
 * The Opportunity Radar: every slate player's O1-O3 metrics
 * (metricsService, cached per slate) scored 0-100 for Cash and GPP
 * (radarScore.js, weights in radarConfig.js) with a reason line, best
 * score first for the requested mode.
 *
 * No lookahead (metricsService reads only games and slates before the slate
 * date). A backtest adds actualPoints / actualMinutes / resultStatus (as
 * slateSource.withActuals) and `validation`: per mode, whether the top
 * decile by score beat 5x salary more often than the slate.
 */

import { getOpportunityMetrics } from './metricsService.js';
import { opportunityScore, reasonLine, decileValidation } from './radarScore.js';
import RADAR_CONFIG, { RADAR_MODES } from './radarConfig.js';
import { SlateSourceError } from '../slateSource.js';

export const VALIDATION_MULTIPLE = 5;

/** One radar row: the metrics row, both scores, the mode's components and the reason line. */
export function scoreRow(row, mode, { isBacktest = false, config = RADAR_CONFIG } = {}) {
  const cash = opportunityScore(row, 'cash', config);
  const gpp = opportunityScore(row, 'gpp', config);
  const picked = mode === 'gpp' ? gpp : cash;
  return {
    ...row,
    score: picked.score,
    cash_score: cash.score,
    gpp_score: gpp.score,
    components: picked.components,
    coverage: picked.coverage,
    reason: reasonLine(row, config),
    ...(isBacktest
      ? { actualPoints: row.actual_points ?? null, actualMinutes: row.actual_minutes ?? null, resultStatus: row.result_status ?? null }
      : {})
  };
}

/**
 * Opportunity Radar for a slate: { source, slateDate, season, mode,
 * computedAt, cached, weights, players, validation }. Slate selection as
 * getOpportunityMetrics (slateId, slateDate - a past date is a backtest -
 * site, refresh). mode: 'cash' | 'gpp'. validation is null live.
 * Throws SlateSourceError (400 bad mode, 404 no slate).
 */
export async function getOpportunityRadar({ slateId = null, slateDate = null, site = null, mode = 'cash', refresh = false, now = new Date() } = {}) {
  const m = String(mode || 'cash').toLowerCase();
  if (!RADAR_MODES.includes(m)) throw new SlateSourceError(`mode must be one of: ${RADAR_MODES.join(', ')}`, 400);

  const metrics = await getOpportunityMetrics({ slateId, slateDate, site, refresh, now });
  const isBacktest = Boolean(metrics.source.isBacktest);
  const players = metrics.players
    .map(row => scoreRow(row, m, { isBacktest }))
    .sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || (Number(b.salary) || 0) - (Number(a.salary) || 0));

  const validation = isBacktest
    ? Object.fromEntries(RADAR_MODES.map(k => [k, decileValidation(players, { multiple: VALIDATION_MULTIPLE, scoreKey: `${k}_score` })]))
    : null;

  return {
    source: metrics.source,
    slateDate: metrics.slateDate,
    season: metrics.season,
    mode: m,
    computedAt: metrics.computedAt,
    cached: metrics.cached,
    weights: RADAR_CONFIG.weights[m],
    players,
    validation
  };
}

export default { getOpportunityRadar, scoreRow };
