import { describe, test, expect, vi, beforeEach } from 'vitest';
import { createRng } from '../simulation/rng.js';
import { createSolverContext, matchSlots, ROSTER_SIZE, SALARY_CAP } from './lineupSolver.js';
import { FIELD_RULES, fieldRulesFor, generateRuleField } from './fieldGenerator.js';
import { simulateContest, sampleRank, sampleRankShared, drawRankLuck } from './contestSim.js';
import { resolveContest, createPayoutLookup } from './payouts.js';
import {
  CHEAP_FLOOR, chalkCapFor, createCappedSolver, failsCheapFloor, normalizeGppSimOptions, prepareSimPlayers,
  runGppSim, sampleNight, selectByWinRate, simulateNights
} from './gppSim.js';

vi.mock('../slateSource.js', () => ({
  resolveSlate: vi.fn(),
  loadSlatePlayers: vi.fn(),
  loadActuals: vi.fn(),
  lineupActualTotal: (players) => (players.some((p) => p.actualPoints == null) ? null : players.reduce((s, p) => s + p.actualPoints, 0))
}));
const slateSource = await import('../slateSource.js');
const { loadGppSimInputs, mergeSimPlayers } = await import('./gppSimInputs.js');
const { createGppSimJob, getJob, clearGppSimCache, gppCacheKey } = await import('./jobs.js');

const POSITIONS = ['PG', 'SG', 'SF', 'PF', 'C', 'PG/SG', 'SG/SF', 'SF/PF', 'PF/C', 'PG'];

/** Synthetic sim slate: `games` games x 2 teams x perTeam players. */
function makeSlate({ games = 8, perTeam = 9, seed = 3 } = {}) {
  const r = createRng(seed).uniform;
  const players = [];
  let id = 1;
  for (let g = 0; g < games; g++) {
    for (const [team, opp] of [[`H${g}`, `A${g}`], [`A${g}`, `H${g}`]]) {
      for (let k = 0; k < perTeam; k++) {
        const salary = Math.max(3000, Math.round((10800 - k * 900 + (r() - 0.5) * 1200) / 100) * 100);
        const proj = Math.round((salary / 1000) * (4.7 + r() * 1.4) * 10) / 10;
        players.push({
          id: id++,
          name: `${team}-P${k}`,
          team,
          opponent: opp,
          position: POSITIONS[(k + g) % POSITIONS.length],
          salary,
          proj,
          p10: proj * 0.55,
          p90: proj * 1.45,
          pPlay: 0.97,
          own: Math.max(0.5, Math.round((proj / (salary / 1000)) ** 3 * 0.12 * 10) / 10),
          minutes: Math.max(6, 36 - k * 3.5)
        });
      }
    }
  }
  return players;
}

const FAST = { evalNights: 400, fieldSize: 600, seeds: 2, optNights: 20, seed: 't' };

describe('field rules by slate size', () => {
  test('frac / salary floor per slate size', () => {
    expect(fieldRulesFor(2)).toEqual({ frac: 0.9, minSalary: 49000 });
    expect(fieldRulesFor(3)).toEqual({ frac: 0.9, minSalary: 49000 });
    expect(fieldRulesFor(4)).toEqual({ frac: 0.88, minSalary: 49000 });
    expect(fieldRulesFor(7)).toEqual({ frac: 0.88, minSalary: 49000 });
    expect(fieldRulesFor(8)).toEqual({ frac: 0.86, minSalary: 49200 });
    expect(fieldRulesFor(14)).toEqual({ frac: 0.86, minSalary: 49200 });
    expect(FIELD_RULES).toHaveLength(3);
  });

  test('rule field: valid lineups over the salary floor and projection threshold, ruled-out players never drawn', () => {
    const sim = prepareSimPlayers(makeSlate({ games: 4 }));
    const ctx = createSolverContext(sim.players);
    const eligible = new Uint8Array(sim.P).fill(1);
    const top = [...sim.proj.keys()].sort((a, b) => sim.own[b] - sim.own[a])[0];
    eligible[top] = 0;
    const field = generateRuleField(ctx, { own: sim.own, proj: sim.proj, eligible, size: 300, rng: createRng(1), minSalary: 49000, minProjection: 200 });
    expect(field.count).toBe(300);
    for (let f = 0; f < field.count; f++) {
      const ids = Array.from(field.lineups.subarray(f * ROSTER_SIZE, (f + 1) * ROSTER_SIZE));
      const sal = ids.reduce((s, i) => s + ctx.salary[i], 0);
      const proj = ids.reduce((s, i) => s + sim.proj[i], 0);
      expect(new Set(ids).size).toBe(ROSTER_SIZE);
      expect(sal).toBeGreaterThanOrEqual(49000);
      expect(sal).toBeLessThanOrEqual(SALARY_CAP);
      expect(proj).toBeGreaterThanOrEqual(200);
      expect(matchSlots(Uint8Array.from(ids, (i) => ctx.mask[i]))).not.toBeNull();
      expect(ids).not.toContain(top);
    }
  });

  test('the sim uses the slate-size threshold (frac x max projection)', () => {
    const r4 = runGppSim(makeSlate({ games: 4 }), FAST);
    expect(r4.slate.games).toBe(4);
    expect(r4.field.rules.frac).toBe(0.88);
    expect(r4.field.rules.minProjection).toBeCloseTo(0.88 * r4.field.rules.maxProjection, 0);
    const r8 = runGppSim(makeSlate({ games: 8 }), FAST);
    expect(r8.field.rules).toMatchObject({ frac: 0.86, minSalary: 49200 });
    expect(r8.field.salary.p10).toBeGreaterThanOrEqual(49200);
  });
});

describe('outcome model', () => {
  test('split-normal around blend_point / p_play, DNP with 1 - p_play', () => {
    const sim = prepareSimPlayers([
      { id: 1, name: 'a', team: 'X', opponent: 'Y', position: 'PG', salary: 8000, proj: 40, p10: 25, p90: 60, pPlay: 0.8, own: 10 },
      { id: 2, name: 'b', team: 'Y', opponent: 'X', position: 'C', salary: 5000, proj: 20, p10: 15, p90: 21, pPlay: 1, own: 10 }
    ]);
    expect(sim.mean[0]).toBeCloseTo(50);
    expect(sim.sdLo[0]).toBeCloseTo((50 - 25) / 1.2816);
    expect(sim.sdHi[0]).toBeCloseTo((60 - 50) / 1.2816);
    expect(sim.sdHi[1]).toBe(2); // narrow range -> sd floor of 2
    const rng = createRng(5);
    const row = new Float64Array(2);
    let dnp = 0;
    for (let n = 0; n < 4000; n++) if (sampleNight(sim, rng, row)[0] === 0) dnp++;
    expect(dnp / 4000).toBeGreaterThan(0.17);
    expect(dnp / 4000).toBeLessThan(0.23);
  });
});

describe('common random numbers', () => {
  test('every candidate is scored on the same nights', () => {
    const sim = prepareSimPlayers(makeSlate({ games: 3 }));
    const N = 300;
    const T = simulateNights(sim, N, createRng(9));
    const ctx = createSolverContext(sim.players);
    const solve = createCappedSolver(ctx, { allowed: new Uint8Array(sim.P).fill(1), rng: createRng(2) });
    const a = solve(sim.proj).players;
    // b = a with its cheapest player swapped for nobody else: identical lineup twice, plus a different one
    const c = solve(Array.from(sim.proj, (v, i) => (a.includes(i) ? v * 0.5 : v))).players;
    const pool = new Uint16Array([...a, ...a, ...c]);
    const field = generateRuleField(ctx, { own: sim.own, proj: sim.proj, size: 400, rng: createRng(3), minSalary: 0, minProjection: 0 });
    const contest = resolveContest({ preset: '20-max', contestSize: 2000 });
    const res = simulateContest({
      T, P: sim.P, N, pool, C: 3, field: field.lineups, F: field.count, contest,
      payout: createPayoutLookup(contest.payouts), dupes: new Int32Array(3), rng: createRng(4)
    });
    // Same lineup -> exactly the same score on every night
    expect(res.sumScore[0]).toBe(res.sumScore[1]);
    let manual = 0;
    for (let n = 0; n < N; n++) for (const i of c) manual += T[n * sim.P + i];
    expect(res.sumScore[2]).toBeCloseTo(manual, 2);
  });

  test('shared rank luck: same odds per candidate as sampleRank, no rank noise between candidates', () => {
    const rng = createRng(11);
    const n = 40000;
    const rate = (fn) => {
      let w = 0;
      for (let i = 0; i < n; i++) if (fn() === 0) w++;
      return w / n;
    };
    // P(rank 1 | beat all of a 6,000 sample, 14,000 entries) = 1 / (1 + 14000/6001) ~ 0.30 either way
    const indep = rate(() => sampleRank(0, 6000, 13999, rng));
    const shared = rate(() => sampleRankShared(0, 6000, 13999, drawRankLuck(rng)));
    expect(Math.abs(indep - shared)).toBeLessThan(0.015);
    expect(shared).toBeGreaterThan(0.28);
    expect(shared).toBeLessThan(0.32);
    // On one night: rank never improves with more lineups above (within the exact Gamma range
    // and within its normal approximation), and equal `above` -> equal rank
    for (let night = 0; night < 300; night++) {
      const luck = drawRankLuck(rng);
      for (const range of [[0, 1, 2, 5, 9, 12, 20, 29], [30, 60, 80, 140, 400, 1500]]) {
        let prev = -1;
        for (const above of range) {
          const r = sampleRankShared(above, 6000, 13999, luck);
          expect(r).toBeGreaterThanOrEqual(prev - (prev > 30 ? 1 : 0)); // +-1 from rounding at the lambda = 30 seam
          expect(sampleRankShared(above, 6000, 13999, luck)).toBe(r);
          prev = r;
        }
      }
    }
  });

  test('with shared luck two lineups with equal scores get identical results', () => {
    const sim = prepareSimPlayers(makeSlate({ games: 3 }));
    const N = 300;
    const T = simulateNights(sim, N, createRng(9));
    const ctx = createSolverContext(sim.players);
    const a = createCappedSolver(ctx, { allowed: new Uint8Array(sim.P).fill(1), rng: createRng(2) })(sim.proj).players;
    const field = generateRuleField(ctx, { own: sim.own, proj: sim.proj, size: 400, rng: createRng(3) });
    const contest = resolveContest({ preset: '20-max', contestSize: 2000 });
    const res = simulateContest({
      T, P: sim.P, N, pool: new Uint16Array([...a, ...a]), C: 2, field: field.lineups, F: field.count, contest,
      payout: createPayoutLookup(contest.payouts), dupes: new Int32Array(2), rng: createRng(4), sharedRankLuck: true
    });
    expect(res.top1[0]).toBe(res.top1[1]);
    expect(res.cashes[0]).toBe(res.cashes[1]);
    expect(res.wins[0]).toBe(res.wins[1]);
    expect(res.sumPay[0]).toBe(res.sumPay[1]);
  });

  test('a seed reproduces the run; candidates pool across seeds', () => {
    const slate = makeSlate();
    const a = runGppSim(slate, FAST);
    const b = runGppSim(slate, FAST);
    expect(b.lineups.map((l) => l.players.map((s) => s.player.id))).toEqual(a.lineups.map((l) => l.players.map((s) => s.player.id)));
    expect(b.lineups[0].metrics).toEqual(a.lineups[0].metrics);
    expect(a.candidateCount).toBeGreaterThan(10);
    expect(a.candidates[0].winRate).toBeGreaterThanOrEqual(a.candidates[a.candidates.length - 1].winRate);
    // The single pick is the best win rate among pickable candidates
    expect(a.lineups[0].metrics.rank).toBe(1);
    expect(a.lineups[0].metrics.winRate).toBe(a.candidates[0].winRate);
    expect(a.maxProjection.metrics.projection).toBeGreaterThanOrEqual(a.lineups[0].metrics.projection - 1e-9);
    expect(a.lineups[0].why).toMatch(/win rate/);
  });
});

describe('chalk cap', () => {
  test('cap by slate size: none <= 3 games, 1 on 4-7, 0 on 8+', () => {
    expect(chalkCapFor(2)).toBeNull();
    expect(chalkCapFor(3)).toBeNull();
    expect(chalkCapFor(4)).toBe(1);
    expect(chalkCapFor(7)).toBe(1);
    expect(chalkCapFor(8)).toBe(0);
  });

  test('capped solver keeps at most `cap` chalk players and is optimal among those lineups', () => {
    const sim = prepareSimPlayers(makeSlate({ games: 5 }));
    const ctx = createSolverContext(sim.players);
    const allowed = new Uint8Array(sim.P).fill(1);
    const free = createCappedSolver(ctx, { allowed, rng: createRng(1) })(sim.proj);
    const chalk = free.players.slice(0, 3); // force the cap to bind
    const capped1 = createCappedSolver(ctx, { allowed, chalk, cap: 1, rng: createRng(1) })(sim.proj);
    const capped0 = createCappedSolver(ctx, { allowed, chalk, cap: 0, rng: createRng(1) })(sim.proj);
    expect(capped1.players.filter((i) => chalk.includes(i)).length).toBeLessThanOrEqual(1);
    expect(capped0.players.filter((i) => chalk.includes(i)).length).toBe(0);
    expect(capped0.value).toBeLessThanOrEqual(capped1.value + 1e-9);
    expect(capped1.value).toBeLessThanOrEqual(free.value + 1e-9);
  });

  test('chalkCap option: every pick respects the cap; the uncapped max projection stays as the comparison', () => {
    const slate = makeSlate({ games: 8 });
    const res = runGppSim(slate, { ...FAST, chalkCap: true });
    expect(res.slate.chalk.cap).toBe(0);
    const chalkNames = res.slate.chalk.players.map((p) => p.name);
    for (const l of res.lineups) {
      expect(l.players.filter((s) => chalkNames.includes(s.player.name))).toHaveLength(0);
      expect(l.metrics.chalkPlayers).toBe(0);
    }
    expect(res.maxProjection).not.toBeNull();
    expect(normalizeGppSimOptions({}).chalkCap).toBe(false);
  });
});

describe('cheap-player minutes floor', () => {
  test('under $5K with projected minutes below 20 fails the floor', () => {
    expect(CHEAP_FLOOR).toEqual({ salary: 5000, minutes: 20 });
    expect(failsCheapFloor({ salary: 4800, minutes: 18 })).toBe(true);
    expect(failsCheapFloor({ salary: 4800, minutes: 24 })).toBe(false);
    expect(failsCheapFloor({ salary: 5000, minutes: 10 })).toBe(false);
    expect(failsCheapFloor({ salary: 3500, minutes: null })).toBe(false);
  });

  test('cheapMinutesFloor option keeps those players out of our lineups (default off)', () => {
    const slate = makeSlate();
    // Make the cheap, low-minute players irresistible on projection
    for (const p of slate) if (p.salary < 5000 && p.minutes < 20) p.proj *= 2.2;
    const off = runGppSim(slate, FAST);
    const used = (r) => r.lineups.flatMap((l) => l.players.map((s) => s.player)).filter((p) => p.salary < 5000 && p.minutes < 20);
    expect(used(off).length).toBeGreaterThan(0);
    const on = runGppSim(slate, { ...FAST, cheapMinutesFloor: true });
    expect(used(on)).toHaveLength(0);
    expect(on.slate.cheapExcluded.length).toBeGreaterThan(0);
  });
});

describe('at-lock exclusion', () => {
  test('ruled-out players are out of our lineups and the field', () => {
    const slate = makeSlate({ games: 4 });
    const base = runGppSim(slate, FAST);
    const star = base.lineups[0].players[0].player;
    const res = runGppSim(slate.map((p) => (p.id === star.id ? { ...p, out: true, outReason: 'did not play' } : p)), FAST);
    expect(res.slate.ruledOut).toEqual([{ id: star.id, name: star.name, team: star.team, reason: 'did not play' }]);
    expect(res.slate.players).toBe(base.slate.players - 1);
    const all = [...res.lineups, res.maxProjection, ...res.candidates.map((c) => ({ players: c.playerIds.map((id) => ({ player: { id } })) }))];
    for (const l of all) expect(l.players.map((s) => s.player.id)).not.toContain(star.id);
    // ruledOut by request works the same way
    const viaRequest = runGppSim(slate, { ...FAST, ruledOut: [String(star.id)] });
    expect(viaRequest.slate.ruledOut.map((r) => r.id)).toEqual([star.id]);
    expect(viaRequest.lineups[0].players.map((s) => s.player.id)).not.toContain(star.id);
  });

  test('field generator never draws ineligible players', () => {
    const sim = prepareSimPlayers(makeSlate({ games: 2 }));
    const ctx = createSolverContext(sim.players);
    const eligible = new Uint8Array(sim.P).fill(1);
    for (let i = 0; i < sim.P; i += 3) eligible[i] = 0;
    const field = generateRuleField(ctx, { own: sim.own, proj: sim.proj, eligible, size: 200, rng: createRng(8) });
    for (const i of field.lineups) expect(eligible[i]).toBe(1);
  });

  describe('loadGppSimInputs', () => {
    const rows = [
      { id: 1, name: 'Star Guard', team: 'X', opponent: 'Y', position: 'PG', salary: 9000, rostership: 30, injury_status: null },
      { id: 2, name: 'Tagged Out', team: 'X', opponent: 'Y', position: 'C', salary: 7000, rostership: 5, injury_status: 'OUT' },
      { id: 3, name: 'Late Scratch', team: 'Y', opponent: 'X', position: 'SF', salary: 6000, rostership: 12, injury_status: 'GTD' }
    ];
    const ownModel = {
      players: rows.map((r) => ({ id: r.id, blend_point: 30, blend_p10: 18, blend_p90: 45, p_play: r.id === 3 ? 0.6 : 0.97, ours_minutes: 30 }))
    };
    const project = async () => ownModel;
    beforeEach(() => {
      vi.mocked(slateSource.loadSlatePlayers).mockResolvedValue(rows);
    });

    test('OUT tags are always ruled out; at lock a live slate refreshes tags (read-only fetch)', async () => {
      vi.mocked(slateSource.resolveSlate).mockResolvedValue({ slateId: '9', slateDate: '2026-11-09', isBacktest: false });
      const sync = await loadGppSimInputs({ slateId: '9' }, { projectOwnModel: project, fetchOuts: async () => { throw new Error('should not fetch'); } });
      expect(sync.players.filter((p) => p.out).map((p) => p.id)).toEqual([2]);
      expect(sync.players[0]).toMatchObject({ proj: 30, p10: 18, p90: 45, own: 30, minutes: 30 });

      const fetchOuts = vi.fn(async () => new Map([['late scratch', 'RotoWire: OUT']]));
      const lock = await loadGppSimInputs({ slateId: '9' }, { atLock: true, projectOwnModel: project, fetchOuts });
      expect(fetchOuts).toHaveBeenCalledWith('9');
      expect(lock.players.filter((p) => p.out).map((p) => [p.id, p.outReason])).toEqual([[2, 'tagged OUT'], [3, 'RotoWire: OUT']]);

      const failed = await loadGppSimInputs({ slateId: '9' }, { atLock: true, projectOwnModel: project, fetchOuts: async () => { throw new Error('offline'); } });
      expect(failed.players.filter((p) => p.out).map((p) => p.id)).toEqual([2]);
      expect(failed.notes.join(' ')).toMatch(/Could not refresh injury tags \(offline\)/);
    });

    test('at lock a past slate drops players who did not play; ruledOut ids from the request', async () => {
      vi.mocked(slateSource.resolveSlate).mockResolvedValue({ slateId: '9', slateDate: '2026-11-02', isBacktest: true });
      vi.mocked(slateSource.loadActuals).mockResolvedValue(new Map([
        [1, { actualPoints: 50, resultStatus: 'PLAYED' }], [3, { actualPoints: 0, resultStatus: 'INACTIVE' }]
      ]));
      const lock = await loadGppSimInputs({ slateDate: '2026-11-02' }, { atLock: true, projectOwnModel: project });
      expect(lock.players.filter((p) => p.out).map((p) => [p.id, p.outReason])).toEqual([[2, 'tagged OUT'], [3, 'did not play']]);
      const sync = await loadGppSimInputs({ slateDate: '2026-11-02' }, { ruledOut: ['1'], projectOwnModel: project });
      expect(sync.players.filter((p) => p.out).map((p) => p.id)).toEqual([1, 2]);
    });

    test('falls back to the slate projections without a blend', () => {
      const merged = mergeSimPlayers([{ ...rows[0], projected_points: 41, floor: 30, ceiling: 55 }], null);
      expect(merged[0]).toMatchObject({ proj: 41, p10: 30, p90: 55, pPlay: null });
    });
  });
});

describe('multi-entry', () => {
  test('selectByWinRate: best win rates subject to the overlap cap', () => {
    const L = (players, wins) => ({ players, wins, top1: 0, cashes: 0, ownership: 100 });
    const rows = [
      L([1, 2, 3, 4, 5, 6, 7, 8], 50),
      L([1, 2, 3, 4, 5, 6, 7, 9], 40), // shares 7 with the first
      L([1, 2, 3, 4, 5, 10, 11, 12], 30), // shares 5
      L([13, 14, 15, 16, 17, 18, 19, 20], 20)
    ];
    expect(selectByWinRate(rows, 3, 5).picks.map((r) => r.wins)).toEqual([50, 30, 20]);
    expect(selectByWinRate(rows, 3, 7).picks.map((r) => r.wins)).toEqual([50, 40, 30]);
    expect(selectByWinRate(rows, 4, 0).picks.map((r) => r.wins)).toEqual([50, 20]);
  });

  test('multi mode returns distinct win-rate picks sharing at most maxOverlap players', () => {
    const res = runGppSim(makeSlate(), { ...FAST, mode: 'multi', entries: 4, maxOverlap: 5 });
    expect(res.settings).toMatchObject({ mode: 'multi', entries: 4 });
    expect(res.lineups).toHaveLength(4);
    const sets = res.lineups.map((l) => l.players.map((s) => s.player.id));
    for (let a = 0; a < sets.length; a++) {
      for (let b = a + 1; b < sets.length; b++) {
        expect(sets[a].filter((x) => sets[b].includes(x)).length).toBeLessThanOrEqual(5);
      }
    }
    // Ordered by win rate
    const wins = res.lineups.map((l) => l.metrics.winRate);
    expect([...wins].sort((x, y) => y - x)).toEqual(wins);
    expect(res.caveat).toBeNull();
  });

  test('single mode forces one entry; small single-entry contests carry the caveat', () => {
    expect(normalizeGppSimOptions({ mode: 'single', entries: 5 }).entries).toBe(1);
    expect(normalizeGppSimOptions({}).contestSize).toBe(14000);
    expect(() => normalizeGppSimOptions({ mode: 'turbo' })).toThrow(/mode/);
    const res = runGppSim(makeSlate({ games: 3 }), { ...FAST, contestSize: 2000 });
    expect(res.caveat).toMatch(/single-entry fields are sharper/);
  });
});

describe('jobs: background run + cache', () => {
  const waitDone = async (job) => {
    for (let i = 0; i < 600 && !job.finishedAt; i++) await new Promise((r) => setTimeout(r, 50));
    return job;
  };
  const players = makeSlate({ games: 3 });
  const loadInputs = vi.fn(async () => ({ source: { slateId: '77', slateDate: '2026-11-09', isBacktest: false }, players, actuals: null, notes: [], ownModel: null }));

  test('runs in a worker, then serves the cached result for the same inputs', async () => {
    clearGppSimCache();
    const opts = { ...FAST, loadInputs };
    const first = await waitDone(createGppSimJob('77', opts));
    expect(first.error).toBeNull();
    expect(first.status).toBe('completed');
    expect(first.result).toMatchObject({ kind: 'gpp-sim', cached: false });
    expect(first.result.lineups).toHaveLength(1);

    const second = await waitDone(createGppSimJob('77', opts));
    expect(second.status).toBe('completed');
    expect(second.result.cached).toBe(true);
    expect(second.result.lineups[0].players).toEqual(first.result.lineups[0].players);
    expect(getJob(second.id)).toBe(second);

    const refreshed = await waitDone(createGppSimJob('77', { ...opts, refresh: true }));
    expect(refreshed.result.cached).toBe(false);
  }, 60000);

  test('the cache key follows the inputs and options', () => {
    const o = normalizeGppSimOptions({});
    const k = gppCacheKey({ slateId: '1', slateDate: 'd' }, o, players);
    expect(gppCacheKey({ slateId: '1', slateDate: 'd' }, o, players)).toBe(k);
    expect(gppCacheKey({ slateId: '1', slateDate: 'd' }, { ...o, chalkCap: true }, players)).not.toBe(k);
    expect(gppCacheKey({ slateId: '1', slateDate: 'd' }, o, players.map((p, i) => (i === 0 ? { ...p, proj: p.proj + 1 } : p)))).not.toBe(k);
    expect(gppCacheKey({ slateId: '1', slateDate: 'd' }, o, players.map((p, i) => (i === 0 ? { ...p, out: true } : p)))).not.toBe(k);
  });

  test('invalid options are rejected up front', () => {
    expect(() => createGppSimJob('77', { mode: 'nope' })).toThrow(/mode/);
  });
});
