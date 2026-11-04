/**
 * VERDICT BACKTEST
 *
 * How the player-card verdicts (slateVerdicts.js) did on saved main slates:
 * every slate's verdicts as of its date joined to actual DK points
 * (historical_games; no box score = 0 / DNP), then per verdict bucket and per
 * cash / GPP: n, avg actual, avg actual - blend projection, avg value (pts per
 * $1K), % hitting 5x, % hitting 6x (boom), plus the correlation of the score
 * with actual - projection. By salary tier and for studs ($9.5K+) too.
 *
 * Players listed OUT (forced Fade) and players without a projection are not
 * in the buckets: they would only flatter the Fade bucket. They are counted.
 *
 * Read-only. Reporting only - the rules are not tuned here.
 */

import { VERDICTS, STUD_SALARY, isOut } from './verdict.js';
import { resolveSlate, loadActuals } from '../slateSource.js';
import { listMainSlates } from '../modelEval/modelEvalService.js';
import { getSlateVerdicts } from './slateVerdicts.js';

export const MODES = ['cash', 'gpp'];
export const SALARY_TIERS = [
  { key: 'under_5k', label: '< $5K', min: 0, max: 4999 },
  { key: '5k_7k', label: '$5K-6.9K', min: 5000, max: 6999 },
  { key: '7k_9k', label: '$7K-9.4K', min: 7000, max: STUD_SALARY - 1 },
  { key: 'studs', label: '$9.5K+ (studs)', min: STUD_SALARY, max: Infinity },
];

const r2 = (x) => (x === null || !Number.isFinite(x) ? null : Math.round(x * 100) / 100 + 0);
const r3 = (x) => (x === null || !Number.isFinite(x) ? null : Math.round(x * 1000) / 1000 + 0);
const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);

/** Pearson correlation of two equal-length arrays (null under 3 points or no variance). */
export function correlation(xs, ys) {
  const n = xs.length;
  if (n < 3 || ys.length !== n) return null;
  const mx = mean(xs);
  const my = mean(ys);
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) ** 2;
    syy += (ys[i] - my) ** 2;
  }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : null;
}

/**
 * One row per scored player: { date, slateId, name, salary, injury_status,
 * projection (blend), actual, cash: {verdict, score, confidence}, gpp }.
 * excluded rows carry `excluded: 'out' | 'no_projection' | 'no_salary'`.
 */
export function joinRows({ date, slateId, verdicts, actuals }) {
  return Object.values(verdicts.players).map(e => {
    const salary = Number(e.salary) || null;
    const blend = e.projection?.blend ?? e.projection?.active ?? null;
    const a = actuals.get(e.id) ?? actuals.get(String(e.id));
    const row = {
      date, slateId, id: e.id, name: e.name, team: e.team, salary,
      injury_status: e.injury_status ?? null,
      projection: blend,
      actual: a?.actualPoints ?? 0,
      status: a?.resultStatus ?? 'NO_BOX_SCORE',
      cash: e.cash,
      gpp: e.gpp,
    };
    if (!salary) row.excluded = 'no_salary';
    else if (isOut(e.injury_status)) row.excluded = 'out';
    else if (!(Number(e.projection?.active) > 0) || blend === null) row.excluded = 'no_projection';
    return row;
  });
}

/** Bucket stats for rows (already filtered): n, avg actual, avg actual - projection, value, 5x / 6x rates. */
export function bucketStats(rows) {
  if (!rows.length) return { n: 0, avg_actual: null, avg_vs_projection: null, avg_value: null, hit5x: null, hit6x: null, avg_salary: null };
  const k = (r) => r.salary / 1000;
  return {
    n: rows.length,
    avg_actual: r2(mean(rows.map(r => r.actual))),
    avg_vs_projection: r2(mean(rows.map(r => r.actual - r.projection))),
    avg_value: r2(mean(rows.map(r => r.actual / k(r)))),
    hit5x: r3(rows.filter(r => r.actual >= k(r) * 5).length / rows.length),
    hit6x: r3(rows.filter(r => r.actual >= k(r) * 6).length / rows.length),
    avg_salary: Math.round(mean(rows.map(r => r.salary))),
  };
}

/** Per mode: every verdict bucket's stats + the score correlations. */
export function modeReport(rows, mode) {
  const buckets = Object.fromEntries(VERDICTS.map(v => [v, bucketStats(rows.filter(r => r[mode].verdict === v))]));
  const scores = rows.map(r => r[mode].score);
  return {
    buckets,
    all: bucketStats(rows),
    corr_score_vs_projection_miss: r3(correlation(scores, rows.map(r => r.actual - r.projection))),
    corr_score_vs_actual: r3(correlation(scores, rows.map(r => r.actual))),
    corr_score_vs_value: r3(correlation(scores, rows.map(r => r.actual / (r.salary / 1000)))),
  };
}

/** The full report from joined rows. */
export function buildReport(allRows, { slates = [], projectionSource = null } = {}) {
  const rows = allRows.filter(r => !r.excluded);
  const excluded = {};
  for (const r of allRows) if (r.excluded) excluded[r.excluded] = (excluded[r.excluded] ?? 0) + 1;
  const report = {
    generatedAt: new Date().toISOString(),
    projectionSource,
    slates,
    players: rows.length,
    excluded,
    dnp: rows.filter(r => r.status !== 'PLAYED').length,
    overall: Object.fromEntries(MODES.map(m => [m, modeReport(rows, m)])),
    tiers: Object.fromEntries(SALARY_TIERS.map(t => {
      const inTier = rows.filter(r => r.salary >= t.min && r.salary <= t.max);
      return [t.key, { label: t.label, ...Object.fromEntries(MODES.map(m => [m, modeReport(inTier, m)])) }];
    })),
  };
  report.studs = report.tiers.studs;
  return report;
}

/**
 * Run the verdicts on every saved main slate (as of each date) and build the
 * report. onSlate({ date, slateId, players, ms }) reports progress.
 */
export async function runVerdictBacktest({ site = 'draftkings', dates = null, projectionSource = null, now = new Date(), onSlate = null } = {}) {
  const slates = await listMainSlates({ site, dates, now });
  const allRows = [];
  const done = [];
  for (const { date, slateId } of slates) {
    const t0 = performance.now();
    const verdicts = await getSlateVerdicts({ slateId, slateDate: date, projectionSource, detail: true, now });
    const source = await resolveSlate({ slateId, slateDate: date, now });
    const actuals = await loadActuals(source, Object.values(verdicts.players).map(e => ({ id: e.id, player_key: e.player_key, name: e.name })));
    const rows = joinRows({ date, slateId, verdicts, actuals });
    allRows.push(...rows);
    const info = { date, slateId, players: rows.length, warnings: verdicts.warnings, ms: Math.round(performance.now() - t0) };
    done.push(info);
    onSlate?.(info);
  }
  return { report: buildReport(allRows, { slates: done, projectionSource }), rows: allRows };
}

export default { runVerdictBacktest, buildReport, modeReport, bucketStats, joinRows, correlation };
