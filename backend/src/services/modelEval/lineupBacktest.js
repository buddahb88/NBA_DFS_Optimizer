/**
 * LINEUP-LEVEL BACKTEST (M4): what each projection source's lineups actually
 * scored on the saved slates. Works on scored harness slate rows (one row per
 * snapshot player with preds per source, actual DK, slate fields); reads no
 * database.
 *
 * Per slate and source (a source = a prediction key in row.preds; its
 * dk_points / minutes / p10 / p90 become projected_points / projected_minutes
 * / floor / ceiling of an optimizer pool, ownership is the snapshot's):
 *   cash  the single max-projection lineup (the optimizer's LP pipeline - DK
 *         slots, $50K cap, $49K min salary - with the projection as the
 *         objective, solved by HiGHS): actual score, % of the hindsight optimal
 *         (same rules, actual points as the objective), and its percentile in
 *         a synthetic field of ownership-sampled valid lineups
 *         (portfolio/fieldGenerator, no optimizer share: the same field for
 *         every source on a slate).
 *   gpp   a 20-lineup portfolio from generateLineupBatch (the app's batch
 *         optimizer: GPP score = ceiling / value / ownership / leverage) with the
 *         Lineup Studio "20-max" preset: randomness 15, min uniqueness 2, max
 *         exposure 60%, $47.5K min salary, min projection 20, min minutes 20, a
 *         3-man game stack with a bring-back in 60% of lineups. Seeded
 *         randomness, the same seed per slate for every source. Leverage: the
 *         snapshot's (the app's boom model) for sources without p_boom, else
 *         p_boom x 100 / (ownership + 1) as the app computes it. Best and average
 *         actual score, and the best lineup's field percentile.
 */

import optimizerService from '../optimizerService.js';
import { buildRequestContext, buildSolveContext } from '../optimizer/context.js';
import { generateLineupBatch } from '../optimizer/constraints/exposure.js';
import { solveWithHighs } from '../optimizer/solvers/highs.js';
import { createSolverContext, ROSTER_SIZE } from '../portfolio/lineupSolver.js';
import { generateField, resolveOwnership } from '../portfolio/fieldGenerator.js';
import { createRng } from '../simulation/rng.js';
import { isOutStatus } from '../minutesModel.js';
import { mulberry32 } from './metrics.js';
import { seedOf } from './ratesV1.js';

export const GPP_SETTINGS = Object.freeze({
  mode: 'gpp',
  site: 'draftkings',
  numLineups: 20,
  randomness: 15,
  minUniqueness: 2,
  maxExposure: 60,
  minSalary: 47500,
  minProjection: 20,
  minMinutes: 20,
  stackRules: [{ type: 'gameStack', min: 3, bringBack: 1, percentOfLineups: 60 }]
});
export const FIELD_SIZE = 5000;

const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const round = (v, d = 2) => (finite(v) ? Math.round(v * 10 ** d) / 10 ** d : null);
const mean = (xs) => (xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : null);

/** Rows of the slate that can be rostered (salary, position, not ruled OUT before lock). */
export function rosterable(rows) {
  return rows.filter(r => r.salary > 0 && r.position && !isOutStatus(r.slate?.injuryStatus));
}

/**
 * Optimizer pool of one source: players-table shape with ids stable across
 * sources (index in `rows` + 1) and the actual DK points.
 */
export function poolFor(rows, source) {
  const out = [];
  rows.forEach((r, i) => {
    const p = r.preds?.[source];
    if (!finite(p?.dk_points)) return;
    const ownership = r.slate?.ownership ?? null;
    out.push({
      id: i + 1,
      name: r.name,
      team: r.team,
      opponent: r.opponent,
      position: r.position,
      salary: r.salary,
      projected_points: p.dk_points,
      projected_minutes: p.minutes ?? null,
      floor: finite(p.p10) ? p.p10 : null,
      ceiling: finite(p.p90) ? p.p90 : null,
      rostership: ownership,
      leverage_score: finite(p.p_boom) ? (p.p_boom * 100) / ((ownership ?? 0) + 1) : r.slate?.leverage ?? null,
      actual: r.actual?.dk ?? 0
    });
  });
  return out;
}

/**
 * Max-`field` lineup under the site rules via the optimizer's LP pipeline and
 * HiGHS. Returns { players, salary, projected, actual } or null.
 */
export function bestLineup(pool, field = 'projected_points', { minSalary } = {}) {
  const players = pool.filter(p => finite(p[field]) && (field !== 'projected_points' || p[field] > 0));
  if (players.length < ROSTER_SIZE) return null;
  const requestCtx = buildRequestContext({ mode: 'cash', site: 'draftkings', ...(minSalary !== undefined ? { minSalary } : {}) });
  const ctx = buildSolveContext(requestCtx, players);
  const model = optimizerService.buildLPModel(ctx);
  for (const [name, meta] of ctx.varMeta) model.variables[name].cashScore = ctx.playersById.get(meta.playerId)[field];
  const result = solveWithHighs(model);
  if (!result?.feasible) return null;
  const lineup = optimizerService.extractLineupFromSolution(result, players, ctx);
  if (!lineup?.isValid) return null;
  return summarizeLineup(lineup.players.map(s => s.player));
}

function summarizeLineup(players) {
  return {
    players: players.map(p => p.id),
    names: players.map(p => p.name),
    salary: players.reduce((s, p) => s + p.salary, 0),
    projected: round(players.reduce((s, p) => s + (p.projected_points ?? 0), 0)),
    actual: round(players.reduce((s, p) => s + p.actual, 0))
  };
}

/**
 * Synthetic field of ownership-sampled valid lineups' actual scores (sorted).
 * rows: rosterable rows; actual by row index.
 */
export function fieldScores(rows, { size = FIELD_SIZE, seed = 'field' } = {}) {
  const players = rows.map((r, i) => ({ id: i + 1, salary: r.salary, position: r.position, rostership: r.slate?.ownership ?? null }));
  const ctx = createSolverContext(players);
  const { pct } = resolveOwnership(players);
  const field = generateField(ctx, pct, { size, rng: createRng(seed), optimizedShare: 0 });
  const n = field.lineups.length / ROSTER_SIZE;
  const scores = new Float64Array(n);
  for (let l = 0; l < n; l++) {
    let s = 0;
    for (let k = 0; k < ROSTER_SIZE; k++) s += rows[field.lineups[l * ROSTER_SIZE + k]].actual?.dk ?? 0;
    scores[l] = s;
  }
  return scores.sort();
}

/** Percentile (0-100) of a score in a sorted field (ties count half). */
export function percentileIn(sorted, score) {
  if (!sorted.length || !finite(score)) return null;
  let below = 0, equal = 0;
  for (const s of sorted) {
    if (s < score) below++;
    else if (s === score) equal++;
  }
  return round((100 * (below + equal / 2)) / sorted.length, 1);
}

/** Run fn with console.log / console.warn silenced (the optimizer logs every solve). */
function quietly(fn) {
  const { log, warn } = console;
  console.log = () => {};
  console.warn = () => {};
  try {
    return fn();
  } finally {
    console.log = log;
    console.warn = warn;
  }
}

/**
 * GPP portfolio of one source. Falls back to no pool filters when the
 * preset's filters leave fewer than 20 players (tiny slates). Returns
 * { lineups: [{ actual, projected }], best, avg, filtersRelaxed, warnings } or null.
 */
export function gppPortfolio(pool, { settings = GPP_SETTINGS, seed = 'gpp' } = {}) {
  const run = (body) => quietly(() => generateLineupBatch(pool, body, { rng: mulberry32(seedOf(seed)) }));
  let result = run(settings);
  let filtersRelaxed = false;
  if (!result.lineups.length && result.error === 'Insufficient players') {
    result = run({ ...settings, minProjection: 0, minMinutes: 0 });
    filtersRelaxed = true;
  }
  if (!result.lineups.length) return { lineups: [], best: null, avg: null, filtersRelaxed, warnings: [result.error ?? 'no lineups', ...(result.warnings ?? [])] };
  const lineups = result.lineups.map(l => summarizeLineup(l.players.map(s => s.player)));
  return {
    lineups,
    best: round(Math.max(...lineups.map(l => l.actual))),
    avg: round(mean(lineups.map(l => l.actual))),
    filtersRelaxed,
    warnings: result.warnings ?? []
  };
}

/**
 * Lineup backtest over slates. rows: scored slate rows (with position, slate,
 * preds); sources: prediction keys. options: { gpp = true, fieldSize, settings }.
 * Returns { sources, slates: [{ slateId, date, players, optimal, fieldMedian,
 * cash: { source: {...} }, gpp: { source: {...} } }], totals: { source: {...} } }.
 */
export function runLineupBacktest(rows, sources, { gpp = true, fieldSize = FIELD_SIZE, settings = GPP_SETTINGS, gppSeeds = 1, onSlate = null } = {}) {
  const bySlate = new Map();
  for (const r of rows) {
    if (!bySlate.has(r.slateId)) bySlate.set(r.slateId, []);
    bySlate.get(r.slateId).push(r);
  }
  const slates = [];
  for (const [slateId, all] of bySlate) {
    const list = rosterable(all);
    const date = all[0].date;
    const field = fieldScores(list, { size: fieldSize, seed: `field|${slateId}` });
    const actualPool = poolFor(list.map(r => ({ ...r, preds: { actual: { dk_points: r.actual?.dk ?? 0 } } })), 'actual');
    const optimal = quietly(() => bestLineup(actualPool, 'actual'));
    const out = { slateId, date, players: list.length, optimal: optimal?.actual ?? null, fieldMedian: round(field[Math.floor(field.length / 2)]), fieldP90: round(field[Math.floor(field.length * 0.9)]), cash: {}, gpp: {} };
    for (const source of sources) {
      const pool = poolFor(list, source);
      const cash = quietly(() => bestLineup(pool));
      out.cash[source] = cash ? {
        ...cash,
        pctOfOptimal: optimal?.actual ? round((100 * cash.actual) / optimal.actual, 1) : null,
        fieldPercentile: percentileIn(field, cash.actual)
      } : null;
      if (gpp) {
        const runs = Array.from({ length: Math.max(1, gppSeeds) }, (_, k) => {
          const g = gppPortfolio(pool, { settings, seed: k ? `gpp|${slateId}|${k}` : `gpp|${slateId}` });
          return {
            ...g,
            bestFieldPercentile: percentileIn(field, g.best),
            avgFieldPercentile: g.lineups.length ? mean(g.lineups.map(l => percentileIn(field, l.actual))) : null
          };
        });
        const ok = runs.filter(g => g.lineups.length);
        const avgOf = (k) => (ok.length ? round(mean(ok.map(g => g[k])), 2) : null);
        out.gpp[source] = {
          seeds: runs.length,
          best: avgOf('best'),
          avg: avgOf('avg'),
          bestFieldPercentile: avgOf('bestFieldPercentile'),
          avgFieldPercentile: avgOf('avgFieldPercentile'),
          bestBySeed: runs.map(g => g.best),
          filtersRelaxed: runs.some(g => g.filtersRelaxed),
          warnings: [...new Set(runs.flatMap(g => g.warnings))],
          lineups: runs[0].lineups.map(l => ({ actual: l.actual, projected: l.projected }))
        };
      }
    }
    slates.push(out);
    onSlate?.(out);
  }
  const totals = {};
  for (const source of sources) {
    const cash = slates.map(s => s.cash[source]).filter(Boolean);
    const g = slates.map(s => s.gpp[source]).filter(x => x?.lineups?.length);
    totals[source] = {
      cashSlates: cash.length,
      cashActual: round(cash.reduce((t, c) => t + c.actual, 0)),
      cashProjected: round(cash.reduce((t, c) => t + c.projected, 0)),
      cashPctOfOptimal: round(mean(cash.map(c => c.pctOfOptimal).filter(finite)), 1),
      cashFieldPercentile: round(mean(cash.map(c => c.fieldPercentile).filter(finite)), 1),
      cashWins: slates.filter(s => s.cash[source] && Object.values(s.cash).every(c => !c || c.actual <= s.cash[source].actual)).length,
      gppSlates: g.length,
      gppBest: round(g.reduce((t, x) => t + x.best, 0)),
      gppAvg: round(g.reduce((t, x) => t + x.avg, 0)),
      gppBestFieldPercentile: round(mean(g.map(x => x.bestFieldPercentile).filter(finite)), 1),
      gppAvgFieldPercentile: round(mean(g.map(x => x.avgFieldPercentile).filter(finite)), 1)
    };
  }
  return { sources, gppSettings: gpp ? settings : null, fieldSize, slates, totals };
}

export default { runLineupBacktest, poolFor, bestLineup, fieldScores, percentileIn, gppPortfolio, rosterable, GPP_SETTINGS };
