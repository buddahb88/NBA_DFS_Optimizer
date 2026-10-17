/**
 * SIMULATION SERVICE
 *
 * simulatePlayers(slateId, { iterations, seed }) -> per-player outcome distributions
 * scoreLineups(lineups, sims)                     -> per-lineup distribution summaries
 */

import playerModel from '../../models/playerModel.js';
import { fetchHistoricalStats } from './historyRepository.js';
import { runSimulation, summarizePlayers, scoreLineups, playerSamples, DEFAULTS } from './engine.js';
import { randomSeed } from './rng.js';

export const MAX_ITERATIONS = 100000;

/**
 * Simulate every active player on a slate.
 * @returns {Promise<{slateId, iterations, seed, elapsedMs, players: object[], sims: object}>}
 *   `players` are summary stats; `sims` holds the raw Float32Array samples for scoreLineups().
 */
export async function simulatePlayers(slateId, { iterations = DEFAULTS.iterations, seed, config } = {}) {
  const iters = Math.min(MAX_ITERATIONS, Math.max(1, Math.floor(Number(iterations) || DEFAULTS.iterations)));
  const runSeed = seed ?? randomSeed();

  const rows = await playerModel.getBySlateId(slateId);
  // Stable input order so a given seed always reproduces the same samples
  const players = [...(rows || [])].sort((a, b) => (a.id ?? 0) - (b.id ?? 0));

  let historicalStats = new Map();
  try {
    historicalStats = await fetchHistoricalStats(players.map((p) => p.name));
  } catch (err) {
    console.warn('⚠️  Simulation: historical variance unavailable, using fallbacks:', err.message);
  }

  const start = Date.now();
  const sims = runSimulation(players, { iterations: iters, seed: runSeed, historicalStats, config });
  const summaries = summarizePlayers(sims, config);
  const elapsedMs = Date.now() - start;

  return { slateId, iterations: iters, seed: runSeed, elapsedMs, players: summaries, sims };
}

export { scoreLineups, runSimulation, summarizePlayers, playerSamples };
