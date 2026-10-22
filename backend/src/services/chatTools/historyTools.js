/**
 * CHAT HISTORY TOOLS
 *
 * Historical-data tools shared by both chat paths: aiChatService (single
 * model with function calling) and AnalystAgent (agentic chat). Each tool is
 * { name, description, parameters (JSON schema), execute(args) -> object }.
 *
 * Shared rules:
 * - Names resolve to player_key with the player key utility (diacritics,
 *   punctuation, Jr./III), then every query filters on player_key. An
 *   unresolved name returns success: false with the closest matches.
 * - Averages count season_type = 'regular' (seasonType overrides) and
 *   minutes > 0 rows only; outputs carry the season.
 * - site picks the fantasy points column (draftkings / fanduel / yahoo).
 * - "Games without" a teammate is insightsService's roster window: the team's
 *   schedule (team_game_stats) while the teammate was on the team, so
 *   injured players missing from the box score count; game_player_status only
 *   labels the absence DNP-CD vs OUT.
 */

import db, { DATABASE_TYPE } from '../../config/database.js';
import insightsService from '../insightsService.js';
import { playerKey, canonicalTeam } from '../../utils/playerKey.js';
import { seasonStartDate, seasonForDate, seasonEndYear } from '../../utils/season.js';

export const HISTORY_TOOL_NAMES = Object.freeze([
  'get_player_history',
  'get_matchup_history',
  'get_historical_summary',
  'get_usage_without_teammate',
  'analyze_roster_context',
  'get_team_roster',
  'compare_players',
  'query_historical_data',
]);

// Tables query_historical_data may read (at least one must be referenced)
export const ANALYSIS_TABLES = ['historical_games', 'player_season_profiles', 'player_archetypes', 'team_archetype_defense', 'slate_player_snapshots'];

const SEASON_TYPES = ['regular', 'playoffs', 'play-in', 'all'];
const SITES = ['draftkings', 'fanduel', 'yahoo'];
const SUGGESTION_LIMIT = 5;
const SUGGESTION_MIN_SCORE = 0.4;
const SMALL_SAMPLE = 5;

const isAzure = () => DATABASE_TYPE === 'azuresql';
const limitSql = () => (isAzure() ? 'OFFSET 0 ROWS FETCH NEXT ? ROWS ONLY' : 'LIMIT ?');
const placeholders = (n) => Array(n).fill('?').join(', ');
const round1 = (x) => (x === null || x === undefined ? null : Math.round(x * 10) / 10);
const toDateString = (value) => (value instanceof Date ? value.toISOString().slice(0, 10) : value ?? null);

// Shared JSON-schema properties
const SITE_PROP = { type: 'string', enum: SITES, description: 'DFS site for fantasy points (default draftkings)' };
const SEASON_PROP = { type: 'string', description: 'Season like "2025-26" (default: the latest season with data)' };
const SEASON_TYPE_PROP = {
  type: 'string',
  enum: SEASON_TYPES,
  description: 'Games to include: regular (default), playoffs, play-in, or all',
};

function siteOf(site) {
  return insightsService.normalizeSite(site) || 'draftkings';
}

/** " AND <alias>season_type = ?" unless seasonType is 'all' */
function seasonTypeFilter(seasonType = 'regular', alias = '') {
  if (seasonType === 'all') return { sql: '', params: [] };
  if (!SEASON_TYPES.includes(seasonType)) throw new Error(`seasonType must be one of: ${SEASON_TYPES.join(', ')}`);
  return { sql: ` AND ${alias}season_type = ?`, params: [seasonType] };
}

// ── Name resolution ──────────────────────────────────────────────────

function editDistance(a, b) {
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const up = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = up;
    }
  }
  return prev[b.length];
}

// Share of query tokens found in the candidate (one typo allowed in 4+ letter tokens)
function similarity(queryKey, candidateKey) {
  const candidateTokens = candidateKey.split(' ');
  const queryTokens = queryKey.split(' ');
  const tokenHits = queryTokens.filter(q => candidateTokens.some(c =>
    c === q || (q.length >= 4 && editDistance(q, c) <= 1) || (q.length >= 3 && c.startsWith(q))
  )).length;
  const whole = 1 - editDistance(queryKey, candidateKey) / Math.max(queryKey.length, candidateKey.length);
  return 0.6 * (tokenHits / queryTokens.length) + 0.4 * whole;
}

async function closestPlayers(key) {
  if (!key) return [];
  const rows = await db.all(`
    SELECT player_key, MAX(player_name) AS player_name, MAX(game_date) AS last_game
    FROM historical_games
    GROUP BY player_key
  `);
  return rows
    .map(r => ({ key: r.player_key, name: r.player_name, score: similarity(key, r.player_key), lastGame: toDateString(r.last_game) }))
    .filter(r => r.score >= SUGGESTION_MIN_SCORE)
    .sort((a, b) => b.score - a.score || (b.lastGame || '').localeCompare(a.lastGame || ''))
    .slice(0, SUGGESTION_LIMIT)
    .map(({ key: k, name, lastGame }) => ({ key: k, name, lastGame }));
}

/**
 * Resolve a typed name to a historical player:
 * { found: true, key, name, team, season, lastGame } (latest row's spelling and team), or
 * { found: false, query, key, suggestions: [{ key, name, lastGame }] }.
 * Players only listed in game_player_status (never in a box score) resolve too.
 */
export async function resolvePlayer(name) {
  const key = playerKey(name);
  if (key) {
    for (const table of ['historical_games', 'game_player_status']) {
      const seasonCol = table === 'historical_games' ? 'season' : 'NULL';
      const row = await db.get(`
        SELECT player_key, player_name, team, game_date, ${seasonCol} AS season
        FROM ${table}
        WHERE player_key = ?
        ORDER BY game_date DESC
        ${limitSql()}
      `, [key, 1]);
      if (row) {
        return {
          found: true,
          key,
          name: row.player_name,
          team: row.team,
          season: row.season,
          lastGame: toDateString(row.game_date),
        };
      }
    }
  }
  return { found: false, query: name, key, suggestions: await closestPlayers(key) };
}

function notFound(resolved, role = 'Player') {
  const names = resolved.suggestions.map(s => s.name);
  return {
    success: false,
    message: `${role} "${resolved.query}" not found in historical data.${names.length ? ` Closest matches: ${names.join(', ')}.` : ''} Ask the user which player they mean, or retry with one of these names.`,
    closestMatches: names,
  };
}

// ── Shared queries ───────────────────────────────────────────────────

/** Per-season averages for one player (newest season first) */
async function seasonAverages(key, col, { seasonType, season, opponent } = {}) {
  const type = seasonTypeFilter(seasonType);
  const extra = [];
  const params = [key, ...type.params];
  if (season) { extra.push(' AND season = ?'); params.push(season); }
  if (opponent) { extra.push(' AND opponent = ?'); params.push(opponent); }
  const rows = await db.all(`
    SELECT season,
      COUNT(*) AS games,
      SUM(CASE WHEN is_starter = 1 THEN 1 ELSE 0 END) AS starts,
      AVG(${col}) AS avg_fpts,
      AVG(minutes) AS avg_min,
      MIN(${col}) AS floor,
      MAX(${col}) AS ceiling,
      AVG(${col} * ${col}) - AVG(${col}) * AVG(${col}) AS variance,
      AVG(points) AS avg_pts,
      AVG(rebounds) AS avg_reb,
      AVG(assists) AS avg_ast,
      AVG(CASE WHEN is_home = 1 THEN ${col} END) AS home_avg,
      AVG(CASE WHEN is_home = 0 THEN ${col} END) AS away_avg,
      AVG(CASE WHEN is_back_to_back = 1 THEN ${col} END) AS b2b_avg,
      AVG(CASE WHEN is_back_to_back = 0 THEN ${col} END) AS rested_avg,
      MAX(game_date) AS last_game
    FROM historical_games
    WHERE player_key = ? AND minutes > 0 AND ${col} IS NOT NULL${type.sql}${extra.join('')}
    GROUP BY season
    ORDER BY season DESC
  `, params);
  return rows.map(r => {
    const sd = Math.sqrt(Math.max(0, r.variance || 0));
    return {
      season: r.season,
      games: r.games,
      starts: r.starts,
      avgFpts: round1(r.avg_fpts),
      avgMinutes: round1(r.avg_min),
      floor: round1(r.floor),
      ceiling: round1(r.ceiling),
      stdDev: round1(sd),
      consistency: r.avg_fpts > 0 ? round1(100 * Math.max(0, 1 - sd / r.avg_fpts)) : 0,
      avgPoints: round1(r.avg_pts),
      avgRebounds: round1(r.avg_reb),
      avgAssists: round1(r.avg_ast),
      homeAvg: round1(r.home_avg),
      awayAvg: round1(r.away_avg),
      b2bAvg: round1(r.b2b_avg),
      restedAvg: round1(r.rested_avg),
      lastGame: toDateString(r.last_game),
    };
  });
}

async function latestSeason(table, { team, seasonType } = {}) {
  const type = seasonTypeFilter(seasonType);
  const params = [...type.params];
  let teamSql = '';
  if (team) { teamSql = ' AND team = ?'; params.push(team); }
  const row = await db.get(`SELECT MAX(season) AS season FROM ${table} WHERE season IS NOT NULL${type.sql}${teamSql}`, params);
  return row?.season || null;
}

/** The team's season window: season start through its last scheduled game in the data */
async function teamSeasonWindow(team, season) {
  const row = await db.get('SELECT MAX(game_date) AS last_date FROM team_game_stats WHERE team = ? AND season = ?', [team, season]);
  const endDate = toDateString(row?.last_date);
  return endDate ? { startDate: seasonStartDate(season), endDate } : null;
}

/** The team a player played for in a season (latest game) */
async function teamInSeason(key, season) {
  const row = await db.get(`
    SELECT team FROM historical_games
    WHERE player_key = ? AND season = ? AND minutes > 0
    ORDER BY game_date DESC
    ${limitSql()}
  `, [key, season, 1]);
  return row?.team || null;
}

function splitStats(games) {
  if (games.length === 0) return null;
  const avg = (field) => round1(games.reduce((sum, g) => sum + (Number(g[field]) || 0), 0) / games.length);
  return {
    games: games.length,
    avgFpts: avg('fpts'),
    avgMinutes: avg('minutes'),
    avgPoints: avg('points'),
    avgRebounds: avg('rebounds'),
    avgAssists: avg('assists'),
  };
}

const playerRef = (p) => ({ name: p.name, key: p.key, team: p.team });
const previousSeason = (season) => seasonForDate(`${seasonEndYear(season) - 1}-01-01`);

/**
 * Early in a season the latest season has a handful of games. When the caller
 * did not pick a season and the latest one's sample is under SMALL_SAMPLE,
 * answer from the previous season instead and say so.
 */
async function withSeasonFallback(handler, args, sampleSize) {
  const result = await handler(args);
  if (args.season || !result.success) return result;
  const n = sampleSize(result);
  if (n >= SMALL_SAMPLE) return result;
  const previous = await handler({ ...args, season: previousSeason(result.season) });
  if (!previous.success || sampleSize(previous) <= n) return result;
  return {
    ...previous,
    note: `${result.season} has only ${n} games for this so far, so this is ${previous.season}. Pass season "${result.season}" for the current season.`,
  };
}

const sampleNote = (n, season) => (n < SMALL_SAMPLE
  ? `Small sample (${n} games) in ${season}; consider the previous season too (pass season).`
  : undefined);

// ── Tool handlers ────────────────────────────────────────────────────

async function getPlayerHistory({ playerName, limit = 10, season, seasonType = 'regular', site }) {
  const siteKey = siteOf(site);
  const col = insightsService.pointsColumn(siteKey);
  const player = await resolvePlayer(playerName);
  if (!player.found) return notFound(player);

  const bySeason = await seasonAverages(player.key, col, { seasonType });
  const selected = season ? bySeason.find(s => s.season === season) : bySeason[0];
  if (!selected) {
    return {
      success: false,
      player: playerRef(player),
      message: `No ${seasonType === 'all' ? '' : `${seasonType} `}games with minutes for ${player.name}${season ? ` in ${season}` : ''}.`,
      seasonsAvailable: bySeason.map(s => s.season),
    };
  }

  const type = seasonTypeFilter(seasonType);
  const n = Math.max(1, Math.min(Number(limit) || 10, 50));
  const params = [player.key, ...type.params];
  let seasonSql = '';
  if (season) { seasonSql = ' AND season = ?'; params.push(season); }
  const games = await db.all(`
    SELECT game_date, season, season_type, team, opponent, is_home, is_starter, is_back_to_back, rest_days,
      minutes, ${col} AS fpts, points, rebounds, assists, steals, blocks, turnovers, fg3_made
    FROM historical_games
    WHERE player_key = ? AND minutes > 0 AND ${col} IS NOT NULL${type.sql}${seasonSql}
    ORDER BY game_date DESC
    ${limitSql()}
  `, [...params, n]);

  return {
    success: true,
    player: playerRef(player),
    site: siteKey,
    seasonType,
    season: selected.season,
    averages: selected,
    bySeason,
    recentGames: games.map(g => ({
      date: toDateString(g.game_date),
      season: g.season,
      seasonType: g.season_type,
      team: g.team,
      opponent: g.opponent,
      isHome: g.is_home,
      isStarter: g.is_starter,
      isB2B: g.is_back_to_back,
      restDays: g.rest_days,
      minutes: g.minutes,
      fpts: g.fpts,
      points: g.points,
      rebounds: g.rebounds,
      assists: g.assists,
      steals: g.steals,
      blocks: g.blocks,
      turnovers: g.turnovers,
      threes: g.fg3_made,
    })),
    note: sampleNote(selected.games, selected.season),
  };
}

async function getMatchupHistory({ playerName, opponent, season, seasonType = 'regular', site }) {
  const siteKey = siteOf(site);
  const col = insightsService.pointsColumn(siteKey);
  const opp = canonicalTeam(opponent);
  if (!opp) return { success: false, message: 'opponent is required (team abbreviation, e.g. "BOS")' };
  const player = await resolvePlayer(playerName);
  if (!player.found) return notFound(player);

  const type = seasonTypeFilter(seasonType);
  const params = [opp, opp, player.key, ...type.params];
  let seasonSql = '';
  if (season) { seasonSql = ' AND season = ?'; params.push(season); }
  const seasons = (await db.all(`
    SELECT season,
      SUM(CASE WHEN opponent = ? THEN 1 ELSE 0 END) AS games_vs,
      AVG(CASE WHEN opponent = ? THEN ${col} END) AS avg_vs,
      AVG(${col}) AS season_avg,
      COUNT(*) AS games
    FROM historical_games
    WHERE player_key = ? AND minutes > 0 AND ${col} IS NOT NULL${type.sql}${seasonSql}
    GROUP BY season
    ORDER BY season DESC
  `, params)).filter(r => r.games_vs > 0);

  const games = await db.all(`
    SELECT game_date, season, season_type, team, is_home, minutes, ${col} AS fpts, points, rebounds, assists
    FROM historical_games
    WHERE player_key = ? AND opponent = ? AND minutes > 0 AND ${col} IS NOT NULL${type.sql}${seasonSql}
    ORDER BY game_date DESC
  `, [player.key, opp, ...type.params, ...(season ? [season] : [])]);

  if (games.length === 0) {
    return { success: true, player: playerRef(player), opponent: opp, site: siteKey, seasonType, gamesPlayed: 0, message: `No ${seasonType} games for ${player.name} vs ${opp}${season ? ` in ${season}` : ''}.`, games: [] };
  }
  const avg = splitStats(games);
  return {
    success: true,
    player: playerRef(player),
    opponent: opp,
    site: siteKey,
    seasonType,
    gamesPlayed: games.length,
    averages: { fpts: avg.avgFpts, minutes: avg.avgMinutes, points: avg.avgPoints },
    bySeason: seasons.map(s => ({
      season: s.season,
      gamesVs: s.games_vs,
      avgVs: round1(s.avg_vs),
      seasonAvg: round1(s.season_avg),
      seasonGames: s.games,
    })),
    games: games.map(g => ({
      date: toDateString(g.game_date),
      season: g.season,
      team: g.team,
      isHome: g.is_home,
      minutes: g.minutes,
      fpts: g.fpts,
      points: g.points,
      rebounds: g.rebounds,
      assists: g.assists,
    })),
    note: 'Head-to-head samples are small; weigh against team_archetype_defense.',
  };
}

async function getHistoricalSummary({ topN = 10, minGames, season, seasonType = 'regular', site }) {
  const siteKey = siteOf(site);
  const col = insightsService.pointsColumn(siteKey);
  const type = seasonTypeFilter(seasonType);

  const seasons = await db.all(`
    SELECT season, season_type, COUNT(*) AS player_games, COUNT(DISTINCT player_key) AS players,
      COUNT(DISTINCT game_date) AS dates, MIN(game_date) AS first_game, MAX(game_date) AS last_game
    FROM historical_games
    WHERE minutes > 0
    GROUP BY season, season_type
    ORDER BY season DESC, season_type
  `);
  const chosen = season || await latestSeason('historical_games', { seasonType });
  if (!chosen) return { success: false, message: 'No historical games in the database. Sync historical data first.' };

  const scope = ` AND season = ?${type.sql}`;
  const scopeParams = [chosen, ...type.params];
  const league = await db.get(`
    SELECT AVG(${col}) AS avg_fpts, AVG(minutes) AS avg_min, COUNT(*) AS player_games
    FROM historical_games WHERE minutes > 0 AND ${col} IS NOT NULL${scope}
  `, scopeParams);
  const b2b = await db.all(`
    SELECT CASE WHEN is_back_to_back = 1 THEN 'B2B' ELSE 'Rested' END AS rest_status,
      COUNT(*) AS games, AVG(${col}) AS avg_fpts, AVG(minutes) AS avg_min
    FROM historical_games WHERE minutes > 0 AND ${col} IS NOT NULL${scope}
    GROUP BY CASE WHEN is_back_to_back = 1 THEN 'B2B' ELSE 'Rested' END
  `, scopeParams);
  const maxGames = (await db.get(`
    SELECT MAX(n) AS n FROM (
      SELECT COUNT(*) AS n FROM historical_games WHERE minutes > 0 AND ${col} IS NOT NULL${scope} GROUP BY player_key
    ) x
  `, scopeParams))?.n || 0;
  const min = minGames ?? Math.min(5, maxGames);
  const top = await db.all(`
    WITH g AS (
      SELECT player_key, player_name, team, minutes, ${col} AS fpts,
        ROW_NUMBER() OVER (PARTITION BY player_key ORDER BY game_date DESC) AS rn
      FROM historical_games
      WHERE minutes > 0 AND ${col} IS NOT NULL${scope}
    )
    SELECT player_key,
      MAX(CASE WHEN rn = 1 THEN player_name END) AS player_name,
      MAX(CASE WHEN rn = 1 THEN team END) AS team,
      COUNT(*) AS games, AVG(fpts) AS avg_fpts, AVG(minutes) AS avg_min, MAX(fpts) AS ceiling
    FROM g
    GROUP BY player_key
    HAVING COUNT(*) >= ?
    ORDER BY AVG(fpts) DESC, player_key
    ${limitSql()}
  `, [...scopeParams, min, Math.max(1, Math.min(Number(topN) || 10, 50))]);

  return {
    success: true,
    site: siteKey,
    season: chosen,
    seasonType,
    seasons: seasons.map(s => ({
      season: s.season,
      seasonType: s.season_type,
      playerGames: s.player_games,
      players: s.players,
      dates: s.dates,
      firstGame: toDateString(s.first_game),
      lastGame: toDateString(s.last_game),
    })),
    leagueAverages: { fpts: round1(league?.avg_fpts), minutes: round1(league?.avg_min), playerGames: league?.player_games || 0 },
    b2bImpact: b2b.map(r => ({ restStatus: r.rest_status, games: r.games, avgFpts: round1(r.avg_fpts), avgMinutes: round1(r.avg_min) })),
    minGames: min,
    topPerformers: top.map(p => ({
      name: p.player_name,
      key: p.player_key,
      team: p.team,
      games: p.games,
      avgFpts: round1(p.avg_fpts),
      avgMinutes: round1(p.avg_min),
      ceiling: round1(p.ceiling),
    })),
  };
}

async function usageSplits({ playerName, teammateName, team, season, seasonType = 'regular', site }) {
  const siteKey = siteOf(site);
  const col = insightsService.pointsColumn(siteKey);
  const player = await resolvePlayer(playerName);
  if (!player.found) return notFound(player);
  const teammate = await resolvePlayer(teammateName);
  if (!teammate.found) return notFound(teammate, 'Teammate');
  if (teammate.key === player.key) return { success: false, message: 'player and teammate are the same person' };

  const chosenSeason = season || player.season || await latestSeason('historical_games', { seasonType });
  const teamCode = canonicalTeam(team) || await teamInSeason(player.key, chosenSeason);
  if (!teamCode) return { success: false, player: playerRef(player), message: `${player.name} has no games in ${chosenSeason}.` };
  const window = await teamSeasonWindow(teamCode, chosenSeason);
  if (!window) return { success: false, message: `No ${teamCode} games in ${chosenSeason}.` };

  const absences = insightsService.absenceGamesSql([[teammate.key, teamCode]], window);
  const type = seasonTypeFilter(seasonType, 'l.');
  const rows = await db.all(`
    WITH ${absences.sql}
    SELECT l.game_date, l.played, l.dnp, h.opponent, h.minutes, h.${col} AS fpts, h.points, h.rebounds, h.assists
    FROM team_games l
    LEFT JOIN historical_games h ON h.game_id = l.game_id AND h.team = l.team AND h.player_key = ?
      AND h.minutes > 0 AND h.${col} IS NOT NULL
    WHERE 1 = 1${type.sql}
    ORDER BY l.game_date DESC
  `, [...absences.params, player.key, ...type.params]);

  if (rows.length === 0) {
    return {
      success: false,
      message: `${teammate.name} did not appear for ${teamCode} in ${chosenSeason}, so there is no with/without split. Pass team or season if he played elsewhere.`,
    };
  }
  const playerRows = rows.filter(r => r.minutes > 0);
  if (playerRows.length === 0) {
    return { success: false, message: `${player.name} has no ${seasonType} games with minutes for ${teamCode} in ${chosenSeason}.` };
  }

  const withRows = playerRows.filter(r => r.played === 1);
  const withoutRows = playerRows.filter(r => r.played === 0);
  const withStats = splitStats(withRows);
  const withoutStats = splitStats(withoutRows);
  const dnp = withoutRows.filter(r => r.dnp === 1).length;
  if (withoutStats) {
    withoutStats.teammateDnp = dnp;
    withoutStats.teammateOut = withoutRows.length - dnp;
  }
  const absenceReason = withoutRows.length === 0 ? null : dnp === withoutRows.length ? 'DNP-CD' : dnp === 0 ? 'OUT' : 'MIXED';

  let usageBump = null;
  if (withStats && withoutStats) {
    usageBump = {
      fptsDiff: round1(withoutStats.avgFpts - withStats.avgFpts),
      minutesDiff: round1(withoutStats.avgMinutes - withStats.avgMinutes),
      pointsDiff: round1(withoutStats.avgPoints - withStats.avgPoints),
      percentBoost: withStats.avgFpts > 0 ? round1(((withoutStats.avgFpts - withStats.avgFpts) / withStats.avgFpts) * 100) : null,
    };
  }

  return {
    success: true,
    player: playerRef(player),
    teammate: playerRef(teammate),
    team: teamCode,
    season: chosenSeason,
    seasonType,
    site: siteKey,
    window: { from: toDateString(rows[rows.length - 1].game_date), to: toDateString(rows[0].game_date) },
    teamGamesWithoutTeammate: rows.filter(r => r.played === 0).length,
    withTeammate: withStats,
    withoutTeammate: withoutStats,
    absenceReason,
    usageBump,
    insight: usageBump
      ? `${player.name} averages ${usageBump.fptsDiff > 0 ? '+' : ''}${usageBump.fptsDiff} ${siteKey} points (${usageBump.percentBoost > 0 ? '+' : ''}${usageBump.percentBoost}%) when ${teammate.name} is out (${withoutStats.games} games without, ${withStats.games} with, ${chosenSeason}).`
      : `Not enough games both with and without ${teammate.name} in ${chosenSeason}.`,
    recentGamesWithout: withoutRows.slice(0, 5).map(r => ({
      date: toDateString(r.game_date),
      opponent: r.opponent,
      teammateStatus: r.dnp === 1 ? 'DNP-CD' : 'OUT',
      minutes: r.minutes,
      fpts: r.fpts,
      points: r.points,
      rebounds: r.rebounds,
      assists: r.assists,
    })),
    note: withoutStats ? sampleNote(withoutStats.games, chosenSeason) : undefined,
  };
}

async function rosterContext({ team, absentPlayers = [], activePlayers = [], season, seasonType = 'regular', site }) {
  const siteKey = siteOf(site);
  const col = insightsService.pointsColumn(siteKey);
  const teamCode = canonicalTeam(team);
  if (!teamCode) return { success: false, message: 'team is required (abbreviation, e.g. "LAL")' };
  if (!Array.isArray(absentPlayers) || absentPlayers.length === 0) {
    return { success: false, message: 'absentPlayers must list at least one player who is out' };
  }

  const absent = [];
  for (const name of absentPlayers) {
    const p = await resolvePlayer(name);
    if (!p.found) return notFound(p);
    absent.push(p);
  }
  const active = [];
  const notFoundActive = [];
  for (const name of activePlayers || []) {
    const p = await resolvePlayer(name);
    if (p.found) active.push(p); else notFoundActive.push(notFound(p));
  }

  const chosenSeason = season || await latestSeason('team_game_stats', { team: teamCode, seasonType });
  const window = chosenSeason && await teamSeasonWindow(teamCode, chosenSeason);
  if (!window) return { success: false, message: `No ${teamCode} games${chosenSeason ? ` in ${chosenSeason}` : ''}.` };

  const absentKeys = [...new Set(absent.map(p => p.key))];
  const absences = insightsService.absenceGamesSql(absentKeys.map(k => [k, teamCode]), window);
  const type = seasonTypeFilter(seasonType);
  // Games inside every absent player's roster window; n_out = how many of them sat
  const ctx = `
    ${absences.sql},
    ctx AS (
      SELECT game_id, MAX(game_date) AS game_date, COUNT(*) AS n_windows,
        SUM(CASE WHEN played = 0 THEN 1 ELSE 0 END) AS n_out
      FROM team_games
      WHERE 1 = 1${type.sql}
      GROUP BY game_id
    )`;
  const n = absentKeys.length;

  const contextGames = await db.all(`
    WITH ${ctx}
    SELECT game_date FROM ctx WHERE n_windows = ? AND n_out = ? ORDER BY game_date DESC
  `, [...absences.params, ...type.params, n, n]);

  const rows = await db.all(`
    WITH ${ctx}
    SELECT h.player_key,
      MAX(h.player_name) AS player_name,
      SUM(CASE WHEN c.n_out = ? THEN 1 ELSE 0 END) AS games_context,
      SUM(CASE WHEN c.n_out < ? THEN 1 ELSE 0 END) AS games_other,
      AVG(CASE WHEN c.n_out = ? THEN h.${col} END) AS avg_context,
      AVG(CASE WHEN c.n_out < ? THEN h.${col} END) AS avg_other,
      AVG(CASE WHEN c.n_out = ? THEN h.minutes END) AS min_context,
      AVG(CASE WHEN c.n_out < ? THEN h.minutes END) AS min_other
    FROM ctx c
    JOIN historical_games h ON h.game_id = c.game_id AND h.team = ?
    WHERE c.n_windows = ? AND h.minutes > 0 AND h.${col} IS NOT NULL
      AND h.player_key NOT IN (${placeholders(n)})
    GROUP BY h.player_key
  `, [...absences.params, ...type.params, n, n, n, n, n, n, teamCode, n, ...absentKeys]);

  const splits = rows
    .filter(r => r.games_context > 0)
    .map(r => {
      const pct = r.avg_other > 0 ? ((r.avg_context - r.avg_other) / r.avg_other) * 100 : null;
      return {
        player: r.player_name,
        key: r.player_key,
        gamesInContext: r.games_context,
        gamesOther: r.games_other,
        contextAvgFpts: round1(r.avg_context),
        otherAvgFpts: r.avg_other === null ? null : round1(r.avg_other),
        contextAvgMin: round1(r.min_context),
        otherAvgMin: r.min_other === null ? null : round1(r.min_other),
        fptsBump: r.avg_other === null ? null : round1(r.avg_context - r.avg_other),
        minutesBump: r.min_other === null ? null : round1(r.min_context - r.min_other),
        percentBoost: pct === null ? null : round1(pct),
      };
    });
  const usageBumps = splits
    .filter(p => p.gamesInContext >= 2 && p.gamesOther >= 1)
    .sort((a, b) => b.fptsBump - a.fptsBump);
  const activeKeys = new Set(active.map(p => p.key));
  const absentNames = absent.map(p => p.name).join(', ');

  return {
    success: true,
    team: teamCode,
    season: chosenSeason,
    seasonType,
    site: siteKey,
    scenario: { absentPlayers: absent.map(playerRef), activePlayers: active.map(playerRef) },
    matchingGames: {
      count: contextGames.length,
      recentDates: contextGames.slice(0, 5).map(g => toDateString(g.game_date)),
    },
    usageBumps: usageBumps.slice(0, 10),
    topBeneficiaries: usageBumps.filter(p => p.fptsBump > 0 && p.percentBoost > 5).slice(0, 5),
    activePlayerSplits: splits.filter(p => activeKeys.has(p.key)),
    notFound: notFoundActive.length ? notFoundActive.map(r => r.message) : undefined,
    insight: contextGames.length === 0
      ? `No ${teamCode} games in ${chosenSeason} with ${absentNames} all out.`
      : `${contextGames.length} ${teamCode} games in ${chosenSeason} with ${absentNames} out; context averages are compared with the other games while they were on the roster.`,
    note: sampleNote(contextGames.length, chosenSeason),
  };
}

const getUsageWithoutTeammate = (args) => withSeasonFallback(usageSplits, args,
  r => (r.withTeammate?.games || 0) + (r.withoutTeammate?.games || 0));

const analyzeRosterContext = (args) => withSeasonFallback(rosterContext, args, r => r.matchingGames.count);

async function getTeamRoster({ team, season, seasonType = 'regular', site, minGames = 1 }) {
  const siteKey = siteOf(site);
  const col = insightsService.pointsColumn(siteKey);
  const teamCode = canonicalTeam(team);
  if (!teamCode) return { success: false, message: 'team is required (abbreviation, e.g. "LAL")' };
  const chosenSeason = season || await latestSeason('historical_games', { team: teamCode, seasonType });
  if (!chosenSeason) return { success: false, message: `No historical data found for team ${teamCode}` };

  const type = seasonTypeFilter(seasonType);
  const rows = await db.all(`
    WITH g AS (
      SELECT player_key, player_name, game_date, minutes, is_starter, ${col} AS fpts,
        ROW_NUMBER() OVER (PARTITION BY player_key ORDER BY game_date DESC) AS rn
      FROM historical_games
      WHERE team = ? AND season = ? AND minutes > 0 AND ${col} IS NOT NULL${type.sql}
    ),
    latest AS (
      SELECT player_key, team FROM (
        SELECT player_key, team, ROW_NUMBER() OVER (PARTITION BY player_key ORDER BY game_date DESC) AS rn
        FROM historical_games
        WHERE player_key IN (SELECT player_key FROM g)
      ) x WHERE rn = 1
    )
    SELECT g.player_key,
      MAX(CASE WHEN g.rn = 1 THEN g.player_name END) AS player_name,
      COUNT(*) AS games,
      SUM(CASE WHEN g.is_starter = 1 THEN 1 ELSE 0 END) AS starts,
      MAX(g.game_date) AS last_game,
      AVG(g.fpts) AS avg_fpts,
      AVG(g.minutes) AS avg_min,
      MAX(l.team) AS current_team
    FROM g
    LEFT JOIN latest l ON l.player_key = g.player_key
    GROUP BY g.player_key
    HAVING COUNT(*) >= ?
    ORDER BY AVG(g.fpts) DESC, g.player_key
  `, [teamCode, chosenSeason, ...type.params, minGames]);

  if (rows.length === 0) return { success: false, message: `No ${seasonType} games for ${teamCode} in ${chosenSeason}` };
  return {
    success: true,
    team: teamCode,
    season: chosenSeason,
    seasonType,
    site: siteKey,
    playerCount: rows.length,
    roster: rows.map(p => ({
      name: p.player_name,
      key: p.player_key,
      games: p.games,
      starts: p.starts,
      lastGame: toDateString(p.last_game),
      avgFpts: round1(p.avg_fpts),
      avgMinutes: round1(p.avg_min),
      currentTeam: p.current_team,
    })),
  };
}

async function comparePlayers({ playerNames = [], season, seasonType = 'regular', site }) {
  const siteKey = siteOf(site);
  const col = insightsService.pointsColumn(siteKey);
  const comparison = [];
  const missed = [];
  for (const name of playerNames) {
    const player = await resolvePlayer(name);
    if (!player.found) {
      missed.push({ query: name, closestMatches: player.suggestions.map(s => s.name) });
      continue;
    }
    const [row] = await seasonAverages(player.key, col, { seasonType, season });
    if (!row) {
      missed.push({ query: name, message: `No ${seasonType} games${season ? ` in ${season}` : ''}` });
      continue;
    }
    comparison.push({ name: player.name, key: player.key, team: player.team, ...row });
  }

  if (comparison.length === 0) {
    return { success: false, message: 'No historical data found for any of the requested players', notFound: missed };
  }
  const best = comparison.reduce((a, b) => (b.avgFpts > a.avgFpts ? b : a));
  const steadiest = comparison.reduce((a, b) => (b.consistency > a.consistency ? b : a));
  const seasons = [...new Set(comparison.map(p => p.season))];
  return {
    success: true,
    site: siteKey,
    seasonType,
    playersCompared: comparison.length,
    comparison,
    notFound: missed.length ? missed : undefined,
    summary: comparison.length >= 2
      ? `${best.name} has the highest average (${best.avgFpts}); ${steadiest.name} is the most consistent.${seasons.length > 1 ? ` Seasons differ (${seasons.join(', ')}); pass season to compare like for like.` : ''}`
      : null,
  };
}

async function queryHistoricalData({ query, explanation }) {
  // Only read-only SELECTs on the history tables
  const normalizedQuery = String(query || '').trim().toUpperCase();
  if (!normalizedQuery.startsWith('SELECT')) {
    return { success: false, error: 'Only SELECT queries are allowed' };
  }
  if (!ANALYSIS_TABLES.some(table => new RegExp(`\\b${table}\\b`, 'i').test(query))) {
    return { success: false, error: `Query must reference one of: ${ANALYSIS_TABLES.join(', ')}` };
  }
  if (/\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|ATTACH|PRAGMA)\b/i.test(query)) {
    return { success: false, error: 'Only read-only SELECT queries are allowed' };
  }
  try {
    const results = await db.all(query);
    return {
      success: true,
      rowCount: results.length,
      data: results.slice(0, 50),
      truncated: results.length > 50,
      explanation,
    };
  } catch (error) {
    return { success: false, error: error.message, query };
  }
}

// ── Tool definitions ─────────────────────────────────────────────────

const DEFINITIONS = [
  {
    name: 'get_player_history',
    description: 'Game log and season averages for one player (resolves name spellings, accents and Jr./III). Use for recent form, consistency, ceiling/floor, home/away and B2B splits. Averages are regular season with minutes > 0 unless seasonType says otherwise.',
    parameters: {
      type: 'object',
      properties: {
        playerName: { type: 'string', description: 'Player name (e.g., "LeBron James", "Luka Doncic")' },
        limit: { type: 'number', description: 'Number of recent games to return (default 10, max 50)' },
        season: SEASON_PROP,
        seasonType: SEASON_TYPE_PROP,
        site: SITE_PROP,
      },
      required: ['playerName'],
    },
    handler: getPlayerHistory,
  },
  {
    name: 'get_matchup_history',
    description: "A player's games against one opponent, per season, next to his season average.",
    parameters: {
      type: 'object',
      properties: {
        playerName: { type: 'string', description: 'Player name' },
        opponent: { type: 'string', description: 'Opponent team abbreviation (e.g., "LAL", "BOS")' },
        season: { type: 'string', description: 'Season like "2025-26" (default: all seasons)' },
        seasonType: SEASON_TYPE_PROP,
        site: SITE_PROP,
      },
      required: ['playerName', 'opponent'],
    },
    handler: getMatchupHistory,
  },
  {
    name: 'get_historical_summary',
    description: 'What historical data exists (seasons, date ranges, player-games) plus league averages, B2B impact and top performers for a season.',
    parameters: {
      type: 'object',
      properties: {
        topN: { type: 'number', description: 'Number of top performers to return (default 10)' },
        minGames: { type: 'number', description: 'Minimum games for top performers (default 5, lower early in a season)' },
        season: SEASON_PROP,
        seasonType: SEASON_TYPE_PROP,
        site: SITE_PROP,
      },
    },
    handler: getHistoricalSummary,
  },
  {
    name: 'get_usage_without_teammate',
    description: "How a player's fantasy production and minutes change when a teammate is OUT. Games without = the team's games while the teammate was on the roster in which he did not play (including injuries that never show in box scores).",
    parameters: {
      type: 'object',
      properties: {
        playerName: { type: 'string', description: 'The player to analyze (e.g., "Austin Reaves")' },
        teammateName: { type: 'string', description: 'The teammate who is OUT (e.g., "Luka Doncic")' },
        team: { type: 'string', description: "Team abbreviation (default: the player's team that season)" },
        season: { type: 'string', description: "Season like \"2025-26\" (default: the player's latest season)" },
        seasonType: SEASON_TYPE_PROP,
        site: SITE_PROP,
      },
      required: ['playerName', 'teammateName'],
    },
    handler: getUsageWithoutTeammate,
  },
  {
    name: 'analyze_roster_context',
    description: "Team games where all the absent players were out vs the team's other games while they were on the roster, with each teammate's fantasy points and minutes in both. activePlayers only picks whose splits to highlight.",
    parameters: {
      type: 'object',
      properties: {
        team: { type: 'string', description: 'Team abbreviation (e.g., "LAL", "DAL")' },
        absentPlayers: { type: 'array', items: { type: 'string' }, description: 'Players who are OUT tonight' },
        activePlayers: { type: 'array', items: { type: 'string' }, description: 'Players expected to play whose splits matter (optional)' },
        season: SEASON_PROP,
        seasonType: SEASON_TYPE_PROP,
        site: SITE_PROP,
      },
      required: ['team', 'absentPlayers'],
    },
    handler: analyzeRosterContext,
  },
  {
    name: 'get_team_roster',
    description: "Everyone who played for a team in a season with games, starts, averages and their current team (traded players show a different one).",
    parameters: {
      type: 'object',
      properties: {
        team: { type: 'string', description: 'Team abbreviation (e.g., "LAL", "DAL")' },
        season: SEASON_PROP,
        seasonType: SEASON_TYPE_PROP,
        site: SITE_PROP,
        minGames: { type: 'number', description: 'Minimum games played (default 1)' },
      },
      required: ['team'],
    },
    handler: getTeamRoster,
  },
  {
    name: 'compare_players',
    description: 'Compare two or more players on season averages, ceiling/floor, consistency and splits.',
    parameters: {
      type: 'object',
      properties: {
        playerNames: { type: 'array', items: { type: 'string' }, description: 'Player names to compare' },
        season: { type: 'string', description: "Season like \"2025-26\" (default: each player's latest season)" },
        seasonType: SEASON_TYPE_PROP,
        site: SITE_PROP,
      },
      required: ['playerNames'],
    },
    handler: comparePlayers,
  },
  {
    name: 'query_historical_data',
    description: `Read-only SQL against the history tables (${ANALYSIS_TABLES.join(', ')}) for analysis the other tools do not cover: B2B or rest splits, archetype matchups, role changes, multi-condition filters. Filter by player_key (get it from the other tools, which resolve names); filter season_type = 'regular' and minutes > 0 for averages. historical_games has: player_key, player_name, team, opponent, game_date, season, season_type, is_home, is_back_to_back, rest_days, minutes, points, rebounds, assists, steals, blocks, turnovers, dk_fantasy_points, fd_fantasy_points, yahoo_fantasy_points, ts_pct, plus_minus.`,
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'SQL SELECT query (must start with SELECT, only reads allowed)' },
        explanation: { type: 'string', description: 'Brief explanation of what this query analyzes' },
      },
      required: ['query', 'explanation'],
    },
    handler: queryHistoricalData,
  },
];

/** Fresh tool objects: { name, description, parameters, execute } */
export function createHistoryTools() {
  return DEFINITIONS.map(({ handler, ...def }) => ({
    ...def,
    execute: async (args = {}) => {
      console.log(`\n📊 [history] ${def.name}`, JSON.stringify(args));
      try {
        return await handler(args);
      } catch (error) {
        console.error(`❌ ${def.name} error:`, error);
        return { success: false, error: error.message };
      }
    },
  }));
}
