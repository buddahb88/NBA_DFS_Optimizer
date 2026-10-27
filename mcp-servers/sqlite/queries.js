/**
 * Queries behind the history / matchup MCP tools (better-sqlite3, synchronous).
 *
 * Players are matched on player_key, the backend's accent/punctuation/suffix-
 * free name key, so "Jaren Jackson Jr." and "Luka Dončić" resolve the same way
 * the projections do.
 */

import { playerKey } from '../../backend/src/utils/playerKey.js';
import { applySanity } from '../../backend/src/services/projections/sanityLayer.js';
import { projectionSanityEnabled, projectionSanityConfig } from '../../backend/src/config/projectionSanity.js';

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

/**
 * Slate rows for the value / GPP tools: the latest live slate, or with
 * slateDate (YYYY-MM-DD) the biggest saved slate of that night from
 * slate_player_snapshots, with actual DK points from historical_games
 * (a backtest). Returns { slateId, slateDate, backtest, from, actual }
 * where `from` is a FROM/WHERE clause over alias p.
 */
function slateRows(db, slateDate) {
  if (!slateDate) {
    const slate = latestSlate(db);
    return {
      slateId: slate?.slate_id ?? null, slateDate: null, backtest: false,
      from: 'FROM players p WHERE p.slate_id = ?', params: [slate?.slate_id ?? null], name: 'p.name', actual: ''
    };
  }
  const slate = db.prepare(`SELECT slate_id FROM slate_player_snapshots WHERE game_date = ? AND site = 'draftkings'
    GROUP BY slate_id ORDER BY COUNT(*) DESC LIMIT 1`).get(slateDate);
  return {
    slateId: slate?.slate_id ?? null, slateDate, backtest: true,
    from: `FROM slate_player_snapshots p
      LEFT JOIN historical_games h ON h.player_key = p.player_key AND h.game_date = p.game_date
      WHERE p.game_date = ? AND p.site = 'draftkings' AND p.slate_id = ?`,
    params: [slateDate, slate?.slate_id ?? null],
    name: 'p.player_name',
    actual: ', h.dk_fantasy_points AS actual_points'
  };
}

/**
 * The backend's projection sanity layer on tool rows (rows need
 * projected_points, projected_minutes, vegas_spread), as the app's slate reads
 * apply it: switched by PROJECTION_SANITY / PROJECTION_SANITY_BLOWOUT (this
 * process has no runtime toggle). The FPPM shrink needs game-log history the
 * MCP server does not load, so only the blowout trim runs here. Adjusted rows
 * keep the posted value (projection_raw) with the reasons.
 */
function withSanity(rows) {
  if (!projectionSanityEnabled()) return rows;
  const config = projectionSanityConfig();
  config.fppm.enabled = false;
  return rows.map(r => {
    const a = applySanity({ projectedPoints: r.projected_points, projectedMinutes: r.projected_minutes, spread: r.vegas_spread }, config);
    const reasons = a.reasons.map(x => x.text);
    if (!reasons.length) return { ...r, projection_raw: r.projected_points, projection_reasons: [], projection_sanity: true };
    const ratio = a.projection / a.raw_projection;
    return {
      ...r,
      projected_points: round2(a.projection),
      projected_minutes: Math.round(a.minutes * 10) / 10,
      floor: r.floor == null ? r.floor : round2(r.floor * ratio),
      ceiling: r.ceiling == null ? r.ceiling : round2(r.ceiling * ratio),
      projection_raw: r.projected_points,
      projection_reasons: reasons,
      projection_sanity: true
    };
  });
}

/** Value plays (projection per $1K) under maxSalary, on the sanity-adjusted projection. */
export function valuePlays(db, { maxSalary = 5500, limit = 15, slateDate = null } = {}) {
  const s = slateRows(db, slateDate);
  const rows = db.prepare(
    `SELECT ${s.name} AS name, p.position, p.team, p.opponent, p.salary, p.projected_points, p.projected_minutes, p.vegas_spread,
            p.floor, p.ceiling${s.actual}
     ${s.from} AND p.salary < ? AND p.salary > 0 AND p.projected_points > 0`
  ).all(...s.params, maxSalary);
  const plays = withSanity(rows)
    .map(p => ({ ...p, value: round2(p.projected_points / p.salary * 1000) }))
    .sort((a, b) => b.value - a.value || b.projected_points - a.projected_points)
    .slice(0, limit);
  return { slateId: s.slateId, slateDate: s.slateDate, backtest: s.backtest, plays };
}

/** GPP leverage plays: low ownership, high ceiling (projection / ceiling after the sanity layer). */
export function gppPlays(db, { maxRostership = 12, minCeiling = 40, limit = 15, slateDate = null } = {}) {
  const s = slateRows(db, slateDate);
  const plays = withSanity(db.prepare(
    `SELECT ${s.name} AS name, p.position, p.team, p.opponent, p.salary, p.projected_points, p.projected_minutes, p.vegas_spread,
            p.rostership, p.ceiling, p.leverage_score, p.boom_probability${s.actual}
     ${s.from} AND p.rostership < ? AND p.ceiling > ?
     ORDER BY p.leverage_score DESC LIMIT ?`
  ).all(...s.params, maxRostership, minCeiling, limit));
  return { slateId: s.slateId, slateDate: s.slateDate, backtest: s.backtest, plays };
}
