/**
 * STACKING (extension point - not implemented yet)
 *
 * Intended for team/game stack rules (e.g. settings.teamStacks, which
 * routes/optimizer.js already accepts). Available on ctx:
 *   ctx.settings, ctx.site, ctx.players, ctx.playersById
 *   ctx.varsByPlayer      Map playerId -> LP variable names
 *   helpers.addToPlayerVars / helpers.requireDistinctGroups for building constraints
 */
export const name = 'stacking';

export function apply(model, ctx) {}
