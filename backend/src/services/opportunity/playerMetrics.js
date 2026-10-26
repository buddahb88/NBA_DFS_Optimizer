/**
 * OPPORTUNITY PLAYER METRICS
 *
 * Pure per-player opportunity metrics from a game log (regular-season games
 * with minutes > 0, most recent first, all before the slate date). Rows are
 * playerProfileService GAME_ROWS_SELECT rows plus `fp`, the slate site's
 * fantasy points.
 *
 * Sample: the current season's games; with fewer than MIN_CURRENT_GAMES of
 * them, the recent windows (L3 / L5 / L10) run on through last season's games
 * and the "season" baseline is last season (season_fallback = true).
 *
 * Definitions:
 * - Usage and TS% use computeProfiles (Basketball-Reference usage with team
 *   totals per game), on the L5 games and on the baseline.
 * - True shot attempts (TSA) = FGA + 0.44 FTA; per 36 = 36 * Σ / Σ minutes.
 * - shooting_flag: L5 TSA/36 within VOLUME_STABLE_PCT of the baseline and TS%
 *   at least TS_REGRESSION_GAP below it ('bounce_back') or above it ('fade').
 * - starter_change: the starter flag flipped between two games within the
 *   last 3; 'into' or 'out' of the lineup by the latest flip.
 * - Value hit rates: share of L10 games scoring >= N x salary / 1000.
 * - min_sd_l10 is the population standard deviation of L10 minutes.
 * Deltas are recent minus baseline. Everything is null without the games.
 */

import { computeProfiles } from '../playerProfileService.js';

export const MIN_CURRENT_GAMES = 3;
export const TS_REGRESSION_GAP = 0.06;
export const VOLUME_STABLE_PCT = 0.15;
export const VALUE_MULTIPLES = [4, 5, 6];
export const LOW_MINUTES = 20;

const n = (v) => Number(v) || 0;
// + 0 turns -0 (a tiny negative delta) into 0
const round = (x, digits) => (x === null || x === undefined || !Number.isFinite(x) ? null : Number(x.toFixed(digits)) + 0);
const r1 = (x) => round(x, 1);
const r2 = (x) => round(x, 2);
const r3 = (x) => round(x, 3);
const delta = (a, b) => (a === null || b === null ? null : a - b);
const ratio = (num, den) => (den > 0 ? num / den : null);
const sum = (games, f) => games.reduce((s, g) => s + f(g), 0);
const avgMinutes = (games) => (games.length ? sum(games, g => n(g.minutes)) / games.length : null);
const per36 = (games, f) => ratio(36 * sum(games, f), sum(games, g => n(g.minutes)));
const tsa = (g) => n(g.fg_attempted) + 0.44 * n(g.ft_attempted);

/** Usage and TS% over a set of games, as playerProfileService computes them. */
function rates(games) {
  if (!games.length) return { usg: null, ts: null };
  const [profile] = computeProfiles(null, games.map(g => ({ ...g, player_key: 'sample' })));
  return { usg: profile.usg_pct, ts: profile.ts_pct };
}

/**
 * Split a log (most recent first) into the recent-window games and the
 * season baseline. Returns { recent, baseline, baselineSeason, fallback, currentGames }.
 */
export function splitSample(games, season) {
  const current = games.filter(g => g.season === season);
  if (current.length >= MIN_CURRENT_GAMES) {
    return { recent: current, baseline: current, baselineSeason: season, fallback: false, currentGames: current.length };
  }
  const prior = games.filter(g => g.season !== season);
  const priorSeason = prior[0]?.season ?? null;
  if (!priorSeason) {
    return { recent: current, baseline: current, baselineSeason: season, fallback: false, currentGames: current.length };
  }
  const last = prior.filter(g => g.season === priorSeason);
  return {
    recent: [...current, ...last],
    baseline: last,
    baselineSeason: priorSeason,
    fallback: true,
    currentGames: current.length
  };
}

function starterChange(recent) {
  for (let i = 0; i < 3 && i + 1 < recent.length; i++) {
    const now = recent[i].is_starter;
    const before = recent[i + 1].is_starter;
    if (now === null || now === undefined || before === null || before === undefined) continue;
    if (n(now) !== n(before)) return n(now) === 1 ? 'into' : 'out';
  }
  return null;
}

function shootingFlag(l5, tsGap, tsaL5, tsaSeason) {
  if (l5.length < MIN_CURRENT_GAMES || tsGap === null || !(tsaL5 > 0) || !(tsaSeason > 0)) return null;
  if (Math.abs(tsaL5 / tsaSeason - 1) > VOLUME_STABLE_PCT) return null;
  if (tsGap <= -TS_REGRESSION_GAP) return 'bounce_back';
  if (tsGap >= TS_REGRESSION_GAP) return 'fade';
  return null;
}

function minutesSd(games) {
  if (!games.length) return null;
  const mean = avgMinutes(games);
  return Math.sqrt(sum(games, g => (n(g.minutes) - mean) ** 2) / games.length);
}

/**
 * Metrics for one player.
 * @param {object[]} games  regular-season games before the slate date, most recent first
 * @param {{ season: string, salary?: number }} options  season = the slate date's season
 */
export function computePlayerMetrics(games, { season, salary = null } = {}) {
  const { recent, baseline, baselineSeason, fallback, currentGames } = splitSample(games, season);
  const l3 = recent.slice(0, 3);
  const l5 = recent.slice(0, 5);
  const l10 = recent.slice(0, 10);

  const minL3 = avgMinutes(l3);
  const minL5 = avgMinutes(l5);
  const minSeason = avgMinutes(baseline);

  const recentRates = rates(l5);
  const seasonRates = rates(baseline);

  const fppmL10 = ratio(sum(l10, g => n(g.fp)), sum(l10, g => n(g.minutes)));
  const fppmSeason = ratio(sum(baseline, g => n(g.fp)), sum(baseline, g => n(g.minutes)));

  const tsaL5 = per36(l5, tsa);
  const tsaSeason = per36(baseline, tsa);
  const fg3aL5 = per36(l5, g => n(g.fg3_attempted));
  const fg3aSeason = per36(baseline, g => n(g.fg3_attempted));
  const tsGap = delta(recentRates.ts, seasonRates.ts);

  const valueRates = {};
  for (const multiple of VALUE_MULTIPLES) {
    const target = (n(salary) / 1000) * multiple;
    valueRates[`hit${multiple}x_l10`] = salary > 0 && l10.length
      ? r3(l10.filter(g => n(g.fp) >= target).length / l10.length)
      : null;
  }

  const last = recent[0];
  return {
    season_fallback: fallback,
    baseline_season: baselineSeason,
    current_season_games: currentGames,
    games_l3: l3.length,
    games_l5: l5.length,
    games_l10: l10.length,
    games_season: baseline.length,

    min_l3: r1(minL3),
    min_l5: r1(minL5),
    min_l10: r1(avgMinutes(l10)),
    min_season: r1(minSeason),
    min_delta_l3: r1(delta(minL3, minSeason)),
    min_delta_l5: r1(delta(minL5, minSeason)),
    started_last_game: last?.is_starter === null || last?.is_starter === undefined ? null : n(last.is_starter) === 1,
    starts_l5: l5.length ? l5.filter(g => n(g.is_starter) === 1).length : null,
    starter_change: starterChange(recent),

    usg_l5: r3(recentRates.usg),
    usg_season: r3(seasonRates.usg),
    usg_delta: r3(delta(recentRates.usg, seasonRates.usg)),

    fppm_l10: r3(fppmL10),
    fppm_season: r3(fppmSeason),
    fppm_delta: r3(delta(fppmL10, fppmSeason)),

    tsa36_l5: r1(tsaL5),
    tsa36_season: r1(tsaSeason),
    tsa36_delta: r1(delta(tsaL5, tsaSeason)),
    fg3a36_l5: r1(fg3aL5),
    fg3a36_season: r1(fg3aSeason),
    fg3a36_delta: r1(delta(fg3aL5, fg3aSeason)),

    ts_l5: r3(recentRates.ts),
    ts_season: r3(seasonRates.ts),
    ts_gap: r3(tsGap),
    shooting_flag: shootingFlag(l5, tsGap, tsaL5, tsaSeason),

    min_sd_l10: r2(minutesSd(l10)),
    under20_l10: l10.length ? l10.filter(g => n(g.minutes) < LOW_MINUTES).length : null,
    fouls36_l10: r1(per36(l10, g => n(g.fouls))),

    value_games_l10: l10.length,
    ...valueRates,

    last_game_date: last?.game_date ?? null
  };
}

export default { computePlayerMetrics, splitSample };
