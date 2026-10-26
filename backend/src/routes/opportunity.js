/**
 * OPPORTUNITY ROUTES
 *
 * Opportunity Radar: per-player metrics that spot players in position to
 * succeed (services/opportunity/).
 */

import express from 'express';
import { getOpportunityMetrics } from '../services/opportunity/metricsService.js';
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

export default router;
