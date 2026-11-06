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
 * By slate size (runSlateSizeBacktest): every saved classic slate, main and
 * non-main, split into small (1-3 games) / medium (4-7) / large (8+); each
 * player is scored with the old slate-agnostic rules (buildVerdict without
 * context) and the new slate-aware ones on the same signals, so the two
 * tables differ only by the rules.
 *
 * Read-only. Reporting only - the rules are not tuned here.
 */

import db from '../../config/database.js';
import { getSiteConfig } from '../../config/sites.js';
import { easternDate } from '../slateSnapshotService.js';
import { VERDICTS, STUD_SALARY, isOut, buildVerdict } from './verdict.js';
import { resolveSlate, loadActuals } from '../slateSource.js';
import { listMainSlates } from '../modelEval/modelEvalService.js';
import { getSlateVerdicts, computeSlateVerdicts } from './slateVerdicts.js';

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

// --- By slate size: old (slate-agnostic) vs new (slate-aware) rules --------------------------

export const SIZE_BUCKETS = ['small', 'medium', 'large'];
export const SIZE_LABELS = { small: '1-3 games', medium: '4-7 games', large: '8+ games' };

/**
 * Every saved slate of the site (main and non-main) with snapshot rows, before
 * today: [{ date, slateId, name, games, isMain }].
 */
export async function listBacktestSlates({ site = 'draftkings', dates = null, mainOnly = false, now = new Date() } = {}) {
  const rows = await db.all(`
    SELECT DISTINCT c.game_date, c.slate_id, c.name, c.games, c.is_main FROM slate_catalog c
    WHERE c.site = ? AND c.game_date < ? AND COALESCE(c.contest_type, 'classic') = 'classic'
      ${mainOnly ? 'AND c.is_main = 1' : ''}
      AND EXISTS (SELECT 1 FROM slate_player_snapshots s WHERE s.site = c.site AND s.slate_id = c.slate_id AND s.game_date = c.game_date)
    ORDER BY c.game_date, c.slate_id`, getSiteConfig(site).key, easternDate(now));
  return rows.map(r => ({
    date: String(r.game_date).slice(0, 10), slateId: String(r.slate_id), name: r.name ?? null,
    games: r.games ?? null, isMain: Boolean(r.is_main),
  })).filter(s => !dates || dates.includes(s.date));
}

/**
 * One row per player of a computed slate (computeSlateVerdicts rows) with both
 * rule sets: cash / gpp = slate-aware (as served), legacy = buildVerdict on the
 * same signals without slate context. Exclusions as joinRows.
 */
export function joinSizedRows({ date, slateId, isMain, slate, rows, actuals }) {
  return rows.map(({ p, a }) => {
    const salary = Number(a.salary) || null;
    const blend = a.projection?.blend ?? a.projection?.active ?? null;
    const act = actuals.get(p.id) ?? actuals.get(String(p.id));
    const legacy = buildVerdict(a.signals);
    const row = {
      date, slateId, isMain, sizeBucket: slate?.sizeBucket ?? null, games: slate?.gameCount ?? null,
      id: p.id, name: p.name, salary, injury_status: p.injury_status ?? null,
      projection: blend,
      actual: act?.actualPoints ?? 0,
      status: act?.resultStatus ?? 'NO_BOX_SCORE',
      cash: pickVerdict(a.verdict.cash),
      gpp: pickVerdict(a.verdict.gpp),
      legacy: { cash: pickVerdict(legacy.cash), gpp: pickVerdict(legacy.gpp) },
    };
    if (!salary) row.excluded = 'no_salary';
    else if (isOut(p.injury_status)) row.excluded = 'out';
    else if (!(Number(a.projection?.active) > 0) || blend === null) row.excluded = 'no_projection';
    return row;
  });
}

const pickVerdict = ({ verdict, score, confidence }) => ({ verdict, score, confidence });

/** Old-vs-new report per slate-size bucket (and all buckets together). */
export function buildSizeReport(allRows, { slates = [], projectionSource = null } = {}) {
  const rows = allRows.filter(r => !r.excluded);
  const legacyView = (rs) => rs.map(r => ({ ...r, cash: r.legacy.cash, gpp: r.legacy.gpp }));
  const section = (rs) => ({
    slates: new Set(rs.map(r => `${r.date}|${r.slateId}`)).size,
    players: rs.length,
    old: Object.fromEntries(MODES.map(m => [m, modeReport(legacyView(rs), m)])),
    new: Object.fromEntries(MODES.map(m => [m, modeReport(rs, m)])),
    changed: Object.fromEntries(MODES.map(m => [m, rs.filter(r => r[m].verdict !== r.legacy[m].verdict).length])),
    transitions: Object.fromEntries(MODES.map(m => {
      const t = {};
      for (const r of rs) {
        if (r[m].verdict === r.legacy[m].verdict) continue;
        const k = `${r.legacy[m].verdict} -> ${r[m].verdict}`;
        t[k] = (t[k] ?? []).concat(r);
      }
      return [m, Object.fromEntries(Object.entries(t).map(([k, v]) => [k, bucketStats(v)]))];
    })),
  });
  return {
    generatedAt: new Date().toISOString(),
    projectionSource,
    slates,
    players: rows.length,
    excluded: allRows.filter(r => r.excluded).length,
    buckets: Object.fromEntries(SIZE_BUCKETS.map(b => [b, { label: SIZE_LABELS[b], ...section(rows.filter(r => r.sizeBucket === b)) }])),
    all: section(rows),
  };
}

/**
 * Run both rule sets on every saved slate (main and non-main unless mainOnly)
 * as of its date and build the by-size report. Read-only.
 */
export async function runSlateSizeBacktest({
  site = 'draftkings', dates = null, mainOnly = false, projectionSource = null, now = new Date(), onSlate = null,
} = {}) {
  const slates = await listBacktestSlates({ site, dates, mainOnly, now });
  const allRows = [];
  const done = [];
  for (const s of slates) {
    const t0 = performance.now();
    const source = await resolveSlate({ slateId: s.slateId, slateDate: s.date, site, now });
    if (!source) continue;
    const { prep, rows } = await computeSlateVerdicts(source, { projectionSource, now });
    const actuals = await loadActuals(source, rows.map(({ p, a }) => ({ id: p.id, player_key: a.key, name: p.name })));
    const joined = joinSizedRows({ date: s.date, slateId: s.slateId, isMain: s.isMain, slate: prep.slate, rows, actuals });
    allRows.push(...joined);
    const info = {
      ...s, gameCount: prep.slate?.gameCount ?? null, sizeBucket: prep.slate?.sizeBucket ?? null,
      avgOwnership: prep.slate?.ownership?.avg ?? null, players: joined.length, warnings: prep.warnings,
      ms: Math.round(performance.now() - t0),
    };
    done.push(info);
    onSlate?.(info);
  }
  return { report: buildSizeReport(allRows, { slates: done, projectionSource }), rows: allRows };
}

export default {
  runVerdictBacktest, runSlateSizeBacktest, buildReport, buildSizeReport, modeReport, bucketStats, joinRows, joinSizedRows, correlation,
};
