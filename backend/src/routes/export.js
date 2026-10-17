import express from 'express';
import playerModel from '../models/playerModel.js';
import { isValidSite } from '../config/sites.js';
import { buildLineupCsv } from '../services/lineupExport.js';

const router = express.Router();

/**
 * POST /api/export/lineups
 * Build a site upload CSV for a set of lineups.
 *
 * Body: { site, slateId?, lineups: [{ players: [{ slot, playerId }] }] }
 * Returns: { csv, filename, count, warnings }
 */
router.post('/lineups', async (req, res) => {
  try {
    const { site, slateId, lineups } = req.body;

    if (!isValidSite(site)) {
      return res.status(400).json({ error: 'site must be one of draftkings, fanduel, yahoo' });
    }
    if (!Array.isArray(lineups) || lineups.length === 0) {
      return res.status(400).json({ error: 'lineups must be a non-empty array' });
    }

    const ids = [...new Set(lineups.flatMap((l) => (l.players || []).map((p) => Number(p.playerId))))];
    const rows = await Promise.all(ids.map((id) => playerModel.getById(id)));
    const playersById = new Map(rows.filter(Boolean).map((p) => [Number(p.id), p]));

    const { csv, count, warnings } = buildLineupCsv(site, lineups, playersById);
    if (count === 0) {
      return res.status(400).json({ error: 'No complete lineups to export', details: warnings });
    }

    const stamp = new Date().toISOString().slice(0, 10);
    const filename = `${site.toLowerCase()}-${slateId ? `${slateId}-` : ''}lineups-${stamp}.csv`;
    res.json({ csv, filename, count, warnings });
  } catch (error) {
    console.error('Export error:', error);
    res.status(500).json({ error: 'Export failed', message: error.message });
  }
});

export default router;
