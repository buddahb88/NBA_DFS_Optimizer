/**
 * PROJECTION SOURCE SERVICE
 *
 * Applies sourceLayer.js to slate players (live or a backtest night) with the
 * own model of the slate's date (modelEval/ownModelService.projectSlateOwnModel:
 * point-in-time features, no outcome; cached per slate + data signature).
 *
 * Never breaks a slate read: when the own model throws, or a player has no
 * row, that player keeps RotoWire (projection_fallback, with the reason) and
 * the summary counts it; a console warning names the slate.
 *
 * Summaries per slate are kept for GET /api/projections/source?slateId=
 * (lastSummary) and returned to callers that want them (optimizer response).
 */

import { applySource, FADE_THRESHOLD } from './sourceLayer.js';

const SUMMARY_LIMIT = 20;
const summaries = new Map();      // `${slateId}|${slateDate}` -> summary
const inflight = new Map();       // same key + source -> Promise<own model>

const slateKey = (source) => `${source.slateId}|${source.slateDate ?? ''}`;

async function defaultProject(source, { now }) {
  // Imported late: ownModelService reads slates through slateSource, which calls this service
  const { projectSlateOwnModel } = await import('../modelEval/ownModelService.js');
  return projectSlateOwnModel(source.slateId, { source, now });
}

/** One own-model run per slate at a time (concurrent cold reads share it). */
function ownModel(source, project, now) {
  const key = slateKey(source);
  if (!inflight.has(key)) {
    inflight.set(key, Promise.resolve().then(() => project(source, { now })).finally(() => inflight.delete(key)));
  }
  return inflight.get(key);
}

function remember(source, summary) {
  const key = slateKey(source);
  summaries.delete(key);
  summaries.set(key, summary);
  while (summaries.size > SUMMARY_LIMIT) summaries.delete(summaries.keys().next().value);
}

/**
 * The layer over `players`. projectionSource: 'ours' | 'blend' ('rotowire'
 * returns the players untouched). project: own-model runner (tests).
 * Returns { players, summary: { source, slateId, slateDate, players, applied,
 * fallback, fades, error, cached, modelMs, weights } }.
 */
export async function applyProjectionSource(source, players, {
  projectionSource, now = new Date(), project = defaultProject, threshold = FADE_THRESHOLD
} = {}) {
  const base = { source: projectionSource, slateId: source?.slateId ?? null, slateDate: source?.slateDate ?? null };
  if (!source || projectionSource === 'rotowire' || players.length === 0) {
    return { players, summary: { ...base, players: players.length, applied: 0, fallback: 0, fades: 0, error: null } };
  }

  const t0 = Date.now();
  let model = null;
  let error = null;
  try {
    model = await ownModel(source, project, now);
  } catch (e) {
    error = e?.message || String(e);
    console.warn(`⚠️ Projection source "${projectionSource}": own model failed for slate ${source.slateId}`
      + `${source.slateDate ? ` (${source.slateDate})` : ''}, keeping RotoWire: ${error}`);
  }
  const byId = new Map((model?.players ?? []).map(p => [String(p.id), p]));
  const reason = error ? `own model unavailable: ${error}` : null;
  const out = players.map(p => applySource(p, byId.get(String(p.id)) ?? null, projectionSource, { reason, threshold }));

  const fallback = out.filter(p => p.projection_fallback).length;
  const summary = {
    ...base,
    players: out.length,
    applied: out.filter(p => p.projection_source === projectionSource).length,
    fallback,
    fades: out.filter(p => p.projection_fade).length,
    error,
    cached: model?.cached ?? null,
    modelMs: Date.now() - t0,
    modelDate: model?.date ?? null,
    weights: model?.weights?.name ?? null
  };
  if (fallback > 0 && !error) {
    const names = out.filter(p => p.projection_fallback).slice(0, 5).map(p => p.name).join(', ');
    console.warn(`⚠️ Projection source "${projectionSource}": ${fallback} player(s) on slate ${source.slateId} kept RotoWire (${names}${fallback > 5 ? ', ...' : ''})`);
  }
  remember(source, summary);
  return { players: out, summary };
}

/** The last summary for a slate (null when it has not been read with ours / blend). */
export function lastSummary(source) {
  return source ? summaries.get(slateKey(source)) ?? null : null;
}

/** Drop remembered summaries (tests). */
export function clearSourceSummaries() {
  summaries.clear();
  inflight.clear();
}

export default { applyProjectionSource, lastSummary, clearSourceSummaries };
