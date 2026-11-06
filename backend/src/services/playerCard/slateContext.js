/**
 * SLATE CONTEXT for the player-card verdicts (verdict.js buildVerdict's
 * second argument), computed once per slate from its rows. Pure.
 *
 *   gameCount, sizeBucket ('small' <= 3 games, 'medium' 4-7, 'large' 8+), label ('2-game slate')
 *   poolSize      active players: salary > 0, projection > 0, not OUT
 *   ownership     { n, avg, median, p90, chalkCount (30%+) } over active players with rostership > 0,
 *                 null when the slate has no ownership
 *   studSalary    the salary at rank studsPerGame x games (small slates: its "studs", top 1 per game), else null
 *   pool          [{ id, name, salary, projection }] active players without an injury tag (pivot candidates)
 */

import { canonicalTeam } from '../../utils/playerKey.js';
import { SLATE_RULES, sizeBucketFor, isOut, isRisky } from './verdict.js';

const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const r2 = (x) => Math.round(x * 100) / 100 + 0;

/** Value at quantile q (0-1) of an ascending array. */
function quantile(sorted, q) {
  if (!sorted.length) return null;
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

/** Distinct games (team pairs) among rows with a team and an opponent. */
export function countGames(rows) {
  const games = new Set();
  for (const p of rows) {
    const t = p.team ? canonicalTeam(p.team) : null;
    const o = p.opponent ? canonicalTeam(p.opponent) : null;
    if (t && o) games.add([t, o].sort().join('@'));
  }
  return games.size;
}

/**
 * The context for slate rows (players-table rows or snapshot rows: id, name,
 * team, opponent, salary, projected_points, rostership, injury_status).
 * gameCount overrides the count from the rows. Null without any game.
 */
export function buildSlateContext(rows = [], { gameCount = null } = {}) {
  const games = num(gameCount) ?? countGames(rows);
  const sizeBucket = sizeBucketFor(games);
  if (!sizeBucket) return null;

  const active = rows.filter(p => num(p.salary) > 0 && num(p.projected_points) > 0 && !isOut(p.injury_status));
  const owns = active.map(p => num(p.rostership)).filter(o => o !== null && o > 0).sort((a, b) => a - b);
  const ownership = owns.length ? {
    n: owns.length,
    avg: r2(owns.reduce((t, o) => t + o, 0) / owns.length),
    median: r2(quantile(owns, 0.5)),
    p90: r2(quantile(owns, 0.9)),
    chalkCount: owns.filter(o => o >= 30).length,
  } : null;

  const rules = SLATE_RULES[sizeBucket];
  let studSalary = null;
  if (rules.studsPerGame) {
    const salaries = active.map(p => num(p.salary)).sort((a, b) => b - a);
    const rank = Math.min(salaries.length, rules.studsPerGame * games);
    studSalary = rank ? salaries[rank - 1] : null;
  }

  return {
    gameCount: games,
    sizeBucket,
    label: `${games}-game slate`,
    poolSize: active.length,
    ownership,
    studSalary,
    pool: active.filter(p => !isRisky(p.injury_status)).map(p => ({
      id: p.id ?? null, name: p.name ?? null, salary: num(p.salary), projection: num(p.projected_points),
    })),
  };
}

/** The context without the pool (API responses). */
export const slateContextSummary = (c) => {
  if (!c) return null;
  const { pool, ...rest } = c;
  return rest;
};

export default { buildSlateContext, countGames, slateContextSummary };
