/**
 * PLAYER SEASON PROFILE SERVICE
 *
 * Builds player_season_profiles (one row per season + player_key) from
 * regular-season historical_games joined to team_game_stats for the player's
 * team and its opponent in each game. Only games with minutes > 0 count.
 *
 * Team-relative rates use the Basketball-Reference formulas, summed over the
 * player's games so traded players get the right team context for each game:
 *   share = MP / (TmMP / 5)                       (fraction of team minutes)
 *   usg   = Σ(FGA + 0.44 FTA + TOV) / Σ share·(TmFGA + 0.44 TmFTA + TmTOV)
 *   ast   = ΣAST / Σ(share·TmFGM − FGM)
 *   oreb  = ΣOREB / Σ share·(TmOREB + OppDREB)     dreb, reb likewise
 *   stl   = ΣSTL / Σ share·OppPoss
 *   blk   = ΣBLK / Σ share·(OppFGA − Opp3PA)
 * All rates are fractions; null when the denominator is 0.
 */

import db, { DATABASE_TYPE } from '../config/database.js';
import { PROFILE_COLUMNS } from '../config/playerProfileMigrations.js';
import { listSeasons } from '../utils/season.js';

export const FIRST_PROFILE_SEASON = '2024-25';

const GAME_ROWS_SQL = `
  SELECT h.player_key, h.player_name, h.espn_player_id, h.team, h.position, h.is_starter,
         h.minutes, h.points, h.assists, h.steals, h.blocks, h.turnovers,
         h.fg_made, h.fg_attempted, h.fg3_made, h.fg3_attempted, h.ft_made, h.ft_attempted,
         h.oreb, h.dreb, h.dk_fantasy_points, h.fd_fantasy_points,
         t.minutes AS tm_minutes, t.fgm AS tm_fgm, t.fga AS tm_fga, t.fta AS tm_fta, t.tov AS tm_tov,
         t.oreb AS tm_oreb, t.dreb AS tm_dreb,
         o.fga AS opp_fga, o.fg3a AS opp_fg3a, o.oreb AS opp_oreb, o.dreb AS opp_dreb,
         o.possessions AS opp_possessions
  FROM historical_games h
  LEFT JOIN team_game_stats t ON t.game_id = h.game_id AND t.team = h.team
  LEFT JOIN team_game_stats o ON o.game_id = h.game_id AND o.team = t.opponent
  WHERE h.season = ? AND COALESCE(h.season_type, 'regular') = 'regular'
    AND h.minutes > 0 AND h.player_key IS NOT NULL
  ORDER BY h.game_date, h.id
`;

const SUM_FIELDS = ['minutes', 'points', 'assists', 'steals', 'blocks', 'turnovers', 'fg_made', 'fg_attempted',
  'fg3_made', 'fg3_attempted', 'ft_made', 'ft_attempted', 'oreb', 'dreb', 'dk_fantasy_points', 'fd_fantasy_points'];
// Σ share·(...) denominators, plus the player stats counted only in games with team context
const TEAM_FIELDS = ['plays', 'teammate_fgm', 'oreb_chances', 'dreb_chances', 'opp_possessions', 'opp_fg2a',
  'used', 'assists', 'oreb', 'dreb', 'steals', 'blocks'];

const n = (v) => Number(v) || 0;
const ratio = (num, den) => (den > 0 ? num / den : null);

function hasTeamContext(row) {
  return n(row.tm_minutes) > 0 && row.opp_fga != null;
}

/**
 * Aggregate per-game rows (GAME_ROWS_SQL shape, in game order) into profiles.
 */
export function computeProfiles(season, gameRows) {
  const players = new Map();

  for (const row of gameRows) {
    let p = players.get(row.player_key);
    if (!p) {
      p = { games: 0, starts: 0, teams: [], positions: new Map(), sums: {}, team: {} };
      for (const f of SUM_FIELDS) p.sums[f] = 0;
      for (const f of TEAM_FIELDS) p.team[f] = 0;
      players.set(row.player_key, p);
    }

    // Latest values win for identity columns
    p.player_name = row.player_name;
    if (row.espn_player_id) p.espn_player_id = String(row.espn_player_id);
    if (row.team && !p.teams.includes(row.team)) p.teams.push(row.team);
    if (row.team) p.latestTeam = row.team;
    if (row.position) {
      // Re-inserting moves the key last, so ties go to the most recent position
      const count = (p.positions.get(row.position) || 0) + 1;
      p.positions.delete(row.position);
      p.positions.set(row.position, count);
    }

    p.games++;
    if (n(row.is_starter) === 1) p.starts++;
    for (const f of SUM_FIELDS) p.sums[f] += n(row[f]);

    if (hasTeamContext(row)) {
      const share = n(row.minutes) / (n(row.tm_minutes) / 5);
      const t = p.team;
      t.plays += share * (n(row.tm_fga) + 0.44 * n(row.tm_fta) + n(row.tm_tov));
      t.teammate_fgm += share * n(row.tm_fgm) - n(row.fg_made);
      t.oreb_chances += share * (n(row.tm_oreb) + n(row.opp_dreb));
      t.dreb_chances += share * (n(row.tm_dreb) + n(row.opp_oreb));
      t.opp_possessions += share * n(row.opp_possessions);
      t.opp_fg2a += share * (n(row.opp_fga) - n(row.opp_fg3a));
      t.used += n(row.fg_attempted) + 0.44 * n(row.ft_attempted) + n(row.turnovers);
      t.assists += n(row.assists);
      t.oreb += n(row.oreb);
      t.dreb += n(row.dreb);
      t.steals += n(row.steals);
      t.blocks += n(row.blocks);
    }
  }

  return [...players.entries()].map(([player_key, p]) => {
    const s = p.sums;
    const t = p.team;
    let position = null;
    let best = 0;
    for (const [pos, count] of p.positions) {
      if (count >= best) { position = pos; best = count; }
    }
    const per36 = (v) => ratio(36 * v, s.minutes);
    const shootingPossessions = s.fg_attempted + 0.44 * s.ft_attempted;

    return {
      season,
      player_key,
      player_name: p.player_name,
      espn_player_id: p.espn_player_id ?? null,
      team: p.latestTeam ?? null,
      teams: p.teams.join(',') || null,
      position,
      games: p.games,
      starts: p.starts,
      minutes: s.minutes,
      minutes_pg: s.minutes / p.games,
      usg_pct: ratio(t.used, t.plays),
      ast_pct: ratio(t.assists, t.teammate_fgm),
      oreb_pct: ratio(t.oreb, t.oreb_chances),
      dreb_pct: ratio(t.dreb, t.dreb_chances),
      reb_pct: ratio(t.oreb + t.dreb, t.oreb_chances + t.dreb_chances),
      stl_pct: ratio(t.steals, t.opp_possessions),
      blk_pct: ratio(t.blocks, t.opp_fg2a),
      three_pa_rate: ratio(s.fg3_attempted, s.fg_attempted),
      ft_rate: ratio(s.ft_attempted, s.fg_attempted),
      ts_pct: ratio(s.points, 2 * shootingPossessions),
      dk_fppm: ratio(s.dk_fantasy_points, s.minutes),
      fd_fppm: ratio(s.fd_fantasy_points, s.minutes),
      pts_per36: per36(s.points),
      reb_per36: per36(s.oreb + s.dreb),
      ast_per36: per36(s.assists),
      fg3m_per36: per36(s.fg3_made),
    };
  });
}

const INSERT_SQL = `INSERT INTO player_season_profiles (${PROFILE_COLUMNS.join(', ')})
  VALUES (${PROFILE_COLUMNS.map(c => `@${c}`).join(', ')})`;
const DELETE_SQL = 'DELETE FROM player_season_profiles WHERE season = @season';

/**
 * Recompute and replace every profile for one season.
 * Returns { season, players, games }.
 */
export async function refreshSeasonProfiles(season) {
  const gameRows = await db.all(GAME_ROWS_SQL, season);
  const rows = computeProfiles(season, gameRows);

  if (DATABASE_TYPE === 'azuresql') {
    await db.run(DELETE_SQL, { season });
    for (const row of rows) await db.run(INSERT_SQL, row);
  } else {
    const sqlite = db.sqliteDb;
    const insert = sqlite.prepare(INSERT_SQL);
    db.transaction(() => {
      sqlite.prepare(DELETE_SQL).run({ season });
      for (const row of rows) insert.run(row);
    })();
  }

  return { season, players: rows.length, games: gameRows.length };
}

/** Refresh several seasons (default: FIRST_PROFILE_SEASON through the current one, oldest first). */
export async function refreshProfiles(seasons = listSeasons(FIRST_PROFILE_SEASON).reverse()) {
  const results = [];
  for (const season of seasons) results.push(await refreshSeasonProfiles(season));
  return results;
}
