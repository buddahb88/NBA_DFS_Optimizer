/**
 * ARCHETYPE MATCHUP EDGE
 *
 * A good archetype matchup only pays if the player gets the minutes and the
 * role. Turns the defense cell's fp_over_expectation (archetypeDefenseService)
 * into an adjusted edge that the Tonight view and the Player Pool share:
 *
 *   volume             = min(1, minutes / fullMinutes), minutes = projected,
 *                        else current-season mpg (minCurrentGames+), else last
 *                        season's mpg, else unknownVolume
 *   role_factor        = product of the penalties for each flag:
 *                        new_team    slate team != last season's profile team
 *                        role_down   projection or current-season mpg 4+ below last season
 *                        role_up     ... 4+ above (and not down)
 *                        no_history  no last-season profile
 *   minutes_confidence = volume x role_factor
 *   crowding_factor    = 1 / (1 + crowdingPenalty x teammates), teammates =
 *                        same team, opponent and archetype, projected for
 *                        crowdingMinMinutes+ and not OUT
 *   adjusted_edge      = matchup_edge x minutes_confidence x crowding_factor
 *
 * Every component is returned so the UI can explain the number.
 */

import db from '../config/database.js';
import { canonicalTeam } from '../utils/playerKey.js';

export const MATCHUP_EDGE_CONFIG = {
  fullMinutes: 32,
  unknownVolume: 0.5,
  roleChangeMinutes: 4,
  minCurrentGames: 2,
  penalties: { new_team: 0.85, role_down: 0.8, role_up: 0.9, no_history: 0.85 },
  crowdingPenalty: 0.25,
  crowdingMinMinutes: 12,
};

const round1 = (x) => Math.round(x * 10) / 10;
const round3 = (x) => Math.round(x * 1000) / 1000;
const num = (v) => (v === null || v === undefined || v === '' || Number.isNaN(Number(v)) ? null : Number(v));
const isOut = (status) => /^out$/i.test(String(status ?? '').trim());

/** Minutes context and role flags for one player. Pure. */
function minutesContext(p, last, current, config) {
  const projected = num(p.projected_minutes);
  const lastMinutes = last ? num(last.minutes_pg) : null;
  const currentGames = current ? Number(current.games) || 0 : 0;
  const currentMinutes = current && currentGames > 0 ? num(current.minutes_pg) : null;
  const currentCounts = currentMinutes !== null && currentGames >= config.minCurrentGames;

  let basis = null;
  let minutes = null;
  if (projected !== null) [basis, minutes] = ['projected', projected];
  else if (currentCounts) [basis, minutes] = ['current', currentMinutes];
  else if (lastMinutes !== null) [basis, minutes] = ['last_season', lastMinutes];

  const changes = [];
  if (lastMinutes !== null) {
    if (projected !== null) changes.push(projected - lastMinutes);
    if (currentCounts) changes.push(currentMinutes - lastMinutes);
  }
  const t = config.roleChangeMinutes;
  const role = changes.some(c => c <= -t) ? 'role_down' : changes.some(c => c >= t) ? 'role_up' : null;

  const lastTeam = last ? canonicalTeam(last.team) : null;
  const newTeam = Boolean(lastTeam && canonicalTeam(p.team) && lastTeam !== canonicalTeam(p.team));

  return {
    minutes: {
      projected,
      last_season: lastMinutes === null ? null : round1(lastMinutes),
      current: currentMinutes === null ? null : round1(currentMinutes),
      current_games: currentGames,
      change: minutes === null || lastMinutes === null || basis === 'last_season' ? null : round1(minutes - lastMinutes),
      basis,
    },
    volume: minutes === null ? config.unknownVolume : Math.min(1, Math.max(0, minutes) / config.fullMinutes),
    role,
    newTeam,
    lastTeam,
  };
}

/**
 * Adjusted matchup edge per slate player. Pure.
 * @param {Array} players - { player_id, player_key, name, team, opponent,
 *   archetype, projected_minutes, injury_status, matchup_edge (null = none) };
 *   pass the whole slate so crowding sees every teammate
 * @param {Object} context - { lastSeason, current }: Map(player_key ->
 *   { minutes_pg, games, team? }) for last season's profile and this season so far
 * Returns Map(player_id -> { matchup_edge, adjusted_edge, minutes, role,
 *   new_team, last_team, crowding: { count, teammates }, flags, components })
 */
export function scoreMatchupEdges(players, context = {}, config = MATCHUP_EDGE_CONFIG) {
  const { lastSeason = new Map(), current = new Map() } = context;

  // Crowding groups: same team x opponent x archetype, eligible players only
  const groupOf = (p) => (p.archetype && p.archetype !== 'unclassified'
    ? `${canonicalTeam(p.team)}|${canonicalTeam(p.opponent)}|${p.archetype}` : null);
  const groups = new Map();
  for (const p of players) {
    const g = groupOf(p);
    if (!g || isOut(p.injury_status) || !((num(p.projected_minutes) ?? 0) >= config.crowdingMinMinutes)) continue;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(p);
  }

  const out = new Map();
  for (const p of players) {
    const last = lastSeason.get(p.player_key);
    const ctx = minutesContext(p, last, current.get(p.player_key), config);
    const flags = [];
    if (ctx.newTeam) flags.push('new_team');
    if (ctx.role) flags.push(ctx.role);
    if (!last) flags.push('no_history');
    const roleFactor = round3(flags.reduce((f, flag) => f * config.penalties[flag], 1));

    const teammates = (groups.get(groupOf(p)) ?? []).filter(t => t.player_id !== p.player_id).map(t => t.name);
    if (teammates.length > 0) flags.push('crowded');
    const crowdingFactor = round3(1 / (1 + config.crowdingPenalty * teammates.length));

    const minutesConfidence = round3(ctx.volume * roleFactor);
    const edge = num(p.matchup_edge);
    out.set(p.player_id, {
      matchup_edge: edge,
      adjusted_edge: edge === null ? null : round3(edge * minutesConfidence * crowdingFactor),
      minutes: ctx.minutes,
      role: ctx.role,
      new_team: ctx.newTeam,
      last_team: ctx.lastTeam,
      crowding: { count: teammates.length, teammates },
      flags,
      components: { volume: round3(ctx.volume), role_factor: roleFactor, minutes_confidence: minutesConfidence, crowding_factor: crowdingFactor },
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

const PROFILES_SQL = 'SELECT player_key, team, games, minutes_pg FROM player_season_profiles WHERE season = ?';

// Regular-season minutes so far, before asOfDate (no lookahead in backtests)
const CURRENT_MINUTES_SQL = `
  SELECT player_key, COUNT(*) AS games, AVG(minutes) AS minutes_pg
  FROM historical_games
  WHERE season = ? AND COALESCE(season_type, 'regular') = 'regular'
    AND minutes > 0 AND player_key IS NOT NULL AND game_date < ?
  GROUP BY player_key
`;

/**
 * Minutes context for scoreMatchupEdges: `lastSeason` profiles and `season`
 * minutes before `asOfDate` (YYYY-MM-DD, default today).
 */
export async function loadEdgeContext({ season, lastSeason, asOfDate = new Date().toISOString().slice(0, 10) }) {
  const [profiles, currentRows] = await Promise.all([
    db.all(PROFILES_SQL, lastSeason),
    db.all(CURRENT_MINUTES_SQL, season, asOfDate),
  ]);
  return {
    lastSeason: new Map(profiles.map(r => [r.player_key, r])),
    current: new Map(currentRows.map(r => [r.player_key, r])),
  };
}
