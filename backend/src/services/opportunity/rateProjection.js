/**
 * OPPORTUNITY RATE PROJECTION
 *
 * Pure math for a rate-based projection to hold against the posted one:
 *
 *   rate_projection = projected minutes (slate) x FPPM x environment x teammate
 *
 * FPPM (site points per minute, games before the slate date only):
 * - base: this season's FPPM shrunk toward last season's with
 *   SEASON_PRIOR_MINUTES pseudo-minutes (last season alone with no games this
 *   season; this season alone without last season).
 * - recent: FPPM over the last 10 games (crossing into last season only when
 *   splitSample falls back, as O1's L10 windows do).
 * - blend = w x recent + (1 - w) x base, w = L10_WEIGHT x m / (m + L10_SHRINK_MINUTES)
 *   with m = minutes in the last 10, so a few games lean on the base.
 *
 * Environment (one factor, capped; Vegas prices pace in, so pace only fills in
 * when there is no line):
 * - implied: 1 + (implied total - LEAGUE_IMPLIED_TOTAL) x IMPLIED_PER_POINT
 *   (minutesModel's Vegas coefficients).
 * - pace: 1 + PACE_ELASTICITY x (pace proxy / league pace - 1).
 *
 * Teammate out: O2's combined `adjusted` split when its sample is confirmed
 * (pre-lock outs only): the relative FPPM change without the teammate(s),
 * shrunk by games_without / (games_without + TEAMMATE_SHRINK_GAMES) and capped
 * (minutesModel's usage bump caps). Minutes are not bumped: the slate's minutes
 * projection already accounts for who is out.
 *
 * Coefficients were checked on the no-lookahead replay
 * (scripts/rate-projection-report.js); they are deliberately conservative.
 * 2025-26 with actual minutes (26k games): MAE 5.52 vs 5.59 for plain season
 * FPPM; L10 weight 0.3-0.7, shrink 75-300 and prior 120-480 minutes all land
 * within 5.49-5.54, pace elasticity 0.25-1 within 0.01, so the middle values
 * stand.
 */

import { DEFAULT_MINUTES_CONFIG } from '../minutesModel.js';
import { splitSample } from './playerMetrics.js';

export const RATE_CONFIG = Object.freeze({
  l10Games: 10,
  l10Weight: 0.5,
  l10ShrinkMinutes: 150,
  seasonPriorMinutes: 240,
  leagueImpliedTotal: DEFAULT_MINUTES_CONFIG.leagueImpliedTotal,
  impliedPerPoint: DEFAULT_MINUTES_CONFIG.vegasPerPoint,
  envCap: DEFAULT_MINUTES_CONFIG.vegasCap,
  paceElasticity: 0.5,
  teammateShrinkGames: DEFAULT_MINUTES_CONFIG.usageShrinkGames,
  teammateBumpCap: DEFAULT_MINUTES_CONFIG.usageBumpCap,
  teammateDropCap: DEFAULT_MINUTES_CONFIG.usageDropCap
});

const n = (v) => Number(v) || 0;
const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const round = (x, digits) => (x === null || x === undefined || !Number.isFinite(x) ? null : Number(x.toFixed(digits)) + 0);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const sum = (games, f) => games.reduce((s, g) => s + f(g), 0);
const minutesOf = (games) => sum(games, g => n(g.minutes));
const fpOf = (games) => sum(games, g => n(g.fp));

/**
 * Blended FPPM from a game log (minutes > 0, most recent first, before the
 * slate date). Unrounded. Null fields without games.
 * Returns { fppm, recent, base, current, prior, l10_weight, l10_minutes, current_minutes }.
 */
export function blendFppm(games, { season, config = RATE_CONFIG } = {}) {
  const current = games.filter(g => g.season === season);
  const priorSeason = games.find(g => g.season !== season)?.season ?? null;
  const prior = priorSeason ? games.filter(g => g.season === priorSeason) : [];
  const curMin = minutesOf(current);
  const priorMin = minutesOf(prior);
  const curFppm = curMin > 0 ? fpOf(current) / curMin : null;
  const priorFppm = priorMin > 0 ? fpOf(prior) / priorMin : null;

  let base = null;
  if (curFppm !== null && priorFppm !== null) {
    base = (fpOf(current) + config.seasonPriorMinutes * priorFppm) / (curMin + config.seasonPriorMinutes);
  } else {
    base = curFppm ?? priorFppm;
  }
  if (base === null) {
    return { fppm: null, recent: null, base: null, current: null, prior: null, l10_weight: null, l10_minutes: 0, current_minutes: 0 };
  }

  const l10 = splitSample(games, season).recent.slice(0, config.l10Games);
  const l10Min = minutesOf(l10);
  const recent = l10Min > 0 ? fpOf(l10) / l10Min : base;
  const w = config.l10Weight * l10Min / (l10Min + config.l10ShrinkMinutes);
  return {
    fppm: w * recent + (1 - w) * base,
    recent,
    base,
    current: curFppm,
    prior: priorFppm,
    l10_weight: w,
    l10_minutes: l10Min,
    current_minutes: curMin
  };
}

/**
 * Environment factor: Vegas implied total when posted (> 0), else the pace
 * proxy vs league pace, else 1. Returns { factor, basis: 'implied' | 'pace' | null }.
 */
export function environmentFactor({ impliedTotal = null, paceProxy = null, leaguePace = null } = {}, config = RATE_CONFIG) {
  const cap = (x) => clamp(x, 1 - config.envCap, 1 + config.envCap);
  const implied = num(impliedTotal);
  if (implied !== null && implied > 0) {
    return { factor: cap(1 + (implied - config.leagueImpliedTotal) * config.impliedPerPoint), basis: 'implied' };
  }
  const pace = num(paceProxy);
  const league = num(leaguePace);
  if (pace !== null && pace > 0 && league !== null && league > 0) {
    return { factor: cap(1 + config.paceElasticity * (pace / league - 1)), basis: 'pace' };
  }
  return { factor: 1, basis: null };
}

/**
 * Teammate-out factor from O2's combined split (`adjusted`): only a confirmed
 * sample counts. Returns { factor, applied, games_without }.
 */
export function teammateFactor(adjusted, config = RATE_CONFIG) {
  const none = { factor: 1, applied: false, games_without: adjusted?.games_without ?? null };
  if (!adjusted || adjusted.sample !== 'confirmed') return none;
  const withRate = num(adjusted.fppm_with);
  const withoutRate = num(adjusted.fppm_without);
  if (!(withRate > 0) || withoutRate === null) return none;
  const gw = n(adjusted.games_without);
  const shrink = gw / (gw + config.teammateShrinkGames);
  const change = clamp((withoutRate / withRate - 1) * shrink, config.teammateDropCap, config.teammateBumpCap);
  return { factor: 1 + change, applied: true, games_without: gw };
}

/**
 * The rate projection and its gap to the posted projection.
 * @param {{ fppm: object, projectedMinutes, projectedPoints, salary,
 *   impliedTotal, paceProxy, leaguePace, adjusted }} input
 *   fppm: blendFppm's result; adjusted: O2's combined split (pre-lock outs)
 * Returns rounded output fields; rate_projection is null with rate_reason
 * 'no_projected_minutes' | 'no_games'.
 */
export function rateProjection({
  fppm = null, projectedMinutes = null, projectedPoints = null, salary = null,
  impliedTotal = null, paceProxy = null, leaguePace = null, adjusted = null, config = RATE_CONFIG
}) {
  const env = environmentFactor({ impliedTotal, paceProxy, leaguePace }, config);
  const mate = teammateFactor(adjusted, config);
  const minutes = num(projectedMinutes);

  let reason = null;
  if (!(minutes > 0)) reason = 'no_projected_minutes';
  else if (fppm?.fppm === null || fppm?.fppm === undefined) reason = 'no_games';

  const rate = reason ? null : minutes * fppm.fppm * env.factor * mate.factor;
  const f = fppm ?? {};
  const posted = num(projectedPoints);
  const gap = rate !== null && posted !== null ? rate - posted : null;
  const sal = num(salary);
  return {
    rate_projection: round(rate, 1),
    rate_reason: reason,
    rate_fppm: round(f.fppm, 3),
    rate_fppm_recent: round(f.recent, 3),
    rate_fppm_base: round(f.base, 3),
    rate_l10_weight: round(f.l10_weight, 3),
    rate_env_factor: round(env.factor, 3),
    rate_env_basis: env.basis,
    rate_teammate_factor: round(mate.factor, 3),
    rate_teammate_applied: mate.applied,
    rate_teammate_outs: mate.applied ? adjusted.out_names ?? null : null,
    rate_gap: round(gap, 1),
    rate_gap_pct: gap !== null && posted > 0 ? round(gap / posted, 3) : null,
    rate_value: rate !== null && sal > 0 ? round(rate / (sal / 1000), 2) : null
  };
}

export default { blendFppm, environmentFactor, teammateFactor, rateProjection, RATE_CONFIG };
