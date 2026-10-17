import { test } from 'vitest';
import assert from 'node:assert/strict';
import { createRng } from '../simulation/rng.js';
import { runSimulation } from '../simulation/engine.js';
import { createSolverContext, solveLineup, slotMask, matchSlots, ROSTER_SLOTS, SALARY_CAP } from './lineupSolver.js';
import { generatePayoutTable, payoutTableFromSpec, resolveContest, createPayoutLookup } from './payouts.js';
import { resolveOwnership, generateField, tiltToSalary, impliedLineupSalary } from './fieldGenerator.js';
import { transposeScores, simulateContest, sampleRank, countAbove, quickselect } from './contestSim.js';
import { selectPortfolio } from './portfolioSelector.js';
import { buildPortfolio, normalizeOptions } from './index.js';
import { scoreDistributions, niceBinWidth } from './scoreDistribution.js';

const POSITIONS = ['PG', 'SG', 'SF', 'PF', 'C', 'PG/SG', 'SG/SF', 'SF/PF', 'PF/C', 'PG'];

/** Synthetic slate with salary-consistent ownership (implied lineup salary ~$49.7k). */
function makeSlate({ games = 8, perTeam = 10, seed = 7 } = {}) {
  const rng = createRng(seed);
  const r = rng.uniform;
  const players = [];
  let id = 1;
  for (let g = 0; g < games; g++) {
    const total = 215 + r() * 25;
    const spread = (r() - 0.5) * 16;
    for (const [team, opp, sp] of [[`H${g}`, `A${g}`, -spread], [`A${g}`, `H${g}`, spread]]) {
      for (let k = 0; k < perTeam; k++) {
        const salary = Math.max(3000, Math.round((11000 - k * 850 + (r() - 0.5) * 1500) / 100) * 100);
        players.push({
          id: id++,
          player_id: `dk${id}`,
          name: `${team}-P${k}`,
          team,
          opponent: opp,
          position: POSITIONS[(k + g) % POSITIONS.length],
          salary,
          projected_points: Math.round((salary / 1000) * (4.6 + r() * 1.6) * (total / 228) * 10) / 10,
          projected_minutes: Math.max(8, 36 - k * 2.5),
          usage: Math.max(10, 30 - k * 1.8),
          vegas_over_under: total,
          vegas_spread: sp
        });
      }
    }
  }
  const raw = players.map((p) => p.projected_points * (p.projected_points / (p.salary / 1000)) ** 3 * (0.6 + r() * 0.8));
  const own = tiltToSalary(raw, players.map((p) => p.salary));
  players.forEach((p, i) => (p.rostership = Math.round(own[i] * 10) / 10));
  return players;
}

function bruteForceBest(ctx, proj) {
  let best = -Infinity;
  const pick = [];
  const rec = (start, sal) => {
    if (pick.length === 8) {
      const v = pick.reduce((s, i) => s + proj[i], 0);
      if (v > best && matchSlots(Uint8Array.from(pick, (i) => ctx.mask[i]))) best = v;
      return;
    }
    for (let i = start; i < ctx.n; i++) {
      if (sal + ctx.salary[i] > SALARY_CAP) continue;
      pick.push(i);
      rec(i + 1, sal + ctx.salary[i]);
      pick.pop();
    }
  };
  rec(0, 0);
  return best;
}

function assertValidLineup(players, ctx, { minSalary = 0 } = {}) {
  assert.equal(players.length, 8);
  assert.equal(new Set(players).size, 8, 'no duplicate players');
  players.forEach((p, slot) => assert.ok(ctx.mask[p] & (1 << slot), `player ${p} eligible for ${ROSTER_SLOTS[slot]}`));
  const sal = players.reduce((s, p) => s + ctx.salary[p], 0);
  assert.ok(sal <= SALARY_CAP && sal >= minSalary, `salary ${sal}`);
}

// ---------------------------------------------------------------- solver

test('slotMask follows DK eligibility (incl. slash and comma dual positions)', () => {
  const bits = (m) => ROSTER_SLOTS.filter((_, i) => m & (1 << i));
  assert.deepEqual(bits(slotMask('PG/SG')), ['PG', 'SG', 'G', 'UTIL']);
  assert.deepEqual(bits(slotMask('SF,PF')), ['SF', 'PF', 'F', 'UTIL']);
  assert.deepEqual(bits(slotMask('C')), ['C', 'UTIL']);
});

test('solveLineup matches brute force on small slates', () => {
  for (let seed = 1; seed <= 6; seed++) {
    const slate = makeSlate({ games: 1, perTeam: 9, seed });
    const ctx = createSolverContext(slate);
    const rng = createRng(seed);
    const proj = slate.map((p) => p.projected_points * (0.6 + 0.8 * rng.uniform()));
    const res = solveLineup(ctx, proj, { kicks: 16, rng });
    const best = bruteForceBest(ctx, proj);
    if (best === -Infinity) {
      assert.equal(res, null);
      continue;
    }
    assertValidLineup(res.players, ctx);
    assert.ok(Math.abs(res.value - best) < 1e-6, `seed ${seed}: ${res.value} vs optimum ${best}`);
  }
});

test('solveLineup honours locks, exclusions and min salary', () => {
  const slate = makeSlate();
  const locked = [3, 40];
  const ctx = createSolverContext(slate, { minSalary: 49500, locked });
  const allowed = new Uint8Array(slate.length).fill(1);
  allowed[0] = 0;
  allowed[1] = 0;
  const proj = slate.map((p) => p.projected_points);
  const res = solveLineup(ctx, proj, { allowed, kicks: 4 });
  assertValidLineup(res.players, ctx, { minSalary: 49500 });
  for (const l of locked) assert.ok(res.players.includes(l));
  assert.ok(!res.players.includes(0) && !res.players.includes(1));
});

// ---------------------------------------------------------------- payouts

test('generated payout tables sum to the prize pool and are top-heavy', () => {
  const t = generatePayoutTable({ contestSize: 10000, entryFee: 10, rake: 0.15, paidFraction: 0.2, firstPlaceShare: 0.12, minCashMultiple: 1.8 });
  const pool = 10000 * 10 * 0.85;
  assert.equal(t.length, 2000);
  assert.ok(Math.abs(t.reduce((s, v) => s + v, 0) - pool) < 5);
  assert.ok(Math.abs(t[0] / pool - 0.12) < 0.005);
  for (let r = 1; r < t.length; r++) assert.ok(t[r] <= t[r - 1] + 1e-9);
  assert.ok(Math.abs(t[t.length - 1] - 18) < 0.01);
});

test('custom payout tiers, presets and dupe splitting', () => {
  const table = payoutTableFromSpec([{ minRank: 1, payout: 100 }, { minRank: 2, maxRank: 3, payout: 40 }]);
  assert.deepEqual(Array.from(table), [100, 40, 40]);
  const c = resolveContest({ contestSize: 10, entryFee: 5, maxEntries: 2, payouts: [30, 10] });
  assert.equal(c.name, 'custom');
  assert.equal(c.prizePool, 40);
  const pay = createPayoutLookup(table);
  assert.equal(pay(0), 100);
  assert.equal(pay(0, 1), 70); // tie with one dupe: split 1st + 2nd
  assert.equal(pay(2, 3), 10); // 40 spread over 4 entrants
  assert.equal(pay(5), 0);
  assert.throws(() => resolveContest('9-max'), /Unknown contest preset/);
  assert.equal(resolveContest('150-max').maxEntries, 150);
});

// ---------------------------------------------------------------- ownership + field

test('ownership normalizes to 800% and estimates are salary-consistent', () => {
  const slate = makeSlate();
  const { pct, source } = resolveOwnership(slate);
  assert.equal(source, 'projected');
  assert.ok(Math.abs(pct.reduce((s, v) => s + v, 0) - 800) < 1e-6);

  const noOwn = slate.map(({ rostership, ...p }) => p);
  const est = resolveOwnership(noOwn);
  assert.equal(est.source, 'estimated');
  assert.ok(Math.abs(est.pct.reduce((s, v) => s + v, 0) - 800) < 1e-6);
  const implied = impliedLineupSalary(est.pct, noOwn.map((p) => p.salary));
  assert.ok(implied > 49000 && implied < 50500, `implied salary ${implied}`);

  const overridden = resolveOwnership(noOwn, { [slate[0].id]: 50 });
  assert.ok(overridden.pct[0] > 40, 'override applied');
});

test('synthetic field matches ownership and uses realistic salary', () => {
  const slate = makeSlate();
  const ctx = createSolverContext(slate);
  const { pct } = resolveOwnership(slate);
  const means = Float64Array.from(slate, (p) => p.projected_points);
  const field = generateField(ctx, pct, { size: 3000, rng: createRng(5), projections: means, optimizedShare: 0.3 });
  assert.equal(field.optimizedCount, 900);
  assert.ok(field.calibrationError < 1.5, `calibration error ${field.calibrationError}`);
  for (let f = 0; f < 3000; f++) {
    const players = Array.from(field.lineups.subarray(f * 8, f * 8 + 8));
    assert.equal(new Set(players).size, 8);
    assert.ok(matchSlots(Uint8Array.from(players, (i) => ctx.mask[i])));
    assert.ok(field.salaries[f] <= SALARY_CAP);
    if (f >= 900) assert.ok(field.salaries[f] >= SALARY_CAP - 2000, 'ownership-sampled lineups leave <= maxLeftover');
  }
  const median = Int32Array.from(field.salaries).sort()[1500];
  assert.ok(median >= 49500, `median salary ${median}`);
});

// ---------------------------------------------------------------- contest sim

test('quickselect / countAbove helpers', () => {
  const a = Float32Array.from([5, 1, 9, 3, 7, 2, 8]);
  quickselect(a, 4);
  const topThree = Array.from(a.subarray(4)).sort((x, y) => x - y);
  assert.deepEqual(topThree, [7, 8, 9]);
  assert.equal(countAbove(Float32Array.from([1, 2, 3, 4]), 2.5), 2);
  assert.equal(countAbove(Float32Array.from([1, 2, 3, 4]), 4), 0);
});

test('sampleRank reproduces fair odds for an exchangeable entry', () => {
  const rng = createRng(1);
  const F = 1000;
  const opponents = 9999;
  let wins = 0;
  let sumRank = 0;
  const draws = 40000;
  for (let k = 0; k < draws; k++) {
    if (sampleRank(0, F, opponents, rng) === 0) wins++;
    sumRank += sampleRank(99, F, opponents, rng);
  }
  // P(win | beat all F) = (F+1)/(F+M) and E[rank | 99 above] = opponents * 100/(F+2)
  assert.ok(Math.abs(wins / draws - 1001 / 11000) < 0.006, `win rate ${wins / draws}`);
  assert.ok(Math.abs(sumRank / draws / (opponents * (100 / 1002)) - 1) < 0.02);
});

test('lineups drawn like the field earn prize pool / entries (ROI = -rake)', () => {
  const slate = makeSlate();
  const P = slate.length;
  const ctx = createSolverContext(slate);
  const { pct } = resolveOwnership(slate);
  const C = 600;
  const F = 2000;
  const N = 300;
  const all = generateField(ctx, pct, { size: C + F, rng: createRng(3), optimizedShare: 0 });
  const sims = runSimulation(slate, { iterations: N, seed: 9 });
  const contest = resolveContest('single-entry');
  const sim = simulateContest({
    T: transposeScores(sims), P, N, pool: all.lineups.slice(0, C * 8), C, field: all.lineups.slice(C * 8), F,
    contest, payout: createPayoutLookup(contest.payouts), dupes: new Int32Array(C), rng: createRng(4)
  });
  const avgPay = sim.sumPay.reduce((s, v) => s + v, 0) / (C * N);
  const cashRate = sim.cashes.reduce((s, v) => s + v, 0) / (C * N);
  const fair = contest.prizePool / contest.contestSize;
  assert.ok(Math.abs(avgPay / fair - 1) < 0.08, `avg payout ${avgPay} vs fair ${fair}`);
  assert.ok(Math.abs(cashRate - contest.payouts.length / contest.contestSize) < 0.01, `cash rate ${cashRate}`);
});

// ---------------------------------------------------------------- selection

test('portfolio selection penalizes lineups that cash in the same sims', () => {
  // A and B win the same 10 iterations (B scores slightly lower); C wins 7 others.
  // Standalone B (EV 10) beats C (7), but next to A, B only gets 2nd place money (6).
  const N = 100;
  const sim = { sumPay: Float64Array.from([1000, 1000, 700]), itmIter: [[], [], []], itmRank: [[], [], []], itmScore: [[], [], []] };
  for (let i = 0; i < 10; i++) {
    sim.itmIter[0].push(i); sim.itmRank[0].push(0); sim.itmScore[0].push(300);
    sim.itmIter[1].push(i); sim.itmRank[1].push(0); sim.itmScore[1].push(299);
    if (i < 7) { sim.itmIter[2].push(10 + i); sim.itmRank[2].push(0); sim.itmScore[2].push(280); }
  }
  const pool = new Uint16Array(24);
  for (let c = 0; c < 3; c++) for (let k = 0; k < 8; k++) pool[c * 8 + k] = c * 8 + k; // disjoint rosters
  const contest = { entryFee: 1, contestSize: 1000, payouts: Float64Array.from([100, 60, 10]) };
  const res = selectPortfolio({
    pool, C: 3, N, sim, payout: (r) => [100, 60, 10][r] ?? 0, dupes: new Int32Array(3), contest, numLineups: 2
  });
  assert.deepEqual(res.selected, [0, 2]);
});

// ---------------------------------------------------------------- end to end

test('normalizeOptions validates and applies preset defaults', () => {
  const o = normalizeOptions({ contest: '3-max', numLineups: 10 });
  assert.equal(o.numLineups, 3, 'capped at the contest max entries');
  assert.equal(o.minUnique, 2);
  assert.throws(() => normalizeOptions({ poolSize: 10, numLineups: 20, contest: '20-max' }), /poolSize/);
  assert.throws(() => normalizeOptions({ contest: { contestSize: 1, entryFee: 1, payouts: [1] } }), /contestSize/);
});

test('buildPortfolio end to end respects exposure, uniqueness, locks and seed', () => {
  const slate = makeSlate();
  const lockedId = slate.find((p) => p.salary < 4500).id;
  const excludedId = slate[0].id;
  const options = {
    contest: '20-max',
    numLineups: 10,
    poolSize: 120,
    fieldSize: 800,
    iterations: 300,
    optimalIterations: 100,
    seed: 11,
    maxExposure: 50,
    minUnique: 3,
    lockedPlayers: [lockedId],
    excludedPlayers: [excludedId]
  };
  const progress = [];
  const res = buildPortfolio(slate, options, { onProgress: (p) => progress.push(p) });
  const { lineups, metrics } = res.portfolio;

  assert.equal(lineups.length, 10);
  assert.ok(progress.length > 0 && progress.every((p, i) => i === 0 || p.progress >= progress[i - 1].progress));
  const counts = new Map();
  const sets = lineups.map((l) => {
    assert.ok(l.totalSalary <= SALARY_CAP && l.totalSalary >= 49000);
    l.players.forEach((s, slot) => {
      assert.equal(s.position, ROSTER_SLOTS[slot]);
      assert.ok(slotMask(s.player.position) & (1 << slot));
    });
    const ids = l.players.map((s) => s.player.id);
    assert.ok(ids.includes(lockedId));
    assert.ok(!ids.includes(excludedId));
    ids.forEach((id) => counts.set(id, (counts.get(id) || 0) + 1));
    return new Set(ids);
  });
  for (const [id, n] of counts) if (id !== lockedId) assert.ok(n <= 5, `player ${id} in ${n}/10 lineups`);
  for (let a = 0; a < sets.length; a++) {
    for (let b = a + 1; b < sets.length; b++) {
      const shared = [...sets[a]].filter((id) => sets[b].has(id)).length;
      assert.ok(shared <= 5, `lineups ${a}/${b} share ${shared}`);
    }
  }

  assert.equal(metrics.entries, 10);
  assert.equal(metrics.totalFees, 50);
  for (const k of ['anyCashRate', 'anyWinRate', 'anyTop1Rate', 'profitableRate']) assert.ok(metrics[k] >= 0 && metrics[k] <= 1);
  const c0 = res.candidates[0];
  for (const k of ['roi', 'winRate', 'top1Rate', 'cashRate', 'dupes', 'totalOwnership']) assert.ok(Number.isFinite(c0[k]), k);
  assert.ok(res.candidates.every((c, i) => i === 0 || c.roi <= res.candidates[i - 1].roi));
  const optimalTotal = res.players.reduce((s, p) => s + p.optimalRate, 0);
  assert.ok(Math.abs(optimalTotal - 800) < 2, `optimal rates sum to ${optimalTotal}%`);
  for (const p of res.players) assert.ok(Math.abs(p.leverage - (p.optimalRate - p.ownership)) < 0.11);

  const dist = res.portfolio.scoreDistribution;
  assert.equal(dist.lineups.length, 10);
  dist.lineups.forEach((d, k) => {
    assert.equal(d.counts.length, dist.binCount);
    assert.equal(d.counts.reduce((s, n) => s + n, 0), 300);
    assert.ok(Math.abs(d.mean - lineups[k].metrics.meanScore) < 0.2, `lineup ${k} mean ${d.mean} vs ${lineups[k].metrics.meanScore}`);
  });

  const again = buildPortfolio(slate, options);
  assert.deepEqual(
    again.portfolio.lineups.map((l) => l.metrics.playerIds),
    lineups.map((l) => l.metrics.playerIds),
    'same seed -> same portfolio'
  );
});

test('scoreDistributions bins every iteration on shared bins with ordered percentiles', () => {
  assert.equal(niceBinWidth(97, 40), 2.5);
  assert.equal(niceBinWidth(400, 40), 10);
  const P = 9;
  const N = 500;
  const rng = createRng(3);
  const T = Float32Array.from({ length: N * P }, () => 20 + rng.normal() * 8);
  const res = scoreDistributions(T, P, N, [[0, 1, 2, 3, 4, 5, 6, 7], [1, 2, 3, 4, 5, 6, 7, 8]], { bins: 30 });
  assert.ok(res.binCount >= 10 && res.binCount <= 31);
  for (const d of res.lineups) {
    assert.equal(d.counts.reduce((s, n) => s + n, 0), N);
    assert.ok(d.p10 <= d.p50 && d.p50 <= d.p90 && d.p90 <= d.p99);
    assert.ok(Math.abs(d.mean - 160) < 5);
    assert.ok(d.p10 >= res.binStart && d.p99 <= res.binStart + res.binWidth * res.binCount);
  }
  assert.deepEqual(scoreDistributions(T, P, N, []).lineups, []);
});
