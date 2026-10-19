/**
 * EXPOSURE (extension point - not implemented yet)
 *
 * Intended for per-player min/max exposure across a multi-lineup request.
 * Available on ctx:
 *   ctx.settings          raw request settings (maxExposure, ...)
 *   ctx.numLineups        lineups requested
 *   ctx.priorLineups      player ID arrays of lineups already built
 *   ctx.playerUsageCount  Map playerId -> lineups used in so far
 *   ctx.varsByPlayer      Map playerId -> LP variable names (see helpers.addToPlayerVars)
 *
 * Today maxExposure is still enforced by OptimizerService, which excludes
 * overexposed players before each solve (ctx.excludedPlayers).
 */
export const name = 'exposure';

export function apply(model, ctx) {}
