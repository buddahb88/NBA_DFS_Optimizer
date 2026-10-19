import * as roster from './roster.js';
import * as salary from './salary.js';
import * as filters from './filters.js';
import * as lockExclude from './lockExclude.js';
import * as teamLimits from './teamLimits.js';
import * as uniqueness from './uniqueness.js';
import * as exposure from './exposure.js';
import * as stacking from './stacking.js';

/**
 * CONSTRAINT PIPELINE
 *
 * Each module exports `name` and optionally:
 *   filterPlayers(players, ctx) -> players   once per request, trims the pool
 *   apply(model, ctx)                        once per solve, mutates the LP model
 *
 * Modules run in this order. roster must be first in apply because it creates
 * the variables the others attach coefficients to. To add a rule, write a
 * module and add it here.
 */
export const CONSTRAINTS = [
  roster,
  salary,
  filters,
  lockExclude,
  teamLimits,
  uniqueness,
  exposure,
  stacking
];

export function filterPool(players, ctx, constraints = CONSTRAINTS) {
  return constraints.reduce(
    (pool, mod) => (mod.filterPlayers ? mod.filterPlayers(pool, ctx) : pool),
    players
  );
}

export function applyConstraints(model, ctx, constraints = CONSTRAINTS) {
  constraints.forEach(mod => mod.apply?.(model, ctx));
  return model;
}
