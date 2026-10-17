/**
 * SYNTHETIC CONTEST FIELD
 *
 * Opponent lineups are sampled player-by-player with probability proportional to a
 * per-player weight, subject to roster-slot feasibility and the salary cap. The last pick
 * is tilted toward using the cap (leftover ~ exponential(meanLeftover), at most
 * maxLeftover), which reproduces the field's typical 49.5k-50k salary usage. Weights start
 * at projected ownership and are refit for a few rounds so realized field exposure matches
 * ownership.
 *
 * Real fields are partly optimizer-built, so `optimizedShare` of the field is made by the
 * lineup solver on noisy projections (proj * lognormal(optimizerNoise)); the ownership
 * sampler fills the rest, refit against whatever exposure the optimized part leaves over
 * so the combined field still matches ownership.
 */

import { canMatch, solveLineup, ROSTER_SIZE } from './lineupSolver.js';

export const FIELD_DEFAULTS = {
  meanLeftover: 250,
  maxLeftover: 2000,
  calibrationRounds: 6,
  optimizedShare: 0.3,
  optimizerNoise: 0.25
};

const CALIBRATION_SAMPLE = 2000; // lineups per refit round (final round uses the full field size)
const TYPICAL_LINEUP_SALARY = 49700;

const TOTAL_OWNERSHIP = ROSTER_SIZE * 100; // classic: 8 roster spots -> ownership sums to 800%
const MIN_OWN = 0.05;
const MAX_OWN = 95;

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Scale to TOTAL_OWNERSHIP while respecting per-player bounds. */
function normalizeOwnership(pct) {
  for (let round = 0; round < 10; round++) {
    let free = 0;
    let fixed = 0;
    for (const v of pct) {
      if (v >= MAX_OWN) fixed += MAX_OWN;
      else free += v;
    }
    const scale = free > 0 ? (TOTAL_OWNERSHIP - fixed) / free : 1;
    let clipped = false;
    for (let i = 0; i < pct.length; i++) {
      if (pct[i] >= MAX_OWN) continue;
      pct[i] = Math.max(MIN_OWN, pct[i] * scale);
      if (pct[i] > MAX_OWN) {
        pct[i] = MAX_OWN;
        clipped = true;
      }
    }
    if (!clipped) break;
  }
  return pct;
}

/**
 * Exponentially tilt ownership by salary (own_i * exp(-lambda * salary_i), renormalized)
 * so the implied average lineup salary sum(own_i * salary_i) / 100 hits `target`.
 */
export function tiltToSalary(pct, salaries, target = TYPICAL_LINEUP_SALARY) {
  const implied = (lambda) => {
    let w = 0;
    let ws = 0;
    for (let i = 0; i < pct.length; i++) {
      const v = pct[i] * Math.exp(-lambda * (salaries[i] / 1000));
      w += v;
      ws += v * salaries[i];
    }
    return w > 0 ? (ws / w) * ROSTER_SIZE : 0;
  };
  let lo = -3;
  let hi = 3;
  for (let it = 0; it < 60; it++) {
    const mid = (lo + hi) / 2;
    if (implied(mid) > target) lo = mid;
    else hi = mid;
  }
  const lambda = (lo + hi) / 2;
  const out = Float64Array.from(pct, (v, i) => v * Math.exp(-lambda * (salaries[i] / 1000)));
  const sum = out.reduce((a, v) => a + v, 0) || 1;
  for (let i = 0; i < out.length; i++) out[i] = (out[i] / sum) * TOTAL_OWNERSHIP;
  return out;
}

/** Average lineup salary implied by an ownership vector (%). */
export function impliedLineupSalary(pct, salaries) {
  let s = 0;
  for (let i = 0; i < pct.length; i++) s += (pct[i] / 100) * salaries[i];
  return s;
}

/**
 * Projected ownership (%) per player, normalized to sum to 800%.
 * Uses `rostership`; if most of the slate is missing it, estimates from projection and value.
 * @param overrides - { [id | player_id | name]: pct }
 * @returns {{pct: Float64Array, source: 'projected'|'estimated'|'mixed', rawTotal: number}}
 */
export function resolveOwnership(players, overrides = {}) {
  const n = players.length;
  const pct = new Float64Array(n);
  const override = (p) => {
    for (const k of [p.id, p.player_id, p.name]) {
      if (k != null && overrides[k] != null && num(overrides[k]) !== null) return num(overrides[k]);
    }
    return null;
  };

  let have = 0;
  let rawTotal = 0;
  players.forEach((p) => {
    const r = num(p.rostership);
    if (r && r > 0) {
      have++;
      rawTotal += r;
    }
  });

  const estimate = have < n * 0.3;
  let source = estimate ? 'estimated' : have === n ? 'projected' : 'mixed';
  players.forEach((p, i) => {
    if (estimate) {
      const proj = num(p.projected_points) || 0;
      const value = proj / Math.max(1, (num(p.salary) || 0) / 1000);
      pct[i] = proj * value ** 3;
    } else {
      const r = num(p.rostership);
      pct[i] = r && r > 0 ? r : 0.5;
    }
  });
  if (estimate) {
    // Value-driven guess, then made salary-consistent (a real field averages ~$49.7k)
    const tilted = tiltToSalary(pct, players.map((p) => num(p.salary) || 0));
    pct.set(tilted);
  }
  let overridden = 0;
  players.forEach((p, i) => {
    const o = override(p);
    if (o !== null) {
      pct[i] = Math.max(0, o);
      overridden++;
    }
  });
  if (overridden && source === 'projected' && overridden < n) source = 'mixed';
  return { pct: normalizeOwnership(pct), source, rawTotal: Math.round(rawTotal * 10) / 10 };
}

/**
 * Sample a synthetic field.
 * @param ctx - solver context (salary, mask, salaryCap)
 * @param ownPct - target ownership % per player (sum 800)
 * @param opts - { size, rng, meanLeftover, maxLeftover, calibrationRounds, optimizedShare, optimizerNoise,
 *   projections? (required for optimizedShare > 0), eligible?: Uint8Array, onProgress }
 * @returns {{lineups: Uint16Array (size*8), salaries: Int32Array, exposure: Float64Array (%), calibrationError: number,
 *   optimizedCount: number}}
 */
export function generateField(ctx, ownPct, opts) {
  const { size, rng, onProgress } = opts;
  const meanLeftover = opts.meanLeftover ?? FIELD_DEFAULTS.meanLeftover;
  const maxLeftover = opts.maxLeftover ?? FIELD_DEFAULTS.maxLeftover;
  const rounds = Math.max(1, opts.calibrationRounds ?? FIELD_DEFAULTS.calibrationRounds);
  const share = opts.projections ? Math.min(1, Math.max(0, opts.optimizedShare ?? FIELD_DEFAULTS.optimizedShare)) : 0;
  const noise = Math.max(0, opts.optimizerNoise ?? FIELD_DEFAULTS.optimizerNoise);
  const { salary, mask, salaryCap } = ctx;

  const pool = [];
  for (let i = 0; i < ctx.n; i++) {
    if ((!opts.eligible || opts.eligible[i]) && mask[i] && salary[i] > 0 && ownPct[i] > 0) pool.push(i);
  }
  if (pool.length < ROSTER_SIZE) throw new Error('Not enough players with ownership to build a field');

  let minSal = Infinity;
  let maxSal = 0;
  for (const i of pool) {
    minSal = Math.min(minSal, salary[i]);
    maxSal = Math.max(maxSal, salary[i]);
  }
  const maskTypes = [...new Set(pool.map((i) => mask[i]))];
  const maskOk = new Uint8Array(256);
  const weights = new Float64Array(ctx.n);

  const chosen = new Uint8Array(ctx.n);
  const picked = new Int32Array(ROSTER_SIZE);
  const pickedMasks = new Uint8Array(ROSTER_SIZE);
  const cand = new Int32Array(pool.length);
  const candW = new Float64Array(pool.length);

  const sampleOne = (out, offset) => {
    let rem = salaryCap;
    let step = 0;
    for (; step < ROSTER_SIZE; step++) {
      for (const m of maskTypes) {
        pickedMasks[step] = m;
        maskOk[m] = canMatch(pickedMasks, step + 1) ? 1 : 0;
      }
      const slotsLeft = ROSTER_SIZE - 1 - step;
      const last = slotsLeft === 0;
      let k = 0;
      let total = 0;
      for (const i of pool) {
        if (chosen[i] || !maskOk[mask[i]]) continue;
        const after = rem - salary[i];
        if (after < slotsLeft * minSal) continue;
        let w = weights[i];
        if (last) {
          if (after > maxLeftover) continue;
          w *= Math.exp(-after / meanLeftover);
        } else if (after - maxLeftover > slotsLeft * maxSal) continue;
        if (!(w > 0)) continue;
        cand[k] = i;
        total += w;
        candW[k++] = total;
      }
      if (k === 0) break;
      const u = rng.uniform() * total;
      let lo = 0;
      let hi = k - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (candW[mid] > u) hi = mid;
        else lo = mid + 1;
      }
      const pick = cand[lo];
      picked[step] = pick;
      pickedMasks[step] = mask[pick];
      chosen[pick] = 1;
      rem -= salary[pick];
    }
    for (let s = 0; s < step; s++) chosen[picked[s]] = 0;
    if (step < ROSTER_SIZE) return -1;
    for (let s = 0; s < ROSTER_SIZE; s++) out[offset + s] = picked[s];
    return salaryCap - rem;
  };

  const lineups = new Uint16Array(size * ROSTER_SIZE);
  const salaries = new Int32Array(size);
  const counts = new Float64Array(ctx.n);

  // ---- Optimizer-built share ----
  const optCounts = new Float64Array(ctx.n);
  let nOpt = 0;
  const optTarget = Math.round(size * share);
  if (optTarget > 0) {
    const proj = new Float64Array(ctx.n);
    for (let tries = 0; nOpt < optTarget && tries < optTarget * 3; tries++) {
      for (const i of pool) proj[i] = opts.projections[i] * Math.exp(noise * rng.normal() - (noise * noise) / 2);
      const res = solveLineup(ctx, proj, { rng });
      if (!res) continue;
      const off = nOpt * ROSTER_SIZE;
      for (let s = 0; s < ROSTER_SIZE; s++) {
        lineups[off + s] = res.players[s];
        optCounts[res.players[s]]++;
      }
      salaries[nOpt++] = res.salary;
      if (onProgress && nOpt % 100 === 0) onProgress((share * nOpt) / optTarget);
    }
  }
  const nRand = size - nOpt;

  // ---- Ownership-sampled remainder: target what the optimized part leaves over ----
  const target = new Float64Array(ctx.n);
  for (const i of pool) {
    target[i] = nRand > 0 ? Math.max(0, (ownPct[i] / 100) * size - optCounts[i]) / nRand : 0;
  }
  const targetSum = pool.reduce((a, i) => a + target[i], 0);
  if (targetSum > 0) for (const i of pool) target[i] *= ROSTER_SIZE / targetSum;
  for (const i of pool) weights[i] = Math.max(target[i], 1e-6);

  const randLineups = lineups.subarray(nOpt * ROSTER_SIZE);
  for (let round = 0; nRand > 0 && round < rounds; round++) {
    const last = round === rounds - 1;
    const m = last ? nRand : Math.min(nRand, CALIBRATION_SAMPLE);
    counts.fill(0);
    let made = 0;
    let attempts = 0;
    while (made < m) {
      if (++attempts > m * 50) throw new Error('Field sampler could not build valid lineups (check salaries/positions)');
      const sal = sampleOne(randLineups, made * ROSTER_SIZE);
      if (sal < 0) continue;
      salaries[nOpt + made] = sal;
      for (let s = 0; s < ROSTER_SIZE; s++) counts[randLineups[made * ROSTER_SIZE + s]]++;
      made++;
    }
    if (onProgress) onProgress(share + (1 - share) * ((round + 1) / rounds));
    if (last) break;

    // Multiplicative refit toward target exposure (bounded per round)
    for (const i of pool) {
      const ratio = (target[i] + 0.5 / m) / (counts[i] / m + 0.5 / m);
      weights[i] *= Math.min(5, Math.max(0.2, ratio));
    }
  }

  const exposure = Float64Array.from(counts, (c, i) => ((c + optCounts[i]) / size) * 100);
  let calibrationError = 0;
  for (const i of pool) calibrationError += Math.abs(exposure[i] - ownPct[i]);
  calibrationError /= pool.length;
  return { lineups, salaries, exposure, calibrationError, optimizedCount: nOpt };
}

/**
 * Expected number of *other* entries holding an identical lineup.
 *
 * Model: each player is in a random field lineup independently with p = own, conditioned
 * on exactly 8 players, so P(L) = prod_{i in L} p_i/(1-p_i) * prod_all (1-p_j) / P(sum = 8).
 * Roster/salary rules concentrate mass on valid lineups, so the model is rescaled by k,
 * fit from duplicate pairs in the sampled field (collision rate = E_field[P(L)]).
 *
 * @returns {{estimate: (players: ArrayLike<number>) => number, scale: number, fieldDuplicatePairs: number}}
 */
export function createDupeModel(ownPct, field, fieldSize, contestSize) {
  const n = ownPct.length;
  const logOdds = new Float64Array(n);
  let logBase = 0;
  // Poisson-binomial P(exactly ROSTER_SIZE of n Bernoullis)
  let dp = new Float64Array(ROSTER_SIZE + 2);
  dp[0] = 1;
  for (let i = 0; i < n; i++) {
    const p = Math.min(0.97, Math.max(1e-4, ownPct[i] / 100));
    logOdds[i] = Math.log(p / (1 - p));
    logBase += Math.log(1 - p);
    const next = new Float64Array(ROSTER_SIZE + 2);
    for (let k = 0; k <= ROSTER_SIZE + 1; k++) {
      next[k] += dp[k] * (1 - p);
      if (k + 1 <= ROSTER_SIZE + 1) next[k + 1] += dp[k] * p;
    }
    dp = next;
  }
  logBase -= Math.log(Math.max(1e-300, dp[ROSTER_SIZE]));
  const modelProb = (players) => {
    let s = logBase;
    for (let k = 0; k < players.length; k++) s += logOdds[players[k]];
    return Math.exp(s);
  };

  const counts = new Map();
  let meanModel = 0;
  const tmp = new Array(ROSTER_SIZE);
  for (let f = 0; f < fieldSize; f++) {
    for (let s = 0; s < ROSTER_SIZE; s++) tmp[s] = field[f * ROSTER_SIZE + s];
    meanModel += modelProb(tmp);
    const key = [...tmp].sort((a, b) => a - b).join(',');
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  meanModel /= fieldSize;
  let pairs = 0;
  for (const c of counts.values()) pairs += (c * (c - 1)) / 2;
  const totalPairs = (fieldSize * (fieldSize - 1)) / 2;

  let scale = 1;
  if (meanModel > 0) {
    // With few observed collisions, only trust the fit as an upper bound
    const fitted = Math.max(pairs, 0.5) / totalPairs / meanModel;
    scale = pairs >= 3 ? fitted : Math.min(1, fitted);
    scale = Math.min(50, Math.max(0.2, scale));
  }

  return {
    scale,
    fieldDuplicatePairs: pairs,
    estimate: (players) => Math.min(contestSize - 1, (contestSize - 1) * scale * modelProb(players))
  };
}
