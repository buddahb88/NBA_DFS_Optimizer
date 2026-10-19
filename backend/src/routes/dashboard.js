import express from 'express';
import teamDefenseModel from '../models/teamDefenseModel.js';
import { buildTeamStatsMap } from '../utils/teamStats.js';

const router = express.Router();

// GET /api/dashboard/team-stats?teams=BOS,PHX
// Pace and efficiency per team for the slate dashboard's game cards.
router.get('/team-stats', async (req, res) => {
  try {
    const teams = String(req.query.teams || '')
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
    const rows = await teamDefenseModel.getAll();
    res.json(buildTeamStatsMap(rows, teams));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
