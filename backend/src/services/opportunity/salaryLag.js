/**
 * OPPORTUNITY SALARY LAG
 *
 * Has the site salary caught up with recent production? From the player's
 * salaries on earlier saved slates (slate_player_snapshots, same site, before
 * the slate date) and his site points per game:
 *
 * - salary_change_l1: tonight's salary - the most recent earlier slate's.
 * - salary_change: tonight's - the oldest of the last SALARY_SLATES earlier
 *   slates (salary_slates = how many were found). One salary per date (the
 *   highest, if several slates differ).
 * - fp_l5 vs fp_prior_l5: average points over the last 5 games vs the 5
 *   before them (at least PRIOR_MIN_GAMES), regular season, both seasons
 *   (production_spans_seasons when the 10 games cross a season).
 * - salary_lag: production up >= PRODUCTION_UP_POINTS and >= PRODUCTION_UP_PCT
 *   while salary_change <= SALARY_FLAT (flat or down).
 *
 * Snapshots start 2026-10-20, so early slates have little or no salary
 * history: every field is null with salary_lag_reason 'no_salary' |
 * 'no_prior_snapshots' | 'insufficient_games'. Only rows before the slate
 * date are read (no lookahead).
 */

import db from '../../config/database.js';

export const SALARY_SLATES = 3;
export const SALARY_WINDOW_DAYS = 30;
export const PRODUCTION_UP_POINTS = 5;
export const PRODUCTION_UP_PCT = 0.2;
export const SALARY_FLAT = 100;
export const PRIOR_MIN_GAMES = 3;

const CHUNK = 500;
const n = (v) => Number(v) || 0;
const round = (x, digits) => (x === null || x === undefined || !Number.isFinite(x) ? null : Number(x.toFixed(digits)) + 0);
const toDateStr = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : v ? String(v).slice(0, 10) : null);
const avgFp = (games) => (games.length ? games.reduce((s, g) => s + n(g.fp), 0) / games.length : null);
const addDays = (date, days) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

/**
 * Salaries on saved slates in the SALARY_WINDOW_DAYS before the slate date:
 * Map(player_key -> [{ game_date, salary }], most recent first).
 */
export async function loadSalaryHistory(keys, { site, beforeDate }) {
  const list = [...new Set(keys.filter(Boolean))];
  const rows = [];
  for (let i = 0; i < list.length; i += CHUNK) {
    const chunk = list.slice(i, i + CHUNK);
    rows.push(...await db.all(`
      SELECT player_key, game_date, MAX(salary) AS salary FROM slate_player_snapshots
      WHERE player_key IN (${chunk.map(() => '?').join(', ')})
        AND site = ? AND game_date < ? AND game_date >= ? AND salary > 0
      GROUP BY player_key, game_date`, ...chunk, site, beforeDate, addDays(beforeDate, -SALARY_WINDOW_DAYS)));
  }
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.player_key)) map.set(r.player_key, []);
    map.get(r.player_key).push({ game_date: toDateStr(r.game_date), salary: Number(r.salary) });
  }
  for (const history of map.values()) history.sort((a, b) => (a.game_date < b.game_date ? 1 : -1));
  return map;
}

const empty = (reason, extra = {}) => ({
  salary_change_l1: null, salary_change: null, salary_slates: 0,
  fp_l5: null, fp_prior_l5: null, production_change: null, production_change_pct: null,
  production_spans_seasons: null, salary_lag: null, salary_lag_reason: reason, ...extra
});

/**
 * Salary lag for one player.
 * @param {{ salary: number, history: {game_date, salary}[], games: object[] }} input
 *   history: earlier slates, most recent first; games: regular-season games
 *   before the slate date with `fp`, most recent first
 */
export function computeSalaryLag({ salary, history = [], games = [] }) {
  const current = n(salary);
  if (!(current > 0)) return empty('no_salary');

  const l5 = games.slice(0, 5);
  const prior = games.slice(5, 10);
  const fpL5 = l5.length === 5 ? avgFp(l5) : null;
  const fpPrior = prior.length >= PRIOR_MIN_GAMES ? avgFp(prior) : null;
  const change = fpL5 !== null && fpPrior !== null ? fpL5 - fpPrior : null;
  const production = {
    fp_l5: round(fpL5, 1),
    fp_prior_l5: round(fpPrior, 1),
    production_change: round(change, 1),
    production_change_pct: change !== null && fpPrior > 0 ? round(change / fpPrior, 3) : null,
    production_spans_seasons: l5.length || prior.length ? new Set([...l5, ...prior].map(g => g.season)).size > 1 : null
  };

  const slates = history.slice(0, SALARY_SLATES);
  if (!slates.length) return { ...empty('no_prior_snapshots'), ...production };
  const salaryChange = current - slates[slates.length - 1].salary;
  const salaries = {
    salary_change_l1: current - slates[0].salary,
    salary_change: salaryChange,
    salary_slates: slates.length
  };
  if (change === null) return { ...empty('insufficient_games'), ...production, ...salaries };

  const up = change >= PRODUCTION_UP_POINTS && fpPrior > 0 && change / fpPrior >= PRODUCTION_UP_PCT;
  return {
    ...salaries,
    ...production,
    salary_lag: up && salaryChange <= SALARY_FLAT,
    salary_lag_reason: null
  };
}

export default { loadSalaryHistory, computeSalaryLag };
