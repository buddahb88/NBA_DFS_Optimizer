// Pure helpers for the GPP portfolio builder UI: request building, form
// validation, and shaping /api/portfolio results for tables and charts.

// The portfolio engine solves DraftKings rosters only (backend/src/services/portfolio/lineupSolver.js)
export const PORTFOLIO_SITE = 'draftkings';

export const STAGE_LABELS = {
  queued: 'Queued',
  loading: 'Loading slate',
  simulate: 'Simulating player outcomes',
  pool: 'Generating candidate lineups',
  field: 'Building synthetic field',
  contest: 'Simulating contest',
  optimal: 'Computing optimal rates',
  select: 'Selecting portfolio',
  done: 'Done',
};

const DEFAULT_LIMITS = {
  poolSize: { min: 10, max: 5000, default: 1000 },
  iterations: { min: 100, max: 20000, default: 2000 },
};

export const pct = (rate, dp = 1) => `${(rate * 100).toFixed(dp)}%`;
export const money = (v) =>
  `$${Number(v).toLocaleString(undefined, { minimumFractionDigits: v % 1 ? 2 : 0, maximumFractionDigits: 2 })}`;
export const signedPct = (rate, dp = 1) => `${rate > 0 ? '+' : ''}${(rate * 100).toFixed(dp)}%`;

/** Expected prize pool for a preset-shaped contest. */
export const estimatePrizePool = (contestSize, entryFee, rake = 0.15) => contestSize * entryFee * (1 - rake);

/** Short description of a preset's payout curve. */
export function payoutCurveLabel(preset) {
  return `${preset.label} curve · ${Math.round(preset.paidFraction * 100)}% paid · ${Math.round(preset.firstPlaceShare * 100)}% to 1st`;
}

/** Form defaults for a contest preset key. */
export function formFromPreset(presets, key, limits = DEFAULT_LIMITS) {
  const p = presets[key];
  return {
    contestPreset: key,
    payoutPreset: key,
    contestSize: p.contestSize,
    entryFee: p.entryFee,
    maxEntries: p.maxEntries,
    numLineups: p.maxEntries,
    poolSize: Math.max(limits.poolSize?.default ?? 1000, p.maxEntries * 5),
    iterations: limits.iterations?.default ?? 2000,
  };
}

const isInt = (v) => Number.isInteger(Number(v)) && String(v).trim() !== '';

/** Field errors keyed by form field; empty object when the form is valid. */
export function validatePortfolioForm(form, limits = DEFAULT_LIMITS) {
  const errors = {};
  const n = (k) => Number(form[k]);
  if (!isInt(form.contestSize) || n('contestSize') < 2) errors.contestSize = 'At least 2 entries';
  if (!(n('entryFee') > 0)) errors.entryFee = 'Must be above $0';
  if (!isInt(form.maxEntries) || n('maxEntries') < 1) errors.maxEntries = 'At least 1';
  else if (n('contestSize') >= 2 && n('maxEntries') >= n('contestSize')) errors.maxEntries = 'Must be below contest size';
  if (!isInt(form.numLineups) || n('numLineups') < 1) errors.numLineups = 'At least 1';
  else if (n('maxEntries') >= 1 && n('numLineups') > n('maxEntries')) errors.numLineups = `Max entries is ${n('maxEntries')}`;
  const range = (k, label) => {
    const { min, max } = limits[k] || DEFAULT_LIMITS[k];
    if (!isInt(form[k]) || n(k) < min || n(k) > max) errors[k] = `${label} ${min.toLocaleString()}–${max.toLocaleString()}`;
  };
  range('poolSize', 'Between');
  range('iterations', 'Between');
  if (!errors.poolSize && !errors.numLineups && n('poolSize') < n('numLineups')) errors.poolSize = 'Must be at least the lineup count';
  return errors;
}

/** POST /api/portfolio/build body from the form plus Lineup Studio context. */
export function buildPortfolioRequest(form, { slateId, presets, locked = [], excluded = [], minSalary }) {
  const request = {
    slateId,
    contest: {
      // The payout preset supplies the curve shape; size/fee/max entries override it
      preset: form.payoutPreset,
      label: presets?.[form.contestPreset]?.label || 'Custom',
      contestSize: Number(form.contestSize),
      entryFee: Number(form.entryFee),
      maxEntries: Number(form.maxEntries),
    },
    numLineups: Number(form.numLineups),
    poolSize: Number(form.poolSize),
    iterations: Number(form.iterations),
    lockedPlayers: [...locked],
    excludedPlayers: [...excluded],
  };
  if (Number.isFinite(minSalary)) request.minSalary = minSalary;
  return request;
}

/** Lineup rows for the results table, ranked by standalone ROI. */
export function lineupRows(result) {
  return (result?.portfolio?.lineups || [])
    .map((l, i) => ({
      key: String(l.lineupNumber ?? i + 1),
      number: l.lineupNumber ?? i + 1,
      distIndex: i,
      players: l.players,
      salary: l.totalSalary,
      projection: l.projectedPoints,
      // Backtest: actual DK points of the lineup (null live, or while results are pending)
      actual: l.actualPoints ?? null,
      ...l.metrics,
    }))
    .sort((a, b) => b.roi - a.roi);
}

/** Dupe-risk bucket from the expected number of identical lineups in the contest. */
export function dupeRisk(dupes) {
  if (dupes < 0.5) return { label: 'Low', tone: 'positive' };
  if (dupes < 2) return { label: 'Med', tone: 'caution' };
  return { label: 'High', tone: 'negative' };
}

/**
 * Leverage chart rows: the `limit` players with the largest positive (mode 'over')
 * or negative (mode 'under') optimal% - ownership gap.
 */
export function leverageChartRows(players, mode = 'over', limit = 15) {
  const sign = mode === 'under' ? -1 : 1;
  return [...(players || [])]
    .filter((p) => sign * p.leverage > 0)
    .sort((a, b) => sign * (b.leverage - a.leverage))
    .slice(0, limit)
    .map((p) => ({ id: p.id, name: p.name, team: p.team, optimal: p.optimalRate, ownership: p.ownership, leverage: p.leverage }));
}

/**
 * Histogram rows on the server's shared bins: `all` is the share of every selected
 * lineup's sims in the bin (%), `focus` the same for one lineup (index into
 * scoreDistribution.lineups) or undefined.
 */
export function histogramRows(dist, focusIndex = null, include = null) {
  if (!dist || !dist.binCount) return [];
  const lineups = include ? dist.lineups.filter((_, i) => include.has(i)) : dist.lineups;
  const totals = new Array(dist.binCount).fill(0);
  let grand = 0;
  for (const l of lineups) {
    l.counts.forEach((c, b) => {
      totals[b] += c;
      grand += c;
    });
  }
  const focus = focusIndex != null ? dist.lineups[focusIndex] : null;
  const focusTotal = focus ? focus.counts.reduce((s, c) => s + c, 0) : 0;
  return totals.map((t, b) => {
    const from = dist.binStart + b * dist.binWidth;
    return {
      bin: b,
      from,
      to: from + dist.binWidth,
      mid: from + dist.binWidth / 2,
      all: grand ? (t / grand) * 100 : 0,
      focus: focus && focusTotal ? (focus.counts[b] / focusTotal) * 100 : undefined,
    };
  });
}

/** Export API lineups from portfolio lineups ({ players: [{ position, player }] }). */
export const toExportLineups = (rows) =>
  rows.map((r) => ({ players: r.players.map((s) => ({ slot: s.position, playerId: s.player.id })) }));

const lastName = (name = '') => {
  const parts = String(name).trim().split(/\s+/);
  return parts.length > 1 && /^(jr\.?|sr\.?|ii|iii|iv)$/i.test(parts[parts.length - 1])
    ? parts[parts.length - 2]
    : parts[parts.length - 1];
};

/** "Doncic, Irving, …" summary of a lineup's players. */
export const lineupNames = (players) => players.map((s) => lastName(s.player.name)).join(', ');
