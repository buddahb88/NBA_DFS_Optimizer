/**
 * GPP SIMULATION MODE (pure, no DB access - runs inside a worker thread)
 *
 * Picks lineups the way the 10/20-11/7 backtests found best (18 DK main slates, 14k field):
 * the lineup with the highest simulated WIN RATE, not max projection (which it beat on
 * every run) and not a smooth payout EV (more stable but ~4 pts/slate worse, drifts to chalk).
 *
 *   1. outcomes   - own-model blend per player: mean = blend_point / p_play if he plays,
 *                   split-normal from blend_p10 / blend_p90, DNP with 1 - p_play;
 *                   z = 0.30 game + 0.15 team + 0.942 own (correlated nights)
 *   2. candidates - pooled over several seeds: the most frequent optimal lineups on
 *                   simulated nights, perturbed builds (0.5 proj + 0.5 night), max projection
 *                   and 0.8 proj + 0.2 p90 (lineupSolver.js)
 *   3. field      - ownership-weighted valid lineups over the slate-size salary floor and
 *                   projection threshold (fieldGenerator.generateRuleField)
 *   4. contest    - every candidate on the SAME nights (common random numbers), contest
 *                   rank from contestSim.simulateContest's contest-size rank sampling, with one
 *                   rank draw per night shared by all candidates (sharedRankLuck)
 *   5. pick       - win rate (then top 1%, cash, lower ownership); multi-entry takes the
 *                   next best win rates that share at most `maxOverlap` players with each pick
 *
 * Options (normalizeGppSimOptions): contestSize, entries, mode, chalkCap (at most 1 of the
 * 3 highest-owned on 4-7 games, 0 on 8+), cheapMinutesFloor (no under-$5K player projected
 * under 20 min in our lineups). Ruled-out players (player.out) are removed from our pool AND
 * from the field (real entrants swap late scratches).
 */

import { createRng } from '../simulation/rng.js';
import { createSolverContext, solveLineup, lineupKey, slotMask, ROSTER_SLOTS, ROSTER_SIZE } from './lineupSolver.js';
import { fieldRulesFor, generateRuleField, resolveOwnership, createDupeModel } from './fieldGenerator.js';
import { simulateContest } from './contestSim.js';
import { resolveContest, createPayoutLookup } from './payouts.js';

export const GPP_SIM_LIMITS = {
  contestSize: { min: 100, max: 500000, default: 14000 },
  entries: { min: 1, max: 150, default: 1 },
  evalNights: { min: 200, max: 20000, default: 6000 },
  fieldSize: { min: 500, max: 20000, default: 6000 },
  seeds: { min: 1, max: 12, default: 4 },
  optNights: { min: 10, max: 1000, default: 100 },
  maxOverlap: { min: 0, max: 7, default: 5 }
};

// Correlation weights (sum of squares = 1)
export const CORRELATION = { game: 0.3, team: 0.15, own: 0.942 };
const Z10 = 1.2816; // standard normal 90th percentile
const MIN_SD = 2;
const DEFAULT_P_PLAY = 0.97;
const MIN_P_PLAY = 0.5;
/** Cheap-player minutes floor: under this salary, projected minutes below MIN_MINUTES are excluded. */
export const CHEAP_FLOOR = { salary: 5000, minutes: 20 };
/** Single-entry contests at or under this size: fields are sharper than modeled. */
export const SMALL_SINGLE_ENTRY = 10000;

const STAGES = [
  ['simulate', 0.08],
  ['candidates', 0.42],
  ['field', 0.12],
  ['contest', 0.33],
  ['select', 0.05]
];

const clampInt = (v, { min, max, default: d }) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d;
};
const bool = (v) => v === true || v === 'true' || v === 1 || v === '1';
const round = (v, dp = 2) => (Number.isFinite(v) ? Math.round(v * 10 ** dp) / 10 ** dp + 0 : null);

/** Validate and fill defaults. Throws on invalid input (callers map that to HTTP 400). */
export function normalizeGppSimOptions(raw = {}) {
  const mode = raw.mode ?? (Number(raw.entries) > 1 ? 'multi' : 'single');
  if (!['single', 'multi'].includes(mode)) throw new Error('mode must be single or multi');
  if (raw.entries != null && !(Math.floor(Number(raw.entries)) >= 1)) throw new Error('entries must be >= 1');
  const contestSize = clampInt(raw.contestSize, GPP_SIM_LIMITS.contestSize);
  const entries = mode === 'single' ? 1 : Math.min(contestSize - 1, clampInt(raw.entries ?? 2, GPP_SIM_LIMITS.entries));
  const asList = (v) => (Array.isArray(v) ? v.map(String) : []);
  // More entries need a bigger candidate pool to stay distinct
  const seedsDefault = Math.min(GPP_SIM_LIMITS.seeds.max, GPP_SIM_LIMITS.seeds.default + Math.floor(entries / 10));
  return {
    contestSize,
    entries,
    mode,
    chalkCap: bool(raw.chalkCap),
    cheapMinutesFloor: bool(raw.cheapMinutesFloor),
    atLock: bool(raw.atLock),
    maxOverlap: clampInt(raw.maxOverlap, GPP_SIM_LIMITS.maxOverlap),
    evalNights: clampInt(raw.evalNights, GPP_SIM_LIMITS.evalNights),
    fieldSize: clampInt(raw.fieldSize, GPP_SIM_LIMITS.fieldSize),
    seeds: clampInt(raw.seeds ?? seedsDefault, GPP_SIM_LIMITS.seeds),
    optNights: clampInt(raw.optNights, GPP_SIM_LIMITS.optNights),
    seed: raw.seed != null && raw.seed !== '' ? String(raw.seed) : 'gpp-sim',
    excludedPlayers: asList(raw.excludedPlayers),
    ruledOut: asList(raw.ruledOut)
  };
}

/** At most this many of the slate's 3 highest-owned players per lineup; null = no cap (<= 3 games). */
export function chalkCapFor(games) {
  if (games <= 3) return null;
  return games <= 7 ? 1 : 0;
}

/** True when the cheap-player minutes floor removes this player from our lineups (unknown minutes: kept). */
export function failsCheapFloor(p) {
  if (p.minutes === null || p.minutes === undefined || p.minutes === '') return false;
  const minutes = Number(p.minutes);
  return Number(p.salary) < CHEAP_FLOOR.salary && Number.isFinite(minutes) && minutes < CHEAP_FLOOR.minutes;
}

const gameKey = (p) => [p.team, p.opponent].map((t) => String(t ?? '')).sort().join('-');

/**
 * Slate players -> the sim's arrays. Players kept: projected > 0, salary > 0, a DK position,
 * not ruled out (`out`). Input fields: id, name, team, opponent, position, salary,
 * proj (blend_point), p10, p90, pPlay, own (ownership %), minutes, out.
 */
export function prepareSimPlayers(rawPlayers) {
  const players = [...rawPlayers]
    .filter((p) => !p.out && Number(p.proj) > 0 && Number(p.salary) > 0 && slotMask(p.position) !== 0)
    .sort((a, b) => String(a.id).localeCompare(String(b.id), undefined, { numeric: true }));
  const P = players.length;
  const mean = new Float64Array(P);
  const sdLo = new Float64Array(P);
  const sdHi = new Float64Array(P);
  const pPlay = new Float64Array(P);
  const proj = new Float64Array(P);
  const p90 = new Float64Array(P);
  const own = new Float64Array(P);
  const games = [];
  const teams = [];
  const gi = new Int32Array(P);
  const ti = new Int32Array(P);
  players.forEach((p, i) => {
    const pp = Math.min(1, Math.max(MIN_P_PLAY, Number(p.pPlay) > 0 ? Number(p.pPlay) : DEFAULT_P_PLAY));
    const m = Number(p.proj) / pp;
    const lo = Math.max(0, Number.isFinite(Number(p.p10)) && p.p10 != null ? Number(p.p10) : m * 0.6);
    const hi = Number.isFinite(Number(p.p90)) && p.p90 != null ? Number(p.p90) : m * 1.4;
    pPlay[i] = pp;
    mean[i] = m;
    sdLo[i] = Math.max(MIN_SD, (m - lo) / Z10);
    sdHi[i] = Math.max(MIN_SD, (hi - m) / Z10);
    proj[i] = Number(p.proj);
    p90[i] = hi;
    own[i] = Math.max(0, Number(p.own) || 0);
    const g = gameKey(p);
    if (!games.includes(g)) games.push(g);
    if (!teams.includes(p.team)) teams.push(p.team);
    gi[i] = games.indexOf(g);
    ti[i] = teams.indexOf(p.team);
  });
  return { players, P, mean, sdLo, sdHi, pPlay, proj, p90, own, gi, ti, games, teams, G: games.length };
}

/**
 * One correlated night into `out` (length P): DNP with 1 - p_play, else
 * max(0, mean + z * sd) with sd = sdLo below the mean and sdHi above.
 */
export function sampleNight(sim, rng, out) {
  const { P, mean, sdLo, sdHi, pPlay, gi, ti } = sim;
  const gz = sim.gz ?? (sim.gz = new Float64Array(sim.G));
  const tz = sim.tz ?? (sim.tz = new Float64Array(sim.teams.length));
  for (let g = 0; g < gz.length; g++) gz[g] = rng.normal();
  for (let t = 0; t < tz.length; t++) tz[t] = rng.normal();
  for (let i = 0; i < P; i++) {
    if (rng.uniform() > pPlay[i]) {
      out[i] = 0;
      continue;
    }
    const z = CORRELATION.game * gz[gi[i]] + CORRELATION.team * tz[ti[i]] + CORRELATION.own * rng.normal();
    out[i] = Math.max(0, mean[i] + z * (z < 0 ? sdLo[i] : sdHi[i]));
  }
  return out;
}

/** N nights, iteration-major (T[n * P + i]) like contestSim.transposeScores. */
export function simulateNights(sim, N, rng, onProgress) {
  const T = new Float32Array(N * sim.P);
  const row = new Float64Array(sim.P);
  for (let n = 0; n < N; n++) {
    sampleNight(sim, rng, row);
    T.set(row, n * sim.P);
    if (onProgress && n % 500 === 499) onProgress((n + 1) / N);
  }
  return T;
}

/**
 * Lineup solver honoring the chalk cap ("at most `cap` of `chalk`"): the best of the
 * solves that each allow only one admissible subset of the chalk players.
 */
export function createCappedSolver(ctx, { allowed, chalk = [], cap = null, rng, kicks = 4 }) {
  const variants = [];
  if (cap == null || chalk.length <= cap) variants.push(allowed);
  else {
    const subsets = [[]];
    if (cap >= 1) chalk.forEach((c) => subsets.push([c]));
    if (cap >= 2) chalk.forEach((a, i) => chalk.slice(i + 1).forEach((b) => subsets.push([a, b])));
    for (const keep of subsets) {
      const a = Uint8Array.from(allowed);
      for (const c of chalk) if (!keep.includes(c)) a[c] = 0;
      variants.push(a);
    }
  }
  return (objective) => {
    let best = null;
    for (const a of variants) {
      const res = solveLineup(ctx, objective, { allowed: a, rng, kicks });
      if (res && (!best || res.value > best.value + 1e-9)) best = res;
    }
    return best;
  };
}

/**
 * Candidate pool pooled across `seeds` independent seeds. Seed 0 runs 2x the nights and
 * keeps 2x the top lineups (as mc_stable.mjs). Returns { list: [{players, tags:Set, seeds:Set}] }.
 */
export function generateCandidates(sim, solve, opts) {
  const { seeds, optNights, seed, onProgress } = opts;
  const topKeep = opts.topKeep ?? 60;
  const perturbed = opts.perturbed ?? 20;
  const byKey = new Map();
  const add = (res, tag, k) => {
    if (!res) return null;
    const key = lineupKey(res.players);
    if (!byKey.has(key)) byKey.set(key, { players: res.players, tags: new Set(), seeds: new Set() });
    const c = byKey.get(key);
    c.tags.add(tag);
    if (k != null) c.seeds.add(k);
    return key;
  };
  add(solve(sim.proj), 'maxProjection', null);
  add(solve(Array.from(sim.proj, (v, i) => 0.8 * v + 0.2 * sim.p90[i])), 'proj80p90', null);

  const night = new Float64Array(sim.P);
  const obj = new Float64Array(sim.P);
  const totalWork = seeds * (optNights + perturbed) + optNights + perturbed;
  let done = 0;
  for (let k = 0; k < seeds; k++) {
    const rng = createRng(`${seed}:cand:${k}`);
    const nights = k === 0 ? optNights * 2 : optNights;
    const freq = new Map();
    for (let s = 0; s < nights; s++) {
      const res = solve(sampleNight(sim, rng, night));
      if (res) {
        const key = lineupKey(res.players);
        const f = freq.get(key);
        if (f) f.n++;
        else freq.set(key, { n: 1, res });
      }
      if (onProgress && ++done % 10 === 0) onProgress(done / totalWork);
    }
    [...freq.values()]
      .sort((a, b) => b.n - a.n)
      .slice(0, k === 0 ? topKeep * 2 : topKeep)
      .forEach((f) => add(f.res, 'simOptimal', k));
    const pert = k === 0 ? perturbed * 2 : perturbed;
    for (let s = 0; s < pert; s++) {
      sampleNight(sim, rng, night);
      for (let i = 0; i < sim.P; i++) obj[i] = 0.5 * sim.proj[i] + 0.5 * night[i];
      add(solve(obj), 'perturbed', k);
      if (onProgress && ++done % 10 === 0) onProgress(done / totalWork);
    }
  }
  return { list: [...byKey.values()] };
}

const overlap = (a, b) => {
  let n = 0;
  for (const x of a) if (b.includes(x)) n++;
  return n;
};

/** Win rate, then top 1%, then cash rate, then lower total ownership. */
export const byWinRate = (a, b) => b.wins - a.wins || b.top1 - a.top1 || b.cashes - a.cashes || a.ownership - b.ownership;

/**
 * Picks: the best win rate, then (multi-entry) the next best whose overlap with every
 * earlier pick is at most maxOverlap players.
 */
export function selectByWinRate(rows, entries, maxOverlap) {
  const ranked = [...rows].sort(byWinRate);
  const picks = [];
  for (const r of ranked) {
    if (picks.length >= entries) break;
    if (picks.every((p) => overlap(p.players, r.players) <= maxOverlap)) picks.push(r);
  }
  return { picks, ranked };
}

/**
 * Run the GPP sim.
 * @param rawPlayers - see prepareSimPlayers (ruled-out players carry out: true)
 * @param rawOptions - see normalizeGppSimOptions
 * @param hooks - { onProgress?: ({stage, progress, message}) => void }
 */
export function runGppSim(rawPlayers, rawOptions = {}, { onProgress } = {}) {
  const t0 = Date.now();
  const opts = normalizeGppSimOptions(rawOptions);
  const timings = {};
  const warnings = [];
  let stageBase = 0;
  const runStage = (stage, message, fn) => {
    const weight = STAGES.find(([s]) => s === stage)[1];
    const report = (f) => onProgress?.({ stage, progress: Math.min(0.999, stageBase + weight * Math.min(1, f)), message });
    report(0);
    const start = Date.now();
    const out = fn(report);
    timings[`${stage}Ms`] = Date.now() - start;
    stageBase += weight;
    return out;
  };

  // ---- Players ----
  const refOf = (p) => [p.id, p.player_id, p.name].filter((x) => x != null).map(String);
  const ruledOutRefs = new Set(opts.ruledOut);
  const input = (rawPlayers || []).map((p) => (refOf(p).some((r) => ruledOutRefs.has(r)) ? { ...p, out: true, outReason: p.outReason ?? 'ruled out' } : p));
  const sim = prepareSimPlayers(input);
  const { players, P, G } = sim;
  if (P < ROSTER_SIZE * 2) throw new Error(`Not enough playable players (${P})`);
  const ruledOut = input.filter((p) => p.out && Number(p.salary) > 0).map((p) => ({ id: p.id, name: p.name, team: p.team, reason: p.outReason ?? p.injury_status ?? 'OUT' }));

  // Our lineups: minus request exclusions and (optionally) the cheap minutes floor
  const excludedRefs = new Set(opts.excludedPlayers);
  const allowed = new Uint8Array(P).fill(1);
  const cheapExcluded = [];
  players.forEach((p, i) => {
    if (refOf(p).some((r) => excludedRefs.has(r))) allowed[i] = 0;
    if (opts.cheapMinutesFloor && failsCheapFloor(p)) {
      allowed[i] = 0;
      cheapExcluded.push(p.name);
    }
  });
  const chalk = [...players.keys()].sort((a, b) => sim.own[b] - sim.own[a] || a - b).slice(0, 3);
  const cap = opts.chalkCap ? chalkCapFor(G) : null;

  const ctx = createSolverContext(players);
  const solveRng = createRng(`${opts.seed}:solve`);
  const solve = createCappedSolver(ctx, { allowed, chalk, cap, rng: solveRng });
  const fieldMax = solveLineup(ctx, sim.proj, { rng: solveRng, kicks: 8 });
  if (!fieldMax) throw new Error('No valid lineup on this slate');

  // ---- 1. Evaluation nights (common to every candidate) ----
  const N = opts.evalNights;
  const T = runStage('simulate', 'Simulating player outcomes', (onP) => simulateNights(sim, N, createRng(`${opts.seed}:eval`), onP));

  // ---- 2. Candidates ----
  const cands = runStage('candidates', 'Building candidate lineups', (onP) =>
    generateCandidates(sim, solve, {
      seeds: opts.seeds,
      optNights: opts.optNights,
      seed: opts.seed,
      topKeep: Math.max(60, opts.entries * 3),
      perturbed: 20,
      onProgress: onP
    })
  );
  if (cands.list.length === 0) throw new Error('No valid candidate lineups (check exclusions / options)');
  // Max projection without the chalk cap, for the comparison (scored, never picked when it breaks the cap)
  const maxProjection = solveLineup(ctx, sim.proj, { allowed, rng: solveRng, kicks: 8 });
  const maxProjKey = maxProjection ? lineupKey(maxProjection.players) : null;
  if (maxProjection && !cands.list.some((c) => lineupKey(c.players) === maxProjKey)) {
    cands.list.push({ players: maxProjection.players, tags: new Set(['maxProjection']), seeds: new Set() });
  }
  const C = cands.list.length;
  const pool = new Uint16Array(C * ROSTER_SIZE);
  cands.list.forEach((c, k) => pool.set(c.players, k * ROSTER_SIZE));

  // ---- 3. Field ----
  const rules = fieldRulesFor(G);
  const minProjection = rules.frac * fieldMax.value;
  const field = runStage('field', 'Building the contest field', (onP) =>
    generateRuleField(ctx, {
      own: sim.own,
      proj: sim.proj,
      size: opts.fieldSize,
      rng: createRng(`${opts.seed}:field`),
      minSalary: rules.minSalary,
      minProjection,
      onProgress: onP
    })
  );
  if (field.count < Math.min(opts.fieldSize, 200)) {
    throw new Error(`Field sampler kept only ${field.count} lineups (threshold ${minProjection.toFixed(1)} pts, $${rules.minSalary}); check the slate`);
  }
  if (field.count < opts.fieldSize) warnings.push(`Field sampler kept ${field.count} of ${opts.fieldSize} lineups; ranks use that sample`);
  const F = field.count;

  // ---- 4. Contest (same nights for every candidate) ----
  const contest = resolveContest({ preset: '20-max', contestSize: opts.contestSize, maxEntries: Math.max(1, opts.entries), label: 'GPP sim' });
  const payout = createPayoutLookup(contest.payouts);
  const res = runStage('contest', 'Simulating the contest', (onP) =>
    simulateContest({
      T, P, N, pool, C, field: field.lineups, F, contest, payout, dupes: new Int32Array(C),
      rng: createRng(`${opts.seed}:rank`), sharedRankLuck: true, onProgress: onP
    })
  );

  // ---- 5. Pick ----
  const { pct: ownNorm } = resolveOwnership(players.map((p, i) => ({ ...p, rostership: sim.own[i] })));
  const dupeModel = createDupeModel(ownNorm, field.lineups, F, opts.contestSize);
  const rows = cands.list.map((c, k) => {
    let projection = 0;
    let ownership = 0;
    let salary = 0;
    for (const i of c.players) {
      projection += sim.proj[i];
      ownership += sim.own[i];
      salary += ctx.salary[i];
    }
    return {
      index: k,
      key: lineupKey(c.players),
      players: Array.from(c.players),
      tags: [...c.tags],
      seeds: c.seeds.size,
      wins: res.wins[k],
      top1: res.top1[k],
      cashes: res.cashes[k],
      meanScore: res.sumScore[k] / N,
      projection,
      ownership,
      salary,
      chalkCount: c.players.filter((i) => chalk.includes(i)).length
    };
  });
  const pickable = rows.filter((r) => cap == null || r.chalkCount <= cap);
  const { picks, ranked } = runStage('select', 'Picking lineups', () => selectByWinRate(pickable, opts.entries, opts.maxOverlap));
  if (picks.length < opts.entries) {
    warnings.push(`Only ${picks.length} of ${opts.entries} lineups share at most ${opts.maxOverlap} players with each other; raise the overlap cap or add seeds`);
  }
  const rankOf = new Map(ranked.map((r, k) => [r.key, k + 1]));
  const maxRow = maxProjKey ? rows.find((r) => r.key === maxProjKey) : null;

  const playerOut = (i) => {
    const p = players[i];
    return {
      id: p.id,
      player_id: p.player_id,
      name: p.name,
      team: p.team,
      opponent: p.opponent,
      position: p.position,
      salary: Number(p.salary) || 0,
      projected_points: round(sim.proj[i], 2),
      rostership: round(sim.own[i], 1),
      p_play: round(sim.pPlay[i], 3),
      minutes: round(Number(p.minutes), 1),
      injury_status: p.injury_status ?? null
    };
  };
  const metricsOf = (r) => ({
    winRate: round(r.wins / N, 5),
    top1Rate: round(r.top1 / N, 5),
    cashRate: round(r.cashes / N, 4),
    meanScore: round(r.meanScore, 1),
    projection: round(r.projection, 1),
    totalOwnership: round(r.ownership, 1),
    salary: r.salary,
    dupes: round(dupeModel.estimate(r.players), 2),
    seeds: r.seeds,
    rank: rankOf.get(r.key) ?? null,
    chalkPlayers: r.chalkCount,
    sources: r.tags
  });
  const lineupOut = (r) => ({
    players: r.players.map((i, s) => ({ position: ROSTER_SLOTS[s], player: playerOut(i) })),
    totalSalary: r.salary,
    projectedPoints: round(r.projection, 1),
    metrics: metricsOf(r)
  });
  const pct = (x) => `${(x * 100).toFixed(x < 0.01 ? 2 : 1)}%`;
  const whyOf = (r, k) => {
    const parts = [];
    parts.push(k === 0
      ? `Best simulated win rate (${pct(r.wins / N)}) of ${C} candidates on ${N.toLocaleString()} shared nights.`
      : `#${rankOf.get(r.key)} by win rate (${pct(r.wins / N)}), at most ${opts.maxOverlap} players shared with earlier picks.`);
    if (maxRow && maxRow.key === r.key) parts.push('It is also the max-projection lineup.');
    else if (maxRow) {
      parts.push(`Max projection wins ${pct(maxRow.wins / N)} (${maxRow.projection.toFixed(1)} proj vs ${r.projection.toFixed(1)}; ${maxRow.ownership.toFixed(0)}% vs ${r.ownership.toFixed(0)}% own).`);
    }
    const lev = r.players.filter((i) => sim.own[i] < 10).sort((a, b) => sim.proj[b] - sim.proj[a])[0];
    if (lev !== undefined) parts.push(`Leverage: ${players[lev].name} (${sim.own[lev].toFixed(1)}% own).`);
    if (r.seeds > 1) parts.push(`Found on ${r.seeds} of ${opts.seeds} seeds.`);
    return parts.join(' ');
  };

  const lineups = picks.map((r, k) => ({ lineupNumber: k + 1, ...lineupOut(r), isValid: true, why: whyOf(r, k) }));
  const caveat = opts.entries === 1 && opts.contestSize <= SMALL_SINGLE_ENTRY
    ? 'Small single-entry contest: single-entry fields are sharper than the modeled field, so the simulated win and cash rates are optimistic.'
    : null;
  let fieldOwn = 0;
  let fieldProj = 0;
  for (let k = 0; k < field.lineups.length; k++) fieldOwn += sim.own[field.lineups[k]];
  for (let f = 0; f < F; f++) fieldProj += field.projections[f];
  const sortedSal = Int32Array.from(field.salaries).sort();

  timings.totalMs = Date.now() - t0;
  return {
    kind: 'gpp-sim',
    seed: opts.seed,
    settings: {
      contestSize: opts.contestSize,
      entries: opts.entries,
      mode: opts.mode,
      chalkCap: opts.chalkCap,
      cheapMinutesFloor: opts.cheapMinutesFloor,
      atLock: opts.atLock,
      maxOverlap: opts.maxOverlap,
      evalNights: N,
      fieldSize: F,
      seeds: opts.seeds,
      optNights: opts.optNights
    },
    slate: {
      games: G,
      players: P,
      ruledOut,
      chalk: { cap, applied: cap != null, players: chalk.map((i) => ({ name: players[i].name, ownership: round(sim.own[i], 1) })) },
      cheapExcluded
    },
    lineups,
    maxProjection: maxRow ? { ...lineupOut(maxRow), why: 'Highest projected lineup (same options), for comparison.' } : null,
    field: {
      size: F,
      rules: { ...rules, minProjection: round(minProjection, 1), maxProjection: round(fieldMax.value, 1) },
      acceptRate: round(field.acceptRate, 6),
      meanProjection: round(fieldProj / F, 1),
      meanOwnership: round(fieldOwn / F, 1),
      salary: { p10: sortedSal[Math.floor(F * 0.1)], p50: sortedSal[Math.floor(F * 0.5)] }
    },
    contest: { contestSize: contest.contestSize, paidPlaces: contest.payouts.length, top1Places: Math.max(1, Math.floor(contest.contestSize * 0.01)) },
    candidates: ranked.slice(0, 200).map((r) => ({
      key: r.key,
      playerIds: r.players.map((i) => players[i].id),
      names: r.players.map((i) => players[i].name),
      ...metricsOf(r)
    })),
    candidateCount: C,
    caveat,
    warnings,
    timings
  };
}
