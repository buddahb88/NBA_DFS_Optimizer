/**
 * Helpers shared by constraint modules
 */

/**
 * Add `coef` for constraint `key` to every LP variable of a player
 * (one variable per eligible slot). No-op if the player has no variables.
 */
export function addToPlayerVars(model, ctx, playerId, key, coef = 1) {
  for (const varName of ctx.varsByPlayer.get(playerId) || []) {
    const variable = model.variables[varName];
    if (variable) variable[key] = (variable[key] || 0) + coef;
  }
}

/**
 * Require the lineup to use at least `minGroups` distinct groups
 * (teams, games, ...). groupOf(player) returns the group key, or null to skip.
 *
 * minGroups = 2 is a plain cap of (rosterSize - 1) per group. Higher values add
 * one binary per group: used_g <= players from g, and sum(used_g) >= minGroups.
 */
export function requireDistinctGroups(model, ctx, { prefix, minGroups, groupOf }) {
  if (!minGroups || minGroups < 2) return;

  const groups = new Map();
  for (const player of ctx.players) {
    const group = groupOf(player);
    if (group == null || !ctx.varsByPlayer.has(player.id)) continue;
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(player.id);
  }

  if (minGroups === 2) {
    groups.forEach((playerIds, group) => {
      const key = `${prefix}Max_${group}`;
      model.constraints[key] = { max: ctx.rosterSize - 1 };
      playerIds.forEach(id => addToPlayerVars(model, ctx, id, key));
    });
    return;
  }

  const countKey = `${prefix}Count`;
  model.constraints[countKey] = { min: minGroups };
  groups.forEach((playerIds, group) => {
    const usedVar = `${prefix}Used_${group}`;
    const linkKey = `${prefix}Link_${group}`;
    // used_g - sum(players in g) <= 0
    model.constraints[linkKey] = { max: 0 };
    model.variables[usedVar] = { [linkKey]: 1, [countKey]: 1 };
    model.ints[usedVar] = 1;
    model.constraints[`${usedVar}_bin`] = { max: 1 };
    model.variables[usedVar][`${usedVar}_bin`] = 1;
    playerIds.forEach(id => addToPlayerVars(model, ctx, id, linkKey, -1));
  });
}
