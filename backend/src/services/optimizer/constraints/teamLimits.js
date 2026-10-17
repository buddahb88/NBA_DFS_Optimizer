import { addToPlayerVars, requireDistinctGroups } from './helpers.js';

/**
 * TEAM / GAME LIMITS (site rules)
 * - site.maxPlayersPerTeam: cap per real team (FanDuel 4, Yahoo 6, DK none)
 * - site.minTeams / site.minGames: lineup must span that many teams / games
 */
export const name = 'teamLimits';

const gameOf = (p) => (p.team && p.opponent ? [p.team, p.opponent].sort().join('@') : null);

export function apply(model, ctx) {
  const { maxPlayersPerTeam, minTeams, minGames } = ctx.site;

  if (maxPlayersPerTeam) {
    const teams = new Set(ctx.players.map(p => p.team).filter(Boolean));
    teams.forEach(team => {
      model.constraints[`team_${team}`] = { max: maxPlayersPerTeam };
    });
    ctx.players.forEach(p => {
      if (p.team) addToPlayerVars(model, ctx, p.id, `team_${p.team}`);
    });
  }

  // A per-team cap can already force enough teams (FanDuel: 9 players, max 4 -> 3 teams)
  const impliedTeams = maxPlayersPerTeam ? Math.ceil(ctx.rosterSize / maxPlayersPerTeam) : 1;
  if (minTeams > impliedTeams) {
    requireDistinctGroups(model, ctx, { prefix: 'teams', minGroups: minTeams, groupOf: p => p.team || null });
  }

  requireDistinctGroups(model, ctx, { prefix: 'games', minGroups: minGames, groupOf: gameOf });
}
