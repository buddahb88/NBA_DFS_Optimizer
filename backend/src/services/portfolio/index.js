/**
 * GPP PORTFOLIO BUILDER (pure, no DB access - runs inside a worker thread)
 *
 *   1. candidate pool  - optimal lineups against correlated sim draws (candidatePool.js)
 *   2. synthetic field - ownership-weighted, salary-realistic opponents (fieldGenerator.js)
 *   3. contest sim     - score pool + field each iteration, rank, pay out (contestSim.js)
 *   4. metrics         - ROI / win / top 1% / cash / dupes per lineup; optimal % vs ownership per player
 *   5. selection       - greedy by marginal ROI with self-competition, exposure + uniqueness caps
 */

import { runSimulation } from '../simulation/engine.js';
import { createRng, randomSeed } from '../simulation/rng.js';
import { createSolverContext, slotMask, ROSTER_SLOTS, ROSTER_SIZE, SALARY_CAP } from './lineupSolver.js';
import { generateCandidatePool } from './candidatePool.js';
import { resolveOwnership, generateField, createDupeModel, impliedLineupSalary, FIELD_DEFAULTS } from './fieldGenerator.js';
import { transposeScores, simulateContest, optimalRates } from './contestSim.js';
import { selectPortfolio } from './portfolioSelector.js';
import { scoreDistributions } from './scoreDistribution.js';
import { resolveContest, createPayoutLookup, CONTEST_PRESETS } from './payouts.js';

export { CONTEST_PRESETS };

export const LIMITS = {
  poolSize: { min: 10, max: 5000, default: 1000 },
  fieldSize: { min: 100, max: 20000, default: 5000 },
  iterations: { min: 100, max: 20000, default: 2000 },
  optimalIterations: { min: 0, max: 20000, default: 1000 }
};

const STAGES = [
  ['simulate', 0.04],
  ['pool', 0.2],
  ['field', 0.12],
  ['contest', 0.4],
  ['optimal', 0.14],
  ['select', 0.1]
];

const clampInt = (v, { min, max, default: d }) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d;
};
const num = (v, d) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};
const round = (v, dp = 2) => Math.round(v * 10 ** dp) / 10 ** dp + 0; // + 0 turns -0 into 0

/**
 * Validate and fill defaults. Throws on invalid input (callers map that to HTTP 400).
 */
export function normalizeOptions(raw = {}) {
  const contest = resolveContest(raw.contest ?? '20-max');
  const requested = raw.numLineups != null ? Math.floor(Number(raw.numLineups)) : contest.maxEntries;
  if (!(requested >= 1)) throw new Error('numLineups must be >= 1');
  const numLineups = Math.min(requested, contest.maxEntries);
  const poolSize = clampInt(raw.poolSize, LIMITS.poolSize);
  if (poolSize < numLineups) throw new Error('poolSize must be >= numLineups');
  const iterations = clampInt(raw.iterations, LIMITS.iterations);

  const asList = (v) => (Array.isArray(v) ? v : []);
  const asObj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
  const field = asObj(raw.field);

  return {
    contest,
    numLineups,
    poolSize,
    fieldSize: clampInt(raw.fieldSize, LIMITS.fieldSize),
    iterations,
    optimalIterations: Math.min(iterations, clampInt(raw.optimalIterations, LIMITS.optimalIterations)),
    seed: raw.seed ?? randomSeed(),
    randomness: Math.min(1, Math.max(0, num(raw.randomness, 0.6))),
    minSalary: Math.min(SALARY_CAP, Math.max(0, num(raw.minSalary, 49000))),
    lockedPlayers: asList(raw.lockedPlayers),
    excludedPlayers: asList(raw.excludedPlayers),
    ownership: asObj(raw.ownership),
    maxExposure: Math.min(100, Math.max(1, num(raw.maxExposure, numLineups <= 3 ? 100 : 60))),
    playerExposure: asObj(raw.playerExposure),
    minUnique: Math.min(ROSTER_SIZE, Math.max(0, Math.floor(num(raw.minUnique, numLineups > 1 ? 2 : 0)))),
    poolMaxExposure: Math.min(100, Math.max(1, num(raw.poolMaxExposure, 100))),
    field: {
      meanLeftover: Math.max(1, num(field.meanLeftover, FIELD_DEFAULTS.meanLeftover)),
      maxLeftover: Math.max(0, num(field.maxLeftover, FIELD_DEFAULTS.maxLeftover)),
      calibrationRounds: Math.min(10, Math.max(1, Math.floor(num(field.calibrationRounds, FIELD_DEFAULTS.calibrationRounds)))),
      optimizedShare: Math.min(1, Math.max(0, num(field.optimizedShare, FIELD_DEFAULTS.optimizedShare))),
      optimizerNoise: Math.min(1, Math.max(0, num(field.optimizerNoise, FIELD_DEFAULTS.optimizerNoise)))
    },
    simConfig: asObj(raw.simConfig)
  };
}

/** Index players by id / player_id / name for request-supplied references. */
function indexPlayers(players) {
  const byRef = new Map();
  players.forEach((p, i) => {
    for (const k of [p.id, p.player_id, p.name]) {
      if (k != null && !byRef.has(String(k))) byRef.set(String(k), i);
    }
  });
  return (ref) => byRef.get(String(ref));
}

function playerOut(p, ownPct) {
  return {
    id: p.id,
    player_id: p.player_id,
    name: p.name,
    team: p.team,
    opponent: p.opponent,
    position: p.position,
    salary: Number(p.salary) || 0,
    projected_points: Number(p.projected_points) || 0,
    rostership: round(ownPct, 1)
  };
}

/**
 * Build a GPP portfolio.
 * @param {object[]} slatePlayers - slate player rows
 * @param {object} rawOptions - see normalizeOptions
 * @param {object} hooks - { historicalStats?: Map, onProgress?: ({stage, progress, message}) => void }
 */
export function buildPortfolio(slatePlayers, rawOptions = {}, { historicalStats, onProgress } = {}) {
  const t0 = Date.now();
  const opts = normalizeOptions(rawOptions);
  const { contest } = opts;
  const timings = {};

  let stageBase = 0;
  const progress = (stage, frac = 0, message) => {
    if (!onProgress) return;
    const weight = STAGES.find(([s]) => s === stage)?.[1] ?? 0;
    onProgress({ stage, progress: Math.min(0.999, stageBase + weight * Math.min(1, frac)), message });
  };
  const runStage = (stage, message, fn) => {
    progress(stage, 0, message);
    const start = Date.now();
    const out = fn((f) => progress(stage, f, message));
    timings[`${stage}Ms`] = Date.now() - start;
    stageBase += STAGES.find(([s]) => s === stage)[1];
    return out;
  };

  // ---- Eligible players (stable order -> reproducible for a given seed) ----
  const all = [...(slatePlayers || [])].sort((a, b) => (a.id ?? 0) - (b.id ?? 0));
  const refAll = indexPlayers(all);
  const excluded = new Set(opts.excludedPlayers.map(refAll).filter((i) => i !== undefined));
  const players = all.filter(
    (p, i) => !excluded.has(i) && Number(p.projected_points) > 0 && Number(p.salary) > 0 && slotMask(p.position) !== 0
  );
  if (players.length < ROSTER_SIZE * 2) throw new Error(`Not enough eligible players (${players.length})`);
  const ref = indexPlayers(players);
  const locked = [];
  for (const id of opts.lockedPlayers) {
    const i = ref(id);
    if (i === undefined) throw new Error(`Locked player ${id} is not eligible on this slate`);
    locked.push(i);
  }
  const playerMaxExposure = new Map();
  for (const [id, pct] of Object.entries(opts.playerExposure)) {
    const i = ref(id);
    if (i !== undefined && Number.isFinite(Number(pct))) playerMaxExposure.set(i, Math.min(100, Math.max(0, Number(pct))));
  }

  const P = players.length;
  const means = Float64Array.from(players, (p) => Number(p.projected_points) || 0);
  const { pct: ownPct, source: ownershipSource } = resolveOwnership(players, opts.ownership);

  // ---- 0. Simulations: one to score the contest, an independent one to seed the pool ----
  const { sims, poolSims } = runStage('simulate', 'Simulating player outcomes', () => {
    const base = { historicalStats, config: opts.simConfig };
    return {
      sims: runSimulation(players, { ...base, iterations: opts.iterations, seed: opts.seed }),
      poolSims: runSimulation(players, { ...base, iterations: opts.poolSize * 2, seed: `${opts.seed}:pool` })
    };
  });
  const N = sims.iterations;
  const T = transposeScores(sims);

  // ---- 1. Candidate pool ----
  const poolCtx = createSolverContext(players, { minSalary: opts.minSalary, locked });
  const pool = runStage('pool', 'Generating candidate lineups', (onP) =>
    generateCandidatePool(poolCtx, {
      size: opts.poolSize,
      means,
      samples: poolSims.scores,
      sampleCount: poolSims.iterations,
      randomness: opts.randomness,
      maxExposure: opts.poolMaxExposure,
      rng: createRng(`${opts.seed}:poolrng`),
      onProgress: onP
    })
  );
  if (pool.count < opts.numLineups) {
    throw new Error(`Only ${pool.count} valid candidate lineups could be built (need ${opts.numLineups}); relax locks/minSalary`);
  }
  const C = pool.count;

  // ---- 2. Field ----
  const fieldCtx = createSolverContext(players);
  const field = runStage('field', 'Building synthetic field', (onP) =>
    generateField(fieldCtx, ownPct, {
      size: opts.fieldSize,
      rng: createRng(`${opts.seed}:field`),
      ...opts.field,
      projections: means,
      onProgress: onP
    })
  );
  const dupeModel = createDupeModel(ownPct, field.lineups, opts.fieldSize, contest.contestSize);
  const dupeEstimates = new Float64Array(C);
  const dupes = new Int32Array(C);
  for (let c = 0; c < C; c++) {
    dupeEstimates[c] = dupeModel.estimate(pool.lineups.subarray(c * ROSTER_SIZE, (c + 1) * ROSTER_SIZE));
    dupes[c] = Math.round(dupeEstimates[c]);
  }

  // ---- 3. Contest sim ----
  const payout = createPayoutLookup(contest.payouts);
  const sim = runStage('contest', 'Simulating contest', (onP) =>
    simulateContest({
      T, P, N, pool: pool.lineups, C, field: field.lineups, F: opts.fieldSize, contest, payout, dupes,
      rng: createRng(`${opts.seed}:contest`),
      onProgress: onP
    })
  );

  // ---- 4. Optimal % (leverage) ----
  const optimal = runStage('optimal', 'Computing optimal rates', (onP) =>
    opts.optimalIterations > 0
      ? optimalRates(fieldCtx, T, P, N, { iterations: opts.optimalIterations, rng: createRng(`${opts.seed}:opt`), onProgress: onP })
      : { rates: new Float64Array(P), iterations: 0 }
  );

  // ---- 5. Portfolio selection ----
  const selection = runStage('select', 'Selecting portfolio', (onP) =>
    selectPortfolio({
      pool: pool.lineups,
      C,
      N,
      sim,
      payout,
      dupes,
      contest,
      numLineups: opts.numLineups,
      maxExposure: opts.maxExposure,
      playerMaxExposure,
      minUnique: opts.minUnique,
      locked: new Set(locked),
      onProgress: onP
    })
  );

  // ---- Assemble ----
  const fee = contest.entryFee;
  const candidateSummary = (c) => {
    const idx = Array.from(pool.lineups.subarray(c * ROSTER_SIZE, (c + 1) * ROSTER_SIZE));
    const meanPay = sim.sumPay[c] / N;
    let salary = 0;
    let projection = 0;
    let totalOwnership = 0;
    for (const i of idx) {
      salary += Number(players[i].salary) || 0;
      projection += means[i];
      totalOwnership += ownPct[i];
    }
    return {
      candidate: c,
      playerIds: idx.map((i) => players[i].id),
      salary,
      projection: round(projection),
      totalOwnership: round(totalOwnership, 1),
      dupes: round(dupeEstimates[c]),
      meanScore: round(sim.sumScore[c] / N),
      meanPayout: round(meanPay),
      roi: round((meanPay - fee) / fee, 4),
      payoutStdev: round(Math.sqrt(Math.max(0, sim.sumPaySq[c] / N - meanPay ** 2))),
      winRate: round(sim.wins[c] / N, 5),
      top1Rate: round(sim.top1[c] / N, 5),
      cashRate: round(sim.cashes[c] / N, 4)
    };
  };

  const portfolioCounts = new Float64Array(P);
  const lineups = selection.selected.map((c, k) => {
    const idx = pool.lineups.subarray(c * ROSTER_SIZE, (c + 1) * ROSTER_SIZE);
    for (const i of idx) portfolioCounts[i]++;
    const summary = candidateSummary(c);
    const inPortfolio = selection.perLineupMeanPayout.get(c);
    return {
      lineupNumber: k + 1,
      players: Array.from(idx, (i, s) => ({ position: ROSTER_SLOTS[s], player: playerOut(players[i], ownPct[i]) })),
      totalSalary: summary.salary,
      projectedPoints: summary.projection,
      remainingSalary: SALARY_CAP - summary.salary,
      isValid: true,
      metrics: {
        ...summary,
        marginalProfit: round(selection.marginal[k]),
        portfolioMeanPayout: round(inPortfolio),
        portfolioRoi: round((inPortfolio - fee) / fee, 4)
      }
    };
  });

  const entries = lineups.length;
  const scoreDistribution = scoreDistributions(
    T, P, N,
    selection.selected.map((c) => pool.lineups.subarray(c * ROSTER_SIZE, (c + 1) * ROSTER_SIZE))
  );
  const playersOut = players
    .map((p, i) => {
      const optimalRate = optimal.rates[i] * 100;
      return {
        ...playerOut(p, ownPct[i]),
        ownership: round(ownPct[i], 1),
        optimalRate: round(optimalRate, 1),
        leverage: round(optimalRate - ownPct[i], 1),
        fieldExposure: round(field.exposure[i], 1),
        poolExposure: round(pool.exposure[i], 1),
        portfolioExposure: entries ? round((portfolioCounts[i] / entries) * 100, 1) : 0
      };
    })
    .sort((a, b) => b.leverage - a.leverage);

  const sortedSalaries = Int32Array.from(field.salaries).sort();
  let fieldMeanProjection = 0;
  for (let k = 0; k < field.lineups.length; k++) fieldMeanProjection += means[field.lineups[k]];
  fieldMeanProjection /= opts.fieldSize;
  const q = (f) => sortedSalaries[Math.min(sortedSalaries.length - 1, Math.floor(f * sortedSalaries.length))];
  const candidates = Array.from({ length: C }, (_, c) => candidateSummary(c)).sort((a, b) => b.roi - a.roi);

  timings.totalMs = Date.now() - t0;
  return {
    seed: opts.seed,
    contest: {
      name: contest.name,
      label: contest.label,
      contestSize: contest.contestSize,
      entryFee: contest.entryFee,
      maxEntries: contest.maxEntries,
      prizePool: contest.prizePool,
      paidPlaces: contest.payouts.length,
      topPayouts: Array.from(contest.payouts.subarray(0, 10))
    },
    settings: {
      numLineups: opts.numLineups,
      poolSize: opts.poolSize,
      fieldSize: opts.fieldSize,
      iterations: N,
      optimalIterations: optimal.iterations,
      randomness: opts.randomness,
      minSalary: opts.minSalary,
      maxExposure: opts.maxExposure,
      minUnique: opts.minUnique,
      lockedPlayers: locked.map((i) => players[i].id),
      excludedPlayers: [...excluded].map((i) => all[i].id)
    },
    timings,
    portfolio: {
      lineups,
      metrics: selection.metrics,
      scoreDistribution,
      warnings:
        entries < opts.numLineups
          ? [`Only ${entries}/${opts.numLineups} lineups satisfied exposure/uniqueness limits; loosen maxExposure or minUnique`]
          : []
    },
    players: playersOut,
    field: {
      size: opts.fieldSize,
      ownershipSource,
      // ~49.5k-50k for a consistent ownership projection; far above the cap means the field can't match it
      ownershipImpliedSalary: Math.round(impliedLineupSalary(ownPct, players.map((p) => Number(p.salary) || 0))),
      calibrationError: round(field.calibrationError, 2),
      optimizedShare: opts.field.optimizedShare,
      optimizedLineups: field.optimizedCount,
      meanProjection: round(fieldMeanProjection, 1),
      salary: { p10: q(0.1), p50: q(0.5), p90: q(0.9), atCapRate: round(sortedSalaries.filter((s) => s === SALARY_CAP).length / sortedSalaries.length, 3) },
      duplicatePairs: dupeModel.fieldDuplicatePairs,
      dupeModelScale: round(dupeModel.scale, 3)
    },
    pool: { size: C, attempts: pool.attempts },
    candidates
  };
}
