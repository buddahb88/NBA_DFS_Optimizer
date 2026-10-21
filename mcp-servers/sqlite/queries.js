/**
 * Queries behind the history / matchup MCP tools (better-sqlite3, synchronous).
 *
 * Players are matched on player_key, the backend's accent/punctuation/suffix-
 * free name key, so "Jaren Jackson Jr." and "Luka Dončić" resolve the same way
 * the projections do.
 */

import { playerKey } from '../../backend/src/utils/playerKey.js';

// Matchup season = latest with this many defenses at this many games, as the
// Archetypes page's Tonight view does (archetypeDefenseService.TONIGHT_MIN_SEASON)
const MIN_DEFENSES = 20;
const MIN_GAMES = 10;

const round2 = (v) => (v == null ? null : Math.round(v * 100) / 100);

function previousSeason(season) {
  const year = Number(season.slice(0, 4)) - 1;
  return `${year}-${String((year + 1) % 100).padStart(2, '0')}`;
}

/** In-house DvP bucket from a DK/FD position string ('PF/C', 'PG,G,UTIL'). */
function positionGroup(position) {
  const first = String(position ?? '').split(/[/,-]/)[0].trim().toUpperCase();
  if (['PG', 'SG', 'G'].includes(first)) return 'G';
  if (['SF', 'PF', 'F'].includes(first)) return 'F';
  if (first === 'C') return 'C';
  return null;
}

function latestSlate(db) {
  return db.prepare('SELECT slate_id, name, site FROM slates ORDER BY created_at DESC LIMIT 1').get();
}

/** Latest season with enough team_archetype_defense sample for this site, or null. */
export function matchupSeason(db, site) {
  const row = db.prepare(
    `SELECT season FROM team_archetype_defense
     WHERE group_by = 'position' AND site = ? AND games >= ?
     GROUP BY season HAVING COUNT(DISTINCT team) >= ?
     ORDER BY season DESC LIMIT 1`
  ).get(site, MIN_GAMES, MIN_DEFENSES);
  return row?.season ?? null;
}

/**
 * Tonight's healthy players with their archetype defense (and G/F/C DvP)
 * matchup, softest first. Archetype = the season's, else the prior season's
 * when missing or unclassified (as the projection DVP adjustment does).
 */
export function archetypeMatchups(db, { site, season, limit = 50 } = {}) {
  const slate = latestSlate(db);
  if (!slate) return { slate: null, site: null, season: null, players: [] };
  const useSite = site || slate.site || 'draftkings';
  const useSeason = season || matchupSeason(db, useSite);
  if (!useSeason) return { slate: slate.slate_id, site: useSite, season: null, players: [] };

  const archetypesFor = (s) => new Map(
    db.prepare(`SELECT player_key, archetype FROM player_archetypes WHERE season = ? AND archetype <> 'unclassified'`)
      .all(s).map(r => [r.player_key, r.archetype])
  );
  const current = archetypesFor(useSeason);
  const prior = archetypesFor(previousSeason(useSeason));

  const cells = new Map(
    db.prepare(`SELECT * FROM team_archetype_defense WHERE season = ? AND site = ?`)
      .all(useSeason, useSite).map(r => [`${r.group_by}|${r.team}|${r.group_key}`, r])
  );

  const players = db.prepare(
    `SELECT name, position, team, opponent, salary, projected_points, rostership FROM players
     WHERE slate_id = ? AND (injury_status IS NULL OR injury_status = '')`
  ).all(slate.slate_id);

  const rows = [];
  for (const p of players) {
    const key = playerKey(p.name);
    const archetype = current.get(key) ?? prior.get(key) ?? null;
    const group = positionGroup(p.position);
    const cell = archetype ? cells.get(`archetype|${p.opponent}|${archetype}`) : null;
    const posCell = group ? cells.get(`position|${p.opponent}|${group}`) : null;
    if (!cell && !posCell) continue;
    rows.push({
      ...p,
      archetype,
      fp_over_expectation: round2(cell?.fp_over_expectation),
      games: cell?.games ?? null,
      pts_delta: round2(cell?.pts_delta),
      reb_delta: round2(cell?.reb_delta),
      ast_delta: round2(cell?.ast_delta),
      position_group: group,
      position_fp_over_expectation: round2(posCell?.fp_over_expectation),
    });
  }
  const sortValue = (r) => r.fp_over_expectation ?? r.position_fp_over_expectation ?? 0;
  rows.sort((a, b) => sortValue(b) - sortValue(a) || (b.projected_points ?? 0) - (a.projected_points ?? 0));
  return { slate: slate.slate_id, site: useSite, season: useSeason, players: rows.slice(0, limit) };
}

/** Season profiles + archetypes for a player, newest season first. Falls back to a partial name match. */
export function playerProfile(db, name) {
  const sql = `SELECT sp.season, sp.player_name, sp.team, sp.position, sp.games, sp.starts, sp.minutes_pg,
                      sp.usg_pct, sp.ast_pct, sp.reb_pct, sp.three_pa_rate, sp.ts_pct, sp.dk_fppm, sp.fd_fppm,
                      sp.pts_per36, sp.reb_per36, sp.ast_per36, sp.fg3m_per36,
                      a.archetype, a.secondary_archetype
               FROM player_season_profiles sp
               LEFT JOIN player_archetypes a ON a.player_key = sp.player_key AND a.season = sp.season
               WHERE %WHERE%
               ORDER BY sp.season DESC, sp.player_name`;
  const exact = db.prepare(sql.replace('%WHERE%', 'sp.player_key = ?')).all(playerKey(name));
  if (exact.length) return exact;
  return db.prepare(sql.replace('%WHERE%', 'LOWER(sp.player_name) LIKE LOWER(?)')).all(`%${name}%`);
}

/**
 * Recent games played (minutes > 0, all season types) and per-season
 * regular-season averages. Falls back to a partial name match.
 */
export function playerHistory(db, name, limit = 10) {
  const key = playerKey(name);
  const byKey = db.prepare('SELECT 1 FROM historical_games WHERE player_key = ? LIMIT 1').get(key);
  const where = byKey ? 'player_key = ?' : 'LOWER(player_name) LIKE LOWER(?)';
  const arg = byKey ? key : `%${name}%`;

  const recentGames = db.prepare(
    `SELECT player_name, game_date, season, season_type, team, opponent, is_home, is_starter, is_back_to_back,
            minutes, points, rebounds, assists, steals, blocks, turnovers, fg3_made,
            dk_fantasy_points, fd_fantasy_points
     FROM historical_games
     WHERE ${where} AND minutes > 0
     ORDER BY game_date DESC
     LIMIT ?`
  ).all(arg, limit);

  const seasonStats = db.prepare(
    `SELECT season,
            COUNT(*) AS games,
            ROUND(AVG(dk_fantasy_points), 1) AS avg_dk,
            ROUND(MIN(dk_fantasy_points), 1) AS min_dk,
            ROUND(MAX(dk_fantasy_points), 1) AS max_dk,
            ROUND(AVG(fd_fantasy_points), 1) AS avg_fd,
            ROUND(AVG(minutes), 1) AS avg_min,
            ROUND(AVG(points), 1) AS avg_pts,
            ROUND(AVG(rebounds), 1) AS avg_reb,
            ROUND(AVG(assists), 1) AS avg_ast
     FROM historical_games
     WHERE ${where} AND minutes > 0 AND season_type = 'regular'
     GROUP BY season
     ORDER BY season DESC`
  ).all(arg);

  return { recentGames, seasonStats };
}
