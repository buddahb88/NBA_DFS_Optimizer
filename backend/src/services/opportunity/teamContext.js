/**
 * OPPORTUNITY TEAM CONTEXT
 *
 * Pure team-level context for a slate player: rest and back-to-back from the
 * team's schedule (team_game_stats rows before the slate date), a pace proxy
 * from possessions, and the game environment from the slate's Vegas lines.
 *
 * - rest_days: days off before the slate date (0 = back-to-back), as
 *   historical_games.rest_days counts them.
 * - pace_l10: average possessions over the team's last 10 regular-season
 *   games, current season first (splitSample's fallback rule).
 * - pace_proxy: average of the team's and the opponent's pace_l10.
 * - blowout: |spread| >= BLOWOUT_SPREAD.
 */

import { splitSample } from './playerMetrics.js';

export const BLOWOUT_SPREAD = 10;
const PACE_WINDOW = 10;
const DAY_MS = 86400000;

const r1 = (x) => (x === null || x === undefined || !Number.isFinite(x) ? null : Number(x.toFixed(1)));
const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const daysBetween = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);

/**
 * @param {object[]} games  team_game_stats rows ({ season, game_date, possessions }) before the slate date, most recent first
 * @param {{ season: string, slateDate: string }} options
 */
export function computeTeamContext(games, { season, slateDate }) {
  const { recent } = splitSample(games, season);
  const pace = recent.slice(0, PACE_WINDOW).filter(g => num(g.possessions) !== null);
  const lastGame = games[0]?.game_date ?? null;
  const restDays = lastGame ? daysBetween(lastGame, slateDate) - 1 : null;
  return {
    pace_l10: pace.length ? r1(pace.reduce((s, g) => s + Number(g.possessions), 0) / pace.length) : null,
    pace_games: pace.length,
    last_game_date: lastGame,
    rest_days: restDays,
    back_to_back: restDays === null ? null : restDays === 0
  };
}

/** Vegas lines from a slate player (players-table shape) plus both teams' pace. */
export function gameEnvironment(player, team, opponent) {
  const spread = num(player.vegas_spread);
  const teamPace = team?.pace_l10 ?? null;
  const oppPace = opponent?.pace_l10 ?? null;
  return {
    implied_total: num(player.vegas_implied_total),
    over_under: num(player.vegas_over_under),
    spread,
    blowout: spread === null ? null : Math.abs(spread) >= BLOWOUT_SPREAD,
    team_pace_l10: teamPace,
    opp_pace_l10: oppPace,
    pace_proxy: teamPace !== null && oppPace !== null ? r1((teamPace + oppPace) / 2) : null
  };
}

export default { computeTeamContext, gameEnvironment };
