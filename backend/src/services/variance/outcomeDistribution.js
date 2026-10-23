/**
 * PER-PLAYER OUTCOME DISTRIBUTION (floor / ceiling / std_dev / boom / bust)
 *
 * A player's DK score is modelled as S = M x R:
 *   - M, minutes: Normal(projected minutes, minutesSd), truncated to [0, 48].
 *   - R | M, DK points per minute: lognormal with CV kappa / sqrt(M). Per-minute
 *     scoring is noisier in short stints (points accrue roughly like a sum of
 *     per-minute increments), so one constant kappa fits a player across roles.
 *   The rate mean is set so E[S] equals the projection: the distribution only
 *   describes spread around whatever projection the slate carries.
 *
 * kappa and minutesSd come from the player's own recent game log (historical_games,
 * last GAME_WINDOW regular-season games before the slate date), shrunk toward a
 * position / minutes-band prior with weight n / (n + PRIOR_GAMES), so rookies and
 * new players start from the league-typical spread.
 *
 * floor = 15th percentile, ceiling = 85th percentile of S. For a normal these sit
 * ~1 SD either side of the mean (what the old "projection +/- stdDev" intended);
 * using real quantiles keeps the right skew of fantasy scoring. Calibrated so ~15%
 * of actual scores land below the floor and ~15% above the ceiling
 * (scripts/calibrate-outcome-ranges.js).
 *
 * Boom / bust keep the existing definition: value = 5x salary/1000,
 * bust = P(S < value), boom = P(S >= value + 10), both in percent.
 *
 * Blowout risk (spread beyond 10) widens the minutes distribution rather than
 * moving floor/ceiling by fixed point offsets.
 */

export const FLOOR_PCTL = 0.15;
export const CEILING_PCTL = 0.85;
export const GAME_WINDOW = 30;
export const MIN_RATE_MINUTES = 10;
export const PRIOR_GAMES = 8;
export const MAX_MINUTES = 48;

// Global spread multipliers fitted on the no-lookahead 2025-26 replay and checked
// on the 2026-10-20 / 2026-10-21 slates (see scripts/calibrate-outcome-ranges.js).
// They absorb projection error, which a player's own game log does not contain:
// minutes x1.2 took the replay from 17.7% / 17.7% to ~15.9% / 15.0% below floor /
// above ceiling; scaling kappa instead mostly trimmed the upper tail.
export const CALIBRATION = { kappaScale: 1, minutesScale: 1.2 };

// kappa = per-minute CV x sqrt(minutes); 2025-26 medians are ~1.5-1.65 for every band
const KAPPA_PRIOR = { G: 1.6, F: 1.6, C: 1.5 };
// Game-to-game minutes SD by projected-minutes band (2025-26 medians)
const MINUTES_SD_PRIOR = [
  { below: 18, sd: 7.5 },
  { below: 26, sd: 6.8 },
  { below: 32, sd: 5.5 },
  { below: Infinity, sd: 5.0 }
];

const MINUTE_NODES = 48;

// ─────────────────────────────────────────────────────────────
// Normal helpers
// ─────────────────────────────────────────────────────────────

/** Standard normal CDF (Abramowitz-Stegun 7.1.26 erf, |error| < 1.5e-7). */
export function normalCdf(z) {
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const erf = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return z >= 0 ? 0.5 * (1 + erf) : 0.5 * (1 - erf);
}

/** Standard normal quantile (Acklam's rational approximation, |rel error| < 1.2e-9). */
export function normalQuantile(p) {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const lo = 0.02425;
  if (p < lo) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > 1 - lo) return -normalQuantile(1 - p);
  const q = p - 0.5;
  const r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

// ─────────────────────────────────────────────────────────────
// Player profile: game log -> shrunk kappa / minutesSd
// ─────────────────────────────────────────────────────────────

/** 'PG' / 'SG,SF' -> 'G', 'SF' / 'PF,C' -> 'F', 'C' -> 'C' (first listed position wins). */
export function positionGroup(position) {
  const first = String(position ?? '').toUpperCase().split(/[,/]/)[0].trim();
  if (first === 'C') return 'C';
  if (first.endsWith('G')) return 'G';
  return 'F';
}

/** League-typical spread for a position group at a projected-minutes level. */
export function priorFor(group, minutes) {
  const m = Number(minutes) || 0;
  return {
    kappa: KAPPA_PRIOR[group] ?? KAPPA_PRIOR.F,
    minutesSd: MINUTES_SD_PRIOR.find((b) => m < b.below).sd
  };
}

const sampleSd = (values, mean) => {
  if (values.length < 2) return 0;
  let ss = 0;
  for (const v of values) ss += (v - mean) ** 2;
  return Math.sqrt(ss / (values.length - 1));
};

/**
 * Summarize a game log (games with minutes > 0; caller applies the window).
 * Rate stats use games of MIN_RATE_MINUTES+ so cameo minutes don't dominate.
 * @param {{minutes:number, fp:number}[]} games
 */
export function summarizeGameLog(games) {
  const played = (games || []).filter((g) => Number(g.minutes) > 0 && Number.isFinite(Number(g.fp)));
  const rateGames = played.filter((g) => Number(g.minutes) >= MIN_RATE_MINUTES);

  const minutes = played.map((g) => Number(g.minutes));
  const minutesMean = minutes.length ? minutes.reduce((s, v) => s + v, 0) / minutes.length : null;

  let fppm = null;
  let kappa = null;
  if (rateGames.length) {
    const fpSum = rateGames.reduce((s, g) => s + Number(g.fp), 0);
    const minSum = rateGames.reduce((s, g) => s + Number(g.minutes), 0);
    fppm = fpSum / minSum;
    if (rateGames.length >= 2 && fppm > 0) {
      const rates = rateGames.map((g) => Number(g.fp) / Number(g.minutes));
      const rateMean = rates.reduce((s, v) => s + v, 0) / rates.length;
      kappa = (sampleSd(rates, rateMean) / rateMean) * Math.sqrt(minSum / rateGames.length);
    }
  }

  return {
    games: played.length,
    rateGames: kappa == null ? 0 : rateGames.length,
    fppm,
    kappa,
    minutesMean,
    minutesSd: minutes.length >= 2 ? sampleSd(minutes, minutesMean) : null
  };
}

/** Blend a player's observed spread with the prior: weight = n / (n + PRIOR_GAMES). */
export function shrinkProfile(summary, prior) {
  const blend = (observed, n, priorValue) => {
    if (observed == null || n <= 0) return { value: priorValue, weight: 0 };
    const weight = n / (n + PRIOR_GAMES);
    return { value: weight * observed + (1 - weight) * priorValue, weight };
  };
  const k = blend(summary.kappa, summary.rateGames, prior.kappa);
  const m = blend(summary.minutesSd, summary.games, prior.minutesSd);
  return { kappa: k.value, minutesSd: m.value, weight: k.weight, games: summary.games };
}

// ─────────────────────────────────────────────────────────────
// Distribution
// ─────────────────────────────────────────────────────────────

/**
 * Score distribution with E[S] = mean. Minutes are integrated on equal-probability
 * nodes; given minutes the score is lognormal.
 * @returns {{ mean:number, sd:number, cdf:(x:number)=>number, quantile:(p:number)=>number }}
 */
export function outcomeDistribution({ mean, minutes, kappa, minutesSd }) {
  const nodes = [];
  for (let j = 0; j < MINUTE_NODES; j++) {
    const z = normalQuantile((j + 0.5) / MINUTE_NODES);
    nodes.push(Math.min(MAX_MINUTES, Math.max(0, minutes + minutesSd * z)));
  }
  const avgMinutes = nodes.reduce((s, m) => s + m, 0) / MINUTE_NODES;
  const rate = avgMinutes > 0 ? mean / avgMinutes : 0;

  const comps = nodes.map((m) => {
    if (m <= 0 || rate <= 0) return { zero: true, m: 0, cv: 0 };
    const cv = Math.min(2, kappa / Math.sqrt(Math.max(m, 4)));
    const s2 = Math.log(1 + cv * cv);
    return { zero: false, m: rate * m, cv, sigma: Math.sqrt(s2), mu: Math.log(rate * m) - s2 / 2 };
  });

  let second = 0;
  for (const c of comps) second += c.m * c.m * (1 + c.cv * c.cv);
  second /= MINUTE_NODES;
  const sd = Math.sqrt(Math.max(0, second - mean * mean));

  const cdf = (x) => {
    if (x < 0) return 0;
    let p = 0;
    for (const c of comps) {
      if (c.zero) p += 1;
      else if (x > 0) p += normalCdf((Math.log(x) - c.mu) / c.sigma);
    }
    return p / MINUTE_NODES;
  };

  const quantile = (p) => {
    if (cdf(0) >= p) return 0;
    let lo = 0;
    let hi = Math.max(1, mean);
    while (cdf(hi) < p) hi *= 2;
    for (let i = 0; i < 60; i++) {
      const mid = (lo + hi) / 2;
      if (cdf(mid) < p) lo = mid;
      else hi = mid;
    }
    return (lo + hi) / 2;
  };

  return { mean: rate * avgMinutes, sd, cdf, quantile };
}

export function boomBustThresholds(salary) {
  const value = (Number(salary) / 1000) * 5;
  return { value, boom: value + 10 };
}

/**
 * All range metrics for one player from one distribution.
 * @param {{ projection:number, minutes:number, salary:number, profile:{kappa:number, minutesSd:number},
 *           blowoutRisk?:number }} input
 */
export function computeOutcomeRange({ projection, minutes, salary, profile, blowoutRisk = 0 }) {
  const mean = Number(projection) || 0;
  if (mean <= 0) {
    return { floor: 0, ceiling: 0, stdDev: 0, volatility: 0, boomProbability: 0, bustProbability: 0 };
  }
  const mins = Number(minutes) > 0 ? Number(minutes) : 24;
  const dist = outcomeDistribution({
    mean,
    minutes: mins,
    kappa: profile.kappa * CALIBRATION.kappaScale,
    minutesSd: profile.minutesSd * CALIBRATION.minutesScale * (1 + Math.max(0, blowoutRisk))
  });
  const { value, boom } = boomBustThresholds(salary);
  const hasSalary = Number(salary) > 0;
  return {
    floor: dist.quantile(FLOOR_PCTL),
    ceiling: dist.quantile(CEILING_PCTL),
    stdDev: dist.sd,
    volatility: dist.sd / mean,
    boomProbability: hasSalary ? 100 * (1 - dist.cdf(boom)) : 0,
    bustProbability: hasSalary ? 100 * dist.cdf(value) : 0
  };
}
