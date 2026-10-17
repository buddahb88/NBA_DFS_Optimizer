import express from 'express';
import { simulatePlayers, scoreLineups, playerSamples } from '../services/simulation/index.js';

const router = express.Router();

/**
 * POST /api/sim/players/:slateId
 * Body (all optional): { iterations=10000, seed, lineups: [...], includeSamples=false }
 * Returns per-player outcome distributions; if `lineups` are passed they are scored
 * against the same simulation.
 */
router.post('/players/:slateId', async (req, res) => {
  try {
    const { slateId } = req.params;
    const { iterations, seed, lineups, includeSamples = false } = req.body || {};

    const result = await simulatePlayers(slateId, { iterations, seed });
    if (result.players.length === 0) {
      return res.status(404).json({ error: 'No players found for this slate' });
    }

    const players = includeSamples
      ? result.players.map((p, i) => ({ ...p, samples: Array.from(playerSamples(result.sims, i), (v) => Math.round(v * 10) / 10) }))
      : result.players;

    res.json({
      success: true,
      slateId,
      iterations: result.iterations,
      seed: result.seed,
      elapsedMs: result.elapsedMs,
      players,
      lineups: Array.isArray(lineups) ? scoreLineups(lineups, result.sims) : undefined
    });
  } catch (error) {
    console.error('Simulation error:', error);
    res.status(500).json({ error: 'Simulation failed', message: error.message });
  }
});

export default router;
