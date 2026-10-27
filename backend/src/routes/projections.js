import express from 'express';
import db from '../config/database.js';
import playerModel from '../models/playerModel.js';
import projectionOverrideModel from '../models/projectionOverrideModel.js';
import projectionService from '../services/projectionService.js';
import { recomputeSlateRanges } from '../services/variance/outcomeRangeService.js';
import { DEFAULT_SITE, isValidSite } from '../config/sites.js';
import {
  projectionSanityConfig, projectionSanityStatus, setProjectionSanity, setProjectionSanityComponents
} from '../config/projectionSanity.js';

const router = express.Router();

const MAX_MINUTES = 48;

async function getSlateSite(slateId) {
  const slate = await db.get(`SELECT site FROM slates WHERE slate_id = ?`, String(slateId));
  return slate?.site && isValidSite(slate.site) ? slate.site : DEFAULT_SITE;
}

/**
 * Run enhanced + minutes projections for a slate and optionally save them.
 */
async function projectSlate(slateId, { site, slateDate = null, minutesWeight = null, updateDb = false }) {
  const players = await playerModel.getAllForProjections(slateId);
  if (!players || players.length === 0) return null;

  projectionService.clearCache();
  const results = await projectionService.calculateSlateEnhancedProjections(players, slateDate, site, {
    slateId,
    minutesWeight
  });

  if (updateDb) {
    // OUT players project to 0, so their range does too
    await playerModel.bulkUpdateProjections(slateId, results.map(r => ({
      player_id: r.player_id,
      adjusted_projection: r.enhanced_projection
    })));
    await recomputeSlateRanges(slateId);
  }
  return results;
}

// Parse an optional numeric body field: undefined/null/'' -> null
function parseOptional(value, { min, max }, field) {
  if (value === undefined || value === null || value === '') return { value: null };
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) {
    return { error: `${field} must be a number from ${min} to ${max}` };
  }
  return { value: n };
}

const sanityResponse = () => ({ ...projectionSanityStatus(), config: projectionSanityConfig() });
const boolOrNull = (v) => v === undefined || v === null || typeof v === 'boolean';

/**
 * GET /api/projections/sanity
 * Projection sanity layer setting (config/projectionSanity.js): { enabled,
 * source, default, components: { fppm, blowout }, componentDefaults, config }.
 */
router.get('/sanity', (req, res) => {
  res.json(sanityResponse());
});

/**
 * PUT /api/projections/sanity
 * Body { enabled?: boolean | null, components?: { fppm?, blowout? } | null }:
 * runtime override until the server restarts (Lineup Studio toggle); null
 * resets to the env / default. Every slate read (optimizer, portfolio, chat,
 * radar, player tables) follows it.
 */
router.put('/sanity', (req, res) => {
  const { enabled, components } = req.body || {};
  if (!boolOrNull(enabled)) return res.status(400).json({ error: 'enabled must be true, false or null' });
  if (components !== undefined && components !== null) {
    const bad = typeof components !== 'object' || Object.entries(components)
      .some(([k, v]) => !['fppm', 'blowout'].includes(k) || !boolOrNull(v));
    if (bad) return res.status(400).json({ error: 'components: { fppm, blowout } with true, false or null' });
  }
  if (enabled !== undefined) setProjectionSanity(enabled);
  if (components !== undefined) setProjectionSanityComponents(components);
  res.json(sanityResponse());
});

/**
 * Minutes x FPPM projections for a slate
 * POST /api/projections/:slateId/minutes
 *
 * Body params:
 * - site: (optional) DFS site (default: the slate's site)
 * - slateDate: (optional) YYYY-MM-DD, only box scores before it are used
 * - minutesWeight: (optional) 0..1 blend weight (default: PROJECTION_MINUTES_WEIGHT or 0.6)
 * - updateDb: (optional) save the final projections to players.projected_points
 */
router.post('/:slateId/minutes', async (req, res) => {
  try {
    const { slateId } = req.params;
    const { slateDate = null, minutesWeight = null, updateDb = false } = req.body || {};
    const site = req.body?.site || await getSlateSite(slateId);
    if (!isValidSite(site)) {
      return res.status(400).json({ error: `Unknown site "${site}"` });
    }

    const results = await projectSlate(slateId, { site, slateDate, minutesWeight, updateDb });
    if (!results) {
      return res.status(404).json({ error: 'No players found for this slate' });
    }

    res.json({
      success: true,
      slateId,
      site,
      updatedDb: Boolean(updateDb),
      weight: results[0]?.minutes_model?.weight ?? null,
      players: results.map(r => {
        const { projection: modelProjection, ...model } = r.minutes_model;
        return {
          player_id: r.player_id,
          name: r.name,
          team: r.team,
          opponent: r.opponent,
          position: r.position,
          salary: r.salary,
          projection: r.enhanced_projection,
          legacy_projection: r.legacy_projection,
          model_projection: modelProjection,
          ...model
        };
      })
    });
  } catch (error) {
    console.error('Minutes projection error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * List manual overrides for a slate
 * GET /api/projections/:slateId/overrides
 */
router.get('/:slateId/overrides', async (req, res) => {
  try {
    res.json(await projectionOverrideModel.getBySlate(req.params.slateId));
  } catch (error) {
    console.error('Error fetching projection overrides:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Set a manual override for one player
 * PUT /api/projections/:slateId/overrides/:playerId
 *
 * Body params (at least one of minutes/points):
 * - minutes: 0..48. 0 marks the player OUT and hands his minutes to teammates.
 * - points: fantasy points; wins over minutes and is saved to the player's
 *   projected_points right away
 * - note: (optional) free text
 * - apply: (optional) true recalculates and saves the whole slate so a
 *   minutes override (and the teammates it affects) reach the optimizer
 */
router.put('/:slateId/overrides/:playerId', async (req, res) => {
  try {
    const { slateId, playerId } = req.params;
    const body = req.body || {};

    const minutes = parseOptional(body.minutes, { min: 0, max: MAX_MINUTES }, 'minutes');
    const points = parseOptional(body.points, { min: 0, max: 200 }, 'points');
    const error = minutes.error || points.error;
    if (error) return res.status(400).json({ error });
    if (minutes.value === null && points.value === null) {
      return res.status(400).json({ error: 'Provide minutes and/or points (use DELETE to clear an override)' });
    }

    const player = await db.get(
      `SELECT player_id, projected_points FROM players WHERE slate_id = ? AND player_id = ?`,
      String(slateId), String(playerId)
    );
    if (!player) {
      return res.status(404).json({ error: 'Player not found on this slate' });
    }

    const existing = await projectionOverrideModel.get(slateId, playerId);
    const hadPoints = existing?.points !== null && existing?.points !== undefined;

    // Remember the projection from before any points override so it can be restored
    let basePoints = existing?.base_points ?? null;
    if (points.value !== null && !hadPoints) {
      basePoints = player.projected_points ?? null;
    }

    if (points.value !== null) {
      await projectionOverrideModel.setPlayerPoints(slateId, playerId, points.value);
    } else if (hadPoints && basePoints !== null) {
      await projectionOverrideModel.setPlayerPoints(slateId, playerId, basePoints);
      basePoints = null;
    }

    const override = await projectionOverrideModel.upsert(slateId, playerId, {
      minutes: minutes.value,
      points: points.value,
      basePoints: points.value !== null ? basePoints : null,
      note: body.note ?? null
    });

    let recalculated = false;
    if (body.apply === true) {
      const site = await getSlateSite(slateId);
      recalculated = Boolean(await projectSlate(slateId, { site, updateDb: true }));
    }

    res.json({
      success: true,
      override,
      recalculated,
      // Minutes overrides only reach projected_points after a recalculation
      needsRecalculation: minutes.value !== null && !recalculated
    });
  } catch (error) {
    console.error('Error saving projection override:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Clear a player's override
 * DELETE /api/projections/:slateId/overrides/:playerId
 */
router.delete('/:slateId/overrides/:playerId', async (req, res) => {
  try {
    const { slateId, playerId } = req.params;
    const existing = await projectionOverrideModel.get(slateId, playerId);
    if (!existing) {
      return res.status(404).json({ error: 'No override for this player' });
    }

    if (existing.points !== null && existing.base_points !== null) {
      await projectionOverrideModel.setPlayerPoints(slateId, playerId, existing.base_points);
    }
    await projectionOverrideModel.remove(slateId, playerId);

    res.json({
      success: true,
      restoredPoints: existing.points !== null ? existing.base_points : null,
      needsRecalculation: existing.minutes !== null
    });
  } catch (error) {
    console.error('Error deleting projection override:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
