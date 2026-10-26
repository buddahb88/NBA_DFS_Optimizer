/**
 * OPPORTUNITY ROUTES
 *
 * Opportunity Radar: per-player metrics that spot players in position to
 * succeed (services/opportunity/).
 */

import express from 'express';
import { getOpportunityMetrics } from '../services/opportunity/metricsService.js';
import { getTeammateOpportunity } from '../services/opportunity/teammateService.js';
import { sourceFields } from '../services/slateSource.js';

const router = express.Router();

const truthy = (v) => v === '1' || v === 'true';

/**
 * GET /api/opportunity/metrics
 * One row per slate player: minutes / usage / FPPM / shot volume / shooting
 * trends, role stability, value hit rates at the slate salary, rest, game
 * environment, and sample sizes (games_l3 / l5 / l10 / season,
 * season_fallback). Only games before the slate date count; backtest rows
 * add actual_points / actual_minutes / result_status.
 *
 * Query params:
 *   slateId, slateDate (YYYY-MM-DD; a past date is a backtest), site
 *   refresh  1 | true: recompute instead of using the cached result
 */
router.get('/metrics', async (req, res) => {
  try {
    const { slateId, slateDate, site, refresh } = req.query;
    const { source, slateDate: date, season, computedAt, cached, players } = await getOpportunityMetrics({
      slateId: slateId || null, slateDate: slateDate || null, site: site || null, refresh: truthy(refresh)
    });
    res.json({ success: true, ...sourceFields(source), slateDate: date, season, computedAt, cached, count: players.length, players });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ error: error.message });
    console.error('Opportunity metrics error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/opportunity/teammates
 * Teammate-out opportunity: per team, who is out (status_source, prelock)
 * and the usage / minutes / points per game they vacate (vacated_usage is a
 * share of team plays) with who absorbs it; per slate player, usage /
 * minutes / FPPM / points with each OUT teammate off the floor vs on it
 * (splits, sample confirmed | thin | none) and one combined `adjusted` line.
 * Only games before the slate date count.
 *
 * Query params: slateId, slateDate (YYYY-MM-DD; a past date is a backtest), site
 */
router.get('/teammates', async (req, res) => {
  try {
    const { slateId, slateDate, site } = req.query;
    const { source, slateDate: date, season, teams, players } = await getTeammateOpportunity({
      slateId: slateId || null, slateDate: slateDate || null, site: site || null
    });
    res.json({ success: true, ...sourceFields(source), slateDate: date, season, teams, count: players.length, players });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ error: error.message });
    console.error('Teammate opportunity error:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
