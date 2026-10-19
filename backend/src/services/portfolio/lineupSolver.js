/**
 * FAST LINEUP SOLVER (DK NBA classic)
 *
 * Max-projection lineup under the salary cap via k-dominance pruning + local search
 * (best-improvement 1-swaps, then 2-swaps, from a couple of starts). Roster rules come
 * from the DraftKings site config so slot eligibility matches the ILP optimizer exactly; this
 * exists because the ILP takes seconds-to-minutes per solve, and a portfolio build
 * needs thousands of solves (candidate pool + per-iteration optimal lineups).
 */

import { getSiteConfig, getEligibleSlots } from '../../config/sites.js';

const DK = getSiteConfig('draftkings');
export const SALARY_CAP = DK.salaryCap;
export const ROSTER_SLOTS = DK.rosterSlots.map((s) => s.slot);
export const ROSTER_SIZE = ROSTER_SLOTS.length;

const MIN_SALARY_PENALTY = 0.05; // projected pts per $ below minSalary
const EPS = 1e-9;

/** Bitmask of roster slots a DK position string ("PG/SG", "SF,PF") can fill. */
export function slotMask(position) {
  let mask = 0;
  for (const slot of getEligibleSlots('draftkings', position)) {
    const i = ROSTER_SLOTS.indexOf(slot);
    if (i >= 0) mask |= 1 << i;
  }
  return mask;
}

// Shared scratch for the matching hot path (solver runs single-threaded per worker)
const owner = new Int8Array(ROSTER_SIZE);
let seen = 0;
let curMasks = null;

function place(j) {
  const m = curMasks[j];
  for (let s = 0; s < ROSTER_SIZE; s++) {
    const bit = 1 << s;
    if (!(m & bit) || seen & bit) continue;
    seen |= bit;
    if (owner[s] === -1 || place(owner[s])) {
      owner[s] = j;
      return true;
    }
  }
  return false;
}

/** True if every player (by slot mask) can be given a distinct eligible slot (Kuhn's algorithm). */
export function canMatch(masks, count = masks.length) {
  owner.fill(-1);
  curMasks = masks;
  for (let j = 0; j < count; j++) {
    seen = 0;
    if (!place(j)) return false;
  }
  return true;
}

/**
 * Bipartite matching of players (by mask) to slots.
 * @returns {Int8Array|null} slotOwner[slot] = position in `masks` (or -1), null if some player can't be placed
 */
export function matchSlots(masks, count = masks.length) {
  return canMatch(masks, count) ? Int8Array.from(owner) : null;
}

/**
 * Precompute per-player arrays for repeated solves on one slate.
 * @param {object[]} players - rows with salary + position
 */
export function createSolverContext(players, { salaryCap = SALARY_CAP, minSalary = 0, locked = [] } = {}) {
  const n = players.length;
  const salary = new Int32Array(n);
  const mask = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    salary[i] = Math.round(Number(players[i].salary) || 0);
    mask[i] = slotMask(players[i].position);
  }
  // `proj` is a scratch copy of each solve's objective: keeps the hot loops monomorphic
  // whether callers pass Float64Arrays, Float32Array views or plain arrays.
  return { n, salary, mask, salaryCap, minSalary, locked: [...locked], proj: new Float64Array(n) };
}

/** Candidates that could appear in an optimal lineup: drop players dominated by >= ROSTER_SIZE others. */
function prunedCandidates(ctx, proj, allowed, lockedSet) {
  const { n, salary, mask } = ctx;
  const base = [];
  for (let i = 0; i < n; i++) {
    if (lockedSet.has(i)) continue;
    if (allowed && !allowed[i]) continue;
    if (!(proj[i] > 0) || mask[i] === 0) continue;
    base.push(i);
  }
  const keep = [];
  for (const p of base) {
    let dominated = 0;
    for (const q of base) {
      if (q === p) continue;
      if (proj[q] < proj[p] || salary[q] > salary[p] || (mask[q] & mask[p]) !== mask[p]) continue;
      // Exact ties: lower index wins so twins don't eliminate each other
      if (proj[q] === proj[p] && salary[q] === salary[p] && mask[q] === mask[p] && q > p) continue;
      if (++dominated >= ROSTER_SIZE) break;
    }
    if (dominated < ROSTER_SIZE) keep.push(p);
  }
  return keep;
}

/**
 * Solve one lineup.
 * @param ctx - from createSolverContext
 * @param objective - per-player values to maximize (array-like, length ctx.n)
 * @param opts - { allowed?: Uint8Array (0 = excluded), rng?: {uniform}, restarts=2, kicks=0 }
 *   restarts: greedy starts (by projection, by value, then randomized); kicks: perturb-and-reclimb rounds
 * @returns {{players: number[], salary: number, value: number}|null}
 *   players[k] fills ROSTER_SLOTS[k]
 */
export function solveLineup(ctx, objective, { allowed = null, rng = null, restarts = 2, kicks = 0 } = {}) {
  const { salary, mask, salaryCap, minSalary, proj } = ctx;
  for (let i = 0; i < ctx.n; i++) proj[i] = objective[i];
  const lockedSet = new Set(ctx.locked);
  if (lockedSet.size > ROSTER_SIZE) return null;
  const cands = prunedCandidates(ctx, proj, allowed, lockedSet);
  if (cands.length + lockedSet.size < ROSTER_SIZE) return null;

  let minCandSalary = Infinity;
  for (const c of cands) if (salary[c] < minCandSalary) minCandSalary = salary[c];

  const scoreOf = (value, sal) => value - MIN_SALARY_PENALTY * Math.max(0, minSalary - sal);
  const masksOf = (lineup) => Uint8Array.from(lineup, (i) => mask[i]); // typed, like the field sampler: keeps canMatch monomorphic

  const build = (order) => buildFrom([...lockedSet], order);
  const buildFrom = (lineup, order) => {
    let sal = lineup.reduce((s, i) => s + salary[i], 0);
    if (!canMatch(masksOf(lineup))) return null;
    for (const c of order) {
      if (lineup.length === ROSTER_SIZE) break;
      const left = ROSTER_SIZE - lineup.length - 1;
      if (sal + salary[c] + left * minCandSalary > salaryCap) continue;
      lineup.push(c);
      if (!canMatch(masksOf(lineup))) {
        lineup.pop();
        continue;
      }
      sal += salary[c];
    }
    return lineup.length === ROSTER_SIZE ? lineup : null;
  };

  // Candidates in descending projection order so both swap loops can stop at the value bound
  // (objective <= raw value since the min-salary penalty is >= 0).
  const byProj = [...cands].sort((x, y) => proj[y] - proj[x] || x - y);
  const inLineup = new Uint8Array(ctx.n);

  const improve = (lineup) => {
    inLineup.fill(0);
    for (const i of lineup) inLineup[i] = 1;
    let sal = lineup.reduce((s, i) => s + salary[i], 0);
    let value = lineup.reduce((s, i) => s + proj[i], 0);
    const trial = masksOf(lineup);
    const mv = lineup.map((_, k) => k).filter((k) => !lockedSet.has(lineup[k]));
    const swapIn = (slot, x) => {
      inLineup[lineup[slot]] = 0;
      sal += salary[x] - salary[lineup[slot]];
      value += proj[x] - proj[lineup[slot]];
      lineup[slot] = x;
      trial[slot] = mask[x];
      inLineup[x] = 1;
    };

    for (let guard = 0; guard < 200; guard++) {
      let best = null;
      let bestObj = scoreOf(value, sal) + EPS;
      // ---- 1-swaps ----
      for (const a of mv) {
        const out = lineup[a];
        const baseVal = value - proj[out];
        const baseSal = sal - salary[out];
        for (const x of byProj) {
          if (baseVal + proj[x] <= bestObj) break;
          if (inLineup[x] || baseSal + salary[x] > salaryCap) continue;
          const nObj = scoreOf(baseVal + proj[x], baseSal + salary[x]);
          if (nObj <= bestObj) continue;
          trial[a] = mask[x];
          if (canMatch(trial)) {
            best = [a, x];
            bestObj = nObj;
          }
          trial[a] = mask[out];
        }
      }
      if (best) {
        swapIn(best[0], best[1]);
        continue;
      }
      // ---- 2-swaps ----
      for (let ia = 0; ia < mv.length; ia++) {
        for (let ib = ia + 1; ib < mv.length; ib++) {
          const a = mv[ia];
          const b = mv[ib];
          const baseSal = sal - salary[lineup[a]] - salary[lineup[b]];
          const baseVal = value - proj[lineup[a]] - proj[lineup[b]];
          for (let ix = 0; ix < byProj.length - 1; ix++) {
            const x = byProj[ix];
            if (baseVal + proj[x] + proj[byProj[ix + 1]] <= bestObj) break;
            if (inLineup[x] || baseSal + salary[x] + minCandSalary > salaryCap) continue;
            for (let iy = ix + 1; iy < byProj.length; iy++) {
              const y = byProj[iy];
              if (baseVal + proj[x] + proj[y] <= bestObj) break;
              if (inLineup[y]) continue;
              const nSal = baseSal + salary[x] + salary[y];
              if (nSal > salaryCap) continue;
              const nObj = scoreOf(baseVal + proj[x] + proj[y], nSal);
              if (nObj <= bestObj) continue;
              const ma = trial[a];
              const mb = trial[b];
              trial[a] = mask[x];
              trial[b] = mask[y];
              if (canMatch(trial)) {
                best = [a, x, b, y];
                bestObj = nObj;
              }
              trial[a] = ma;
              trial[b] = mb;
            }
          }
        }
      }
      if (!best) break;
      swapIn(best[0], best[1]);
      swapIn(best[2], best[3]);
    }
    return { lineup, sal, value, obj: scoreOf(value, sal) };
  };

  const byValue = [...cands].sort((x, y) => proj[y] / salary[y] - proj[x] / salary[x] || x - y);
  const starts = [byProj, byValue];
  for (let r = 2; r < restarts; r++) {
    const rand = rng ? rng.uniform : Math.random;
    starts.push(
      cands
        .map((c) => [c, proj[c] * (0.6 + 0.8 * rand())])
        .sort((x, y) => y[1] - x[1])
        .map(([c]) => c)
    );
  }

  let best = null;
  for (const order of starts.slice(0, Math.max(1, restarts))) {
    const start = build(order);
    if (!start) continue;
    const res = improve(start);
    if (!best || res.obj > best.obj + EPS) best = res;
  }
  if (!best) {
    // Tight cap: start from the cheapest valid roster and climb from there
    const start = build([...cands].sort((x, y) => salary[x] - salary[y] || proj[y] - proj[x]));
    if (start) best = improve(start);
  }
  // Iterated local search: knock out a few players from the incumbent and re-climb
  const rand = rng ? rng.uniform : Math.random;
  for (let k = 0; best && k < kicks; k++) {
    const lineup = [...best.lineup];
    const free = lineup.map((_, i) => i).filter((i) => !lockedSet.has(lineup[i]));
    const drop = new Set();
    while (drop.size < Math.min(3, free.length)) drop.add(free[Math.floor(rand() * free.length)]);
    const kept = lineup.filter((_, i) => !drop.has(i));
    const pool = cands.filter((c) => !kept.includes(c) && !best.lineup.includes(c));
    const order = pool
      .map((c) => [c, (proj[c] / salary[c]) * (0.5 + rand())])
      .sort((x, y) => y[1] - x[1])
      .map(([c]) => c);
    const start = buildFrom(kept, order);
    if (!start) continue;
    const res = improve(start);
    if (res.obj > best.obj + EPS) best = res;
  }
  if (!best || best.sal < minSalary) return null;

  const slotOwner = matchSlots(masksOf(best.lineup));
  const players = Array.from(slotOwner, (j) => best.lineup[j]);
  return { players, salary: best.sal, value: best.value };
}

/** Order-independent key for a lineup (array of player indices). */
export function lineupKey(players) {
  return [...players].sort((a, b) => a - b).join(',');
}
