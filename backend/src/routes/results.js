/**
 * RESULTS ROUTES
 *
 * Slate snapshots scored against box scores (services/resultsService.js).
 */

import express from 'express';
import { getResults, getPlayerResults, RESULT_STATUSES } from '../services/resultsService.js';
import { isValidSite, SITE_KEYS } from '../config/sites.js';

const router = express.Router();

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Shared query validation; returns [error, filters]
function parseFilters(query) {
  const { from, to, site, slateId } = query;
  for (const [key, value] of Object.entries({ from, to })) {
    if (value && !DATE_RE.test(value)) return [`${key} must be YYYY-MM-DD`];
  }
  if (site && !isValidSite(site)) return [`site must be one of: ${SITE_KEYS.join(', ')}`];
  return [null, { from: from || null, to: to || null, site: site ? site.toLowerCase() : null, slateId: slateId || null }];
}

/**
 * GET /api/results
 * Projection / minutes error, value and 3x/5x/6x hit rates, overall and by
 * salary tier, position and date.
 *
 * Query params (all optional):
 *   from, to   YYYY-MM-DD game date bounds (inclusive)
 *   site       draftkings (default) | fanduel | yahoo
 *   slateId    restrict to one slate
 */
router.get('/', async (req, res) => {
  try {
    const [error, filters] = parseFilters(req.query);
    if (error) return res.status(400).json({ error });
    res.json({ success: true, ...(await getResults(filters)) });
  } catch (error) {
    console.error('Results error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/results/players
 * Per-player rows. Same params as GET /, plus:
 *   status     PLAYED | DNP | INACTIVE | PENDING
 *   player     name / player_key substring
 */
router.get('/players', async (req, res) => {
  try {
    const [error, filters] = parseFilters(req.query);
    if (error) return res.status(400).json({ error });
    const status = req.query.status ? String(req.query.status).toUpperCase() : null;
    if (status && !RESULT_STATUSES.includes(status)) {
      return res.status(400).json({ error: `status must be one of: ${RESULT_STATUSES.join(', ')}` });
    }
    const players = await getPlayerResults({ ...filters, status, player: req.query.player || null });
    res.json({ success: true, filters: { ...filters, status }, count: players.length, players });
  } catch (error) {
    console.error('Player results error:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
