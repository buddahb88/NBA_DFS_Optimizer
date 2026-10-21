/**
 * ARCHETYPE ROUTES
 *
 * Rule-based player archetypes per season (services/archetypeService.js,
 * rules in config/archetypes.js).
 */

import express from 'express';
import { getPlayerArchetypes } from '../services/archetypeService.js';
import { ALL_ARCHETYPES } from '../config/archetypes.js';
import { getCurrentSeason } from '../utils/season.js';

const router = express.Router();

const SEASON_RE = /^\d{4}-\d{2}$/;

/**
 * GET /api/archetypes/players
 * Every classified player-season with label, secondary archetype, rule_trace
 * (parsed JSON) and profile context, plus the per-archetype distribution and
 * the archetype definitions (key, label, description).
 *
 * Query params:
 *   season   e.g. 2025-26 (default: current season)
 */
router.get('/players', async (req, res) => {
  try {
    const season = req.query.season || getCurrentSeason();
    if (!SEASON_RE.test(season)) return res.status(400).json({ error: 'season must look like 2025-26' });
    const archetypes = ALL_ARCHETYPES.map(({ key, label, description }) => ({ key, label, description }));
    res.json({ success: true, ...(await getPlayerArchetypes(season)), archetypes });
  } catch (error) {
    console.error('Archetypes error:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
