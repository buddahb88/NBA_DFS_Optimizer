/**
 * PORTFOLIO SELECTION
 *
 * Greedy by marginal expected profit, with self-competition modeled exactly: in each sim
 * iteration our own lineups push each other down the payout table, so adding a lineup
 * that cashes in the same iterations as ones already picked (i.e. a highly correlated
 * lineup) earns less than its standalone ROI. That is the correlation-aware diversity
 * term; exposure caps and a minimum-unique-players rule are hard constraints on top.
 *
 * Marginal gains only shrink as the portfolio grows, so lazy evaluation (re-score only the
 * current best upper bound) gives the same picks as full greedy at a fraction of the cost.
 */

import { ROSTER_SIZE } from './lineupSolver.js';

/**
 * @param opts - {
 *   pool: Uint16Array (C*8), C, N, sim (from simulateContest), payout, dupes: Int32Array,
 *   contest, numLineups, maxExposure (%), playerMaxExposure: Map<playerIdx, %>,
 *   minUnique, locked: Set<playerIdx>, onProgress
 * }
 */
export function selectPortfolio(opts) {
  const { pool, C, N, sim, payout, dupes, contest, numLineups, locked = new Set(), onProgress } = opts;
  const { itmIter, itmRank, itmScore } = sim;
  const entryFee = contest.entryFee;
  const maxOverlap = ROSTER_SIZE - Math.max(0, Math.min(ROSTER_SIZE, opts.minUnique ?? 0));
  const baseCap = Math.max(1, Math.floor(((opts.maxExposure ?? 100) / 100) * numLineups + 1e-9));
  const capOf = (p) => {
    if (locked.has(p)) return Infinity;
    const custom = opts.playerMaxExposure?.get(p);
    return custom != null ? Math.floor((custom / 100) * numLineups + 1e-9) : baseCap;
  };

  // Per iteration: our in-the-money entries sorted by score desc
  const lists = new Array(N);
  const usage = new Map();
  const dead = new Uint8Array(C);
  const overlap = new Uint8Array(C);
  const fresh = new Int32Array(C).fill(-1);
  const ub = new Float64Array(C);
  for (let c = 0; c < C; c++) ub[c] = sim.sumPay[c] / N - entryFee;

  const gainOf = (c) => {
    const d = dupes[c];
    const its = itmIter[c];
    let g = 0;
    for (let j = 0; j < its.length; j++) {
      const list = lists[its[j]];
      const r = itmRank[c][j];
      if (!list) {
        g += payout(r, d);
        continue;
      }
      const s = itmScore[c][j];
      let pos = 0;
      while (pos < list.length && list[pos].s > s) pos++;
      g += payout(r + pos, d);
      for (let k = pos; k < list.length; k++) {
        const e = list[k];
        g += payout(e.r + k + 1, e.d) - payout(e.r + k, e.d);
      }
    }
    return g / N - entryFee;
  };

  const exceedsCaps = (c) => {
    for (let k = 0; k < ROSTER_SIZE; k++) {
      const p = pool[c * ROSTER_SIZE + k];
      if ((usage.get(p) || 0) + 1 > capOf(p)) return true;
    }
    return false;
  };

  const selected = [];
  const marginal = [];
  const marks = new Uint8Array(65536);
  for (let step = 0; step < numLineups; step++) {
    let pick = -1;
    for (;;) {
      let best = -1;
      for (let c = 0; c < C; c++) {
        if (dead[c]) continue;
        if (best < 0 || ub[c] > ub[best]) best = c;
      }
      if (best < 0) break;
      if (exceedsCaps(best)) {
        dead[best] = 1; // usage only grows, so this candidate is out for good
        continue;
      }
      if (fresh[best] === step) {
        pick = best;
        break;
      }
      ub[best] = gainOf(best);
      fresh[best] = step;
    }
    if (pick < 0) break;

    selected.push(pick);
    marginal.push(ub[pick]);
    dead[pick] = 1;
    const its = itmIter[pick];
    for (let j = 0; j < its.length; j++) {
      const i = its[j];
      const entry = { s: itmScore[pick][j], r: itmRank[pick][j], d: dupes[pick], c: pick };
      if (!lists[i]) lists[i] = [];
      const list = lists[i];
      let pos = 0;
      while (pos < list.length && list[pos].s > entry.s) pos++;
      list.splice(pos, 0, entry);
    }
    for (let k = 0; k < ROSTER_SIZE; k++) {
      const p = pool[pick * ROSTER_SIZE + k];
      usage.set(p, (usage.get(p) || 0) + 1);
      marks[p] = 1;
    }
    for (let c = 0; c < C; c++) {
      if (dead[c]) continue;
      let ov = 0;
      for (let k = 0; k < ROSTER_SIZE; k++) ov += marks[pool[c * ROSTER_SIZE + k]];
      if (ov > overlap[c]) overlap[c] = ov;
      if (overlap[c] > maxOverlap) dead[c] = 1;
    }
    for (let k = 0; k < ROSTER_SIZE; k++) marks[pool[pick * ROSTER_SIZE + k]] = 0;
    if (onProgress) onProgress((step + 1) / numLineups);
  }

  return { selected, marginal, ...portfolioMetrics(lists, selected, { N, payout, contest }) };
}

/** Whole-portfolio outcome distribution, with self-competition applied. */
function portfolioMetrics(lists, selected, { N, payout, contest }) {
  const entries = selected.length;
  const cost = entries * contest.entryFee;
  const top1Cut = Math.max(1, Math.floor(contest.contestSize * 0.01));
  const perLineup = new Map(selected.map((c) => [c, 0]));
  let sum = 0;
  let sumSq = 0;
  let profitable = 0;
  let anyCash = 0;
  let anyWin = 0;
  let anyTop1 = 0;
  for (let i = 0; i < N; i++) {
    const list = lists[i];
    if (!list || list.length === 0) continue;
    let total = 0;
    list.forEach((e, k) => {
      const pay = payout(e.r + k, e.d);
      total += pay;
      perLineup.set(e.c, perLineup.get(e.c) + pay);
    });
    sum += total;
    sumSq += total * total;
    if (total > cost) profitable++;
    if (total > 0) anyCash++;
    if (list[0].r === 0) anyWin++;
    if (list[0].r < top1Cut) anyTop1++;
  }
  const mean = sum / N;
  const r4 = (v) => Math.round(v * 10000) / 10000;
  const r2 = (v) => Math.round(v * 100) / 100;
  return {
    perLineupMeanPayout: new Map([...perLineup].map(([c, v]) => [c, v / N])),
    metrics: {
      entries,
      totalFees: r2(cost),
      expectedPayout: r2(mean),
      expectedProfit: r2(mean - cost),
      roi: cost > 0 ? r4((mean - cost) / cost) : 0,
      payoutStdev: r2(Math.sqrt(Math.max(0, sumSq / N - mean * mean))),
      profitableRate: r4(profitable / N),
      anyCashRate: r4(anyCash / N),
      anyWinRate: r4(anyWin / N),
      anyTop1Rate: r4(anyTop1 / N)
    }
  };
}
