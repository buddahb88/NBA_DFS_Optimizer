import { test, describe, beforeAll, afterAll } from 'vitest';
import assert from 'node:assert/strict';
import solver from 'javascript-lp-solver';
import optimizerService from '../src/services/optimizerService.js';
import { buildRequestContext, buildSolveContext } from '../src/services/optimizer/context.js';
import { CONSTRAINTS } from '../src/services/optimizer/constraints/index.js';
import { makeSlate, scaleSalaries, withSeed } from './fixtures/slate.js';

// The optimizer logs a lot; keep test output readable
const original = { log: console.log, warn: console.warn, error: console.error };
beforeAll(() => { console.log = console.warn = console.error = () => {}; });
afterAll(() => Object.assign(console, original));

const run = (players, settings, seed = 1) => withSeed(seed, () => optimizerService.optimize(players, settings));
const idSet = (lineup) => lineup.players.map(s => s.player.id).sort((a, b) => a - b);
const countBy = (lineup, key) => lineup.players.reduce((m, s) => {
  const k = key(s.player);
  m[k] = (m[k] || 0) + 1;
  return m;
}, {});
const gameOf = (p) => [p.team, p.opponent].sort().join('@');

// Make some teams far better than the rest so team/game limits have to bind
const boostTeams = (players, teams) => players.map(p => (teams.includes(p.team)
  ? { ...p, projected_points: p.projected_points * 3, floor: p.floor * 3, ceiling: p.ceiling * 3 }
  : p));

// Two strong teams (AAA vs BBB) that could fill a whole roster, plus weak CCC vs DDD
const twoStrongTeams = (salary) => {
  const positions = ['PG', 'SG', 'SF', 'PF', 'C'];
  const players = [];
  [['AAA', 'BBB', 40], ['BBB', 'AAA', 40], ['CCC', 'DDD', 10], ['DDD', 'CCC', 10]].forEach(([team, opponent, pts]) => {
    positions.forEach((position, i) => players.push({
      id: players.length + 1, name: `${team} ${position}`, team, opponent, position,
      salary, projected_points: pts + i, floor: pts * 0.8, ceiling: pts * 1.3, rostership: 10
    }));
  });
  return players;
};

const modelFor = (players, settings) => {
  const ctx = buildSolveContext(buildRequestContext(settings), players);
  return { model: optimizerService.buildLPModel(ctx), ctx };
};

describe('DraftKings matches pre-refactor optimizer', () => {
  // Expected player sets captured from optimizerService.js before the pipeline refactor
  const cases = [
    [2, { mode: 'cash' }, [[4, 11, 21, 46, 48, 50, 72, 81]]],
    [99, { mode: 'cash' }, [[18, 23, 24, 30, 70, 80, 84, 86]]],
    [99, { mode: 'gpp' }, [[15, 19, 30, 31, 39, 45, 72, 86]]],
    [1, { mode: 'gpp', numLineups: 3, lockedPlayers: [5, 20], excludedPlayers: [1, 2, 3], minSalary: 48000, minMinutes: 20 },
      [[5, 20, 25, 29, 37, 80, 82, 86]]],
    [2, { mode: 'cash', numLineups: 2, minValue: 5, maxRostership: 30 },
      [[4, 11, 21, 46, 48, 50, 72, 81], [2, 23, 30, 31, 39, 61, 71, 74]]]
  ];

  for (const [seed, settings, expected] of cases) {
    test(`seed ${seed} ${JSON.stringify(settings)}`, () => {
      const result = run(makeSlate({ seed }), settings, seed);
      assert.deepEqual(result.lineups.map(idSet), expected);
      assert.equal(result.settings.site, 'draftkings');
      for (const lineup of result.lineups) {
        assert.deepEqual(lineup.players.map(s => s.position), ['PG', 'SG', 'SF', 'PF', 'C', 'G', 'F', 'UTIL']);
        assert.ok(lineup.totalSalary <= 50000);
        assert.equal(lineup.remainingSalary, 50000 - lineup.totalSalary);
      }
    });
  }

  test('DK model keeps the original salary / roster constraints', () => {
    const { model } = modelFor(makeSlate({ seed: 2 }), {});
    assert.deepEqual(model.constraints.salary, { max: 50000 });
    assert.deepEqual(model.constraints.minSalary, { min: 49000 });
    assert.deepEqual(model.constraints.totalPlayers, { equal: 8 });
    for (const slot of ['PG', 'SG', 'SF', 'PF', 'C', 'G', 'F', 'UTIL']) {
      assert.deepEqual(model.constraints[`slot_${slot}`], { equal: 1 });
    }
    assert.ok(!Object.keys(model.constraints).some(k => k.startsWith('team_')), 'DK has no per-team cap');
  });
});

describe('FanDuel', () => {
  const players = scaleSalaries(makeSlate({ seed: 2 }), 1.2);

  test('model: $60k cap, 9 players, two of each guard/forward slot, max 4 per team', () => {
    const { model } = modelFor(players, { site: 'fanduel' });
    assert.deepEqual(model.constraints.salary, { max: 60000 });
    assert.deepEqual(model.constraints.minSalary, { min: 58800 });
    assert.deepEqual(model.constraints.totalPlayers, { equal: 9 });
    assert.deepEqual(model.constraints.slot_PG, { equal: 2 });
    assert.deepEqual(model.constraints.slot_C, { equal: 1 });
    assert.equal(model.constraints.slot_UTIL, undefined);
    assert.deepEqual(model.constraints.team_BOS, { max: 4 });
  });

  test('builds a valid lineup in FD slot order', () => {
    const [lineup] = run(players, { site: 'fanduel', mode: 'cash' }).lineups;
    assert.ok(lineup?.isValid);
    assert.deepEqual(lineup.players.map(s => s.position), ['PG', 'PG', 'SG', 'SG', 'SF', 'SF', 'PF', 'PF', 'C']);
    assert.equal(new Set(idSet(lineup)).size, 9);
    assert.ok(lineup.totalSalary <= 60000);
    lineup.players.forEach(s => assert.ok(s.player.position.split(',').includes(s.position), `${s.player.position} in ${s.position}`));
  });

  test('never more than 4 players from one team', () => {
    const [lineup] = run(boostTeams(players, ['BOS']), { site: 'fanduel', mode: 'cash' }).lineups;
    const perTeam = countBy(lineup, p => p.team);
    assert.equal(perTeam.BOS, 4);
    assert.ok(Object.values(perTeam).every(n => n <= 4));
  });
});

describe('Yahoo', () => {
  const players = scaleSalaries(makeSlate({ seed: 2 }), 0.004, 1);

  test('builds a valid $200 lineup; ignores a DK-sized minSalary', () => {
    const [lineup] = run(players, { site: 'yahoo', mode: 'gpp', minSalary: 49000 }).lineups;
    assert.ok(lineup?.isValid);
    assert.deepEqual(lineup.players.map(s => s.position), ['PG', 'SG', 'G', 'SF', 'PF', 'F', 'C', 'UTIL']);
    assert.ok(lineup.totalSalary <= 200 && lineup.totalSalary >= 196);
  });

  test('at least 3 teams and at most 6 per team', () => {
    // Unconstrained best lineup is 4 AAA + 4 BBB
    const players = twoStrongTeams(20);
    const { model } = modelFor(players, { site: 'yahoo', minSalary: 0 });
    assert.deepEqual(model.constraints.teamsCount, { min: 3 });

    const [lineup] = run(players, { site: 'yahoo', mode: 'cash', minSalary: 0 }).lineups;
    const perTeam = countBy(lineup, p => p.team);
    assert.ok(Object.keys(perTeam).length >= 3, JSON.stringify(perTeam));
    assert.ok(Object.values(perTeam).every(n => n <= 6));
  });
});

describe('site rules on DraftKings', () => {
  test('lineup spans at least 2 games even when one game dominates', () => {
    // Unconstrained best lineup is all 8 from AAA vs BBB
    const [lineup] = run(twoStrongTeams(5000), { mode: 'cash', minSalary: 0 }).lineups;
    assert.ok(Object.keys(countBy(lineup, gameOf)).length >= 2, JSON.stringify(countBy(lineup, gameOf)));
  });

  test('unknown site fails loudly', () => {
    assert.throws(() => run(makeSlate({ seed: 2 }), { site: 'superdraft' }), /Unknown DFS site/);
  });
});

describe('locks, excludes and minUniqueness', () => {
  test('locks and excludes apply on every site', () => {
    const base = makeSlate({ seed: 2, perTeam: 6 });
    for (const [site, players] of [
      ['draftkings', base],
      ['fanduel', scaleSalaries(base, 1.2)],
      ['yahoo', scaleSalaries(base, 0.004, 1)]
    ]) {
      // Lock players the unconstrained solve skips; exclude ones it picks
      const [free] = run(players, { site, mode: 'cash' }).lineups;
      const picked = idSet(free);
      const locked = players.filter(p => !picked.includes(p.id) && p.salary > 0).slice(0, 2).map(p => p.id);
      const excluded = picked.slice(0, 3);
      const [lineup] = run(players, { site, mode: 'cash', lockedPlayers: locked, excludedPlayers: excluded }).lineups;
      const ids = idSet(lineup);
      locked.forEach(id => assert.ok(ids.includes(id), `${site}: locked ${id}`));
      excluded.forEach(id => assert.ok(!ids.includes(id), `${site}: excluded ${id}`));
    }
  });

  test('locked + excluded player is infeasible', () => {
    const result = run(makeSlate({ seed: 2 }), { mode: 'cash', lockedPlayers: [4], excludedPlayers: [4] });
    assert.equal(result.lineups.length, 0);
  });

  test('uniqueness module caps overlap with each prior lineup', () => {
    const players = makeSlate({ seed: 2 });
    const prior = [[4, 11, 21, 46, 48, 50, 72, 81]];
    const ctx = buildSolveContext(buildRequestContext({ minUniqueness: 3 }), players, { priorLineups: prior });
    const model = optimizerService.buildLPModel(ctx);
    assert.deepEqual(model.constraints.unique_0, { max: 5 });
    assert.equal(model.variables.p4_SF.unique_0, 1);

    const lineup = optimizerService.extractLineupFromSolution(solver.Solve(model), players, ctx);
    const overlap = idSet(lineup).filter(id => prior[0].includes(id)).length;
    assert.ok(lineup.isValid);
    assert.ok(overlap <= 5, `overlap ${overlap}`);
  });

  test('minUniqueness off by default adds no constraints', () => {
    const { model } = modelFor(makeSlate({ seed: 2 }), {});
    assert.ok(!Object.keys(model.constraints).some(k => k.startsWith('unique_')));
  });
});

test('pipeline exposes exposure and stacking extension points', () => {
  const names = CONSTRAINTS.map(c => c.name);
  assert.equal(names[0], 'roster');
  assert.ok(names.includes('exposure'));
  assert.ok(names.includes('stacking'));
});
