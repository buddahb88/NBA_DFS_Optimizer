import express from 'express';
import lineupModel from '../models/lineupModel.js';
import { getSiteConfig, isValidSite, SITE_KEYS } from '../config/sites.js';
import { resolveSite } from '../utils/resolveSite.js';
import { buildLineupExport } from '../services/lineupExportService.js';
import { loadSavedLineups, loadInlineLineups } from '../services/lineupExportData.js';

const router = express.Router();

// Lineup rules (roster size, salary cap) come from the DFS site; DraftKings when omitted
export function validateLineup(players, site) {
  const errors = [];
  let config;
  try {
    config = getSiteConfig(site);
  } catch (error) {
    return { isValid: false, errors: [error.message], totalSalary: 0 };
  }
  const rosterSize = config.rosterSlots.length;

  if (players.length !== rosterSize) {
    errors.push(`Lineup must have exactly ${rosterSize} players`);
  }

  const totalSalary = players.reduce((sum, p) => sum + (p.salary || 0), 0);
  if (totalSalary > config.salaryCap) {
    errors.push(`Total salary ($${totalSalary}) exceeds cap ($${config.salaryCap})`);
  }

  return { isValid: errors.length === 0, errors, totalSalary };
}

// Get all lineups
router.get('/', async (req, res) => {
  try {
    const { slateId } = req.query;
    const lineups = await lineupModel.getAll(slateId);
    res.json(lineups);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get a specific lineup with players
router.get('/:id', async (req, res) => {
  try {
    const lineup = await lineupModel.getById(req.params.id);
    if (!lineup) {
      return res.status(404).json({ error: 'Lineup not found' });
    }
    res.json(lineup);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Create a new lineup
router.post('/', async (req, res) => {
  try {
    const { slateId, name, players } = req.body;

    if (!slateId || !name || !players || !Array.isArray(players)) {
      return res.status(400).json({
        error: 'slateId, name, and players array are required'
      });
    }

    const { site, error: siteError } = await resolveSite(req.body.site, slateId);
    if (siteError) {
      return res.status(400).json({ error: siteError });
    }
    const { rosterSlots } = getSiteConfig(site);

    // Validate lineup
    const validation = validateLineup(players, site);
    if (!validation.isValid) {
      return res.status(400).json({
        error: 'Invalid lineup',
        details: validation.errors
      });
    }

    // Calculate projected points
    const projectedPoints = players.reduce(
      (sum, p) => sum + (parseFloat(p.projectedPoints) || 0),
      0
    );

    // Create lineup
    const lineupId = await lineupModel.create({
      slateId,
      name,
      totalSalary: validation.totalSalary,
      projectedPoints
    });

    // Add players to lineup
    const lineupPlayers = players.map((player, index) => ({
      playerId: player.id,
      positionSlot: player.positionSlot || rosterSlots[index]?.slot
    }));

    await lineupModel.addPlayers(lineupId, lineupPlayers);

    // Return the created lineup
    const lineup = await lineupModel.getById(lineupId);
    res.status(201).json(lineup);
  } catch (error) {
    console.error('Create lineup error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Delete a lineup
router.delete('/:id', async (req, res) => {
  try {
    await lineupModel.delete(req.params.id);
    res.json({ message: 'Lineup deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/lineups/export
 * Body: { site, mode: 'new'|'entries', lineupIds?: [id] | lineups?: [{ name?, players: [{ id, positionSlot? }] }],
 *         entriesTemplate?: string (entries file text, required for mode 'entries') }
 * 200 { success, csv, rowCount, warnings }
 * 422 { success: false, errors: [{ index, lineupId, name, csvRow, messages }], warnings }
 */
router.post('/export', async (req, res) => {
  try {
    const { site, mode = 'new', lineupIds, lineups, entriesTemplate } = req.body || {};

    if (!isValidSite(site)) {
      return res.status(400).json({ error: `site must be one of: ${SITE_KEYS.join(', ')}` });
    }
    const hasIds = Array.isArray(lineupIds) && lineupIds.length > 0;
    const hasInline = Array.isArray(lineups) && lineups.length > 0;
    if (hasIds === hasInline) {
      return res.status(400).json({ error: 'Send either lineupIds or lineups (not both)' });
    }

    const loaded = hasIds ? await loadSavedLineups(lineupIds) : await loadInlineLineups(lineups);
    const result = buildLineupExport({ site: site.toLowerCase(), mode, lineups: loaded, entriesTemplate });

    res.status(result.success ? 200 : 422).json(result);
  } catch (error) {
    console.error('Lineup export error:', error);
    res.status(error.status || 500).json({ error: error.message });
  }
});

export default router;
