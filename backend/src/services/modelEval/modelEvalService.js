/**
 * MODEL EVALUATION SERVICE
 *
 * The bar every projection model (ours, RotoWire, blends) is judged by.
 * Read-only on the database.
 *
 *   replay  walk-forward over every date in historical_games (regular season,
 *           play-in, playoffs): each projector sees only rows before the date
 *           (featureStore.asOf). Segments by season: train (fit() sees only
 *           rows before the first validation season), validation, holdout.
 *           Universe: every player who played plus coach's-decision DNPs.
 *   slate   the saved main slates (slate_catalog.is_main): every snapshot
 *           player, DNPs scoring 0, head to head with RotoWire (raw and
 *           sanity-adjusted).
 *
 * Both report a leaderboard on the rows every projector covered (MAE, RMSE,
 * bias, R^2, correlation, minutes MAE, p10 / p90 coverage, per-stat MAE),
 * a paired bootstrap 95% CI on the MAE difference vs a baseline, points and
 * minutes (clustered by date in replay), breakdowns (minutes bucket, role,
 * archetype, rest, teammate out, blowout, salary tier on slates, and players
 * who beat the reference projection's minutes by 3+: RotoWire on slates,
 * minutes_model in replay) and, on slates, the top-20 value hit rate (5x).
 * Extra paired comparisons (options.comparisons, [a, b] pairs) and
 * projector analyses (projector.analyze(rows): e.g. rates_v1's rate quality
 * at actual minutes) are added per segment / for the slates.
 *
 * Predictions of cacheable projectors are cached on disk per projector
 * version and data signature (cacheDir/predictions), so a re-run only
 * computes new or changed projectors.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import db from '../../config/database.js';
import { getSiteConfig } from '../../config/sites.js';
import { projectionSanityConfig } from '../../config/projectionSanity.js';
import { isOutStatus } from '../minutesModel.js';
import { easternDate } from '../slateSnapshotService.js';
import { loadSlatePlayers, resolveSlate } from '../slateSource.js';
import { canonicalTeam } from '../../utils/playerKey.js';
import { seasonStartDate } from '../../utils/season.js';
import { createFeatureStore, STAT_FIELDS } from './featureStore.js';
import { createProjector, DEFAULT_PROJECTORS, listProjectors } from './projectors.js';
import { fitProjectors, runReplay, runSlates, segmentBySeason, summarizeRows, withPredictionCache } from './evaluate.js';
import { baseHitRate, valueHitRate } from './metrics.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_CACHE_DIR = path.resolve(__dirname, '../../../.cache/model-eval');
// Bump when the feature store changes what projectors see (invalidates cached predictions)
export const FEATURE_VERSION = '2';

export const DEFAULTS = Object.freeze({
  mode: 'both',
  site: 'draftkings',
  trainSeasons: ['2024-25'],
  validationSeasons: ['2025-26'],
  replayBaseline: 'legacy',
  slateBaseline: 'rotowire_raw',
  iterations: 1000,
  seed: 1,
  valueTop: 20,
  valueMultiple: 5,
  cache: true,
  comparisons: [
    ['rates_v1', 'minutes_v2'],
    ['rates_v1', 'rotowire_raw'],
    ['rates_v1_rotowire_minutes', 'rotowire_raw'],
    ['rates_v1_rotowire_minutes', 'rotowire_minutes_x_fppm']
  ]
});

export const LOOKAHEAD_NOTES = Object.freeze([
  'Every feature is built from rows strictly before the game date (featureStore.asOf); tests poison all rows on/after D and assert identical features.',
  'Season profiles, archetypes and archetype defense are rebuilt as-of each date with the same code that fills player_season_profiles / player_archetypes / team_archetype_defense; the stored current-season rows (full-season) are never read.',
  'Legacy model: team_defense_rankings and team_defense_vs_position hold current values only, so the defense, pace and legacy position-DVP adjustments are excluded (0); the archetype DVP is as-of.',
  'Same-day inputs (known at lock): opponent, home/away, team rest from the schedule, and OUT lists - the game\'s INACTIVE listing, plus in replay regulars missing from both box score and listing (inferred, as projectionReplayBacktest); on slates the OUT injury statuses and regulars missing from the slate pool (RotoWire omits OUT players) instead of the box-score inference.',
  'Replay has no Vegas lines, salaries or RotoWire projections; those exist only on the saved slates.',
  'Breakdown tags use the game\'s start flag for role (confirmed lineups are known near lock); projectors never see it.'
]);

const PLAYER_COLUMNS = `id, game_id, game_date, season, season_type, player_key, player_name, team, opponent, position,
  is_home, is_starter, is_back_to_back, minutes, points, rebounds, assists, steals, blocks, turnovers, fouls,
  fg_made, fg_attempted, fg3_made, fg3_attempted, ft_made, ft_attempted, oreb, dreb,
  dk_fantasy_points, fd_fantasy_points, yahoo_fantasy_points`;

/** Everything the feature store indexes, in one pass. */
export async function loadFeatureData({ site = DEFAULTS.site } = {}) {
  const [games, teamGames, statuses] = await Promise.all([
    db.all(`SELECT ${PLAYER_COLUMNS} FROM historical_games WHERE player_key IS NOT NULL ORDER BY game_date, id`),
    db.all('SELECT * FROM team_game_stats ORDER BY game_date, id'),
    db.all('SELECT game_id, game_date, team, player_key, player_name, status, reason FROM game_player_status')
  ]);
  return { site: getSiteConfig(site).key, games, teamGames, statuses };
}

/** Short hash of what the data and the harness are, for cache keys. */
export async function dataSignature() {
  const parts = [FEATURE_VERSION];
  for (const [table, col] of [['historical_games', 'id'], ['team_game_stats', 'id'], ['game_player_status', 'id'], ['slate_player_snapshots', 'captured_at']]) {
    const r = await db.get(`SELECT COUNT(*) AS c, MAX(${col}) AS m FROM ${table}`);
    parts.push(`${table}:${r?.c}:${r?.m}`);
  }
  return crypto.createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 12);
}

/** Saved main slates before today: [{ date, slateId }]. */
export async function listMainSlates({ site = DEFAULTS.site, dates = null, now = new Date() } = {}) {
  const rows = await db.all(`
    SELECT DISTINCT c.game_date, c.slate_id FROM slate_catalog c
    WHERE c.site = ? AND c.is_main = 1 AND c.game_date < ?
      AND EXISTS (SELECT 1 FROM slate_player_snapshots s WHERE s.site = c.site AND s.slate_id = c.slate_id)
    ORDER BY c.game_date`, getSiteConfig(site).key, easternDate(now));
  return rows.map(r => ({ date: String(r.game_date).slice(0, 10), slateId: String(r.slate_id) }))
    .filter(s => !dates || dates.includes(s.date));
}

const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

/**
 * Slate fields a projector sees (ctx.slate) for one players-table / snapshot
 * row: p posted, a the same row after the sanity layer.
 */
export function slateFields(p, a = p) {
  return {
    salary: num(p.salary),
    rotowire: num(p.projected_points),
    rotowireMinutes: num(p.projected_minutes),
    floor: num(p.floor),
    ceiling: num(p.ceiling),
    adjusted: num(a.projected_points),
    adjustedMinutes: num(a.projected_minutes),
    adjustedFloor: num(a.floor),
    adjustedCeiling: num(a.ceiling),
    spread: num(p.vegas_spread),
    impliedTotal: num(p.vegas_implied_total),
    overUnder: num(p.vegas_over_under),
    injuryStatus: p.injury_status ?? null,
    ownership: num(p.rostership),
    leverage: num(p.leverage_score)
  };
}

/**
 * One saved slate as runSlates input: snapshot players (raw and with the
 * sanity layer) with outcomes from the store's box scores; players whose
 * team has no result for the date (postponed / not synced) are left out.
 */
export async function loadSlate(store, { date, slateId, site = DEFAULTS.site }) {
  const source = await resolveSlate({ slateDate: date, slateId, site });
  const raw = await loadSlatePlayers(source, { includeZero: true, sanity: false });
  const adjusted = new Map((await loadSlatePlayers(source, { includeZero: true, sanity: true })).map(p => [p.id, p]));
  const day = store.gameDay(date);
  const box = new Map(day.players.map(p => [`${p.team}|${p.key}`, p]));
  const zero = { dk: 0, minutes: 0, ...Object.fromEntries(Object.keys(STAT_FIELDS).map(k => [k, 0])) };
  const players = [];
  let pending = 0;
  for (const p of raw) {
    const team = canonicalTeam(p.team);
    const t = day.teams.get(team);
    if (!t) { pending++; continue; }
    const result = box.get(`${team}|${p.player_key}`);
    const a = adjusted.get(p.id) ?? p;
    players.push({
      key: p.player_key,
      name: p.name,
      team,
      opponent: canonicalTeam(p.opponent) ?? t.opponent,
      position: p.position,
      isHome: t.isHome,
      seasonType: result?.seasonType ?? 'regular',
      out: isOutStatus(p.injury_status),
      slate: slateFields(p, a),
      outcome: result
        ? { played: result.played, status: result.status, actual: result.actual, isStarter: result.isStarter }
        : { played: false, status: 'DNP', actual: zero, isStarter: false }
    });
  }
  return { date, slateId: String(source.slateId), players, pending };
}

function readCache(file) {
  try {
    return new Map(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch {
    return new Map();
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
}

const ms = (t0) => Date.now() - t0;

/**
 * Run the harness.
 * @param {Object} options
 * @param {'replay'|'slate'|'both'} [options.mode='both']
 * @param {string[]} [options.projectors] - registered names (default: all)
 * @param {string[]} [options.seasons] - replay seasons (default: all)
 * @param {string} [options.from] / [options.to] - replay date range
 * @param {string[]} [options.slateDates] - limit slate mode to these dates
 * @param {string} [options.replayBaseline='legacy'] / [options.slateBaseline='rotowire_raw']
 * @param {string[]} [options.trainSeasons=['2024-25']] / [options.validationSeasons=['2025-26']]
 * @param {Array<string[]>} [options.comparisons] - extra paired bootstraps [a, b] (skipped when either is not run)
 * @param {number} [options.iterations=1000] - bootstrap resamples
 * @param {boolean} [options.cache=true] - reuse / save cached predictions
 * @param {string} [options.cacheDir]
 * @param {boolean} [options.includeRows=false] - add every scored row to the report
 * @param {Function} [options.onProgress] - (message) => void
 * @param {Object} [options.store] - a prebuilt feature store (tests)
 */
export async function runModelEval(options = {}) {
  const o = { ...DEFAULTS, ...Object.fromEntries(Object.entries(options).filter(([, v]) => v !== undefined && v !== null)) };
  const site = getSiteConfig(o.site).key;
  const progress = o.onProgress ?? (() => {});
  const cacheDir = o.cacheDir ?? DEFAULT_CACHE_DIR;
  const tStart = Date.now();
  const timings = {};

  let t0 = Date.now();
  let store = o.store;
  if (!store) {
    const data = await loadFeatureData({ site });
    timings.loadMs = ms(t0);
    t0 = Date.now();
    store = createFeatureStore(data);
    timings.indexMs = ms(t0);
  }
  const signature = o.store ? 'custom' : await dataSignature();

  const names = o.projectors?.length ? o.projectors : DEFAULT_PROJECTORS;
  const caches = new Map();
  const projectors = names.map(name => {
    const p = createProjector(name);
    if (!o.cache || !p.cacheable || o.store) return p;
    const file = path.join(cacheDir, 'predictions', `${name}-v${p.version}-${site}-${signature}.json`);
    const cache = readCache(file);
    caches.set(name, { file, cache, size: cache.size });
    return withPredictionCache(p, cache);
  });

  t0 = Date.now();
  const until = seasonStartDate(o.validationSeasons[0]);
  timings.fit = await fitProjectors(store, projectors, { until, seasons: o.trainSeasons });
  timings.fitMs = ms(t0);

  const report = {
    generatedAt: new Date().toISOString(),
    site,
    signature,
    options: {
      mode: o.mode, projectors: names, seasons: o.seasons ?? null, from: o.from ?? null, to: o.to ?? null,
      slateDates: o.slateDates ?? null, trainSeasons: o.trainSeasons, validationSeasons: o.validationSeasons,
      replayBaseline: o.replayBaseline, slateBaseline: o.slateBaseline, iterations: o.iterations, seed: o.seed, comparisons: o.comparisons,
      sanityConfig: projectionSanityConfig()
    },
    projectors: listProjectors().filter(p => names.includes(p.name)),
    notes: LOOKAHEAD_NOTES,
    timings
  };

  const analyze = async (rows, names, cluster) => {
    const out = {};
    for (const p of projectors) {
      if (!p.analyze || !names.includes(p.name)) continue;
      const a = await p.analyze(rows, { name: p.name, site, cluster, iterations: o.iterations, seed: o.seed });
      if (a) out[p.name] = a;
    }
    return Object.keys(out).length ? out : undefined;
  };

  try {
    if (o.mode === 'replay' || o.mode === 'both') {
      t0 = Date.now();
      const replayNames = projectors.filter(p => p.modes.includes('replay')).map(p => p.name);
      const { rows, dates, timings: per } = await runReplay(store, projectors, {
        from: o.from, to: o.to, seasons: o.seasons,
        onDate: (date, i, total) => { if (i % 25 === 0) progress(`replay ${date} (${i + 1}/${total})`); }
      });
      const baseline = replayNames.includes(o.replayBaseline) ? o.replayBaseline : null;
      const segments = [];
      for (const seg of segmentBySeason(rows, { train: o.trainSeasons, validation: o.validationSeasons })) {
        segments.push({
          season: seg.season,
          role: seg.role,
          dates: new Set(seg.rows.map(r => r.date)).size,
          ...summarizeRows(seg.rows, replayNames, {
            baseline, iterations: o.iterations, seed: o.seed, cluster: r => r.date, comparisons: o.comparisons,
            minutesReference: replayNames.includes('minutes_model') ? 'minutes_model' : null
          }),
          analysis: await analyze(seg.rows, replayNames, r => r.date)
        });
      }
      report.replay = { dates, baseline, segments };
      if (o.includeRows) report.replay.rows = rows;
      timings.replay = { totalMs: ms(t0), perProjectorMs: per };
    }

    if (o.mode === 'slate' || o.mode === 'both') {
      t0 = Date.now();
      const list = await listMainSlates({ site, dates: o.slateDates });
      const slates = [];
      for (const s of list) slates.push(await loadSlate(store, { ...s, site }));
      timings.slateLoadMs = ms(t0);
      t0 = Date.now();
      const slateNames = projectors.filter(p => p.modes.includes('slate')).map(p => p.name);
      const { rows, timings: per } = await runSlates(store, projectors, slates, { onSlate: s => progress(`slate ${s.date} (${s.slateId})`) });
      const baseline = slateNames.includes(o.slateBaseline) ? o.slateBaseline : null;
      const summary = summarizeRows(rows, slateNames, {
        baseline, iterations: o.iterations, seed: o.seed, comparisons: o.comparisons,
        minutesReference: slateNames.includes('rotowire_raw') ? 'rotowire_raw' : null
      });
      summary.analysis = await analyze(rows, slateNames, null);
      const common = rows.filter(r => slateNames.every(name => r.preds[name]));
      report.slate = {
        baseline,
        slates: slates.map(s => {
          const sr = common.filter(r => r.slateId === s.slateId);
          return {
            date: s.date, slateId: s.slateId, players: s.players.length, played: s.players.filter(p => p.outcome.played).length,
            pending: s.pending,
            maeWithDnp: Object.fromEntries(slateNames.map(name => [name, summarizeMae(sr, name)]))
          };
        }),
        ...summary,
        valueHit: {
          top: o.valueTop,
          multiple: o.valueMultiple,
          baseRate: baseHitRate(common, { multiple: o.valueMultiple }),
          projectors: slateNames.map(name => ({ projector: name, ...valueHitRate(common, name, { top: o.valueTop, multiple: o.valueMultiple }) }))
            .sort((a, b) => (b.rate ?? -1) - (a.rate ?? -1))
        }
      };
      if (o.includeRows) report.slate.rows = rows;
      timings.slate = { totalMs: ms(t0), perProjectorMs: per };
    }
  } finally {
    for (const p of projectors) await p.finish?.();
  }

  for (const [name, c] of caches) {
    if (c.cache.size !== c.size) writeJson(c.file, [...c.cache]);
    timings.cache = { ...(timings.cache ?? {}), [name]: { reused: c.size, added: c.cache.size - c.size } };
  }
  timings.totalMs = ms(tStart);
  return report;
}

function summarizeMae(rows, name) {
  const valid = rows.filter(r => r.preds[name]);
  if (!valid.length) return null;
  return Math.round((valid.reduce((s, r) => s + Math.abs(r.preds[name].dk_points - r.actual.dk), 0) / valid.length) * 1000) / 1000;
}

/** Write a report as JSON (default under the gitignored cache dir). Returns the path. */
export function writeReport(report, file = null) {
  const out = file ?? path.join(DEFAULT_CACHE_DIR, 'reports', `model-eval-${report.generatedAt.replace(/[:.]/g, '-')}.json`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(report, null, 2));
  return out;
}

export default { runModelEval, writeReport, loadFeatureData, listMainSlates, loadSlate, dataSignature };
