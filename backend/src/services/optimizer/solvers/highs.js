/**
 * HiGHS adapter for javascript-lp-solver JSON models.
 *
 * Drop-in for `solver.Solve(model)`: takes the same model object
 * ({ optimize, opType, constraints, variables, ints, options.timeout }) and returns the
 * same result shape ({ feasible, bounded, result, [varName]: value }), but solves with
 * HiGHS (WASM build of the native MIP solver) instead of pure-JS branch-and-bound.
 *
 * The model is written to CPLEX LP text with generated row/column names (x0.., r0..)
 * so any variable or constraint key is safe. Integer variables come back rounded, so
 * callers that test `solution[name] === 1` keep working.
 */

import highsLoader from 'highs';

// WASM loads once per process; solve() itself is synchronous
const highs = await highsLoader();

const TERMS_PER_LINE = 8;
const FEAS_TOL = 1e-6;

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? String(n) : '0';
};

function expression(terms) {
  if (!terms.length) return '0 x0';
  const parts = terms.map(([coef, col], i) => {
    const c = Number(coef);
    const sign = c < 0 ? '-' : i === 0 ? '' : '+';
    return `${sign} ${num(Math.abs(c))} ${col}`;
  });
  const lines = [];
  for (let i = 0; i < parts.length; i += TERMS_PER_LINE) {
    lines.push(parts.slice(i, i + TERMS_PER_LINE).join(' '));
  }
  return lines.join('\n  ');
}

/** Convert a javascript-lp-solver model to LP text. Returns { lp, columns, rows } or { infeasible: true }. */
export function toLpFormat(model) {
  const varNames = Object.keys(model.variables);
  const colOf = new Map(varNames.map((name, i) => [name, `x${i}`]));
  const rowTerms = new Map(Object.keys(model.constraints).map((c) => [c, []]));
  const objTerms = [];

  varNames.forEach((name) => {
    const col = colOf.get(name);
    Object.entries(model.variables[name]).forEach(([key, coef]) => {
      if (!coef) return;
      if (key === model.optimize) objTerms.push([coef, col]);
      rowTerms.get(key)?.push([coef, col]);
    });
  });

  const rows = [];
  const lines = [model.opType === 'min' ? 'Minimize' : 'Maximize', ` obj: ${expression(objTerms)}`, 'Subject To'];
  for (const [cName, bounds] of Object.entries(model.constraints)) {
    const terms = rowTerms.get(cName);
    const checks = [];
    if (bounds.equal != null) checks.push(['=', bounds.equal]);
    if (bounds.min != null) checks.push(['>=', bounds.min]);
    if (bounds.max != null) checks.push(['<=', bounds.max]);
    for (const [op, rhs] of checks) {
      if (!terms.length) {
        // Constant row: 0 must satisfy it, otherwise the model is infeasible as written
        const ok = op === '=' ? Math.abs(rhs) <= FEAS_TOL : op === '>=' ? rhs <= FEAS_TOL : rhs >= -FEAS_TOL;
        if (!ok) return { infeasible: true };
        continue;
      }
      const row = `r${rows.length}`;
      rows.push({ terms, op, rhs: Number(rhs) });
      lines.push(` ${row}: ${expression(terms)} ${op} ${num(rhs)}`);
    }
  }

  const ints = varNames.filter((name) => model.ints?.[name]);
  if (ints.length) {
    lines.push('General');
    for (let i = 0; i < ints.length; i += TERMS_PER_LINE) {
      lines.push(' ' + ints.slice(i, i + TERMS_PER_LINE).map((n) => colOf.get(n)).join(' '));
    }
  }
  lines.push('End');
  return { lp: lines.join('\n'), colOf, rows };
}

/** Solve a javascript-lp-solver model with HiGHS. `model.options.timeout` (ms) becomes time_limit. */
export function solveWithHighs(model) {
  const converted = toLpFormat(model);
  if (converted.infeasible) return { feasible: false, bounded: true, result: 0 };
  const { lp, colOf, rows } = converted;

  const options = { output_flag: false };
  const timeoutMs = model.options?.timeout ?? model.timeout;
  if (timeoutMs) options.time_limit = timeoutMs / 1000;

  const sol = highs.solve(lp, options);
  const hasSolution =
    sol.Status === 'Optimal' ||
    (['Time limit reached', 'Iteration limit reached'].includes(sol.Status) && sol.Columns && Object.keys(sol.Columns).length);
  if (!hasSolution) {
    return { feasible: false, bounded: sol.Status !== 'Unbounded', result: 0, status: sol.Status };
  }

  const values = new Map();
  colOf.forEach((col, name) => {
    let v = sol.Columns[col]?.Primal ?? 0;
    if (model.ints?.[name]) v = Math.round(v);
    values.set(col, v);
  });

  // A limit-stopped solve may carry no usable incumbent; verify it against the rows
  const satisfied = rows.every(({ terms, op, rhs }) => {
    const lhs = terms.reduce((s, [c, col]) => s + c * values.get(col), 0);
    const tol = FEAS_TOL * Math.max(1, Math.abs(rhs));
    return op === '=' ? Math.abs(lhs - rhs) <= tol : op === '>=' ? lhs >= rhs - tol : lhs <= rhs + tol;
  });
  if (!satisfied) return { feasible: false, bounded: true, result: 0, status: sol.Status };

  const result = { feasible: true, bounded: true, result: sol.ObjectiveValue, status: sol.Status };
  colOf.forEach((col, name) => {
    const v = values.get(col);
    if (v !== 0) result[name] = v;
  });
  return result;
}
