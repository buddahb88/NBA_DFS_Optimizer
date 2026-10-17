/**
 * ANALYTICS ROUTES
 *
 * Read-only endpoints that measure how the app is performing.
 */

import express from 'express';
import { runProjectionBacktest } from '../services/projectionBacktestService.js';

const router = express.Router();

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * GET /api/analytics/projection-accuracy
 * Score stored projections against actual DK fantasy points.
 *
 * Query params (all optional):
 *   from, to       YYYY-MM-DD date bounds (inclusive)
 *   slateId        restrict to one slate
 *   factors=false  skip per-factor attribution
 *   samples=true   include per-player rows
 */
router.get('/projection-accuracy', async (req, res) => {
  try {
    const { from, to, slateId, factors, samples } = req.query;
    for (const [key, value] of Object.entries({ from, to })) {
      if (value && !DATE_RE.test(value)) {
        return res.status(400).json({ error: `${key} must be YYYY-MM-DD` });
      }
    }
    const report = await runProjectionBacktest({
      from: from || null,
      to: to || null,
      slateId: slateId || null,
      includeFactors: factors !== 'false',
      includeSamples: samples === 'true'
    });
    res.json({ success: true, ...report });
  } catch (error) {
    console.error('Projection accuracy error:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
