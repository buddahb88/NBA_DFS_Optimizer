/**
 * CONTEST PAYOUT STRUCTURES
 *
 * A payout table is a Float64Array indexed by 0-based finishing rank (index 0 = 1st place);
 * ranks beyond its length pay nothing. Presets generate a smooth GPP-style curve:
 *   payout(r) = minCash + A * ((r + 1)^-alpha - paid^-alpha)
 * with A set so the table sums to the prize pool and alpha solved so 1st place takes
 * `firstPlaceShare` of the pool.
 */

export const CONTEST_PRESETS = {
  'single-entry': {
    label: 'Single Entry',
    contestSize: 5000,
    entryFee: 20,
    maxEntries: 1,
    rake: 0.14,
    paidFraction: 0.22,
    firstPlaceShare: 0.1,
    minCashMultiple: 1.8
  },
  '3-max': {
    label: '3-Max',
    contestSize: 12000,
    entryFee: 10,
    maxEntries: 3,
    rake: 0.15,
    paidFraction: 0.22,
    firstPlaceShare: 0.1,
    minCashMultiple: 1.8
  },
  '20-max': {
    label: '20-Max',
    contestSize: 40000,
    entryFee: 5,
    maxEntries: 20,
    rake: 0.15,
    paidFraction: 0.21,
    firstPlaceShare: 0.12,
    minCashMultiple: 1.6
  },
  '150-max': {
    label: '150-Max Large Field',
    contestSize: 150000,
    entryFee: 20,
    maxEntries: 150,
    rake: 0.15,
    paidFraction: 0.2,
    firstPlaceShare: 0.15,
    minCashMultiple: 1.5
  }
};

const round2 = (v) => Math.round(v * 100) / 100;

/** Smooth GPP payout curve. */
export function generatePayoutTable({ contestSize, entryFee, rake = 0.15, paidFraction = 0.2, firstPlaceShare = 0.15, minCashMultiple = 1.5 }) {
  const pool = contestSize * entryFee * (1 - rake);
  const paid = Math.max(1, Math.min(contestSize, Math.floor(contestSize * paidFraction)));
  if (paid === 1) return Float64Array.of(round2(pool));

  let minCash = entryFee * minCashMultiple;
  if (minCash * paid >= pool) minCash = (pool / paid) * 0.5;
  const remaining = pool - minCash * paid;
  const target = Math.min(0.95, Math.max(firstPlaceShare, (minCash + remaining / paid) / pool)) * pool;

  const curve = (alpha) => {
    const floor = paid ** -alpha;
    let sum = 0;
    const g = new Float64Array(paid);
    for (let r = 0; r < paid; r++) {
      g[r] = (r + 1) ** -alpha - floor;
      sum += g[r];
    }
    return { g, A: sum > 0 ? remaining / sum : 0 };
  };

  // First-place payout increases with alpha (more top-heavy): bisect
  let lo = 0.01;
  let hi = 6;
  for (let it = 0; it < 60; it++) {
    const mid = (lo + hi) / 2;
    const { g, A } = curve(mid);
    if (minCash + A * g[0] < target) lo = mid;
    else hi = mid;
  }
  const { g, A } = curve((lo + hi) / 2);
  return Float64Array.from(g, (v) => round2(minCash + A * v));
}

/**
 * Normalize a custom payout spec into a table.
 * Accepts [p1, p2, ...] (by rank) or [{ minRank, maxRank, payout }] (1-based, inclusive).
 */
export function payoutTableFromSpec(spec) {
  if (!Array.isArray(spec) || spec.length === 0) throw new Error('payouts must be a non-empty array');
  if (typeof spec[0] === 'number') {
    return Float64Array.from(spec, (v) => {
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) throw new Error('payouts must be non-negative numbers');
      return n;
    });
  }
  let last = 0;
  for (const tier of spec) {
    const max = Number(tier.maxRank ?? tier.minRank);
    if (!Number.isInteger(max) || max < 1) throw new Error('payout tiers need integer minRank/maxRank >= 1');
    last = Math.max(last, max);
  }
  if (last > 1_000_000) throw new Error('payout tiers exceed 1,000,000 ranks');
  const table = new Float64Array(last);
  for (const tier of spec) {
    const min = Number(tier.minRank);
    const max = Number(tier.maxRank ?? tier.minRank);
    const pay = Number(tier.payout);
    if (!Number.isInteger(min) || min < 1 || max < min || !Number.isFinite(pay) || pay < 0) {
      throw new Error('invalid payout tier');
    }
    for (let r = min; r <= max; r++) table[r - 1] = pay;
  }
  return table;
}

/**
 * Resolve the `contest` request option: a preset name, or an object that may extend a
 * preset ({ preset, contestSize, entryFee, maxEntries, payouts, ... }).
 * @returns {{name, label, contestSize, entryFee, maxEntries, payouts: Float64Array, prizePool}}
 */
export function resolveContest(contest = '20-max') {
  const spec = typeof contest === 'string' ? { preset: contest } : { ...(contest || {}) };
  const presetName = spec.preset || (spec.payouts ? null : '20-max');
  const preset = presetName ? CONTEST_PRESETS[presetName] : {};
  if (presetName && !preset) {
    throw new Error(`Unknown contest preset "${presetName}" (expected ${Object.keys(CONTEST_PRESETS).join(', ')})`);
  }
  const cfg = { ...preset, ...spec };
  const contestSize = Math.floor(Number(cfg.contestSize));
  const entryFee = Number(cfg.entryFee);
  if (!(contestSize >= 2)) throw new Error('contestSize must be >= 2');
  if (!(entryFee > 0)) throw new Error('entryFee must be > 0');
  const maxEntries = Math.max(1, Math.min(contestSize - 1, Math.floor(Number(cfg.maxEntries) || 1)));

  let payouts = spec.payouts ? payoutTableFromSpec(spec.payouts) : generatePayoutTable({ ...cfg, contestSize, entryFee });
  if (payouts.length > contestSize) payouts = payouts.slice(0, contestSize);
  const prizePool = round2(payouts.reduce((s, v) => s + v, 0));

  return {
    name: presetName || 'custom',
    label: cfg.label || 'Custom',
    contestSize,
    entryFee,
    maxEntries,
    payouts,
    prizePool
  };
}

/**
 * Prefix sums so a tie across `dupes` extra entries (they split ranks r..r+dupes) is O(1).
 * @returns {(rank0: number, dupes?: number) => number}
 */
export function createPayoutLookup(payouts) {
  const L = payouts.length;
  const cum = new Float64Array(L + 1);
  for (let r = 0; r < L; r++) cum[r + 1] = cum[r] + payouts[r];
  return (rank0, dupes = 0) => {
    if (rank0 >= L) return 0;
    if (dupes <= 0) return payouts[rank0];
    const end = Math.min(rank0 + dupes + 1, L);
    return (cum[end] - cum[rank0]) / (dupes + 1);
  };
}
