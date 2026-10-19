import { addToPlayerVars } from './helpers.js';

/**
 * MIN UNIQUENESS
 * With settings.minUniqueness = k, every new lineup must differ from each
 * prior lineup in this request by at least k players:
 *   sum(players of prior lineup L picked again) <= |L| - k
 */
export const name = 'uniqueness';

export function apply(model, ctx) {
  const k = ctx.minUniqueness;
  if (!k || k <= 0) return;

  ctx.priorLineups.forEach((playerIds, i) => {
    const key = `unique_${i}`;
    model.constraints[key] = { max: Math.max(0, playerIds.length - k) };
    playerIds.forEach(id => addToPlayerVars(model, ctx, id, key));
  });
}
