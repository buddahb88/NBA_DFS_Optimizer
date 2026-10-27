import express from 'express';
import slateModel from '../models/slateModel.js';
import { runLateSwap } from '../services/lateSwap/index.js';
import { loadSlatePlayers, resolveSlate } from '../services/slateSource.js';

const router = express.Router();

/**
 * POST /api/lateswap
 * Body: { slateId, csv,                  // entries file text (DKEntries.csv / FanDuel entries upload)
 *         site?,                         // 'draftkings' | 'fanduel' (default: detected from the file)
 *         now?,                          // ISO time to evaluate locks at (testing); default: server time
 *         gameTimes?: { TEAM: time },    // start time overrides
 *         lockedTeams?: [TEAM],          // treat as started regardless of time
 *         outPlayers?: [siteId|name],    // late scratches not in the DB yet
 *         excludePlayers?: [siteId|name],
 *         mode?: 'optimize' | 'outOnly', swapQuestionable?, maxExposure?, playerExposure?: { siteId: pct }, unique? }
 * Returns per-entry diffs (old -> new per slot), flags, exposures and `csv`, the filled entries file to upload.
 */
router.post('/', async (req, res) => {
  const { slateId, ...options } = req.body || {};
  if (!slateId) return res.status(400).json({ error: 'slateId is required' });
  if (!options.csv) return res.status(400).json({ error: 'csv (entries file contents) is required' });

  try {
    // All rows, including zero-projection ones, so OUT players are still recognized;
    // projections after the sanity layer when it is on
    const dbPlayers = await loadSlatePlayers(await resolveSlate({ slateId }), { includeZero: true });
    if (!dbPlayers || dbPlayers.length === 0) {
      return res.status(404).json({ error: 'No players found for this slate' });
    }

    const result = runLateSwap({ ...options, dbPlayers });

    const slate = await slateModel.getById(slateId);
    if (slate?.site && slate.site !== result.site) {
      result.warnings.unshift(`Entries file is ${result.site} but slate ${slateId} is ${slate.site}; projections may not line up.`);
    }

    res.json({ success: true, slateId, ...result });
  } catch (error) {
    if (error.status === 400) {
      return res.status(400).json({ error: 'Invalid late swap request', message: error.message });
    }
    console.error('Late swap error:', error);
    res.status(500).json({ error: 'Late swap failed', message: error.message });
  }
});

export default router;
