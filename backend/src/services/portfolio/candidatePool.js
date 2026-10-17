/**
 * CANDIDATE POOL
 *
 * Each candidate is the optimal lineup against a perturbed projection
 *   proj_i = mean_i + randomness * (sample_i - mean_i)
 * where `sample` is one draw from a correlated slate simulation. Using sim draws (not
 * independent noise) means candidates naturally include game stacks and correlated
 * boom spots. The draws come from a separate sim run than the one used to score the
 * contest, so no candidate is fit to the outcomes it is judged on.
 */

import { solveLineup, lineupKey, ROSTER_SIZE } from './lineupSolver.js';

/**
 * @param ctx - solver context (locked players + minSalary already set)
 * @param opts - {
 *   size, means: Float64Array, samples: Float32Array (player-major), sampleCount,
 *   randomness (0..1), maxExposure (% of pool, 100 = none), allowed?: Uint8Array,
 *   rng, kicks, onProgress
 * }
 * @returns {{lineups: Uint16Array (count*8), count: number, exposure: Float64Array (%), attempts: number}}
 */
export function generateCandidatePool(ctx, opts) {
  const { size, means, samples, sampleCount, rng, onProgress } = opts;
  const randomness = Math.min(1, Math.max(0, opts.randomness ?? 0.6));
  const maxCount = Math.max(1, Math.floor(((opts.maxExposure ?? 100) / 100) * size));
  const locked = new Set(ctx.locked);
  const n = ctx.n;

  const allowed = new Uint8Array(n).fill(1);
  if (opts.allowed) allowed.set(opts.allowed);
  const counts = new Int32Array(n);
  const proj = new Float64Array(n);
  const seen = new Set();
  const lineups = new Uint16Array(size * ROSTER_SIZE);
  let count = 0;
  let attempts = 0;
  let stale = 0;

  // Projection-only optimum first, so the pool always contains the "chalk" build
  const first = solveLineup(ctx, means, { allowed, rng, kicks: opts.kicks ?? 4 });
  const add = (res) => {
    const key = lineupKey(res.players);
    if (seen.has(key)) return false;
    seen.add(key);
    lineups.set(res.players, count * ROSTER_SIZE);
    count++;
    for (const p of res.players) {
      if (++counts[p] >= maxCount && !locked.has(p)) allowed[p] = 0;
    }
    return true;
  };
  if (first) add(first);

  const maxAttempts = sampleCount * 2;
  while (count < size && attempts < maxAttempts && stale < Math.max(200, size)) {
    const row = attempts % sampleCount;
    // Second pass over the draws: shrink less so repeats still produce new lineups
    const r = attempts < sampleCount ? randomness : Math.min(1, randomness * 1.5 + 0.1);
    attempts++;
    for (let i = 0; i < n; i++) {
      const s = samples[i * sampleCount + row];
      proj[i] = means[i] + r * (s - means[i]);
    }
    const res = solveLineup(ctx, proj, { allowed, rng, kicks: opts.kicks ?? 4 });
    if (res && add(res)) stale = 0;
    else stale++;
    if (onProgress && (count % 25 === 0 || count === size)) onProgress(count / size);
  }

  const exposure = Float64Array.from(counts, (c) => (count ? (c / count) * 100 : 0));
  return { lineups: lineups.subarray(0, count * ROSTER_SIZE), count, exposure, attempts };
}
