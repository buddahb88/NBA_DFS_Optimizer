/**
 * CONTEST SIMULATION
 *
 * For every sim iteration: score the sampled field, find its top slice, and place each
 * candidate by how many sampled field lineups beat it. The field sample (F lineups) stands
 * in for the contestSize - 1 real opponents; the contest rank is drawn from the
 * Beta-Binomial implied by that count (see sampleRank), which is unbiased even when the
 * contest is many times larger than the sample.
 */

import { ROSTER_SIZE, solveLineup } from './lineupSolver.js';

/** Iteration-major copy of the sim's player-major sample matrix: T[i * P + p]. */
export function transposeScores(sims) {
  const N = sims.iterations;
  const P = sims.players.length;
  const T = new Float32Array(N * P);
  for (let p = 0; p < P; p++) {
    const off = p * N;
    for (let i = 0; i < N; i++) T[i * P + p] = sims.scores[off + i];
  }
  return T;
}

/** Number of entries in ascending `top` strictly greater than s. */
export function countAbove(top, s) {
  let lo = 0;
  let hi = top.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (top[mid] <= s) lo = mid + 1;
    else hi = mid;
  }
  return top.length - lo;
}

/**
 * Sample a 0-based contest rank among `opponents` real entries, given that `above` of
 * `F` sampled field lineups outscored the candidate. The share of the real field above
 * the candidate is p ~ Beta(above + 1, F - above + 1) and the rank is Binomial(opponents, p);
 * for a candidate exchangeable with the field this reproduces fair odds exactly
 * (including the spread across top ranks that matters for top-heavy payouts).
 */
export function sampleRank(above, F, opponents, rng) {
  let p;
  if (above < 30) {
    // Gamma(above + 1) / (F + 1): Beta's small-shape limit, exact enough for F >> above
    let prod = 1;
    for (let j = 0; j <= above; j++) prod *= 1 - rng.uniform();
    p = -Math.log(prod) / (F + 1);
  } else {
    const mean = (above + 1) / (F + 2);
    p = mean + Math.sqrt((mean * (1 - mean)) / (F + 3)) * rng.normal();
  }
  p = Math.min(1, Math.max(0, p));
  const lambda = opponents * p;
  if (lambda < 30) {
    // Poisson(lambda) by multiplying uniforms (Knuth)
    const limit = Math.exp(-lambda);
    let k = 0;
    let prod = rng.uniform();
    while (prod > limit) {
      k++;
      prod *= rng.uniform();
    }
    return Math.min(opponents, k);
  }
  const k = Math.round(lambda + Math.sqrt(lambda * (1 - p)) * rng.normal());
  return Math.min(opponents, Math.max(0, k));
}

/** Partially order `a` in place so a[k] is the k-th smallest and everything after it is >= (Hoare quickselect). */
export function quickselect(a, k) {
  let left = 0;
  let right = a.length - 1;
  while (right > left) {
    const pivot = a[(left + right) >> 1];
    let i = left;
    let j = right;
    while (i <= j) {
      while (a[i] < pivot) i++;
      while (a[j] > pivot) j--;
      if (i <= j) {
        const t = a[i];
        a[i] = a[j];
        a[j] = t;
        i++;
        j--;
      }
    }
    if (k <= j) right = j;
    else if (k >= i) left = i;
    else break;
  }
}

const SMALL_SHAPE = 30;

/** Standard normal quantile (Acklam's rational approximation, |error| < 1.2e-9). */
export function normalQuantile(u) {
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const x = Math.min(1 - 1e-12, Math.max(1e-12, u));
  if (x < 0.02425) {
    const q = Math.sqrt(-2 * Math.log(x));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (x > 1 - 0.02425) return -normalQuantile(1 - x);
  const q = x - 0.5;
  const r = q * q;
  return ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

/** One night's rank luck, shared by every candidate (see sampleRankShared). */
export function drawRankLuck(rng, luck = { gammaCum: new Float64Array(SMALL_SHAPE), z1: 0, u: 0, zu: 0 }) {
  let acc = 0;
  for (let j = 0; j < SMALL_SHAPE; j++) {
    acc += -Math.log(1 - rng.uniform());
    luck.gammaCum[j] = acc; // Gamma(j + 1)
  }
  luck.z1 = rng.normal();
  luck.u = rng.uniform();
  luck.zu = normalQuantile(luck.u); // the same draw for the Poisson's normal approximation
  return luck;
}

/**
 * sampleRank with common random numbers: the same night's `luck` for every candidate, so
 * the rank is non-decreasing in `above` and two lineups that tie on the night tie in rank.
 * Each candidate's own rank distribution is the same as sampleRank's (Gamma / Beta share,
 * then Poisson by inversion of one uniform, normal approximations for large shapes; the
 * Poisson's normal approximation reads the same uniform, so the two meet at lambda = 30).
 */
export function sampleRankShared(above, F, opponents, luck) {
  let p;
  if (above < SMALL_SHAPE) p = luck.gammaCum[above] / (F + 1);
  else {
    const mean = (above + 1) / (F + 2);
    p = mean + Math.sqrt((mean * (1 - mean)) / (F + 3)) * luck.z1;
  }
  p = Math.min(1, Math.max(0, p));
  const lambda = opponents * p;
  if (lambda < 30) {
    let k = 0;
    let pk = Math.exp(-lambda);
    let cdf = pk;
    while (luck.u > cdf && k < opponents) {
      k++;
      pk *= lambda / k;
      cdf += pk;
    }
    return k;
  }
  const k = Math.round(lambda + Math.sqrt(lambda * (1 - p)) * luck.zu);
  return Math.min(opponents, Math.max(0, k));
}

/**
 * @param opts - {
 *   T, P, N, pool: Uint16Array (C*8), C, field: Uint16Array (F*8), F,
 *   contest: { contestSize, entryFee, payouts }, payout: (rank0, dupes) => $, dupes: Int32Array (C),
 *   rng, sharedRankLuck = false, onProgress
 * }
 * sharedRankLuck: one rank draw per night for all candidates (sampleRankShared) instead of an
 * independent draw per candidate - the comparison between candidates then carries no rank
 * noise (common random numbers); each candidate's own odds are unchanged.
 * @returns per-candidate accumulators + sparse in-the-money entries for portfolio selection
 */
export function simulateContest(opts) {
  const { T, P, N, pool, C, field, F, contest, payout, dupes, rng, onProgress } = opts;
  const luck = opts.sharedRankLuck ? drawRankLuck(rng) : null;
  const paidPlaces = contest.payouts.length;
  const top1Cut = Math.max(1, Math.floor(contest.contestSize * 0.01));
  const opponents = contest.contestSize - 1;

  const sumPay = new Float64Array(C);
  const sumPaySq = new Float64Array(C);
  const sumScore = new Float64Array(C);
  const wins = new Int32Array(C);
  const top1 = new Int32Array(C);
  const cashes = new Int32Array(C);
  // In-the-money entries per candidate (iteration, rank0, score); only these can be
  // affected by self-competition when lineups are combined into a portfolio.
  const itmIter = Array.from({ length: C }, () => []);
  const itmRank = Array.from({ length: C }, () => []);
  const itmScore = Array.from({ length: C }, () => []);

  const fieldScores = new Float32Array(F);
  // Only the top of the field decides payouts: keep enough of it that a candidate below
  // the slice has a negligible chance of cashing (paid share + 6 sd of sampling noise).
  const paidShare = Math.min(1, paidPlaces / opponents);
  const K = Math.min(F, Math.ceil(paidShare * F + 6 * Math.sqrt(paidShare * F) + 10));
  const top = fieldScores.subarray(F - K);
  for (let i = 0; i < N; i++) {
    const base = i * P;
    for (let f = 0; f < F; f++) {
      const o = f * ROSTER_SIZE;
      let s = 0;
      for (let k = 0; k < ROSTER_SIZE; k++) s += T[base + field[o + k]];
      fieldScores[f] = s;
    }
    if (K < F) quickselect(fieldScores, F - K);
    top.sort();
    if (luck) drawRankLuck(rng, luck);

    for (let c = 0; c < C; c++) {
      const o = c * ROSTER_SIZE;
      let s = 0;
      for (let k = 0; k < ROSTER_SIZE; k++) s += T[base + pool[o + k]];
      sumScore[c] += s;
      const above = countAbove(top, s);
      if (above === K && K < F) continue; // below the slice: provably out of the money
      const rank0 = luck ? sampleRankShared(above, F, opponents, luck) : sampleRank(above, F, opponents, rng);
      if (rank0 >= paidPlaces) continue;
      const pay = payout(rank0, dupes[c]);
      sumPay[c] += pay;
      sumPaySq[c] += pay * pay;
      if (pay > 0) cashes[c]++;
      if (rank0 === 0) wins[c]++;
      if (rank0 < top1Cut) top1[c]++;
      itmIter[c].push(i);
      itmRank[c].push(rank0);
      itmScore[c].push(s);
    }
    if (onProgress && (i % 50 === 49 || i === N - 1)) onProgress((i + 1) / N);
  }

  return { sumPay, sumPaySq, sumScore, wins, top1, cashes, itmIter, itmRank, itmScore };
}

/**
 * Per-player rate of appearing in the sim-optimal lineup.
 * @returns {{rates: Float64Array, iterations: number}}
 */
export function optimalRates(ctx, T, P, N, { iterations, rng, kicks = 16, onProgress } = {}) {
  const runs = Math.min(N, iterations ?? N);
  const counts = new Float64Array(P);
  // Spread evenly over the sim instead of taking the first `runs` iterations
  const step = N / runs;
  let solved = 0;
  for (let r = 0; r < runs; r++) {
    const i = Math.floor(r * step);
    const row = T.subarray(i * P, (i + 1) * P);
    const res = solveLineup(ctx, row, { rng, kicks });
    if (res) {
      solved++;
      for (const p of res.players) counts[p]++;
    }
    if (onProgress && (r % 50 === 49 || r === runs - 1)) onProgress((r + 1) / runs);
  }
  return { rates: Float64Array.from(counts, (c) => (solved ? c / solved : 0)), iterations: solved };
}
