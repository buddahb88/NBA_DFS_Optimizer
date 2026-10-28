/**
 * PER-MINUTE PRODUCTION MODEL V1 (model evaluation harness projectors
 * "rates_v1" and, on slates, "rates_v1_rotowire_minutes")
 *
 * Our per-minute production, stat by stat. Per player and stat (pts, reb, ast,
 * stl, blk, tov, fg3m) a per-minute rate, then per-stat distributions and DK
 * points by simulation (double-double / triple-double bonuses included).
 *
 *   1. Base rates (empirical Bayes, point-in-time):
 *      volume  (stat + K x archetype prior) / (minutes + K) over every played
 *              game, one sequence decayed by halfLife games, each season
 *              boundary back discounted by seasonDiscount (early in a season
 *              last season carries the rate), games in the other role
 *              (starter / bench) down-weighted by roleWeight. K per stat
 *              (noisy stats - steals, blocks - lean on the prior longer); the
 *              archetype prior (as-of label) is fit on the training window.
 *      points  true-shooting attempts (FGA + 0.44 FTA) per minute x 2 x TS%,
 *              TS% over all games shrunk to the archetype's with
 *              tsShrinkAttempts pseudo attempts (efficiency regresses, volume
 *              stays: a hot shooting stretch does not carry the projection).
 *      threes  3PA per minute x 3P% shrunk with fg3ShrinkAttempts.
 *   2. Per-stat Poisson regressions (log link, offset log minutes; fit on the
 *      training window) on: log base rate, recent form (last 5 and last 15;
 *      volume and shooting separately - the fit puts ~0 on shooting form),
 *      game pace and team scoring environment (as-of shrunk ratings in replay,
 *      the Vegas implied total on slates), the opponent's as-of archetype
 *      defense for the stat (featureStore archetypeDefense deltas, G/F/C when
 *      the archetype cell is missing), home, back-to-back, blowout risk
 *      (|expected margin| by role, as minutes_v2), playoffs, team change, role
 *      change, small samples, OUT teammates - the usage they free up (their
 *      per-minute rate x minutes x how often they played in the team's last
 *      10: a long absence is already in everyone's rates), handed to
 *      teammates in proportion to rate x minutes (so by archetype: a big's
 *      rebounds go mostly to bigs), and the measured with/without per-minute
 *      split shrunk toward no change - and the minutes elasticity:
 *      log(minutes / typical minutes), so a rate is a function of minutes.
 *   3. Distributions: per stat Poisson-gamma (dispersion fit on training) with
 *      a shared per-game gamma factor (good / bad nights move every stat) and
 *      points = 3 x threes + the rest. Simulated at given minutes (actual
 *      minutes for rate evaluation, RotoWire minutes, or minutes_v2's minutes
 *      distribution including DNP) for DK mean / median / p10 / p90,
 *      P(double-double), P(triple-double) and the boom probability.
 *
 * End to end ("rates_v1"): minutes from minutes_v2 (projectDate with the same
 * fit): point = the DK median at minutes_v2's point minutes (0 when that is
 * 0); p10 / p90 / boom / double-doubles from the full mixture (DNP with
 * probability 1 - p_play, else the conditional minutes distribution). Boom:
 * P(DK >= boomMultiple x salary / 1000) on slates, P(DK >= boomPoints) in
 * replay; the prediction carries boom_at.
 *
 * fit() estimates archetype priors, regression coefficients and dispersions
 * on the training window (2024-25). The knobs (halfLife, seasonDiscount, K,
 * TS / 3P% shrinkage, roleWeight, sameGroupWeight, minutesElasticity) were
 * chosen by rate quality at actual minutes on 2025-26 validation, and the end
 * to end point rule (pointMinutes / point / elasticity at projected minutes)
 * by the mean of played and incl.-DNP MAE on validation, minutes_v2's
 * criterion. The 2026-27 holdout and the slates were not used for any choice.
 */

import { getSiteConfig } from '../../config/sites.js';
import { dvpPosition } from '../archetypeDefenseService.js';
import { breakdown, coverage, mulberry32, pairedBootstrap } from './metrics.js';
import { createMinutesV2Projector, DEFAULT_PARAMS as MINUTES_PARAMS, fitMinutesV2, projectDate as projectMinutes, teamCandidates, weightedLeastSquares } from './minutesV2.js';

export const RATE_STATS = Object.freeze(['pts', 'reb', 'ast', 'stl', 'blk', 'tov', 'fg3m']);
// Volume components with an empirical-Bayes base rate (pts and fg3m are built from tsa / fg3a and efficiency)
const VOLUMES = ['tsa', 'fg3a', 'reb', 'ast', 'stl', 'blk', 'tov'];
const DOUBLE_DIGIT = ['pts', 'reb', 'ast', 'stl', 'blk'];
// team_archetype_defense delta per stat
const DEFENSE_DELTA = { pts: 'pts_delta', reb: 'reb_delta', ast: 'ast_delta', fg3m: 'fg3m_delta', stl: 'stocks_delta', blk: 'stocks_delta' };

export const DEFAULT_PARAMS = Object.freeze({
  halfLife: 50,               // games
  seasonDiscount: 0.7,        // weight of a game per season boundary back (on top of the decay)
  roleWeight: 0.6,            // weight of games in the other role (starter vs bench)
  shrink: Object.freeze({ tsa: 50, fg3a: 80, reb: 80, ast: 80, stl: 250, blk: 150, tov: 150 }), // pseudo-minutes of the archetype prior
  tsShrinkAttempts: 200,      // pseudo true-shooting attempts at the archetype TS%
  fg3ShrinkAttempts: 300,     // pseudo 3PA at the archetype 3P%
  formGames: 5,
  formGamesLong: 15,
  minutesElasticity: true,    // per-minute rates scale with (minutes / typical minutes)^elasticity
  usageMinMinutes: 12,        // OUT players below this free no usage
  sameGroupWeight: 1,         // OUT usage to the same position group (1 = in proportion to rate x minutes only)
  splitGames: 60,
  splitMinMinutes: 60,        // minutes with the OUT player before a split counts
  splitShrinkMinutes: 150,
  sims: 300,                  // simulated games per player
  pointMinutes: 'point',      // end to end: DK at minutes_v2's point minutes ('point') or the shaded mixture median ('mixture')
  shading: MINUTES_PARAMS.shading,
  point: 'median',            // 'median' | 'mean' of the simulated DK distribution
  boomMultiple: 6,            // slates: P(DK >= 6x salary / 1000)
  boomPoints: 40,             // replay: P(DK >= 40)
  ridge: 1e-4
});

// League-average per-minute fallbacks (an unfitted model, players nobody can classify)
const FALLBACK_PRIOR = Object.freeze({ tsa: 0.39, fg3a: 0.15, reb: 0.19, ast: 0.105, stl: 0.032, blk: 0.022, tov: 0.056, ts: 0.575, fg3pct: 0.355 });

const n = (v) => Number(v) || 0;
const round = (v, d = 3) => (Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d : null);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const dot = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0);
const tsaOf = (g) => n(g.fg_attempted) + 0.44 * n(g.ft_attempted);
const statOf = {
  tsa: tsaOf, fg3a: (g) => n(g.fg3_attempted), pts: (g) => n(g.points), fg3m: (g) => n(g.fg3_made),
  reb: (g) => n(g.rebounds), ast: (g) => n(g.assists), stl: (g) => n(g.steals), blk: (g) => n(g.blocks), tov: (g) => n(g.turnovers)
};
const QUANTILE_LEVELS = Array.from({ length: 99 }, (_, i) => (i + 1) / 100);

/**
 * Base rates of one player on the view's date.
 * Returns { rates: { pts, reb, ..., tsa, fg3a }, ts, fg3pct, minutes (effective
 * sample), form: { tsa, fg3a, reb, ..., ptsEff, fg3Eff }, role, roleShift,
 * teamChanged, avgMinutes, games, group }.
 */
export function baseRates(view, key, { team = null, prior = FALLBACK_PRIOR } = {}, params = DEFAULT_PARAMS) {
  const hist = view.playerGames(key, { seasons: 'all' }); // played, most recent first
  const cur = hist.filter(g => g.season === view.season);
  const roleGames = cur.length >= 3 ? cur : hist;
  const st3 = roleGames.length ? roleGames.slice(0, 3).reduce((s, g) => s + n(g.is_starter), 0) / Math.min(3, roleGames.length) : 0;
  const older = roleGames.slice(3, 15);
  const stOlder = older.length ? older.reduce((s, g) => s + n(g.is_starter), 0) / older.length : st3;
  const starter = st3 >= 0.5 ? 1 : 0;
  const roleW = (g) => (n(g.is_starter) === starter ? 1 : params.roleWeight);

  // One decayed sequence over every season, each season boundary back discounted by seasonDiscount
  const sums = Object.fromEntries([...VOLUMES, 'pts', 'fg3m'].map(s => [s, 0]));
  let minutes = 0;
  let back = 0;
  let season = view.season;
  hist.forEach((g, i) => {
    if (g.season !== season) { season = g.season; back++; }
    const w = 0.5 ** (i / params.halfLife) * params.seasonDiscount ** back * roleW(g);
    minutes += w * n(g.minutes);
    for (const s in sums) sums[s] += w * statOf[s](g);
  });
  const rates = {};
  for (const s of VOLUMES) rates[s] = (sums[s] + params.shrink[s] * prior[s]) / (minutes + params.shrink[s]);

  // Efficiency over both seasons, undecayed (skill), shrunk hard to the archetype
  let pts = 0, tsa = 0, f3m = 0, f3a = 0;
  for (const g of hist) { pts += statOf.pts(g); tsa += tsaOf(g); f3m += statOf.fg3m(g); f3a += statOf.fg3a(g); }
  const ts = (pts / 2 + params.tsShrinkAttempts * prior.ts) / (tsa + params.tsShrinkAttempts);
  const fg3pct = (f3m + params.fg3ShrinkAttempts * prior.fg3pct) / (f3a + params.fg3ShrinkAttempts);
  rates.pts = rates.tsa * 2 * ts;
  rates.fg3m = rates.fg3a * fg3pct;

  // Recent form vs the base: volume, and shooting (made over expected at the base efficiency)
  const recent = hist.slice(0, params.formGames);
  const rMin = recent.reduce((t, g) => t + n(g.minutes), 0);
  const form = {};
  const shrinkMin = 60;
  for (const s of ['tsa', 'fg3a', 'reb', 'ast', 'stl', 'blk', 'tov']) {
    const r = (recent.reduce((t, g) => t + statOf[s](g), 0) + shrinkMin * rates[s]) / (rMin + shrinkMin);
    form[s] = Math.log(r / rates[s]);
  }
  // A longer window too (role changes that settle in over weeks)
  const mid = hist.slice(0, params.formGamesLong);
  const mMin = mid.reduce((t, g) => t + n(g.minutes), 0);
  form.long = {};
  for (const s of ['tsa', 'fg3a', 'reb', 'ast', 'stl', 'blk', 'tov']) {
    const r = (mid.reduce((t, g) => t + statOf[s](g), 0) + 2 * shrinkMin * rates[s]) / (mMin + 2 * shrinkMin);
    form.long[s] = Math.log(r / rates[s]);
  }
  const rTsa = recent.reduce((t, g) => t + tsaOf(g), 0);
  const rPts = recent.reduce((t, g) => t + statOf.pts(g), 0);
  form.ptsEff = Math.log(((rPts / 2) + 30 * ts) / (rTsa + 30) / ts);
  const rF3a = recent.reduce((t, g) => t + statOf.fg3a(g), 0);
  const rF3m = recent.reduce((t, g) => t + statOf.fg3m(g), 0);
  form.fg3Eff = Math.log((rF3m + 20 * fg3pct) / (rF3a + 20) / fg3pct);

  // Naive comparator: raw per-minute rates this season and last, unshrunk
  const naiveGames = hist.filter(g => g.season === view.season || g.season === view.priorSeason);
  const naiveMin = naiveGames.reduce((t, g) => t + n(g.minutes), 0);
  const naive = naiveMin > 0 ? Object.fromEntries(RATE_STATS.map(s => [s, naiveGames.reduce((t, g) => t + statOf[s](g), 0) / naiveMin])) : null;

  const lastTeam = hist[0]?.team ?? null;
  const avgMinutes = hist.length ? hist.slice(0, 10).reduce((t, g) => t + n(g.minutes), 0) / Math.min(10, hist.length) : 0;
  return {
    rates, ts, fg3pct, minutes, form, naive,
    role: starter, roleShift: st3 - stOlder,
    teamChanged: team && lastTeam && lastTeam !== team ? 1 : 0,
    avgMinutes,
    games: hist.length,
    group: dvpPosition(hist[0]?.position) ?? null
  };
}

/** The archetype's prior per-minute rates (fitted), else the league fallback. */
function priorFor(model, archetype) {
  return model.priors?.[archetype] ?? model.priors?.league ?? FALLBACK_PRIOR;
}

/**
 * Game environment of a team: log pace ratio and log team scoring ratio vs
 * the league (as-of ratings, shrunk; the Vegas implied total when known).
 */
export function gameEnvironment(view, team, opponent, impliedTotal = null) {
  const league = view.league();
  const a = view.teamRatings(team);
  const b = view.teamRatings(opponent);
  const leaguePace = league?.pace ?? 99;
  const leagueRtg = league?.rtg ?? 114;
  const pace = Number.isFinite(a.pace) && Number.isFinite(b.pace) ? (a.pace + b.pace) / 2 : leaguePace;
  const leaguePts = leagueRtg * leaguePace / 100;
  let pts = Number.isFinite(a.offRtg) && Number.isFinite(b.defRtg) ? ((a.offRtg + b.defRtg) / 2) * pace / 100 : leaguePts;
  if (Number.isFinite(impliedTotal) && impliedTotal > 0) pts = impliedTotal;
  return { logPace: Math.log(pace / leaguePace), logEnv: Math.log(pts / leaguePts), pace };
}

/** Opponent's as-of defense for the stat, as a log ratio of the archetype's per-game production. */
function defenseFeature(defense, opponent, archetype, group, stat, prior) {
  const col = DEFENSE_DELTA[stat];
  if (!col || !defense) return 0;
  const row = (archetype && archetype !== 'unclassified' ? defense.cell('archetype', opponent, archetype) : null)
    ?? (group ? defense.cell('position', opponent, group) : null);
  if (!row || !(row.avg_minutes > 0)) return 0;
  const perMinute = stat === 'stl' || stat === 'blk' ? prior.stl + prior.blk
    : stat === 'pts' ? prior.tsa * 2 * prior.ts : stat === 'fg3m' ? prior.fg3a * prior.fg3pct : prior[stat];
  const expected = perMinute * row.avg_minutes;
  if (!(expected > 0)) return 0;
  return Math.log(clamp(1 + n(row[col]) / expected, 0.6, 1.4));
}

/** Regressors of one stat's Poisson regression. */
export function rateVector(stat, f) {
  const form = stat === 'pts' ? [f.form.tsa, f.form.ptsEff] : stat === 'fg3m' ? [f.form.fg3a, f.form.fg3Eff] : [f.form[stat], 0];
  return [
    1, Math.log(f.base[stat]), form[0], form[1], f.form.long?.[stat === 'pts' ? 'tsa' : stat === 'fg3m' ? 'fg3a' : stat] ?? 0,
    f.logPace, f.logEnv, f.defense[stat] ?? 0,
    f.home, f.b2b, f.absMargin * f.role / 10, f.absMargin * (1 - f.role) / 10,
    f.playoffs, f.teamChanged, f.roleShift,
    f.usage[stat] ?? 0, f.split[stat] ?? 0,
    f.lowSample, f.noHistory, f.logMinutesRatio ?? 0
  ];
}

/** log(minutes / the player's typical minutes), clamped; 0 without history. */
export function minutesRatio(minutes, typical) {
  if (!(typical > 0) || !(minutes > 0)) return 0;
  return Math.log(clamp(minutes / Math.max(typical, 8), 0.25, 2.5));
}

const RATE_TERMS = rateVector('reb', {
  base: { reb: 1 }, form: { reb: 0, long: { reb: 0 } }, logPace: 0, logEnv: 0, defense: {}, home: 0, b2b: 0, absMargin: 0, role: 0,
  playoffs: 0, teamChanged: 0, roleShift: 0, usage: {}, split: {}, lowSample: 0, noHistory: 0
}).length;

// Unfitted: the base rate as is
const FALLBACK_COEF = (() => {
  const c = new Array(RATE_TERMS).fill(0);
  c[1] = 1;
  return Object.fromEntries(RATE_STATS.map(s => [s, c]));
})();

/** Poisson regression with a log link and offset (IRLS, light ridge on everything but the intercept). */
export function fitPoisson(X, y, offset, { iterations = 30, ridge = 1e-4, start = null } = {}) {
  let beta = start ? [...start] : new Array(X[0].length).fill(0);
  if (!start) {
    const rate = y.reduce((s, v) => s + v, 0) / offset.reduce((s, o) => s + Math.exp(o), 0);
    beta[0] = Math.log(Math.max(rate, 1e-6));
  }
  for (let it = 0; it < iterations; it++) {
    const z = [], w = [];
    for (let i = 0; i < X.length; i++) {
      const eta = dot(X[i], beta) + offset[i];
      const mu = Math.exp(clamp(eta, -20, 8));
      w.push(mu);
      z.push(eta - offset[i] + (y[i] - mu) / mu);
    }
    const next = weightedLeastSquares(X, z, w, ridge);
    const step = Math.max(...next.map((b, i) => Math.abs(b - beta[i])));
    beta = next;
    if (step < 1e-7) break;
  }
  return beta;
}

// ---------------------------------------------------------------------------
// Simulation
// ---------------------------------------------------------------------------

/** Standard normal via Box-Muller. */
function normal(rand) {
  const u = Math.max(rand(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}

/** Gamma(shape, scale 1) (Marsaglia-Tsang; shape < 1 by boosting). */
export function gamma(rand, shape) {
  if (shape < 1) return gamma(rand, shape + 1) * rand() ** (1 / shape);
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x, v;
    do { x = normal(rand); v = 1 + c * x; } while (v <= 0);
    v = v * v * v;
    const u = rand();
    if (u < 1 - 0.0331 * x ** 4 || Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

/** Poisson(lambda): inversion for small lambda, rounded normal (continuity-corrected) above 30. */
export function poisson(rand, lambda) {
  if (!(lambda > 0)) return 0;
  if (lambda > 30) return Math.max(0, Math.round(lambda + Math.sqrt(lambda) * normal(rand)));
  const L = Math.exp(-lambda);
  let k = 0, p = rand();
  while (p > L) { k++; p *= rand(); }
  return k;
}

/** Multiplicative noise with mean 1 and variance v (gamma), 1 when v is 0. */
const noise = (rand, v) => (v > 1e-6 ? gamma(rand, 1 / v) * v : 1);

/** FNV-1a hash of a string to a 32-bit seed. */
export function seedOf(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

/** DK (site) points of a simulated stat line. */
export function fantasyPoints(line, scoring) {
  let total = 0;
  for (const s of RATE_STATS) {
    const w = s === 'fg3m' ? scoring.tpm : scoring[s];
    total += (w || 0) * line[s];
  }
  const dd = DOUBLE_DIGIT.filter(s => line[s] >= 10).length;
  if (dd >= 3) total += scoring.bonusesStack ? (scoring.doubleDouble || 0) + (scoring.tripleDouble || 0) : (scoring.tripleDouble || 0);
  else if (dd >= 2) total += scoring.doubleDouble || 0;
  return total;
}

/**
 * Simulate games at the given minutes draws. rates: per-minute means;
 * dispersion: { shared, pts, reb, ... } (gamma variances); minutesDraw(rand)
 * -> minutes (0 = DNP). Returns { dk: sorted, dd, td, stats: means }.
 */
export function simulate(rates, dispersion, minutesDraw, { sims = 300, seed = 1, scoring, elasticity = null, typical = 0 }) {
  const rand = mulberry32(seed);
  const dk = new Array(sims);
  const means = Object.fromEntries(RATE_STATS.map(s => [s, 0]));
  let dd = 0, td = 0;
  for (let i = 0; i < sims; i++) {
    const m = minutesDraw(rand);
    const line = { pts: 0, reb: 0, ast: 0, stl: 0, blk: 0, tov: 0, fg3m: 0 };
    if (m > 0) {
      const r = ratesAt(rates, m, elasticity, typical);
      const g = noise(rand, dispersion.shared);
      for (const s of ['reb', 'ast', 'stl', 'blk', 'tov', 'fg3m']) line[s] = poisson(rand, r[s] * m * g * noise(rand, dispersion[s]));
      line.pts = 3 * line.fg3m + poisson(rand, Math.max(0, r.pts - 3 * r.fg3m) * m * g * noise(rand, dispersion.pts));
    }
    const fp = fantasyPoints(line, scoring);
    dk[i] = fp;
    for (const s of RATE_STATS) means[s] += line[s];
    const count = DOUBLE_DIGIT.filter(s => line[s] >= 10).length;
    if (count >= 2) dd++;
    if (count >= 3) td++;
  }
  dk.sort((a, b) => a - b);
  for (const s of RATE_STATS) means[s] /= sims;
  return { dk, dd: dd / sims, td: td / sims, stats: means };
}

/** Per-minute rates at m minutes: rates (at the typical minutes) x (m / typical)^elasticity. */
export function ratesAt(rates, m, elasticity = null, typical = 0) {
  if (!elasticity) return rates;
  const x = minutesRatio(m, typical);
  if (!x) return rates;
  const out = {};
  for (const s of RATE_STATS) out[s] = rates[s] * Math.exp((elasticity[s] ?? 0) * x);
  return out;
}

/** Quantile of an ascending sample. */
const sampleQuantile = (sorted, q) => {
  if (!sorted.length) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  return sorted[lo] + (sorted[Math.ceil(pos)] - sorted[lo]) * (pos - lo);
};
const sampleMean = (xs) => xs.reduce((s, v) => s + v, 0) / (xs.length || 1);
const shareAtLeast = (sorted, t) => {
  let lo = 0, hi = sorted.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid] < t) lo = mid + 1; else hi = mid; }
  return (sorted.length - lo) / (sorted.length || 1);
};

/**
 * DK distribution at fixed minutes (rate evaluation: actual or RotoWire
 * minutes). Returns { mean, median, p10, p90, pDd, pTd, stats }.
 */
export function atMinutes(rates, dispersion, minutes, { sims = DEFAULT_PARAMS.sims, seed = 1, scoring, boomAt = null, elasticity = null, typical = 0 } = {}) {
  const s = simulate(rates, dispersion, () => minutes, { sims, seed, scoring, elasticity, typical });
  return {
    mean: sampleMean(s.dk), median: sampleQuantile(s.dk, 0.5), p10: sampleQuantile(s.dk, 0.1), p90: sampleQuantile(s.dk, 0.9),
    pDd: s.dd, pTd: s.td, stats: s.stats, boom: boomAt === null ? null : shareAtLeast(s.dk, boomAt)
  };
}

/** Inverse CDF of stored standardized quantiles (minutes_v2 zMinutes), normal fallback. */
function zAt(zq, tau) {
  if (!zq) return Math.SQRT2 * inverseErf(2 * tau - 1);
  const pos = tau * 100 - 1;
  if (pos <= 0) return zq[0];
  if (pos >= zq.length - 1) return zq[zq.length - 1];
  const lo = Math.floor(pos);
  return zq[lo] + (zq[lo + 1] - zq[lo]) * (pos - lo);
}

function inverseErf(x) {
  const a = 0.147;
  const ln = Math.log(1 - x * x);
  const t = 2 / (Math.PI * a) + ln / 2;
  return Math.sign(x) * Math.sqrt(Math.sqrt(t * t - ln / a) - t);
}

// ---------------------------------------------------------------------------
// Per-date projection
// ---------------------------------------------------------------------------

/**
 * Per-minute rates of every player on the date / slate (team context: OUT
 * teammates, environment, defense). Returns Map(`${key}|${team}` -> { rates,
 * features }).
 */
export function projectRates(dateCtx, model) {
  const { view, day, players } = dateCtx;
  const params = model.params;
  const defense = view.archetypeDefense();
  const baseCache = dateCtx.baseCache ?? new Map();
  const baseOf = (key, team) => {
    const k = `${key}|${team}`;
    if (!baseCache.has(k)) {
      const archetype = view.archetype(key).archetype;
      const prior = priorFor(model, archetype);
      baseCache.set(k, { ...baseRates(view, key, { team, prior }, params), archetype, prior });
    }
    return baseCache.get(k);
  };
  const byTeam = new Map();
  for (const p of players) {
    if (!byTeam.has(p.team)) byTeam.set(p.team, []);
    byTeam.get(p.team).push(p);
  }
  const results = new Map();
  for (const [team, todays] of byTeam) {
    const teamDay = day.teams.get(team);
    const first = todays[0];
    const env = gameEnvironment(view, team, first.opponent, first.slate?.impliedTotal ?? null);
    const spread = first.slate?.spread;
    const margin = Math.abs(view.expectedMargin(team, first.opponent, first.isHome, Number.isFinite(spread) ? spread : null));
    const usage = usageFeatures(view, team, todays, teamDay?.out ?? [], players, baseOf, params);
    for (const p of todays) {
      const b = baseOf(p.key, team);
      const f = {
        base: b.rates, form: b.form, logPace: env.logPace, logEnv: env.logEnv,
        defense: Object.fromEntries(RATE_STATS.map(s => [s, defenseFeature(defense, p.opponent, b.archetype, b.group, s, b.prior)])),
        home: p.isHome ? 1 : 0, b2b: p.isB2B ? 1 : 0, absMargin: margin, role: b.role,
        playoffs: p.seasonType === 'playoffs' ? 1 : 0, teamChanged: b.teamChanged, roleShift: b.roleShift,
        usage: usage.get(p.key)?.usage ?? {}, split: usage.get(p.key)?.split ?? {},
        lowSample: b.minutes < 300 && b.games > 0 ? 1 : 0, noHistory: b.games === 0 ? 1 : 0
      };
      const rates = {};
      for (const s of RATE_STATS) rates[s] = Math.exp(clamp(dot(rateVector(s, f), model.coef[s]), -12, 1.5));
      results.set(`${p.key}|${team}`, { rates, features: f, base: b, typical: b.avgMinutes, naive: b.naive });
    }
  }
  return results;
}

/**
 * OUT teammates: usage freed (presence x rate x minutes of each OUT player,
 * handed out in proportion to rate x minutes, the same position group weighted
 * up) as log(1 + share), and the measured with/without per-minute split
 * (presence-weighted log ratio, shrunk). Map(key -> { usage, split }).
 */
export function usageFeatures(view, team, todays, outList, players, baseOf, params = DEFAULT_PARAMS) {
  const out = new Map();
  const relevant = [];
  const teamGames = view.teamGames(team).slice(0, 10);
  const recentIds = new Set(teamGames.map(g => g.game_id));
  for (const o of outList) {
    const b = baseOf(o.key, team);
    if (!(b.avgMinutes >= params.usageMinMinutes)) continue;
    const played = teamGames.length
      ? view.playerGames(o.key, { seasons: 'current' }).filter(g => recentIds.has(g.game_id) && g.team === team).length / teamGames.length
      : 1;
    if (played > 0) relevant.push({ ...o, b, presence: played });
  }
  if (!relevant.length) return out;
  const outKeys = new Set(outList.map(o => o.key));
  const elsewhere = new Set(players.filter(p => p.team !== team).map(p => p.key));
  const cands = teamCandidates(view, team, todays, outKeys, elsewhere);
  const entries = cands.map(c => ({ key: c.key, b: baseOf(c.key, team) }));
  for (const e of entries) out.set(e.key, { usage: {}, split: {} });

  for (const s of RATE_STATS) {
    for (const o of relevant) {
      const freed = o.presence * o.b.rates[s] * o.b.avgMinutes;
      const sim = (e) => (e.b.group && e.b.group === o.b.group ? params.sameGroupWeight : 1);
      const denom = entries.reduce((t, e) => t + sim(e) * e.b.rates[s] * e.b.avgMinutes, 0);
      if (!(denom > 0)) continue;
      for (const e of entries) {
        const u = out.get(e.key).usage;
        u[s] = (u[s] ?? 0) + sim(e) * freed / denom;
      }
    }
  }
  for (const e of entries) {
    const u = out.get(e.key).usage;
    for (const s of Object.keys(u)) u[s] = Math.log1p(u[s]);
  }

  // Measured splits over the team's recent games
  const rows = view.teamPlayerRows(team, { games: params.splitGames });
  const byGame = new Map();
  for (const r of rows) {
    if (!byGame.has(r.game_id)) byGame.set(r.game_id, []);
    byGame.get(r.game_id).push(r);
  }
  for (const o of relevant) {
    const withIds = new Set(rows.filter(r => r.player_key === o.key && n(r.minutes) > 0).map(r => r.game_id));
    if (!withIds.size) continue;
    const firstDate = rows.filter(r => r.player_key === o.key && n(r.minutes) > 0).reduce((d, r) => (r.game_date < d ? r.game_date : d), '9999');
    for (const e of entries) {
      const mine = rows.filter(r => r.player_key === e.key && n(r.minutes) > 0 && r.game_date >= firstDate);
      const w = { min: 0 }, wo = { min: 0 };
      for (const r of mine) {
        const t = withIds.has(r.game_id) ? w : wo;
        t.min += n(r.minutes);
        for (const s of RATE_STATS) t[s] = (t[s] ?? 0) + statOf[s](r);
      }
      if (w.min < params.splitMinMinutes || !(wo.min > 0)) continue;
      const split = out.get(e.key).split;
      for (const s of RATE_STATS) {
        const rWith = ((w[s] ?? 0) + 20 * e.b.rates[s]) / (w.min + 20);
        const rWo = ((wo[s] ?? 0) + params.splitShrinkMinutes * rWith) / (wo.min + params.splitShrinkMinutes);
        split[s] = (split[s] ?? 0) + o.presence * Math.log(rWo / rWith);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Fit
// ---------------------------------------------------------------------------

/** Harness-shaped contexts and outcomes of the training dates. */
function trainingDays(store, { seasons = null, dates = null } = {}, contextPlayer) {
  const out = [];
  for (const date of dates ?? store.dates) {
    const view = store.asOf(date);
    if (seasons && !seasons.includes(view.season)) continue;
    const day = store.gameDay(date);
    if (!day.players.length) continue;
    out.push({
      date, view,
      day: { teams: day.teams },
      players: day.players.map(p => ({ ...contextPlayer(p, view, day), slate: null })),
      outcomes: new Map(day.players.map(p => [`${p.key}|${p.team}`, p]))
    });
  }
  return out;
}

/** Archetype prior rates over the training rows (per-minute; TS% / 3P% as rates). */
function fitPriors(days) {
  const acc = new Map();
  const add = (k, g) => {
    if (!acc.has(k)) acc.set(k, { min: 0, pts: 0, tsa: 0, fg3a: 0, fg3m: 0, reb: 0, ast: 0, stl: 0, blk: 0, tov: 0 });
    const a = acc.get(k);
    a.min += n(g.minutes);
    for (const s of ['pts', 'tsa', 'fg3a', 'fg3m', 'reb', 'ast', 'stl', 'blk', 'tov']) a[s] += statOf[s](g);
  };
  for (const d of days) {
    for (const p of d.players) {
      const o = d.outcomes.get(`${p.key}|${p.team}`);
      if (!o?.played || !o.box) continue;
      add(d.view.archetype(p.key).archetype, o.box);
      add('league', o.box);
    }
  }
  const priors = {};
  for (const [k, a] of acc) {
    if (a.min < 2000) continue;
    priors[k] = {
      tsa: a.tsa / a.min, fg3a: a.fg3a / a.min, reb: a.reb / a.min, ast: a.ast / a.min,
      stl: a.stl / a.min, blk: a.blk / a.min, tov: a.tov / a.min,
      ts: a.pts / 2 / a.tsa, fg3pct: a.fg3m / Math.max(1, a.fg3a)
    };
  }
  return priors;
}

/**
 * Fit on the training store: archetype priors (from the box rows of gameDay),
 * per-stat Poisson coefficients, dispersions.
 */
export function fitRatesV1(store, { seasons = null, params = DEFAULT_PARAMS, contextPlayer, days = null, minMinutes = 4 } = {}) {
  const model = { params: { ...params }, coef: FALLBACK_COEF, priors: null, dispersion: defaultDispersion() };
  const list = days ?? trainingDays(store, { seasons }, contextPlayer);
  model.priors = fitPriors(list);
  const X = Object.fromEntries(RATE_STATS.map(s => [s, []]));
  const Y = Object.fromEntries(RATE_STATS.map(s => [s, []]));
  const offset = [];
  const samples = [];
  for (const d of list) {
    const preds = projectRates({ ...d, baseCache: new Map() }, model);
    for (const [k, pr] of preds) {
      const o = d.outcomes.get(k);
      if (!o?.played || o.actual.minutes < minMinutes) continue;
      offset.push(Math.log(o.actual.minutes));
      const features = { ...pr.features, logMinutesRatio: params.minutesElasticity ? minutesRatio(o.actual.minutes, pr.typical) : 0 };
      for (const s of RATE_STATS) { X[s].push(rateVector(s, features)); Y[s].push(o.actual[s]); }
      samples.push({ features, actual: o.actual });
    }
  }
  if (offset.length < 200) return model;
  const coef = {};
  for (const s of RATE_STATS) {
    coef[s] = fitPoisson(X[s], Y[s], offset, { ridge: params.ridge, start: FALLBACK_COEF[s] });
  }
  model.coef = coef;
  model.elasticity = params.minutesElasticity ? Object.fromEntries(RATE_STATS.map(s => [s, coef[s][RATE_TERMS - 1]])) : null;
  model.dispersion = fitDispersion(samples, model);
  model.fitInfo = { dates: list.length, rows: offset.length, priors: Object.keys(model.priors).length };
  return model;
}

export function defaultDispersion() {
  return { shared: 0.04, pts: 0.08, reb: 0.08, ast: 0.1, stl: 0.15, blk: 0.3, tov: 0.1, fg3m: 0.15 };
}

/**
 * Method-of-moments dispersions: the shared factor from the covariance of
 * reb / ast / rest-of-points residuals, each stat's extra-Poisson variance net
 * of it.
 */
function fitDispersion(samples, model) {
  const pairs = [['reb', 'ast'], ['reb', 'rest'], ['ast', 'rest']];
  let cov = 0, covN = 0;
  const extra = Object.fromEntries([...RATE_STATS, 'rest'].map(s => [s, { num: 0, den: 0 }]));
  for (const smp of samples) {
    const m = smp.actual.minutes;
    const mu = {};
    for (const s of RATE_STATS) mu[s] = Math.exp(clamp(dot(rateVector(s, smp.features), model.coef[s]), -12, 1.5)) * m;
    mu.rest = Math.max(0.1, mu.pts - 3 * mu.fg3m);
    const y = { ...smp.actual, rest: smp.actual.pts - 3 * smp.actual.fg3m };
    for (const [a, b] of pairs) {
      if (mu[a] < 0.5 || mu[b] < 0.5) continue;
      cov += ((y[a] - mu[a]) * (y[b] - mu[b])) / (mu[a] * mu[b]);
      covN++;
    }
    for (const s of [...RATE_STATS, 'rest']) {
      if (mu[s] < 0.3) continue;
      extra[s].num += (y[s] - mu[s]) ** 2 - mu[s];
      extra[s].den += mu[s] ** 2;
    }
  }
  const shared = clamp(covN ? cov / covN : 0, 0, 0.3);
  const v = (s) => clamp(extra[s].den ? extra[s].num / extra[s].den - shared : 0, 0, 2);
  return { shared, pts: v('rest'), reb: v('reb'), ast: v('ast'), stl: v('stl'), blk: v('blk'), tov: v('tov'), fg3m: v('fg3m') };
}

// ---------------------------------------------------------------------------
// Projector
// ---------------------------------------------------------------------------

/**
 * Prediction of one player from rates and a minutes source.
 * minutes: { kind: 'fixed', minutes } | { kind: 'mixture', pPlay, cond, sigma,
 * zMinutes, point }. Mixture: p10 / p90 / boom / double-doubles from the full
 * distribution (DNP with probability 1 - p_play, else minutes_v2's
 * conditional minutes); the point is the DK median at minutes_v2's point
 * minutes (pointMinutes 'point') or the median of the mixture with DNP mass
 * shading x (1 - p_play) ('mixture'). quantiles: levels (0-1) of the full
 * mixture to return as dk_quantiles (mixture only; blends re-center them).
 */
export function predictPlayer(rates, model, minutes, { seed, scoring, boomAt, typical = 0, quantiles = null }) {
  const params = model.params;
  const dispersion = model.dispersion;
  const elasticity = model.elasticity ?? null;
  if (minutes.kind === 'fixed') {
    const r = atMinutes(rates, dispersion, minutes.minutes, { sims: params.sims, seed, scoring, boomAt, elasticity, typical });
    return {
      dk_points: params.point === 'mean' ? r.mean : r.median,
      dk_mean: r.mean, minutes: minutes.minutes, p10: r.p10, p90: r.p90,
      stats: r.stats, p_dd: r.pDd, p_td: r.pTd, p_boom: r.boom, rates
    };
  }
  // Conditional on playing: minutes from minutes_v2's distribution (stratified)
  const { pPlay, cond, sigma, zMinutes } = minutes;
  let i = 0;
  const sims = params.sims;
  const draw = () => {
    const tau = (i++ % sims + 0.5) / sims;
    return Math.max(0.5, cond + sigma * zAt(zMinutes, tau));
  };
  const s = simulate(rates, dispersion, draw, { sims, seed, scoring, elasticity, typical });
  const q = 1 - pPlay;
  const mixture = (tau, dnp) => (tau <= dnp ? 0 : sampleQuantile(s.dk, (tau - dnp) / (1 - dnp)));
  const condMean = sampleMean(s.dk);
  let point;
  if (params.pointMinutes === 'point') {
    const at = minutes.point > 0 ? atMinutes(rates, dispersion, minutes.point, { sims, seed, scoring, elasticity, typical }) : null;
    point = at ? (params.point === 'mean' ? at.mean : at.median) : 0;
  } else {
    const pointDnp = params.shading * q;
    point = params.point === 'mean' ? (pointDnp >= 0.5 ? 0 : condMean) : mixture(0.5, pointDnp);
  }
  const stats = {};
  const atPoint = ratesAt(rates, minutes.point, elasticity, typical);
  for (const st of RATE_STATS) stats[st] = atPoint[st] * minutes.point;
  return {
    dk_points: point,
    dk_mean: pPlay * condMean,
    minutes: minutes.point,
    p10: mixture(0.1, q),
    p90: mixture(0.9, q),
    stats,
    p_dd: pPlay * s.dd,
    p_td: pPlay * s.td,
    p_boom: boomAt === null ? null : pPlay * shareAtLeast(s.dk, boomAt),
    rates,
    ...(quantiles ? { dk_quantiles: quantiles.map(t => mixture(t, q)) } : {})
  };
}

/**
 * Mean DK conditional on playing, minutes drawn around `cond` (minutes_v2's
 * conditional distribution: sigma x standardized residual quantiles,
 * stratified as predictPlayer). Multiply by p_play for the mean incl. DNP.
 */
export function conditionalMean(rates, model, { cond, sigma, zMinutes = null }, { seed, scoring, typical = 0 }) {
  const sims = model.params.sims;
  let i = 0;
  const draw = () => Math.max(0.5, cond + sigma * zAt(zMinutes, (i++ % sims + 0.5) / sims));
  return sampleMean(simulate(rates, model.dispersion, draw, { sims, seed, scoring, elasticity: model.elasticity ?? null, typical }).dk);
}

/**
 * Rate quality with the minutes taken out: every played row's DK distribution
 * at its ACTUAL minutes from the projected rates (pred.rates), against
 * projectFppm x actual minutes (pred.fppm, as minutes_v2 / RotoWire min x
 * FPPM) and per stat against the naive raw per-minute rates. Evaluation only:
 * the rates were projected before the game; actual minutes enter here.
 * rates_flat is the same without the minutes elasticity, which was fit on
 * actual minutes (so it carries some game flow: foul trouble, hot nights).
 * Returns { n, leaderboard, paired, stats, coverage, doubles, breakdowns }.
 */
export function rateQuality(rows, name, model, { site = 'draftkings', cluster = null, iterations = 1000, seed = 1 } = {}) {
  const scoring = getSiteConfig(site).scoring;
  const params = model.params;
  const noBonus = { ...scoring, doubleDouble: 0, tripleDouble: 0 };
  const list = [];
  for (const r of rows) {
    const p = r.preds[name];
    const m = r.actual.minutes;
    if (!r.played || !(m > 0) || !p?.rates || !Number.isFinite(p.fppm)) continue;
    const opts = { sims: params.sims, seed: seedOf(`${r.date}|${r.key}|actual`), scoring, typical: p.typical_minutes ?? 0 };
    const d = atMinutes(p.rates, model.dispersion, m, { ...opts, elasticity: model.elasticity ?? null });
    // Without the minutes elasticity (fit on actual minutes, so partly game flow: shown apart)
    const flat = model.elasticity ? atMinutes(p.rates, model.dispersion, m, opts) : d;
    const naiveStats = p.naive_rates ? Object.fromEntries(RATE_STATS.map(s => [s, p.naive_rates[s] * m])) : null;
    list.push({
      ...r,
      preds: {
        rates: { dk_points: params.point === 'mean' ? d.mean : d.median, p10: d.p10, p90: d.p90, stats: d.stats },
        rates_flat: { dk_points: params.point === 'mean' ? flat.mean : flat.median, stats: flat.stats },
        fppm: { dk_points: p.fppm * m },
        naive: naiveStats ? { dk_points: fantasyPoints(naiveStats, noBonus), stats: naiveStats } : null
      },
      dd: d.pDd,
      td: d.pTd
    });
  }
  if (!list.length) return { n: 0 };
  const board = ['rates', 'rates_flat', 'fppm', 'naive'].map(k => {
    const valid = list.filter(r => r.preds[k]);
    const err = valid.reduce((t, r) => t + Math.abs(r.preds[k].dk_points - r.actual.dk), 0);
    const bias = valid.reduce((t, r) => t + r.preds[k].dk_points - r.actual.dk, 0);
    const mins = valid.reduce((t, r) => t + r.actual.minutes, 0);
    return { projector: k, n: valid.length, mae: round(err / valid.length), bias: round(bias / valid.length), perMinuteError: round(err / mins, 4) };
  });
  const stats = Object.fromEntries(RATE_STATS.map(s => [s, Object.fromEntries(['rates', 'rates_flat', 'naive'].map(k => {
    const valid = list.filter(r => r.preds[k]?.stats);
    return [k, valid.length ? round(valid.reduce((t, r) => t + Math.abs(r.preds[k].stats[s] - r.actual[s]), 0) / valid.length) : null];
  }))]));
  const count = (a) => DOUBLE_DIGIT.filter(s => a[s] >= 10).length;
  const groups = {
    archetype: [r => r.tags.archetype],
    role: [r => r.tags.role, ['starter', 'bench']],
    teammateOut: [r => r.tags.teammateOut, ['teammate out', 'none out']],
    pace: [r => r.tags.pace, PACE_BUCKETS],
    blowout: [r => r.tags.blowout, ['<5', '5-10', '10+']],
    salaryTier: [r => r.tags.salaryTier]
  };
  return {
    n: list.length,
    leaderboard: board,
    paired: [
      { projector: 'rates', vs: 'fppm', ...pairedBootstrap(list, 'rates', 'fppm', { cluster, iterations, seed }) },
      { projector: 'rates_flat', vs: 'fppm', ...pairedBootstrap(list, 'rates_flat', 'fppm', { cluster, iterations, seed }) },
      { projector: 'rates', vs: 'naive', ...pairedBootstrap(list, 'rates', 'naive', { cluster, iterations, seed }) }
    ],
    stats,
    coverage: coverage(list.map(r => ({ p10: r.preds.rates.p10, p90: r.preds.rates.p90, actual: r.actual.dk }))),
    doubles: {
      ddPredicted: round(list.reduce((t, r) => t + r.dd, 0), 1), ddActual: list.filter(r => count(r.actual) >= 2).length,
      tdPredicted: round(list.reduce((t, r) => t + r.td, 0), 1), tdActual: list.filter(r => count(r.actual) >= 3).length
    },
    breakdowns: Object.fromEntries(Object.entries(groups)
      .map(([k, [fn, order]]) => [k, breakdown(list, fn, ['rates', 'fppm'], order ?? null)])
      .filter(([, v]) => v.length))
  };
}

const PACE_BUCKETS = ['slow', 'average', 'fast']; // evaluate.PACE_BUCKETS (no import: evaluate -> minutesV2 cycle)

/**
 * Harness projector. minutesSource: 'minutes_v2' (end to end) | 'rotowire'
 * (slates: RotoWire's projected minutes). options.params override
 * DEFAULT_PARAMS; options.model / options.minutesModel skip fit.
 */
export function createRatesV1Projector({ params = {}, minutesParams = {}, model = null, minutesModel = null, minutesSource = 'minutes_v2', contextPlayer = null } = {}) {
  const resolved = { ...DEFAULT_PARAMS, ...params };
  const resolvedMinutes = { ...MINUTES_PARAMS, ...minutesParams };
  let fitted = model ?? { params: resolved, coef: FALLBACK_COEF, priors: null, dispersion: defaultDispersion() };
  let minutesFitted = minutesModel ?? createMinutesV2Projector({ params: resolvedMinutes }).model();
  const ratesKey = `rates_v1|${JSON.stringify(resolved)}`;
  const minutesKey = `rates_v1_minutes|${JSON.stringify(resolvedMinutes)}`;
  return {
    async fit({ store, seasons }) {
      const cp = contextPlayer ?? (await import('./evaluate.js')).contextPlayer;
      if (!model) fitted = fitRatesV1(store, { seasons, params: resolved, contextPlayer: cp });
      if (minutesSource === 'minutes_v2' && !minutesModel) minutesFitted = fitMinutesV2(store, { seasons, params: resolvedMinutes });
    },
    prepareDate(dateCtx) {
      if (!dateCtx.shared.has(ratesKey)) dateCtx.shared.set(ratesKey, projectRates(dateCtx, fitted));
      if (minutesSource === 'minutes_v2' && !dateCtx.shared.has(minutesKey)) {
        dateCtx.shared.set(minutesKey, projectMinutes(dateCtx, minutesFitted));
      }
    },
    project({ mode, date, site, player, slate, shared }) {
      const scoring = getSiteConfig(site).scoring;
      const boomAt = mode === 'slate' ? (slate?.salary > 0 ? resolved.boomMultiple * slate.salary / 1000 : null) : resolved.boomPoints;
      const zero = { dk_points: 0, minutes: 0, p10: 0, p90: 0, p_boom: boomAt === null ? null : 0, boom_at: boomAt, p_dd: 0, p_td: 0 };
      if (player.out) return zero;
      const r = shared.get(ratesKey)?.get(`${player.key}|${player.team}`);
      if (!r) return null;
      const seed = seedOf(`${date}|${player.key}`);
      const extra = { boom_at: boomAt, typical_minutes: r.typical, naive_rates: r.naive };
      if (minutesSource === 'rotowire') {
        const m = slate?.rotowireMinutes;
        if (!Number.isFinite(m)) return null;
        if (!(m > 0)) return { ...zero, rates: r.rates };
        return { ...predictPlayer(r.rates, fitted, { kind: 'fixed', minutes: m }, { seed, scoring, boomAt, typical: r.typical }), ...extra };
      }
      const m = shared.get(minutesKey)?.get(`${player.key}|${player.team}`);
      if (!m) return null;
      const pred = predictPlayer(r.rates, fitted, {
        kind: 'mixture', pPlay: m.p_play, cond: m.conditional_minutes, sigma: m.sigma, zMinutes: minutesFitted?.zMinutes ?? null, point: m.minutes
      }, { seed, scoring, boomAt, typical: r.typical });
      return { ...pred, ...extra, p_play: m.p_play, minutes_p10: m.minutes_p10, minutes_p90: m.minutes_p90, fppm: m.fppm };
    },
    /** Rate quality at actual minutes (rateQuality) on scored rows. */
    analyze(rows, { name, site, cluster, iterations, seed }) {
      if (minutesSource !== 'minutes_v2') return null;
      return { rateQuality: rateQuality(rows, name, fitted, { site, cluster, iterations, seed }) };
    },
    model: () => fitted,
    minutesModel: () => minutesFitted
  };
}

export default { createRatesV1Projector, fitRatesV1, projectRates, baseRates, simulate, atMinutes, rateQuality, DEFAULT_PARAMS, RATE_STATS };
