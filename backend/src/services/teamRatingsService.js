/**
 * TEAM RATINGS
 *
 * Pace and offensive / defensive efficiency per team, computed from
 * team_game_stats (loaded by the ESPN box-score sync) and written to
 * team_defense_rankings, which projectionService (defense / pace
 * adjustments), rotowireService (players.opp_def_eff) and the dashboard read.
 * Replaces the ESPN Hollinger scrape, which ESPN now bot-blocks.
 *
 * Regular season only. Per team:
 *   pace        average possessions per game. ESPN's Hollinger PACE is per
 *               48 minutes, so it reads slightly lower in overtime-heavy samples.
 *   off_eff     100 x points / possessions
 *   def_eff     100 x opponent points / opponent possessions
 *   eff_fg_pct  100 x (FGM + 0.5 x 3PM) / FGA
 *   ts_pct      100 x PTS / (2 x (FGA + 0.44 x FTA))
 *   ast_ratio   100 x AST / (FGA + 0.44 x FTA + AST + TOV)   (Hollinger)
 *   to_ratio    100 x TOV / (FGA + 0.44 x FTA + AST + TOV)   (Hollinger)
 *   rebr        100 x REB / (REB + opponent REB)
 *
 * Early season each value is shrunk toward last season (the team's, else the
 * league's): (n x current + RATING_PRIOR_GAMES x prior) / (n + RATING_PRIOR_GAMES),
 * the same blend modelEval/featureStore.teamRatings uses.
 */

import db from '../config/database.js';
import teamDefenseModel from '../models/teamDefenseModel.js';
import { getCurrentSeason, previousSeason, seasonForDate } from '../utils/season.js';
import { normalizeForRankings } from '../utils/teamMapping.js';

/** Pseudo-games of last season's rating in the early-season blend */
export const RATING_PRIOR_GAMES = 10;

export const RATING_FIELDS = Object.freeze(['pace', 'offEff', 'defEff', 'effFgPct', 'tsPct', 'astRatio', 'toRatio', 'rebr']);

const n = (v) => Number(v) || 0;
const dateStr = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));
const ratio = (num, den, scale = 100) => (den > 0 ? (scale * num) / den : null);

/** (games x current + k x prior) / (games + k); either side alone when the other is missing. */
export const shrinkRating = (cur, prior, games, k = RATING_PRIOR_GAMES) => {
  if (cur === null || cur === undefined) return prior ?? null;
  if (prior === null || prior === undefined) return cur;
  return (games * cur + k * prior) / (games + k);
};

const TOTAL_FIELDS = ['pts', 'fgm', 'fga', 'fg3m', 'fta', 'oreb', 'dreb', 'ast', 'tov', 'possessions'];
const emptyTotals = () => ({ games: 0, oppGames: 0, ...Object.fromEntries(TOTAL_FIELDS.flatMap(f => [[f, 0], [`opp_${f}`, 0]])) });

function addGame(t, g, o) {
  t.games++;
  for (const f of TOTAL_FIELDS) t[f] += n(g[f]);
  if (o) {
    t.oppGames++;
    for (const f of TOTAL_FIELDS) t[`opp_${f}`] += n(o[f]);
  }
}

function ratingsFromTotals(t) {
  if (!t || t.games === 0) return null;
  const shotPoss = t.fga + 0.44 * t.fta;
  const plays = shotPoss + t.ast + t.tov;
  const reb = t.oreb + t.dreb;
  const oppReb = t.opp_oreb + t.opp_dreb;
  return {
    games: t.games,
    pace: t.possessions / t.games,
    offEff: ratio(t.pts, t.possessions),
    defEff: t.oppGames > 0 ? ratio(t.opp_pts, t.opp_possessions) : null,
    effFgPct: ratio(t.fgm + 0.5 * t.fg3m, t.fga),
    tsPct: ratio(t.pts, 2 * shotPoss),
    astRatio: ratio(t.ast, plays),
    toRatio: ratio(t.tov, plays),
    rebr: t.oppGames > 0 ? ratio(reb, reb + oppReb) : null
  };
}

/** Per-team totals (and a league total) of the given rows; opponents found by game_id. */
function totalsByTeam(rows, oppOf) {
  const teams = new Map();
  const league = emptyTotals();
  for (const g of rows) {
    let t = teams.get(g.team);
    if (!t) teams.set(g.team, (t = emptyTotals()));
    const o = oppOf(g);
    addGame(t, g, o);
    addGame(league, g, o);
  }
  return { teams, league };
}

/**
 * Ratings per team from team_game_stats rows (pure).
 * season: the season rated (default: asOf's, else today's); asOf: only
 * games before this date count (point-in-time), else every loaded game.
 * Returns { season, priorSeason, teams: [{ team, games, ...RATING_FIELDS, raw, prior }], league }
 * where league is the current season's league ratings (null with no games).
 */
export function computeTeamRatings(teamGames, { season, asOf = null, priorGames = RATING_PRIOR_GAMES } = {}) {
  season = season || (asOf ? seasonForDate(asOf) : getCurrentSeason());
  const priorSeason = previousSeason(season);

  const rows = (teamGames ?? [])
    .filter(g => (g.season_type ?? 'regular') === 'regular')
    .map(g => ({ ...g, game_date: dateStr(g.game_date), season: g.season || seasonForDate(dateStr(g.game_date)) }));
  const byGameTeam = new Map(rows.map(g => [`${g.game_id}|${g.team}`, g]));
  const oppOf = (g) => byGameTeam.get(`${g.game_id}|${g.opponent}`);

  const current = rows.filter(g => g.season === season && (!asOf || g.game_date < asOf));
  const cur = totalsByTeam(current, oppOf);
  const last = totalsByTeam(rows.filter(g => g.season === priorSeason), oppOf);
  const leaguePrior = ratingsFromTotals(last.league);

  const teamNames = [...new Set([...cur.teams.keys(), ...last.teams.keys()])].sort();
  const teams = teamNames.map(team => {
    const raw = ratingsFromTotals(cur.teams.get(team));
    const prior = ratingsFromTotals(last.teams.get(team)) ?? leaguePrior;
    const games = raw?.games ?? 0;
    const blended = Object.fromEntries(RATING_FIELDS.map(f => [f, shrinkRating(raw?.[f], prior?.[f], games, priorGames)]));
    return { team, games, ...blended, raw, prior };
  });

  return { season, priorSeason, teams, league: ratingsFromTotals(cur.league) };
}

/** Regular-season team_game_stats rows of `season` and the season before it. */
export async function loadTeamGames(season) {
  return db.all(`
    SELECT game_id, game_date, season, season_type, team, opponent,
      pts, fgm, fga, fg3m, fta, oreb, dreb, ast, tov, possessions
    FROM team_game_stats
    WHERE season_type = 'regular' AND season IN (?, ?)
  `, season, previousSeason(season));
}

/**
 * Recompute the ratings and write them to team_defense_rankings (keyed by the
 * table's own abbreviations, utils/teamMapping.normalizeForRankings).
 * Returns { season, teams } (teams written; 0 when there are no games).
 */
export async function refreshTeamRatings({ season, asOf = null } = {}) {
  season = season || (asOf ? seasonForDate(asOf) : getCurrentSeason());
  const result = computeTeamRatings(await loadTeamGames(season), { season, asOf });
  const rows = result.teams
    .filter(t => t.defEff !== null)
    .map(t => ({ ...t, team: normalizeForRankings(t.team) }));
  if (rows.length > 0) await teamDefenseModel.bulkUpsert(rows);
  return { season, teams: rows.length, ratings: result };
}

/** Fill team_defense_rankings at startup when it is empty. */
export async function ensureTeamRatings() {
  const row = await db.get('SELECT COUNT(*) AS count FROM team_defense_rankings');
  if (n(row?.count) > 0) return null;
  return refreshTeamRatings();
}
