/**
 * ARCHETYPE ROUTES
 *
 * Rule-based player archetypes per season (services/archetypeService.js,
 * rules in config/archetypes.js), and how each defense performs against them
 * (services/archetypeDefenseService.js).
 */

import express from 'express';
import { getPlayerArchetypes } from '../services/archetypeService.js';
import { POSITION_LABELS, getDefense, getDefenseGames, getTonight } from '../services/archetypeDefenseService.js';
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

/**
 * GET /api/archetypes/definitions
 * Archetype definitions (key, label, description) in display order, plus the
 * G/F/C position buckets, for legends.
 */
router.get('/definitions', (req, res) => {
  res.json({
    success: true,
    archetypes: ALL_ARCHETYPES.map(({ key, label, description }) => ({ key, label, description })),
    positions: Object.entries(POSITION_LABELS).map(([key, label]) => ({ key, label })),
  });
});

function sendError(res, error) {
  if (error.status) return res.status(error.status).json({ error: error.message });
  console.error('Archetype defense error:', error);
  return res.status(500).json({ error: error.message });
}

/**
 * GET /api/archetypes/defense
 * Opponent x archetype (or G/F/C position) performance vs expectation:
 * games, player_games, avg_fp, avg_expected_fp, fp_over_expectation (shrunk)
 * and _raw, shrink, and shrunk pts/reb/ast/fg3m/stocks deltas, best matchup
 * first. `source` is 'precomputed' (team_archetype_defense) or 'live'.
 *
 * Query params:
 *   season       e.g. 2025-26 (default: current season)
 *   site         dk | fd | yahoo (or full site key; default draftkings)
 *   grouping     archetype (default) | position (G/F/C in-house DvP)
 *   team, group  optional filters (defending team, archetype key or G/F/C)
 *   lastNGames   each defense's last N games
 *   startDate, endDate  YYYY-MM-DD window
 */
router.get('/defense', async (req, res) => {
  try {
    res.json({ success: true, ...(await getDefense(req.query)) });
  } catch (error) {
    sendError(res, error);
  }
});

/**
 * GET /api/archetypes/defense/:team/:archetype/games
 * The player-games behind one cell, newest first, with actual / expected FP
 * and unshrunk per-stat deltas, plus the cell summary. :archetype may be an
 * archetype key or G/F/C. Same query params as /defense.
 */
router.get('/defense/:team/:archetype/games', async (req, res) => {
  try {
    res.json({ success: true, ...(await getDefenseGames(req.params.team, req.params.archetype, req.query)) });
  } catch (error) {
    sendError(res, error);
  }
});

/**
 * GET /api/archetypes/tonight
 * Slate players whose opponent is in the weak tier (top third of defenses,
 * positive delta) vs their archetype or G/F/C, with salary, projection and
 * matchup_delta, best first.
 *
 * Query params:
 *   slateId   required
 *   stat      fp (default) | pts | reb | ast | fg3m - what the tier ranks by
 *   site      default: the slate's site
 *   season, grouping, lastNGames, startDate, endDate  as /defense
 *
 * Without `season`, a current season with too few defenses at 10+ games is
 * tiered on last season; `fallback` ({ from, qualifiedDefenses, minDefenses,
 * minGames }) is set when that happens, null otherwise.
 */
router.get('/tonight', async (req, res) => {
  try {
    res.json({ success: true, ...(await getTonight(req.query)) });
  } catch (error) {
    sendError(res, error);
  }
});

export default router;
