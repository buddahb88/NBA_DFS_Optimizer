/**
 * Per-player outcome spread (stdev) derivation.
 *
 * Primary source: the player's stored std_dev, from the game-log outcome
 * distribution (services/variance) that also sets floor / ceiling, as a CV of
 * the row's projection.
 * Then historical_games dk_fantasy_points variance, expressed as a
 * coefficient of variation and re-applied to today's projection (so a player
 * whose role grew keeps a sensible spread).
 * Fallback: (ceiling - floor) / 2.5, then a flat league-typical CV.
 */

export const MIN_HIST_GAMES = 8;
export const CV_MIN = 0.15;
export const CV_MAX = 0.9;
export const DEFAULT_CV = 0.35;
export const RANGE_DIVISOR = 2.5;

/** Canonical player name for cross-source matching: no accents, punctuation or Jr/Sr/II-style suffixes. */
export function normalizeName(name) {
  return String(name)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[.'’-]/g, '')
    .replace(/\b(jr|sr|ii|iii|iv|v)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function summarize(values) {
  const n = values.length;
  if (n === 0) return { n: 0, mean: 0, sd: 0 };
  let sum = 0;
  for (const v of values) sum += v;
  const mean = sum / n;
  let ss = 0;
  for (const v of values) ss += (v - mean) ** 2;
  const sd = n > 1 ? Math.sqrt(ss / (n - 1)) : 0;
  return { n, mean, sd };
}

/**
 * @returns {{ sd:number, source:'distribution'|'historical'|'range'|'default' }}
 */
export function derivePlayerSd(player, hist) {
  const mean = Number(player.projected_points) || 0;
  if (mean <= 0) return { sd: 0, source: 'default' };

  const clampCv = (cv) => Math.min(CV_MAX, Math.max(CV_MIN, cv));

  const stored = Number(player.std_dev);
  if (Number.isFinite(stored) && stored > 0) {
    return { sd: clampCv(stored / mean) * mean, source: 'distribution' };
  }

  if (hist && hist.n >= MIN_HIST_GAMES && hist.mean > 0 && hist.sd > 0) {
    return { sd: clampCv(hist.sd / hist.mean) * mean, source: 'historical' };
  }

  const floor = Number(player.floor);
  const ceiling = Number(player.ceiling);
  if (Number.isFinite(floor) && Number.isFinite(ceiling) && ceiling > floor) {
    const sd = (ceiling - floor) / RANGE_DIVISOR;
    return { sd: clampCv(sd / mean) * mean, source: 'range' };
  }

  return { sd: DEFAULT_CV * mean, source: 'default' };
}
