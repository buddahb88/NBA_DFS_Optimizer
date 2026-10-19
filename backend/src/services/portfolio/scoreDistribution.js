/**
 * SCORE DISTRIBUTIONS
 *
 * Histograms of each selected lineup's simulated fantasy score on one shared set of bins,
 * so the UI can draw the portfolio's combined distribution and overlay any single lineup.
 */

import { ROSTER_SIZE } from './lineupSolver.js';

const round = (v, dp = 1) => Math.round(v * 10 ** dp) / 10 ** dp + 0;

/** Smallest 1/2/2.5/5 x 10^k step that covers `span` in at most `bins` bins. */
export function niceBinWidth(span, bins) {
  const raw = Math.max(span / bins, 1e-9);
  const mag = 10 ** Math.floor(Math.log10(raw));
  for (const m of [1, 2, 2.5, 5, 10]) {
    if (m * mag >= raw) return m * mag;
  }
  return 10 * mag;
}

const quantile = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(q * sorted.length)))];

/**
 * @param T - iteration-major scores, T[i * P + p]
 * @param P - player count, N - iterations
 * @param lineups - array of player-index lists (ROSTER_SIZE each)
 * @param opts - { bins = 40 } target bin count (actual count may be slightly lower after rounding)
 * @returns {{ binStart, binWidth, binCount, lineups: [{ counts, mean, stdev, p10, p50, p90, p99 }] }}
 */
export function scoreDistributions(T, P, N, lineups, { bins = 40 } = {}) {
  const scores = lineups.map((idx) => {
    const s = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const base = i * P;
      let total = 0;
      for (let k = 0; k < ROSTER_SIZE; k++) total += T[base + idx[k]];
      s[i] = total;
    }
    return s.sort();
  });

  let lo = Infinity;
  let hi = -Infinity;
  for (const s of scores) {
    if (s.length === 0) continue;
    lo = Math.min(lo, s[0]);
    hi = Math.max(hi, s[s.length - 1]);
  }
  if (!Number.isFinite(lo)) return { binStart: 0, binWidth: 1, binCount: 0, lineups: [] };

  const binWidth = niceBinWidth(hi - lo, bins);
  const binStart = Math.floor(lo / binWidth) * binWidth;
  const binCount = Math.max(1, Math.floor((hi - binStart) / binWidth) + 1);

  return {
    binStart: round(binStart, 2),
    binWidth,
    binCount,
    lineups: scores.map((s) => {
      const counts = new Array(binCount).fill(0);
      let sum = 0;
      let sumSq = 0;
      for (const v of s) {
        counts[Math.min(binCount - 1, Math.floor((v - binStart) / binWidth))]++;
        sum += v;
        sumSq += v * v;
      }
      const mean = s.length ? sum / s.length : 0;
      return {
        counts,
        mean: round(mean),
        stdev: round(Math.sqrt(Math.max(0, (s.length ? sumSq / s.length : 0) - mean ** 2))),
        p10: round(quantile(s, 0.1)),
        p50: round(quantile(s, 0.5)),
        p90: round(quantile(s, 0.9)),
        p99: round(quantile(s, 0.99))
      };
    })
  };
}
