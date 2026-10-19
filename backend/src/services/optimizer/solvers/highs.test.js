import { describe, it, expect, vi, afterEach } from 'vitest';
import solver from 'javascript-lp-solver';
import optimizerService from '../../optimizerService.js';
import { buildRequestContext, buildSolveContext } from '../context.js';
import { solveWithHighs, toLpFormat } from './highs.js';
import { buildPlayerPool } from '../../../../test/fixtures/playerPool.js';

describe('solveWithHighs', () => {
  afterEach(() => vi.restoreAllMocks());

  it('solves a small integer model and returns javascript-lp-solver result shape', () => {
    const model = {
      optimize: 'value',
      opType: 'max',
      constraints: { weight: { max: 10 }, pick: { max: 2 } },
      variables: {
        a: { value: 5, weight: 6, pick: 1 },
        b: { value: 4, weight: 5, pick: 1 },
        c: { value: 3, weight: 4, pick: 1 },
      },
      ints: { a: 1, b: 1, c: 1 },
    };
    // Bound each var to 0/1 through its own row, as the optimizer's player_ rows do
    ['a', 'b', 'c'].forEach((v) => {
      model.constraints[`one_${v}`] = { max: 1 };
      model.variables[v][`one_${v}`] = 1;
    });

    const result = solveWithHighs(model);
    expect(result.feasible).toBe(true);
    expect(result.result).toBeCloseTo(8); // a + c (weight 10) beats b + c (7) and a + b (over weight)
    expect(result.a).toBe(1);
    expect(result.c).toBe(1);
    expect(result.b).toBeUndefined();
  });

  it('reports infeasible models, including constraints with no variables', () => {
    const base = {
      optimize: 'value',
      opType: 'max',
      variables: { a: { value: 1, cap: 1 } },
      ints: { a: 1 },
    };
    expect(solveWithHighs({ ...base, constraints: { cap: { min: 2, max: 1 } } }).feasible).toBe(false);
    expect(solveWithHighs({ ...base, constraints: { cap: { max: 1 }, nobody: { equal: 1 } } }).feasible).toBe(false);
    expect(solveWithHighs({ ...base, constraints: { cap: { max: 1 }, nobody: { max: 1 } } }).feasible).toBe(true);
  });

  it('writes safe generated names regardless of variable/constraint keys', () => {
    const { lp } = toLpFormat({
      optimize: 'score',
      opType: 'max',
      constraints: { 'slot PG/G': { equal: 1 } },
      variables: { 'p1_PG': { score: 2, 'slot PG/G': 1 }, 'weird name!': { score: 1, 'slot PG/G': 1 } },
      ints: {},
    });
    expect(lp).toContain('Maximize');
    expect(lp).not.toContain('weird');
    expect(lp).not.toContain('slot PG/G');
  });

  it.each(['cash', 'gpp'])('matches javascript-lp-solver on the %s lineup model', (mode) => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const pool = buildPlayerPool().map((p) => ({ ...p, adjustedProjection: p.projected_points }));
    const ctx = () => buildSolveContext(buildRequestContext({ mode, minSalary: 45000 }), pool);
    const oursCtx = ctx();

    const ours = solveWithHighs(optimizerService.buildLPModel(oursCtx));
    const theirs = solver.Solve(optimizerService.buildLPModel(ctx()));
    expect(ours.feasible).toBe(true);
    expect(ours.result).toBeCloseTo(theirs.result, 4);
    expect(optimizerService.extractLineupFromSolution(ours, pool, oursCtx).isValid).toBe(true);
  });
});
