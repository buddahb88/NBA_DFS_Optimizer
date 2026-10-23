/**
 * EXPOSURE, UNIQUENESS & RANDOMNESS CONSTRAINTS (multi-lineup batches)
 *
 * Enforces exposure as hard constraints across a batch of N lineups instead of the
 * legacy greedy soft cap (which only excluded a player once he was already over).
 * Counts are planned up front, then every single-lineup ILP solve is constrained so
 * that mins are guaranteed and maxes can never be exceeded.
 *
 * ─── REQUEST CONTRACT (POST /api/optimizer/generate) ────────────────────────────
 * All percentages are 0-100 and are percent of numLineups (N).
 *
 * {
 *   slateId:        string            required
 *   mode:           'cash' | 'gpp'    default 'cash'
 *   numLineups:     integer >= 1      default 1
 *   site:           'draftkings' | 'fanduel' | 'yahoo'   default draftkings (route fills it
 *                                     from the slate); cap, roster and team rules follow it
 *   minSalary:      number            default 98% of the site cap ($49,000 on DK)
 *   stackRules / teamStacks           stacking rules (see stacking.js), applied on every solve
 *   ...legacy pool filters (minProjection, minMinutes, maxRostership, ...) unchanged
 *
 *   players: [{                       optional per-player controls; omitted players use defaults
 *     id:                 number      player id (players.id)
 *     minExposure?:       0-100       appear in at least ceil(min% * N / 100) lineups
 *     maxExposure?:       0-100       appear in at most floor(max% * N / 100) lineups
 *                                     (overrides the global maxExposure for this player)
 *     lock?:              boolean     in every lineup (min = max = 100%)
 *     exclude?:           boolean     in no lineup (removed from the pool)
 *     projectionOverride?: number     replaces projected_points; floor/ceiling scale with it
 *   }],
 *   maxExposure:    0-100             default 100; global max for players without their own
 *   teams?:         [{ team, maxExposure }]  max % of lineups containing ANY player from team
 *   maxTeamExposure?: 0-100           default 100; global team max for teams not listed
 *   minUniqueness:  1-rosterSize      default 1; each lineup differs from EVERY earlier
 *                                     lineup by at least K players (hard constraint)
 *   randomness:     0-100             default 0; per-player noise per solve. Each solve draws
 *                                     a sample from the player's [floor, ceiling] range
 *                                     (triangular, mode = projection) and moves the
 *                                     projection randomness% of the way toward it.
 *
 *   lockedPlayers / excludedPlayers   legacy id arrays, still honored (merged into players)
 * }
 *
 * Rounding: maxCount = floor(max% * N / 100) so a max is never exceeded (30% of 20 = 6,
 * 30% of 2 = 0); minCount = ceil(min% * N / 100) so a min is always met.
 *
 * ─── RESPONSE ──────────────────────────────────────────────────────────────────────
 * {
 *   success, lineups, count, settings,
 *   exposureStats,                    legacy shape (unchanged) for existing UI
 *   exposureSummary: {
 *     numLineups,
 *     players: [{ playerId, name, team, salary, count, exposure, minExposure, maxExposure,
 *                 minCount, maxCount, locked }]          sorted by count desc; every player
 *                                                        that was used or has a min/lock
 *     teams:   [{ team, lineups, exposure, playerSlots, maxExposure, maxCount }]
 *   },
 *   warnings: string[]                e.g. a solve was infeasible and the batch stopped early
 * }
 * Invalid configs (min > max, too many locks for minUniqueness, mins that cannot fit)
 * return HTTP 400 with { error }.
 *
 * ─── PIPELINE ──────────────────────────────────────────────────────────────────────
 * generateLineupBatch builds every single-lineup model through the constraint pipeline
 * (constraints/index.js), so site rules, uniqueness and stacking apply to each solve.
 * This module's apply() is the pipeline step that enforces the batch plan for one
 * solve: ctx.exposure = { forced, forbidden } (sets of player ids). Without
 * ctx.exposure (single optimize() calls) it is a no-op.
 */

import optimizerService from '../../optimizerService.js';
import { getSiteConfig } from '../../../config/sites.js';
import { buildRequestContext, buildSolveContext } from '../context.js';
import { filterPool } from './index.js';
import { solveWithHighs } from '../solvers/highs.js';

export const name = 'exposure';
const EPS = 1e-9;

/** Pipeline step: forced players fill a slot, forbidden players can't be picked. */
export function apply(model, ctx) {
  if (!ctx.exposure) return;
  ctx.exposure.forced.forEach((id) => {
    const key = `player_${id}`;
    if (model.constraints[key]) model.constraints[key] = { equal: 1 };
  });
  ctx.exposure.forbidden.forEach((id) => {
    const key = `player_${id}`;
    if (model.constraints[key]) model.constraints[key] = { max: 0 };
  });
}

export class ExposureConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ExposureConfigError';
    this.status = 400;
  }
}

const clampPct = (v, fallback) => {
  const n = Number(v);
  if (v === undefined || v === null || v === '' || !Number.isFinite(n)) return fallback;
  return Math.min(100, Math.max(0, n));
};

export const maxCountFor = (pct, n) => Math.floor((pct * n) / 100 + EPS);
export const minCountFor = (pct, n) => Math.ceil((pct * n) / 100 - EPS);

/**
 * Normalize the request body into a single exposure config. Legacy lockedPlayers /
 * excludedPlayers arrays are merged into the per-player map.
 */
export function parseExposureSettings(body = {}) {
  const rosterSize = getSiteConfig(body.site).rosterSlots.length;
  const numLineups = Math.max(1, parseInt(body.numLineups, 10) || 1);
  const playerSettings = new Map();
  const entry = (id) => {
    const key = Number(id);
    if (!playerSettings.has(key)) playerSettings.set(key, { id: key });
    return playerSettings.get(key);
  };

  (Array.isArray(body.players) ? body.players : []).forEach((p) => {
    if (p == null || p.id == null) return;
    const s = entry(p.id);
    if (p.minExposure != null) s.minExposure = clampPct(p.minExposure, 0);
    if (p.maxExposure != null) s.maxExposure = clampPct(p.maxExposure, 100);
    if (p.lock) s.lock = true;
    if (p.exclude) s.exclude = true;
    const override = Number(p.projectionOverride);
    if (p.projectionOverride != null && p.projectionOverride !== '' && Number.isFinite(override)) {
      s.projectionOverride = override;
    }
  });
  (body.lockedPlayers || []).forEach((id) => { entry(id).lock = true; });
  (body.excludedPlayers || []).forEach((id) => { entry(id).exclude = true; });

  const teamSettings = new Map();
  (Array.isArray(body.teams) ? body.teams : []).forEach((t) => {
    if (t?.team) teamSettings.set(t.team, { maxExposure: clampPct(t.maxExposure, 100) });
  });

  const minUniqueness = Math.min(rosterSize, Math.max(1, parseInt(body.minUniqueness, 10) || 1));

  return {
    numLineups,
    rosterSize,
    playerSettings,
    teamSettings,
    maxExposure: clampPct(body.maxExposure, 100),
    maxTeamExposure: clampPct(body.maxTeamExposure, 100),
    minUniqueness,
    randomness: clampPct(body.randomness, 0),
  };
}

/** Apply projectionOverride (floor/ceiling/std_dev scale proportionally) and drop excluded players. */
export function applyPlayerOverrides(players, config) {
  return players
    .filter((p) => !config.playerSettings.get(Number(p.id))?.exclude)
    .map((p) => {
      const override = config.playerSettings.get(Number(p.id))?.projectionOverride;
      if (override == null) return p;
      const base = p.projected_points || 0;
      const scale = base > 0 ? override / base : 1;
      return {
        ...p,
        projected_points: override,
        floor: p.floor != null && base > 0 ? p.floor * scale : p.floor,
        ceiling: p.ceiling != null && base > 0 ? p.ceiling * scale : p.ceiling,
        std_dev: p.std_dev != null && base > 0 ? p.std_dev * scale : p.std_dev,
      };
    });
}

/**
 * Plan per-player and per-team count limits for the batch, plus a schedule that spreads
 * each player's required (min) appearances across lineup indices so no single solve has
 * to absorb a pile-up of forced players at the end. Throws ExposureConfigError if the
 * config is impossible on its face.
 */
export function planExposure(players, config) {
  const N = config.numLineups;
  const { rosterSize } = config;
  const teamOf = new Map(players.map((p) => [Number(p.id), p.team]));
  const playerLimits = new Map();

  players.forEach((p) => {
    const id = Number(p.id);
    const s = config.playerSettings.get(id) || {};
    let minPct = s.minExposure ?? 0;
    // The global max is only a default: a player's own min above it raises his max
    let maxPct = s.maxExposure ?? Math.max(config.maxExposure, minPct);
    if (s.lock) {
      minPct = 100;
      maxPct = 100;
    }
    const minCount = minCountFor(minPct, N);
    const maxCount = maxCountFor(maxPct, N);
    if (minCount > maxCount) {
      throw new ExposureConfigError(
        `${p.name || `Player ${id}`}: min exposure ${minPct}% (${minCount} lineups) exceeds max ${maxPct}% (${maxCount} of ${N})`
      );
    }
    playerLimits.set(id, { minCount, maxCount, minPct, maxPct, locked: !!s.lock });
  });

  config.playerSettings.forEach((s, id) => {
    if ((s.lock || s.minExposure > 0) && !playerLimits.has(id) && !s.exclude) {
      throw new ExposureConfigError(`Player ${id} has a lock/min exposure but is not in the eligible pool`);
    }
  });

  const teamLimits = new Map();
  new Set(players.map((p) => p.team)).forEach((team) => {
    const pct = config.teamSettings.get(team)?.maxExposure ?? config.maxTeamExposure;
    teamLimits.set(team, { maxPct: pct, maxCount: maxCountFor(pct, N) });
  });

  const lockedCount = [...playerLimits.values()].filter((l) => l.locked).length;
  if (lockedCount > rosterSize) {
    throw new ExposureConfigError(`${lockedCount} locked players exceed the ${rosterSize}-man roster`);
  }
  if (N > 1 && lockedCount > rosterSize - config.minUniqueness) {
    throw new ExposureConfigError(
      `${lockedCount} locked players leave fewer than minUniqueness=${config.minUniqueness} open spots per lineup`
    );
  }

  // Schedule: lineup index -> Set(player ids that are due there). Players with the largest
  // mins go first; each appearance goes to the least-loaded lineup near its ideal even
  // spacing, preferring lineups already holding a teammate (saves team-exposure budget).
  const schedule = Array.from({ length: N }, () => new Set());
  const scheduledTeams = Array.from({ length: N }, () => new Set());
  const withMins = [...playerLimits.entries()]
    .filter(([, l]) => l.minCount > 0)
    .sort((a, b) => b[1].minCount - a[1].minCount);

  for (const [id, { minCount }] of withMins) {
    const team = teamOf.get(id);
    const taken = new Set();
    for (let k = 0; k < minCount; k++) {
      const ideal = ((k + 0.5) * N) / minCount;
      let best = -1;
      let bestKey = null;
      for (let i = 0; i < N; i++) {
        if (taken.has(i) || schedule[i].size >= rosterSize) continue;
        const key = [
          schedule[i].size,
          scheduledTeams[i].has(team) ? 0 : 1,
          Math.abs(i + 0.5 - ideal),
        ];
        if (!bestKey || key[0] < bestKey[0] || (key[0] === bestKey[0] && (key[1] < bestKey[1] || (key[1] === bestKey[1] && key[2] < bestKey[2])))) {
          best = i;
          bestKey = key;
        }
      }
      if (best < 0) {
        throw new ExposureConfigError(`Minimum exposures require more than ${rosterSize} players in some lineup`);
      }
      taken.add(best);
      schedule[best].add(id);
      scheduledTeams[best].add(team);
    }
  }

  // Each team's scheduled (forced) lineups must fit within its team max
  teamLimits.forEach(({ maxCount, maxPct }, team) => {
    const needed = scheduledTeams.filter((s) => s.has(team)).length;
    if (needed > maxCount) {
      throw new ExposureConfigError(
        `Team ${team}: player minimums need ${needed} lineups but team max ${maxPct}% allows ${maxCount}`
      );
    }
  });

  // Remaining scheduled slots per player from index i onward, for pacing checks
  const scheduledFrom = new Map();
  withMins.forEach(([id]) => {
    const suffix = new Array(N + 1).fill(0);
    for (let i = N - 1; i >= 0; i--) suffix[i] = suffix[i + 1] + (schedule[i].has(id) ? 1 : 0);
    scheduledFrom.set(id, suffix);
  });

  return { numLineups: N, playerLimits, teamLimits, schedule, scheduledFrom, teamOf };
}

/** Running usage counts across the batch. */
export function createExposureState() {
  return { playerCounts: new Map(), teamCounts: new Map(), lineups: [] };
}

export function recordLineup(state, playerIds, teamOf) {
  const ids = playerIds.map(Number);
  ids.forEach((id) => state.playerCounts.set(id, (state.playerCounts.get(id) || 0) + 1));
  new Set(ids.map((id) => teamOf.get(id))).forEach((team) => {
    state.teamCounts.set(team, (state.teamCounts.get(team) || 0) + 1);
  });
  state.lineups.push(ids);
}

/**
 * Which players must be forced in / kept out of solve `index`.
 * - forced: player still needs appearances and has no slack left in the schedule
 *   (needed >= scheduled slots remaining from here). With `deadlineOnly`, only players
 *   whose need equals the number of lineups left are forced (fallback when the
 *   schedule's choice is infeasible for this solve).
 * - forbidden: player at max, or team at max once future forced team lineups are reserved.
 */
export function getSolveRestrictions(plan, state, index, { deadlineOnly = false } = {}) {
  const remaining = plan.numLineups - index;
  const forced = new Set();
  const forbidden = new Set();
  const futureForcedTeamLineups = new Map(); // team -> lineups after this one that will force it

  plan.playerLimits.forEach(({ minCount, maxCount }, id) => {
    const used = state.playerCounts.get(id) || 0;
    if (used >= maxCount) {
      forbidden.add(id);
      return;
    }
    const needed = minCount - used;
    const slack = deadlineOnly ? remaining : plan.scheduledFrom.get(id)?.[index];
    if (needed > 0 && needed >= slack) forced.add(id);
  });

  // Reserve team budget for lineups after this one that still have forced players scheduled
  for (let j = index + 1; j < plan.numLineups; j++) {
    const teams = new Set();
    plan.schedule[j].forEach((id) => {
      const lim = plan.playerLimits.get(id);
      if ((state.playerCounts.get(id) || 0) < lim.minCount) teams.add(plan.teamOf.get(id));
    });
    teams.forEach((t) => futureForcedTeamLineups.set(t, (futureForcedTeamLineups.get(t) || 0) + 1));
  }

  const forcedTeams = new Set([...forced].map((id) => plan.teamOf.get(id)));
  plan.teamLimits.forEach(({ maxCount }, team) => {
    if (forcedTeams.has(team)) return; // team is in this lineup regardless
    const used = state.teamCounts.get(team) || 0;
    const reserved = futureForcedTeamLineups.get(team) || 0;
    if (used + reserved >= maxCount) {
      plan.teamOf.forEach((t, id) => {
        if (t === team && !forced.has(id)) forbidden.add(id);
      });
    }
  });

  return { forced, forbidden };
}

function defaultPlayerIdOf(varName) {
  const m = /^p(\d+)_/.exec(varName);
  return m ? Number(m[1]) : null;
}

/**
 * Rest-of-batch lookahead: the lineup picked now must leave the remaining `rest` lineups
 * feasible in aggregate. Adds continuous copies z of the template's player-slot variables
 * standing in for those lineups (score 0), with
 *   - every slot filled `rest` times,
 *   - batch salary within [minSalary, salaryCap] * rest,
 *   - per player: x (this lineup) + z (rest) within [minCount, maxCount] - used,
 *     and z <= rest (a player fills at most one slot per lineup).
 * This is the "plan target counts up front" step, re-planned on every solve: without it
 * early lineups grab the best values and the last solves are left only with players who
 * can't fit under the cap. Relaxation only (ignores uniqueness / team caps).
 */
export function addLookaheadConstraints(model, templateVars, plan, state, rest, { salaryCap, minSalary, slotCounts }) {
  if (rest <= 0) return model;
  slotCounts.forEach((count, slot) => { model.constraints[`la_slot_${slot}`] = { equal: count * rest }; });
  model.constraints.la_salary = { max: salaryCap * rest };
  if (minSalary > 0) model.constraints.la_minSalary = { min: minSalary * rest };

  plan.playerLimits.forEach(({ minCount, maxCount }, id) => {
    const used = state.playerCounts.get(id) || 0;
    model.constraints[`la_cap_${id}`] = { max: Math.max(0, maxCount - used), ...(minCount > used ? { min: minCount - used } : {}) };
    model.constraints[`la_once_${id}`] = { max: rest };
  });

  Object.entries(model.variables).forEach(([name, coeffs]) => {
    const id = defaultPlayerIdOf(name);
    if (id != null) coeffs[`la_cap_${id}`] = 1;
  });
  Object.entries(templateVars).forEach(([name, coeffs]) => {
    const id = defaultPlayerIdOf(name);
    if (id == null) return;
    const slot = name.slice(name.indexOf('_') + 1);
    model.variables[`z${name.slice(1)}`] = {
      [`la_slot_${slot}`]: 1,
      la_salary: coeffs.salary,
      la_minSalary: coeffs.salary,
      [`la_cap_${id}`]: 1,
      [`la_once_${id}`]: 1,
    };
  });
  return model;
}

/** Triangular sample on [lo, hi] with the given mode. */
function sampleTriangular(lo, mode, hi, rng) {
  if (hi <= lo) return mode;
  const u = rng();
  const c = (mode - lo) / (hi - lo);
  return u < c
    ? lo + Math.sqrt(u * (hi - lo) * (mode - lo))
    : hi - Math.sqrt((1 - u) * (hi - lo) * (hi - mode));
}

/**
 * Per-player noise for one solve. Draws from the player's own floor/ceiling range and
 * moves projection (and floor/ceiling, proportionally, so GPP scoring sees it too)
 * `randomness`% of the way toward the draw. 0 = deterministic.
 */
export function applyRandomness(players, randomness, rng = Math.random) {
  return players.map((p) => {
    const proj = p.projected_points || 0;
    if (!randomness || proj <= 0) return { ...p, adjustedProjection: proj };
    const floor = Math.min(p.floor ?? proj * 0.75, proj);
    const ceiling = Math.max(p.ceiling ?? proj * 1.25, proj);
    const draw = sampleTriangular(floor, proj, ceiling, rng);
    const adjusted = Math.max(0, proj + (randomness / 100) * (draw - proj));
    const scale = adjusted / proj;
    return {
      ...p,
      adjustedProjection: adjusted,
      floor: p.floor != null ? p.floor * scale : p.floor,
      ceiling: p.ceiling != null ? p.ceiling * scale : p.ceiling,
    };
  });
}

/** Per-player and per-team exposure summary for a finished batch. */
export function buildExposureSummary(lineups, players, plan) {
  const n = lineups.length;
  const byId = new Map(players.map((p) => [Number(p.id), p]));
  const playerCounts = new Map();
  const teamLineups = new Map();
  const teamSlots = new Map();

  lineups.forEach((lineup) => {
    const teams = new Set();
    lineup.players.forEach(({ player }) => {
      if (!player) return;
      const id = Number(player.id);
      playerCounts.set(id, (playerCounts.get(id) || 0) + 1);
      teamSlots.set(player.team, (teamSlots.get(player.team) || 0) + 1);
      teams.add(player.team);
    });
    teams.forEach((t) => teamLineups.set(t, (teamLineups.get(t) || 0) + 1));
  });

  const pct = (c) => (n ? Math.round((c / n) * 1000) / 10 : 0);

  const playerRows = [...plan.playerLimits.entries()]
    .filter(([id, l]) => playerCounts.has(id) || l.minCount > 0)
    .map(([id, l]) => {
      const p = byId.get(id) || {};
      const count = playerCounts.get(id) || 0;
      return {
        playerId: id,
        name: p.name,
        team: p.team,
        salary: p.salary,
        count,
        exposure: pct(count),
        minExposure: l.minPct,
        maxExposure: l.maxPct,
        minCount: l.minCount,
        maxCount: l.maxCount,
        locked: l.locked,
      };
    })
    .sort((a, b) => b.count - a.count || (b.salary || 0) - (a.salary || 0));

  const teamRows = [...plan.teamLimits.entries()]
    .map(([team, l]) => ({
      team,
      lineups: teamLineups.get(team) || 0,
      exposure: pct(teamLineups.get(team) || 0),
      playerSlots: teamSlots.get(team) || 0,
      maxExposure: l.maxPct,
      maxCount: l.maxCount,
    }))
    .sort((a, b) => b.lineups - a.lineups);

  return { numLineups: n, players: playerRows, teams: teamRows };
}

/**
 * Build a batch of N lineups with exposure / uniqueness / randomness enforced.
 * `players` is the slate pool (DB rows); `body` is the request body (contract above).
 * Each model is built (constraint pipeline) and extracted by optimizerService, so
 * scoring, site and stacking rules stay identical to the single-lineup optimizer. Models are solved with
 * HiGHS by default (~1s per lineup on a 400-player slate vs ~17s+ for
 * javascript-lp-solver); pass `solve` to swap solvers.
 */
export function generateLineupBatch(
  players,
  body = {},
  { optimizer = optimizerService, rng = Math.random, solveTimeoutMs = 60000, solve = solveWithHighs } = {}
) {
  const startTime = Date.now();
  const config = parseExposureSettings(body);
  const N = config.numLineups;
  // Locks / excludes come from the exposure plan; uniqueness is the pipeline's step
  const requestCtx = buildRequestContext({
    ...body,
    lockedPlayers: [],
    excludedPlayers: [],
    minUniqueness: config.minUniqueness,
  });
  const { mode, minSalary, site } = requestCtx;

  // Locked and min-exposure players bypass the pool filters (filters keep "locked")
  const keepIds = [...config.playerSettings.values()]
    .filter((s) => s.lock || s.minExposure > 0)
    .map((s) => s.id);
  const overridden = applyPlayerOverrides(players, config);
  const pool = filterPool(
    overridden,
    buildSolveContext({ ...requestCtx, lockedPlayers: new Set(keepIds) }, overridden)
  );

  if (pool.length < 20) {
    return { lineups: [], exposureStats: null, exposureSummary: null, error: 'Insufficient players', warnings: [] };
  }

  const plan = planExposure(pool, config);
  // Unrestricted model: its variables are the template for the rest-of-batch lookahead
  const templateVars = optimizer.buildLPModel(buildSolveContext(requestCtx, pool, { numLineups: N })).variables;
  const state = createExposureState();
  const lineups = [];
  const warnings = [];

  const solveOnce = (index, { lookahead = true, ...opts } = {}) => {
    const { forced, forbidden } = getSolveRestrictions(plan, state, index, opts);
    const noisy = applyRandomness(pool, config.randomness, rng);
    const rest = N - index - 1;
    const buildModel = (withLookahead) => {
      const ctx = buildSolveContext(requestCtx, noisy, {
        numLineups: N,
        priorLineups: state.lineups,
        exposure: { forced, forbidden },
      });
      const model = optimizer.buildLPModel(ctx);
      if (withLookahead) {
        addLookaheadConstraints(model, templateVars, plan, state, rest, {
          salaryCap: site.salaryCap,
          minSalary,
          slotCounts: requestCtx.slotCounts,
        });
      }
      // Bound branch-and-bound so a hard/infeasible solve fails over to the next fallback
      model.options = { ...model.options, timeout: solveTimeoutMs };
      return { model, ctx };
    };
    const run = ({ model, ctx }) => {
      const result = solve(model);
      if (!result?.feasible) return null;
      const lineup = optimizer.extractLineupFromSolution(result, pool, ctx);
      return lineup?.isValid ? lineup : null;
    };

    if (!lookahead || rest <= 0) return run(buildModel(false));

    // Fast path: the lookahead variables make the MIP several times slower, and most
    // solves don't need them. Solve without, then check the rest of the batch is still
    // feasible (LP with this lineup fixed); only re-solve with lookahead if it isn't.
    const fast = run(buildModel(false));
    if (fast && restStillFeasible(fast)) return fast;
    return run(buildModel(true));

    function restStillFeasible(lineup) {
      const chosen = new Set(lineup.players.map((s) => Number(s.player.id)));
      const { model: check } = buildModel(true);
      Object.keys(check.constraints).forEach((name) => {
        if (!name.startsWith('player_')) return;
        check.constraints[name] = chosen.has(Number(name.slice(7))) ? { equal: 1 } : { max: 0 };
      });
      check.ints = {};
      return !!solve(check)?.feasible;
    }
  };

  for (let i = 0; i < N; i++) {
    // Most to least restrictive: lookahead + min schedule, lookahead + deadline-only mins,
    // then deadline-only mins without lookahead (still never exceeds a max)
    const lineup =
      solveOnce(i) ||
      solveOnce(i, { deadlineOnly: true }) ||
      solveOnce(i, { deadlineOnly: true, lookahead: false });
    if (!lineup) {
      warnings.push(`Lineup ${i + 1}: no feasible lineup under current exposure/uniqueness constraints; stopped at ${lineups.length}/${N}`);
      break;
    }
    lineup.lineupNumber = i + 1;
    lineup.analytics = optimizer.calculateLineupAnalytics(lineup, mode);
    lineups.push(lineup);
    recordLineup(state, lineup.players.map((s) => s.player.id), plan.teamOf);
  }

  plan.playerLimits.forEach((l, id) => {
    const used = state.playerCounts.get(id) || 0;
    if (lineups.length === N && used < l.minCount) {
      warnings.push(`Player ${id}: min exposure not met (${used}/${l.minCount})`);
    }
  });

  return {
    lineups,
    exposureStats: lineups.length > 1 ? optimizer.getExposureStats(lineups, pool) : null,
    exposureSummary: buildExposureSummary(lineups, pool, plan),
    warnings,
    settings: {
      mode,
      site: site.key,
      numLineups: lineups.length,
      requestedLineups: N,
      maxExposure: config.maxExposure,
      minUniqueness: config.minUniqueness,
      randomness: config.randomness,
      executionTime: ((Date.now() - startTime) / 1000).toFixed(2),
    },
  };
}
