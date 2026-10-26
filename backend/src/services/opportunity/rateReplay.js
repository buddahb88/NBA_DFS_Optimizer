/**
 * No-lookahead replay of the rate projection over past games, for
 * calibration (scripts/rate-projection-report.js) and the gap hit-rate
 * checks.
 *
 * Each case (a player's game on a date) sees only games strictly before that
 * date - his own and every team's schedule - the same way a slate only sees
 * box scores from before tip-off. Past seasons have no slate, so:
 * - minutes: 'recent' = recency-weighted average of the last 5 games
 *   (prior-only), or 'actual' = the minutes he played (isolates the FPPM
 *   model; the slate supplies minutes in production).
 * - environment: pace proxy only (no historical Vegas lines).
 * - teammate bump: none (no pre-lock injury listings).
 * - posted proxy: his average site points per game this season before the
 *   date (last season's while under 3 games), standing in for a posted
 *   projection.
 */

import { recencyWeightedAverage } from '../minutesModel.js';
import { previousSeason } from '../../utils/season.js';
import { computeTeamContext } from './teamContext.js';
import { splitSample } from './playerMetrics.js';
import { RATE_CONFIG, blendFppm, environmentFactor } from './rateProjection.js';

const n = (v) => Number(v) || 0;
const byDateDesc = (a, b) => (a.game_date < b.game_date ? 1 : a.game_date > b.game_date ? -1 : 0);

const groupSorted = (rows, key) => {
  const map = new Map();
  for (const r of rows) {
    let list = map.get(r[key]);
    if (!list) map.set(r[key], (list = []));
    list.push(r);
  }
  for (const list of map.values()) list.sort(byDateDesc);
  return map;
};

/** Rows before `date` from a most-recent-first list. */
const before = (list, date) => {
  const i = list.findIndex(g => g.game_date < date);
  return i === -1 ? [] : list.slice(i);
};

/**
 * League pace before a date: average possessions of the season's games so
 * far, last season's while the season has under `minGames` team games.
 */
function leaguePaceFn(teamGames, seasonOf, minGames = 50) {
  const sorted = [...teamGames].filter(g => n(g.possessions) > 0).sort((a, b) => -byDateDesc(a, b));
  const cache = new Map();
  return (date) => {
    if (cache.has(date)) return cache.get(date);
    const season = seasonOf(date);
    const earlier = sorted.filter(g => g.game_date < date);
    const cur = earlier.filter(g => g.season === season);
    const pool = cur.length >= minGames ? cur : earlier.filter(g => g.season === previousSeason(season));
    const pace = pool.length ? pool.reduce((s, g) => s + n(g.possessions), 0) / pool.length : null;
    cache.set(date, pace);
    return pace;
  };
}

/**
 * Replay cases.
 * @param {object[]} games  player rows { player_key, season, game_date, team, opponent, minutes, fp } (regular season)
 * @param {object[]} teamGames  team_game_stats rows { team, season, game_date, possessions }
 * @param {{ from, to, seasonOf: (date) => string, minutes: 'recent' | 'actual', minPriorGames, config }} options
 * @returns {{ player_key, game_date, actual, minutes, rate, posted, gap, fppm, naive_fppm, env }[]}
 */
export function replayRateCases(games, teamGames, {
  from, to, seasonOf, minutes = 'recent', minPriorGames = 5, config = RATE_CONFIG
}) {
  const players = groupSorted(games.filter(g => n(g.minutes) > 0), 'player_key');
  const teams = groupSorted(teamGames, 'team');
  const leaguePace = leaguePaceFn(teamGames, seasonOf);
  const paceCache = new Map();
  const teamPace = (team, date) => {
    const key = `${team}|${date}`;
    if (!paceCache.has(key)) {
      paceCache.set(key, computeTeamContext(before(teams.get(team) ?? [], date), { season: seasonOf(date), slateDate: date }).pace_l10);
    }
    return paceCache.get(key);
  };

  const cases = [];
  for (const list of players.values()) {
    for (const g of list) {
      if (g.game_date < from || g.game_date > to) continue;
      const season = seasonOf(g.game_date);
      const prior = before(list, g.game_date).filter(p => p.season === season || p.season === previousSeason(season));
      if (prior.length < minPriorGames) continue;

      const fppm = blendFppm(prior, { season, config });
      if (fppm.fppm === null) continue;
      const { baseline } = splitSample(prior, season);
      const naive = baseline.reduce((s, p) => s + n(p.fp), 0) / baseline.reduce((s, p) => s + n(p.minutes), 0);
      const posted = baseline.reduce((s, p) => s + n(p.fp), 0) / baseline.length;

      const mins = minutes === 'actual'
        ? n(g.minutes)
        : recencyWeightedAverage(prior.slice(0, 5).map(p => n(p.minutes)));
      const tp = teamPace(g.team, g.game_date);
      const op = teamPace(g.opponent, g.game_date);
      const env = environmentFactor({
        paceProxy: tp !== null && op !== null ? (tp + op) / 2 : null,
        leaguePace: leaguePace(g.game_date)
      }, config);
      const rate = mins * fppm.fppm * env.factor;
      cases.push({
        player_key: g.player_key,
        game_date: g.game_date,
        actual: n(g.fp),
        actual_minutes: n(g.minutes),
        minutes: mins,
        fppm: fppm.fppm,
        naive_fppm: naive,
        env: env.factor,
        rate,
        posted,
        gap: rate - posted
      });
    }
  }
  return cases;
}

const mean = (xs) => (xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : null);

/** Mean absolute error of `pred(row)` against `actual(row)`. */
export const mae = (rows, pred, actual = r => r.actual) => mean(rows.map(r => Math.abs(pred(r) - actual(r))));

/**
 * Per date, the `top` rows by gap (largest positive first, gap > 0 only):
 * how often they beat the posted projection, vs every row's rate.
 * Returns { picks, hits, hitRate, baseRate, avgBeat }.
 */
export function topGapHitRate(rows, { top = 20, gap = r => r.gap, posted = r => r.posted, actual = r => r.actual } = {}) {
  const byDate = new Map();
  for (const r of rows) {
    if (!byDate.has(r.game_date)) byDate.set(r.game_date, []);
    byDate.get(r.game_date).push(r);
  }
  const picks = [];
  for (const list of byDate.values()) {
    picks.push(...list.filter(r => gap(r) > 0).sort((a, b) => gap(b) - gap(a)).slice(0, top));
  }
  const beat = (r) => actual(r) > posted(r);
  return {
    picks: picks.length,
    hits: picks.filter(beat).length,
    hitRate: picks.length ? picks.filter(beat).length / picks.length : null,
    baseRate: rows.length ? rows.filter(beat).length / rows.length : null,
    avgBeat: mean(picks.map(r => actual(r) - posted(r)))
  };
}

export default { replayRateCases, topGapHitRate, mae };
