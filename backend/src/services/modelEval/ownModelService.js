/**
 * OWN MODEL FOR A LIVE SLATE (M4): projectSlateOwnModel(slateId).
 * GET /api/projections/:slateId/own-model. Read-only on the database; not
 * wired into the UI or the optimizer defaults (M5).
 *
 * Per player, from point-in-time features of the slate's date (the feature
 * store as of the date: history strictly before it, plus the slate's pre-lock
 * fields - salary, Vegas, injury statuses, RotoWire's projection; no outcome):
 *   ours_minutes, p_play, ours_mean (DK mean incl. DNP), ours_median, p10, p90,
 *   p_boom (P(DK >= 6x salary)), p_dd  - ownModel.ownPrediction
 *   blend_point (+ its p10 / p90 / p_boom)  - the blend chosen by the M4
 *     backtest, weights in ownModelWeights.json (npm run backtest:own-model --
 *     --write-weights); null without that file
 *   disagreement  ours vs RotoWire (sanity-adjusted) in minutes and DK points,
 *     the lean bucket and how that bucket's calls did on the saved slates
 *
 * The models are the harness fits (2024-25, the evaluated configuration),
 * cached on disk per training data; the feature store is cached in memory per
 * data signature, and results per slate + data + slate rows + weights.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import db from '../../config/database.js';
import { getSiteConfig } from '../../config/sites.js';
import { isOutStatus } from '../minutesModel.js';
import { easternDate, isHomeFlag } from '../slateSnapshotService.js';
import { loadSlatePlayers, resolveSlate } from '../slateSource.js';
import { canonicalTeam, playerKey } from '../../utils/playerKey.js';
import { seasonStartDate } from '../../utils/season.js';
import { createFeatureStore } from './featureStore.js';
import { dataSignature, DEFAULT_CACHE_DIR, DEFAULTS, FEATURE_VERSION, loadFeatureData, slateFields } from './modelEvalService.js';
import { slateDay } from './evaluate.js';
import { createOwnModelProjector, ownPrediction, prepareOwnMaps } from './ownModel.js';
import { blendPrediction, leanBucket } from './blend.js';
import { WEIGHTS_FILE } from './ownModelBacktest.js';

export const MODEL_VERSION = '1';
const TEAMMATE_OUT_MINUTES = 20;
const RESULT_CACHE = 8;

const round = (v, d = 2) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d : null);
const ms = (t0) => Date.now() - t0;

let storeCache = null;      // { signature, store }
let modelCache = null;      // { key, models }
const results = new Map();  // key -> result

/** Read the blend weights artifact (null when missing / unreadable). */
export function readWeights(file = WEIGHTS_FILE) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

async function featureStore(site, signature, timings) {
  if (storeCache?.signature === signature && storeCache.site === site) return storeCache.store;
  const t0 = Date.now();
  const store = createFeatureStore(await loadFeatureData({ site }));
  timings.loadStoreMs = ms(t0);
  storeCache = { site, signature, store };
  return store;
}

/** Hash of the training window's data (rows before the validation season) and the model configuration. */
async function trainingKey(site, until) {
  const parts = [MODEL_VERSION, FEATURE_VERSION, site, until, DEFAULTS.trainSeasons.join(',')];
  for (const [table, col] of [['historical_games', 'id'], ['team_game_stats', 'id'], ['game_player_status', 'id']]) {
    const r = await db.get(`SELECT COUNT(*) AS c, MAX(${col}) AS m FROM ${table} WHERE game_date < ?`, until);
    parts.push(`${table}:${r?.c}:${r?.m}`);
  }
  return crypto.createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 12);
}

/** The fitted rates_v1 / minutes_v2 models (memory, else disk, else fit and save). */
async function fittedModels(store, site, { cacheDir = DEFAULT_CACHE_DIR } = {}, timings = {}) {
  const until = seasonStartDate(DEFAULTS.validationSeasons[0]);
  const key = await trainingKey(site, until);
  if (modelCache?.key === key) return modelCache.models;
  const file = path.join(cacheDir, 'models', `own-model-v${MODEL_VERSION}-${key}.json`);
  let models = null;
  try {
    models = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    const t0 = Date.now();
    const p = createOwnModelProjector();
    await p.fit({ store: store.restrictTo(until), until, seasons: DEFAULTS.trainSeasons, site });
    models = { rates: p.model(), minutes: p.minutesModel() };
    timings.fitMs = ms(t0);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(models));
  }
  modelCache = { key, models };
  return models;
}

async function slateSignature(source) {
  const r = source.isBacktest
    ? await db.get('SELECT COUNT(*) AS c, MAX(captured_at) AS m FROM slate_player_snapshots WHERE slate_id = ? AND game_date = ?', source.slateId, source.slateDate)
    : await db.get('SELECT COUNT(*) AS c, MAX(updated_at) AS m, SUM(projected_points) AS s FROM players WHERE slate_id = ?', source.slateId);
  return `${r?.c}:${r?.m}:${r?.s ?? ''}`;
}

/** One player's output from ours, RotoWire (adjusted) and the blend weights. */
export function playerOutput(entry, ownPred, weights) {
  const s = entry.slate;
  const rw = Number.isFinite(s.adjusted) ? { dk_points: s.adjusted, minutes: s.adjustedMinutes } : null;
  const x = { own: ownPred, rw, salary: s.salary, teammateOut: entry.teammateOut };
  const b = ownPred && weights?.blend ? blendPrediction(x, weights.blend) : null;
  const pointsDiff = ownPred && rw ? ownPred.dk_points - rw.dk_points : null;
  const minutesDiff = ownPred && rw && Number.isFinite(rw.minutes) ? ownPred.minutes - rw.minutes : null;
  const lean = leanBucket(pointsDiff);
  const minutesLean = leanBucket(minutesDiff);
  const history = (table, bucket) => {
    const h = bucket ? weights?.disagreement?.[table]?.[bucket] : null;
    return h ? { n: h.n, hitRate: h.hitRate, closerRate: h.closerRate } : null;
  };
  return {
    id: entry.id,
    player_key: entry.key,
    name: entry.name,
    team: entry.team,
    opponent: entry.opponent,
    position: entry.position,
    salary: s.salary,
    injury_status: s.injuryStatus,
    rotowire_points: round(s.adjusted),
    rotowire_raw_points: round(s.rotowire),
    rotowire_minutes: round(s.adjustedMinutes, 1),
    ours_minutes: round(ownPred?.minutes, 1),
    p_play: round(ownPred?.p_play, 3),
    ours_mean: round(ownPred?.dk_points),
    ours_median: round(ownPred?.ours_median),
    p10: round(ownPred?.p10),
    p90: round(ownPred?.p90),
    p_boom: round(ownPred?.p_boom, 3),
    boom_at: round(ownPred?.boom_at, 1),
    p_dd: round(ownPred?.p_dd, 3),
    blend_point: round(b?.dk_points),
    blend_p10: round(b?.p10),
    blend_p90: round(b?.p90),
    blend_p_boom: round(b?.p_boom, 3),
    blend_weight: round(b?.weight, 3),
    disagreement: {
      minutes_diff: round(minutesDiff, 1),
      points_diff: round(pointsDiff),
      lean,
      minutes_lean: minutesLean,
      history: history('points', lean),
      minutes_history: history('minutes', minutesLean)
    }
  };
}

/**
 * Own-model projections for a slate. options: { site, refresh, weightsFile,
 * cacheDir, now }. Returns { slateId, date, site, label, generatedAt, cached,
 * weights: { name, generatedAt, slates } | null, timings, players }.
 */
export async function projectSlateOwnModel(slateId, { site = null, refresh = false, weightsFile = WEIGHTS_FILE, cacheDir = DEFAULT_CACHE_DIR, now = new Date() } = {}) {
  const tStart = Date.now();
  const timings = {};
  const source = await resolveSlate({ slateId, site });
  if (!source) throw Object.assign(new Error('No slate'), { status: 404 });
  const siteKey = getSiteConfig(source.site).key;
  const weights = readWeights(weightsFile);
  const signature = await dataSignature();
  const cacheKey = [source.slateId, source.slateDate, siteKey, signature, await slateSignature(source), weights?.generatedAt ?? 'none'].join('|');
  if (!refresh && results.has(cacheKey)) {
    return { ...results.get(cacheKey), cached: true, timings: { totalMs: ms(tStart) } };
  }

  let t0 = Date.now();
  const raw = await loadSlatePlayers(source, { includeZero: true, sanity: false, now });
  const adjusted = new Map((await loadSlatePlayers(source, { includeZero: true, sanity: true, now })).map(p => [p.id, p]));
  timings.slateMs = ms(t0);
  if (!raw.length) throw Object.assign(new Error(`No players for slate ${source.slateId}`), { status: 404 });

  const store = await featureStore(siteKey, signature, timings);
  t0 = Date.now();
  const models = await fittedModels(store, siteKey, { cacheDir }, timings);
  timings.modelsMs = ms(t0);

  t0 = Date.now();
  const date = source.slateDate ?? easternDate(now);
  const players = raw.filter(p => Number(p.salary) > 0).map(p => ({
    id: p.id,
    key: p.player_key ?? playerKey(p.name),
    name: p.name,
    team: canonicalTeam(p.team),
    opponent: canonicalTeam(p.opponent),
    position: p.position,
    isHome: isHomeFlag(p) === 1,
    out: isOutStatus(p.injury_status),
    slate: { ...slateFields(p, adjusted.get(p.id) ?? p), slateId: String(source.slateId) }
  }));
  // Home / away from the box score's schedule when the date has one
  const scheduled = store.gameDay(date).teams;
  for (const p of players) if (scheduled.has(p.team)) p.isHome = scheduled.get(p.team).isHome;
  const { view, day, contexts } = slateDay(store, { date, players });
  const dateCtx = {
    mode: 'slate', date, season: view.season, site: siteKey, view, day,
    players: contexts.map((c, i) => ({ ...c, slate: players[i].slate })),
    shared: new Map(), slate: { slateId: String(source.slateId) }
  };
  const maps = prepareOwnMaps(dateCtx, models);
  const out = players.map((p, i) => {
    const ctx = { ...dateCtx, player: contexts[i], slate: p.slate };
    const own = ownPrediction(ctx, maps, models, { minutesGrid: weights?.blend?.kind === 'minutes' ? undefined : [] });
    const teammateOut = contexts[i].teamOut.some(o => o.expectedMinutes >= TEAMMATE_OUT_MINUTES) ? 'teammate out' : 'none out';
    return playerOutput({ ...p, teammateOut }, own, weights);
  }).sort((a, b) => (b.blend_point ?? b.ours_mean ?? 0) - (a.blend_point ?? a.ours_mean ?? 0));
  timings.projectMs = ms(t0);
  timings.totalMs = ms(tStart);

  const result = {
    slateId: String(source.slateId),
    date,
    site: siteKey,
    label: source.label ?? null,
    isBacktest: Boolean(source.isBacktest),
    generatedAt: new Date().toISOString(),
    cached: false,
    signature,
    weights: weights?.blend ? { name: weights.blend.name, kind: weights.blend.kind, scheme: weights.blend.scheme, generatedAt: weights.generatedAt, slates: weights.slates } : null,
    timings,
    players: out
  };
  results.set(cacheKey, result);
  while (results.size > RESULT_CACHE) results.delete(results.keys().next().value);
  return result;
}

/** Drop the in-memory caches (tests). */
export function clearOwnModelCache() {
  storeCache = null;
  modelCache = null;
  results.clear();
}

export default { projectSlateOwnModel, playerOutput, readWeights, clearOwnModelCache };
