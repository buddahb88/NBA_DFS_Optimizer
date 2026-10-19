/**
 * EXACT SEARCH FOR THE OPEN SLOTS OF ONE ENTRY
 *
 * Late swap fills at most a full roster (8 DK / 9 FD slots) from a pruned
 * candidate list, once per entry. A purpose-built branch-and-bound beats the
 * general ILP here, mostly because of uniqueness: "not the same lineup as
 * entry #12" is a no-good cut that makes the LP relaxation weak and
 * javascript-lp-solver slow, while here it's a cheap check at each leaf.
 *
 * Upper bound: Lagrangian relaxation of the salary constraint. For any
 * lambda >= 0, picking exactly r more players is bounded by
 *   lambda * salaryLeft + (sum of the r largest (proj - lambda * salary))
 * and we take the smallest bound over a fixed lambda grid.
 */

const LAMBDAS = [0, 0.001, 0.002, 0.003, 0.004, 0.005, 0.0065, 0.008, 0.01];
const DEFAULT_NODE_LIMIT = 2_000_000;

/** True if every mask can take a distinct slot bit (Kuhn's algorithm). */
export function canMatch(masks) {
  const owner = new Map();
  let seen = 0;
  const place = (j) => {
    for (let m = masks[j]; m; m &= m - 1) {
      const bit = m & -m;
      if (seen & bit) continue;
      seen |= bit;
      if (!owner.has(bit) || place(owner.get(bit))) {
        owner.set(bit, j);
        return true;
      }
    }
    return false;
  };
  for (let j = 0; j < masks.length; j++) {
    seen = 0;
    if (!place(j)) return false;
  }
  return true;
}

/**
 * @param {object} p
 *   items        [{ id, proj, salary, mask, team, game }] - candidates
 *   required     same shape - must be in the lineup (count toward k)
 *   k            players to choose in total (= open slots)
 *   salaryLeft   salary available for the open slots
 *   teamCounts   Map team -> players already on the roster (locked)
 *   maxPerTeam   site max per team (null = none)
 *   minTeams / minGames, fixedTeams / fixedGames (Sets from the locked players)
 *   forbidden    Set of sorted-id keys of lineups that can't be repeated
 *   nodeLimit    stop after this many nodes and return the best found
 * @returns {{ chosen: object[], value: number, exhaustive: boolean } | null}
 */
export function searchLineup({
  items, required = [], k, salaryLeft, teamCounts = new Map(), maxPerTeam = null,
  minTeams = 0, minGames = 0, fixedTeams = new Set(), fixedGames = new Set(),
  forbidden = new Set(), nodeLimit = DEFAULT_NODE_LIMIT
}) {
  const sorted = [...items].sort((a, b) => b.proj - a.proj || a.salary - b.salary);
  const n = sorted.length;
  const proj = Float64Array.from(sorted, x => x.proj);
  const sal = Float64Array.from(sorted, x => x.salary);

  const chosen = [...required];
  const teamCount = new Map(teamCounts);
  for (const p of required) teamCount.set(p.team, (teamCount.get(p.team) || 0) + 1);
  if (maxPerTeam && [...teamCount.values()].some(c => c > maxPerTeam)) return null;
  if (!canMatch(chosen.map(p => p.mask))) return null;

  let budget = salaryLeft - required.reduce((s, p) => s + p.salary, 0);
  let value = required.reduce((s, p) => s + p.proj, 0);
  let best = null;
  let bestValue = -Infinity;
  let nodes = 0;
  const top = new Float64Array(k + 1);
  // minSal[j] = the k cheapest salaries in sorted[j..], ascending
  const minSal = new Array(n + 1);
  minSal[n] = [];
  for (let j = n - 1; j >= 0; j--) {
    const next = [...minSal[j + 1], sal[j]].sort((a, b) => a - b);
    minSal[j] = next.length > k ? next.slice(0, k) : next;
  }

  // Upper bound on what r more picks from sorted[j..] can add within `left` salary
  const bound = (j, r, left) => {
    if (r === 0) return 0;
    if (n - j < r) return -Infinity;
    // Infeasible if even the r cheapest remaining players don't fit
    let cheap = 0;
    for (let q = 0; q < r; q++) cheap += minSal[j][q];
    if (cheap > left) return -Infinity;
    let ub = Infinity;
    for (const lam of LAMBDAS) {
      // r largest of (proj - lam * sal) over the suffix, via a small sorted buffer
      let filled = 0;
      for (let i = j; i < n; i++) {
        const v = proj[i] - lam * sal[i];
        if (filled < r) {
          let q = filled++;
          while (q > 0 && top[q - 1] < v) { top[q] = top[q - 1]; q--; }
          top[q] = v;
        } else if (v > top[r - 1]) {
          let q = r - 1;
          while (q > 0 && top[q - 1] < v) { top[q] = top[q - 1]; q--; }
          top[q] = v;
        }
      }
      let s = lam * left;
      for (let q = 0; q < r; q++) s += top[q];
      if (s < ub) ub = s;
    }
    return ub;
  };

  const leafOk = () => {
    if (forbidden.size && forbidden.has(chosen.map(p => p.id).sort().join('|'))) return false;
    if (minTeams > 0) {
      const t = new Set(fixedTeams);
      chosen.forEach(p => t.add(p.team));
      if (t.size < minTeams) return false;
    }
    if (minGames > 0) {
      const g = new Set(fixedGames);
      chosen.forEach(p => g.add(p.game));
      if (g.size < minGames) return false;
    }
    return true;
  };

  const dfs = (j) => {
    if (++nodes > nodeLimit) return;
    if (chosen.length === k) {
      if (value > bestValue && leafOk()) {
        bestValue = value;
        best = [...chosen];
      }
      return;
    }
    const r = k - chosen.length;
    if (value + bound(j, r, budget) <= bestValue + 1e-9) return;
    for (let i = j; i <= n - r; i++) {
      const x = sorted[i];
      if (x.salary > budget) continue;
      const tc = teamCount.get(x.team) || 0;
      if (maxPerTeam && tc >= maxPerTeam) continue;
      chosen.push(x);
      if (canMatch(chosen.map(p => p.mask))) {
        teamCount.set(x.team, tc + 1);
        budget -= x.salary;
        value += x.proj;
        dfs(i + 1);
        value -= x.proj;
        budget += x.salary;
        teamCount.set(x.team, tc);
      }
      chosen.pop();
      if (nodes > nodeLimit) return;
      // Every later choice at this depth is bounded by the suffix after i
      if (value + bound(i + 1, r, budget) <= bestValue + 1e-9) return;
    }
  };
  dfs(0);

  return best ? { chosen: best, value: bestValue, exhaustive: nodes <= nodeLimit } : null;
}
