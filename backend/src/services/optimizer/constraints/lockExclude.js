/**
 * LOCK / EXCLUDE
 * - Pool: request-level excluded players are dropped (locked players always stay).
 * - Model: locked players must be in the lineup; players excluded for this
 *   solve (request excludes plus per-iteration diversity/exposure excludes)
 *   lose their variables.
 *
 * A player that is both locked and excluded makes the solve infeasible,
 * same as before the pipeline refactor.
 */
export const name = 'lockExclude';

export function filterPlayers(players, ctx) {
  return players.filter(p => ctx.lockedPlayers.has(p.id) || !ctx.requestExcluded.has(p.id));
}

export function apply(model, ctx) {
  ctx.lockedPlayers.forEach(id => {
    const key = `player_${id}`;
    if (model.constraints[key]) model.constraints[key] = { equal: 1 };
  });

  ctx.excludedPlayers.forEach(id => {
    for (const varName of ctx.varsByPlayer.get(id) || []) {
      delete model.variables[varName];
      delete model.ints[varName];
      ctx.varMeta.delete(varName);
    }
    ctx.varsByPlayer.set(id, []);
  });
}
