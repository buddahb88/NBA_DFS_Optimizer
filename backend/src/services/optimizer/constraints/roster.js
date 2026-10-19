import { getEligibleSlots } from '../../../config/sites.js';
import { playerScores } from '../scoring.js';

/**
 * ROSTER
 * Creates one binary variable per (player, eligible slot) and requires:
 * - exactly rosterSize players
 * - each slot name filled exactly as many times as the site lists it
 *   (FanDuel's two PG slots become slot_PG = 2)
 * - each player used at most once
 *
 * Must run first: later modules attach coefficients to these variables.
 */
export const name = 'roster';

export function apply(model, ctx) {
  model.constraints.totalPlayers = { equal: ctx.rosterSize };

  ctx.slotCounts.forEach((count, slot) => {
    model.constraints[`slot_${slot}`] = { equal: count };
  });

  ctx.players.forEach(player => {
    model.constraints[`player_${player.id}`] = { max: 1 };
  });

  ctx.players.forEach(player => {
    const { cashScore, gppScore } = playerScores(player, ctx.site);
    const varNames = [];

    getEligibleSlots(ctx.site.key, player.position).forEach(slot => {
      const varName = `p${player.id}_${slot}`;
      model.variables[varName] = {
        cashScore,
        gppScore,
        totalPlayers: 1,
        [`slot_${slot}`]: 1,
        [`player_${player.id}`]: 1
      };
      model.ints[varName] = 1;
      ctx.varMeta.set(varName, { playerId: player.id, slot });
      varNames.push(varName);
    });

    ctx.varsByPlayer.set(player.id, varNames);
  });
}
