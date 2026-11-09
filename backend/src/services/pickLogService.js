/**
 * PICK LOG (forward test)
 *
 * Logs the lineups our pickers would play on a slate, before lock, and scores
 * them once the box scores exist, so lineup picks can be judged on slates the
 * models never saw (the saved-slate backtests are partly in-sample).
 *
 *   logPick({ slateId, slateDate, site, source, lineup, meta })
 *       one pick per (site, slate, source). Re-logging before lock replaces the
 *       pick (results cleared); after the slate's first game starts it is
 *       refused (PickLogError 409). A source ending in '_backfill' is logged
 *       after the fact on purpose: allowed after lock, stored is_forward = 0.
 *   registerPicker(source, fn)
 *       a picker builds a lineup from the slate pool; logSlatePicks runs every
 *       registered one. Built in: 'max_projection' (the single max-projection
 *       DK lineup of the active projection, the optimizer's LP pipeline).
 *       Another picker (e.g. a GPP sim winner) is one registerPicker call, or
 *       calls logPick directly.
 *   scorePick / scorePendingPicks
 *       actual DK points per player from historical_games (player_key +
 *       game_date via resultsService), DNP count (anyone who did not play),
 *       and an estimated percentile in an ownership-sampled field of the
 *       slate's saved pool. A pick stays unscored while any player's result
 *       is pending.
 *   setNightResult / listNights
 *       the real contest cash line / winning score for a night, entered by
 *       hand (the field percentile is only an estimate).
 */

import crypto from 'crypto';
import db, { DATABASE_TYPE } from '../config/database.js';
import { DEFAULT_SITE, getSiteConfig, isValidSite } from '../config/sites.js';
import { inPool } from '../config/snapshotMigrations.js';
import { projectionSanityEnabled } from '../config/projectionSanity.js';
import { injuryRiskEnabled } from '../config/injuryRisk.js';
import { projectionSource as activeProjectionSource } from '../config/projectionSource.js';
import slateModel from '../models/slateModel.js';
import { playerKey } from '../utils/playerKey.js';
import { easternDate, playerGameStart } from './slateSnapshotService.js';
import { getSlateDate } from './slateFreshness.js';
import { getPlayerResultsOnDate } from './resultsService.js';
import { resolveSlate, loadSlatePlayers } from './slateSource.js';
import { maxFieldLineupSlots, fieldScores, percentileIn, rosterable } from './modelEval/lineupBacktest.js';

export const BACKFILL_SUFFIX = '_backfill';
export const MAX_PROJECTION = 'max_projection';
export const FIELD_SIZE = 2000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export class PickLogError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'PickLogError';
    this.status = status;
  }
}

export const isBackfillSource = (source) => String(source || '').endsWith(BACKFILL_SUFFIX);
const toDateStr = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : v ? String(v).slice(0, 10) : null);
const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const num = (v) => (v === null || v === undefined || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const round = (v, d = 2) => (finite(v) ? Math.round(v * 10 ** d) / 10 ** d : null);
const parseJson = (s, fallback = null) => {
  if (s === null || s === undefined) return fallback;
  if (typeof s !== 'string') return s;
  try { return JSON.parse(s); } catch { return fallback; }
};
const minIso = (values) => {
  const times = values.map(v => (v ? Date.parse(v) : NaN)).filter(Number.isFinite);
  return times.length ? new Date(Math.min(...times)).toISOString() : null;
};

// ---------------------------------------------------------------------------
// Lock time
// ---------------------------------------------------------------------------

/**
 * Earliest game start (ISO UTC) of a slate: the live players rows when the
 * slate is synced (RotoWire game.dateTime / DK game_info), its saved
 * snapshot rows, and its slate_catalog first_game_time - the earliest of
 * whatever is known. Null when nothing is.
 */
export async function slateLockTime({ slateId, site = DEFAULT_SITE, slateDate = null }) {
  const id = String(slateId);
  const starts = [];
  const live = await slateModel.getById(id);
  if (live && (live.site || DEFAULT_SITE) === site) {
    const players = await db.all('SELECT raw_data, game_info FROM players WHERE slate_id = ?', id);
    for (const p of players) starts.push(playerGameStart(p, live.start_time));
  }
  const params = [id, site];
  let dateSql = '';
  if (slateDate) { dateSql = ' AND game_date = ?'; params.push(slateDate); }
  const snap = await db.get(
    `SELECT MIN(game_start_time) AS t FROM slate_player_snapshots WHERE slate_id = ? AND site = ?${dateSql}`, ...params);
  starts.push(snap?.t ?? null);
  const cat = await db.get('SELECT first_game_time AS t FROM slate_catalog WHERE slate_id = ? AND site = ?', id, site);
  starts.push(cat?.t ?? null);
  return minIso(starts);
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

/** Stored lineup entry for one player (players-table row or an already stored entry). */
export function lineupEntry(p) {
  const name = p.name ?? p.player_name ?? null;
  return {
    player_key: p.player_key ?? (name ? playerKey(name) : null),
    player_id: p.player_id ?? (p.id !== undefined && p.id !== null ? String(p.id) : null),
    site_player_id: p.site_player_id ?? null,
    name,
    slot: p.slot ?? null,
    position: p.position ?? null,
    team: p.team ?? null,
    opponent: p.opponent ?? null,
    salary: num(p.salary),
    projected_points: round(num(p.projected_points)),
    ownership: round(num(p.ownership ?? p.rostership)),
    game_start_time: p.game_start_time ?? null
  };
}

const sum = (xs, f) => xs.reduce((s, x) => s + (num(f(x)) ?? 0), 0);

function validate({ slateId, slateDate, site, source, lineup }) {
  if (slateId === undefined || slateId === null || slateId === '') throw new PickLogError('slateId is required');
  if (!slateDate || !DATE_RE.test(slateDate)) throw new PickLogError('slateDate must be YYYY-MM-DD');
  if (!isValidSite(site)) throw new PickLogError(`Unknown site "${site}"`);
  if (typeof source !== 'string' || !source.trim() || source.length > 100 || !/^[\w.:-]+$/.test(source)) {
    throw new PickLogError('source must be 1-100 characters of letters, digits, _ . : -');
  }
  const size = getSiteConfig(site).rosterSlots.length;
  if (!Array.isArray(lineup) || lineup.length !== size) throw new PickLogError(`lineup must have ${size} players`);
  const entries = lineup.map(lineupEntry);
  if (entries.some(e => !e.player_key)) throw new PickLogError('every lineup player needs a name or player_key');
  if (new Set(entries.map(e => e.player_key)).size !== entries.length) throw new PickLogError('lineup has a duplicate player');
  return entries;
}

const isUniqueViolation = (error) => /UNIQUE|duplicate key|UQ_pick_log/i.test(String(error?.message));

/**
 * Log (or replace before lock) one pick. Returns { pick, replaced }.
 * Throws PickLogError: 400 bad input, 409 slate locked / lock time unknown.
 * now: the write time (default: the call time) - the lock check uses it.
 */
export async function logPick({ slateId, slateDate, site = DEFAULT_SITE, source, lineup, meta = {}, now = new Date() } = {}) {
  site = String(site || DEFAULT_SITE).toLowerCase();
  const entries = validate({ slateId, slateDate, site, source, lineup });
  slateId = String(slateId);
  const backfill = isBackfillSource(source);
  const lockTime = await slateLockTime({ slateId, site, slateDate });
  if (!backfill) {
    if (!lockTime) throw new PickLogError(`Lock time of slate ${slateId} is unknown; a forward pick needs it`, 409);
    if (now.getTime() >= Date.parse(lockTime)) {
      throw new PickLogError(`Slate ${slateId} locked at ${lockTime}; picks are only logged before lock`, 409);
    }
  }

  const values = {
    slate_id: slateId,
    game_date: slateDate,
    site,
    source,
    is_forward: backfill ? 0 : 1,
    logged_at: now.toISOString(),
    lock_time: lockTime,
    total_salary: sum(entries, e => e.salary),
    projected_points: round(sum(entries, e => e.projected_points)),
    projected_ownership: round(sum(entries, e => e.ownership)),
    lineup_json: JSON.stringify(entries),
    meta_json: JSON.stringify(meta ?? {})
  };
  const cols = Object.keys(values);
  const resultReset = 'actual_points = NULL, players_json = NULL, dnp_count = NULL, field_percentile = NULL, field_size = NULL, scored_at = NULL';
  const update = async () => db.run(
    `UPDATE pick_log SET ${cols.map(c => `${c} = ?`).join(', ')}, ${resultReset} WHERE site = ? AND slate_id = ? AND source = ?`,
    ...cols.map(c => values[c]), site, slateId, source);

  const existing = await db.get('SELECT id FROM pick_log WHERE site = ? AND slate_id = ? AND source = ?', site, slateId, source);
  let replaced = Boolean(existing);
  if (existing) {
    await update();
  } else {
    try {
      await db.run(`INSERT INTO pick_log (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, ...cols.map(c => values[c]));
    } catch (error) {
      // Another logger inserted the same pick in between: replace it
      if (!isUniqueViolation(error)) throw error;
      await update();
      replaced = true;
    }
  }
  const row = await db.get('SELECT * FROM pick_log WHERE site = ? AND slate_id = ? AND source = ?', site, slateId, source);
  return { pick: formatPick(row), replaced };
}

/** API shape of a pick_log row. */
export function formatPick(row) {
  if (!row) return null;
  const lineup = parseJson(row.lineup_json, []);
  const results = parseJson(row.players_json, null);
  const byKey = new Map((results ?? []).map(r => [r.player_key, r]));
  return {
    id: row.id,
    slateId: String(row.slate_id),
    gameDate: toDateStr(row.game_date),
    site: row.site,
    source: row.source,
    isForward: Number(row.is_forward) === 1,
    loggedAt: row.logged_at,
    lockTime: row.lock_time ?? null,
    totalSalary: num(row.total_salary),
    projectedPoints: num(row.projected_points),
    projectedOwnership: num(row.projected_ownership),
    lineup: lineup.map(p => {
      const r = byKey.get(p.player_key);
      return r ? { ...p, status: r.status, actual_points: r.actual_points, actual_minutes: r.actual_minutes } : p;
    }),
    meta: parseJson(row.meta_json, {}),
    actualPoints: num(row.actual_points),
    dnpCount: num(row.dnp_count),
    fieldPercentile: num(row.field_percentile),
    fieldSize: num(row.field_size),
    scoredAt: row.scored_at ?? null
  };
}

/**
 * Picks, newest night first. filters: { from, to, site, source, slateId,
 * forward (true: forward only, false: backfill only), limit }.
 */
export async function listPicks({ from = null, to = null, site = null, source = null, slateId = null, forward = null, limit = 500 } = {}) {
  const where = [];
  const params = [];
  if (from) { where.push('game_date >= ?'); params.push(from); }
  if (to) { where.push('game_date <= ?'); params.push(to); }
  if (site) { where.push('site = ?'); params.push(site); }
  if (source) { where.push('source = ?'); params.push(source); }
  if (slateId) { where.push('slate_id = ?'); params.push(String(slateId)); }
  if (forward === true) where.push('is_forward = 1');
  if (forward === false) where.push('is_forward = 0');
  const n = Math.max(1, Math.min(Number(limit) || 500, 5000));
  const sql = DATABASE_TYPE === 'azuresql'
    ? `SELECT TOP ${n} * FROM pick_log ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY game_date DESC, source`
    : `SELECT * FROM pick_log ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY game_date DESC, source LIMIT ${n}`;
  return (await db.all(sql, ...params)).map(formatPick);
}

// ---------------------------------------------------------------------------
// Pickers
// ---------------------------------------------------------------------------

/**
 * Max-projection picker: the single max-projection DK lineup of the pool
 * (players-table rows with the active projection applied). Returns
 * { lineup, meta } or null when no valid lineup exists.
 */
export function maxProjectionPicker({ players }) {
  const pool = players.filter(p => Number(p.projected_points) > 0 && Number(p.salary) > 0 && p.position);
  const slots = maxFieldLineupSlots(pool, 'projected_points');
  if (!slots) return null;
  return {
    lineup: slots.map(s => ({ ...s.player, slot: s.slot })),
    meta: { picker: MAX_PROJECTION, objective: 'projected_points', rules: 'DK classic, $50K cap, $49K min salary' }
  };
}

const pickers = new Map([[MAX_PROJECTION, maxProjectionPicker]]);

/**
 * Register a picker run by logSlatePicks (auto-log at lock and "log now").
 * fn({ slate, players, now }) -> { lineup, meta } | null; may be async.
 * slate: the resolved slate source; players: the slate pool with the active
 * projection. Returns an unregister function.
 */
export function registerPicker(source, fn) {
  if (typeof fn !== 'function') throw new TypeError('picker must be a function');
  if (isBackfillSource(source)) throw new TypeError(`a picker source must not end in ${BACKFILL_SUFFIX}`);
  pickers.set(source, fn);
  return () => { if (pickers.get(source) === fn) pickers.delete(source); };
}

export const registeredPickers = () => [...pickers.keys()];

/** Short hash of the pool's projections (what the pickers saw). */
export function poolSignature(players) {
  const text = players
    .map(p => `${p.player_key ?? playerKey(p.name ?? '')}:${p.salary}:${round(num(p.projected_points)) ?? ''}:${round(num(p.rostership)) ?? ''}`)
    .sort()
    .join('|');
  return crypto.createHash('sha1').update(text).digest('hex').slice(0, 12);
}

/**
 * Pool + projection signature for a resolved slate source with the active
 * projection (as every consumer reads it).
 */
export async function loadPickPool(slate, { now = new Date() } = {}) {
  let sourceSummary = null;
  let injurySummary = null;
  const players = await loadSlatePlayers(slate, {
    now,
    onProjectionSource: (s) => { sourceSummary = s; },
    onInjuryRisk: (s) => { injurySummary = s; }
  });
  const signature = {
    projectionSource: activeProjectionSource(),
    sanity: projectionSanityEnabled(),
    injuryRisk: injuryRiskEnabled(),
    poolSize: players.length,
    poolSignature: poolSignature(players),
    sourceSummary: sourceSummary
      ? { applied: sourceSummary.applied ?? null, fallback: sourceSummary.fallback ?? null, fades: sourceSummary.fades ?? null, error: sourceSummary.error ?? null }
      : null,
    injurySummary: injurySummary ?? null
  };
  return { players, signature };
}

/**
 * Run pickers on a resolved slate and log each pick. sources: which
 * registered pickers (default all); suffix: appended to each source
 * ('_backfill' for past slates). Picker errors are reported per source,
 * never thrown. Returns { slateId, slateDate, site, results: [{ source,
 * status: 'logged' | 'replaced' | 'skipped' | 'error', ... }] }.
 */
export async function logPicksForSlate(slate, { sources = null, suffix = '', now = null, extraMeta = {} } = {}) {
  const chosen = sources ?? registeredPickers();
  const { players, signature } = await loadPickPool(slate, { now: now ?? new Date() });
  const results = [];
  for (const name of chosen) {
    const fn = pickers.get(name);
    const source = `${name}${suffix}`;
    if (!fn) { results.push({ source, status: 'error', error: `No picker registered as "${name}"` }); continue; }
    try {
      const picked = await fn({ slate, players, now: now ?? new Date() });
      if (!picked?.lineup) { results.push({ source, status: 'skipped', reason: 'picker returned no lineup' }); continue; }
      const { pick, replaced } = await logPick({
        slateId: slate.slateId,
        slateDate: slate.slateDate,
        site: slate.site,
        source,
        lineup: picked.lineup,
        meta: { ...signature, ...(picked.meta ?? {}), ...extraMeta },
        // The write time decides pre-lock, not the tick that started the run
        now: now ?? new Date()
      });
      results.push({ source, status: replaced ? 'replaced' : 'logged', pickId: pick.id, projectedPoints: pick.projectedPoints });
    } catch (error) {
      results.push({ source, status: 'error', error: error.message, ...(error instanceof PickLogError ? { code: error.status } : {}) });
    }
  }
  return { slateId: slate.slateId, slateDate: slate.slateDate, site: slate.site, results };
}

// ---------------------------------------------------------------------------
// The live main slate
// ---------------------------------------------------------------------------

/**
 * The live slate to auto-log: a synced DraftKings slate (slateId, else the
 * one the catalog marks main for its date, else the only / first DK slate).
 * Returns { slate (resolved source), lockTime, isMain } or null.
 */
export async function liveMainSlate({ slateId = null, site = DEFAULT_SITE } = {}) {
  const all = (await slateModel.getAll()).filter(s => (s.site || DEFAULT_SITE) === site);
  const candidates = slateId ? all.filter(s => String(s.slate_id) === String(slateId)) : all;
  if (candidates.length === 0) return null;
  const withInfo = [];
  for (const s of candidates) {
    const date = await getSlateDate(s);
    const cat = await db.get('SELECT is_main FROM slate_catalog WHERE site = ? AND slate_id = ?', site, String(s.slate_id));
    const mainOfDate = date
      ? await db.get('SELECT slate_id FROM slate_catalog WHERE site = ? AND game_date = ? AND is_main = 1', site, date)
      : null;
    // Main: the catalog says so, or the date has no main yet
    const isMain = Number(cat?.is_main) === 1 || !mainOfDate;
    withInfo.push({ s, date, isMain });
  }
  const pick = withInfo.find(x => x.isMain) ?? (slateId ? withInfo[0] : null);
  if (!pick || !pick.date) return null;
  // A synced slate id resolves to the live slate
  const slate = await resolveSlate({ slateId: pick.s.slate_id, site }).catch(() => null);
  if (!slate || slate.isBacktest) return null;
  const lockTime = await slateLockTime({ slateId: slate.slateId, site, slateDate: pick.date });
  return { slate: { ...slate, slateDate: pick.date }, lockTime, isMain: pick.isMain };
}

/**
 * Log the live DK main slate's picks now (manual "log now"). Refused after
 * lock (each pick's logPick checks it at write time).
 */
export async function logLiveSlateNow({ slateId = null, sources = null, now = null } = {}) {
  const live = await liveMainSlate({ slateId });
  if (!live) throw new PickLogError('No live DraftKings main slate is synced', 404);
  const at = now ?? new Date();
  if (!live.lockTime) throw new PickLogError(`Lock time of slate ${live.slate.slateId} is unknown`, 409);
  if (at.getTime() >= Date.parse(live.lockTime)) {
    throw new PickLogError(`Slate ${live.slate.slateId} locked at ${live.lockTime}; picks are only logged before lock`, 409);
  }
  const out = await logPicksForSlate(live.slate, { sources, now, extraMeta: { trigger: 'manual' } });
  return { ...out, lockTime: live.lockTime };
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

/**
 * Estimated field of a saved slate: actual DK scores of ownership-sampled
 * valid lineups from its pre-lock pool. Sorted Float64Array, or null.
 */
async function slateField({ gameDate, slateId, site }, { size = FIELD_SIZE } = {}) {
  if (site !== 'draftkings') return null;
  const rows = await db.all(
    `SELECT player_key, player_name, salary, position, rostership, injury_status FROM slate_player_snapshots
     WHERE game_date = ? AND slate_id = ? AND site = ? AND ${inPool()} AND salary > 0`,
    gameDate, String(slateId), site);
  if (rows.length < 20) return null;
  const results = await getPlayerResultsOnDate({ playerKeys: rows.map(r => r.player_key), date: gameDate, site });
  const byKey = new Map(results.map(r => [r.playerKey, r]));
  const shaped = rosterable(rows.map(r => {
    const res = byKey.get(r.player_key);
    return {
      salary: r.salary,
      position: r.position,
      slate: { ownership: r.rostership, injuryStatus: r.injury_status },
      actual: { dk: res?.status === 'PLAYED' ? Number(res.actual ?? 0) : 0 }
    };
  }));
  if (shaped.length < 20) return null;
  try {
    return fieldScores(shaped, { size, seed: `pick-log:${gameDate}:${slateId}` });
  } catch {
    return null;
  }
}

/**
 * Score one pick from historical_games. Returns { status: 'scored', pick }
 * or { status: 'pending', pending: n } when box scores are missing.
 * fieldCache: Map shared across picks of a run (one field per slate).
 */
export async function scorePick(row, { now = new Date(), fieldCache = new Map(), fieldSize = FIELD_SIZE } = {}) {
  const pick = formatPick(row);
  const keys = pick.lineup.map(p => p.player_key);
  const results = await getPlayerResultsOnDate({ playerKeys: keys, date: pick.gameDate, site: pick.site });
  const byKey = new Map(results.map(r => [r.playerKey, r]));
  const pending = keys.filter(k => !byKey.get(k) || byKey.get(k).status === 'PENDING');
  if (pending.length) return { status: 'pending', pending: pending.length, pick };

  const players = pick.lineup.map(p => {
    const r = byKey.get(p.player_key);
    const played = r.status === 'PLAYED';
    return {
      player_key: p.player_key,
      name: p.name,
      status: r.status,
      actual_points: played ? round(Number(r.actual ?? 0)) : 0,
      actual_minutes: played ? num(r.actualMinutes) : 0
    };
  });
  const total = round(players.reduce((s, p) => s + p.actual_points, 0));
  const dnp = players.filter(p => p.status !== 'PLAYED').length;

  const cacheKey = `${pick.site}|${pick.slateId}|${pick.gameDate}`;
  if (!fieldCache.has(cacheKey)) {
    fieldCache.set(cacheKey, await slateField({ gameDate: pick.gameDate, slateId: pick.slateId, site: pick.site }, { size: fieldSize }));
  }
  const field = fieldCache.get(cacheKey);
  const percentile = field ? percentileIn(field, total) : null;

  await db.run(
    `UPDATE pick_log SET actual_points = ?, players_json = ?, dnp_count = ?, field_percentile = ?, field_size = ?, scored_at = ? WHERE id = ?`,
    total, JSON.stringify(players), dnp, percentile, field ? field.length : null, now.toISOString(), pick.id);
  return { status: 'scored', pick: formatPick(await db.get('SELECT * FROM pick_log WHERE id = ?', pick.id)) };
}

/**
 * Score every unscored pick of a night before today (ET), or with rescore
 * every pick matching the filters. filters: { slateId, gameDate, site,
 * forward (true: forward picks only, false: backfill only) }.
 * Returns { scored, pending, errors: [{ id, error }] }.
 */
export async function scorePendingPicks({ now = new Date(), rescore = false, slateId = null, gameDate = null, site = null, forward = null } = {}) {
  const where = ['game_date < ?'];
  const params = [easternDate(now)];
  if (!rescore) where.push('scored_at IS NULL');
  if (slateId) { where.push('slate_id = ?'); params.push(String(slateId)); }
  if (gameDate) { where.push('game_date = ?'); params.push(gameDate); }
  if (site) { where.push('site = ?'); params.push(site); }
  if (forward === true) where.push('is_forward = 1');
  if (forward === false) where.push('is_forward = 0');
  const rows = await db.all(`SELECT * FROM pick_log WHERE ${where.join(' AND ')} ORDER BY game_date, id`, ...params);
  const fieldCache = new Map();
  const out = { scored: 0, pending: 0, errors: [] };
  for (const row of rows) {
    try {
      const r = await scorePick(row, { now, fieldCache });
      if (r.status === 'scored') out.scored++;
      else out.pending++;
    } catch (error) {
      out.errors.push({ id: row.id, error: error.message });
    }
  }
  if (rows.length) console.log(`📒 Pick log scoring: ${out.scored} scored, ${out.pending} pending, ${out.errors.length} errors`);
  return out;
}

// ---------------------------------------------------------------------------
// Nights (real contest lines) and summary
// ---------------------------------------------------------------------------

/** Upsert the real contest numbers of a night. Null clears a field. */
export async function setNightResult({ site = DEFAULT_SITE, slateId, gameDate, cashLine = null, winningScore = null, contestName = null, notes = null, now = new Date() } = {}) {
  site = String(site || DEFAULT_SITE).toLowerCase();
  if (!isValidSite(site)) throw new PickLogError(`Unknown site "${site}"`);
  if (slateId === undefined || slateId === null || slateId === '') throw new PickLogError('slateId is required');
  if (!gameDate || !DATE_RE.test(gameDate)) throw new PickLogError('gameDate must be YYYY-MM-DD');
  const cash = num(cashLine);
  const win = num(winningScore);
  if ((cashLine !== null && cashLine !== '' && cash === null) || (winningScore !== null && winningScore !== '' && win === null)) {
    throw new PickLogError('cashLine and winningScore must be numbers');
  }
  if ((cash !== null && cash < 0) || (win !== null && win < 0)) throw new PickLogError('scores cannot be negative');
  const values = [gameDate, cash, win, contestName ? String(contestName).slice(0, 255) : null, notes ? String(notes).slice(0, 1000) : null, now.toISOString()];
  const existing = await db.get('SELECT id FROM pick_log_nights WHERE site = ? AND slate_id = ?', site, String(slateId));
  if (existing) {
    await db.run('UPDATE pick_log_nights SET game_date = ?, cash_line = ?, winning_score = ?, contest_name = ?, notes = ?, updated_at = ? WHERE id = ?',
      ...values, existing.id);
  } else {
    await db.run('INSERT INTO pick_log_nights (site, slate_id, game_date, cash_line, winning_score, contest_name, notes, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      site, String(slateId), ...values);
  }
  return formatNight(await db.get('SELECT * FROM pick_log_nights WHERE site = ? AND slate_id = ?', site, String(slateId)));
}

const formatNight = (r) => (r ? {
  site: r.site,
  slateId: String(r.slate_id),
  gameDate: toDateStr(r.game_date),
  cashLine: num(r.cash_line),
  winningScore: num(r.winning_score),
  contestName: r.contest_name ?? null,
  notes: r.notes ?? null,
  updatedAt: r.updated_at ?? null
} : null);

export async function listNights({ site = null } = {}) {
  const rows = site
    ? await db.all('SELECT * FROM pick_log_nights WHERE site = ? ORDER BY game_date DESC', site)
    : await db.all('SELECT * FROM pick_log_nights ORDER BY game_date DESC');
  return rows.map(formatNight);
}

/**
 * Running totals per source over scored picks: nights, average / best /
 * worst actual, average projected, average DNPs, average field percentile,
 * and against entered cash lines: nights with a line and nights cashed.
 */
export function summarizePicks(picks, nights = []) {
  const lineBySlate = new Map(nights.map(n => [`${n.site}|${n.slateId}`, n]));
  const bySource = new Map();
  for (const p of picks) {
    if (!bySource.has(p.source)) bySource.set(p.source, []);
    bySource.get(p.source).push(p);
  }
  const avg = (xs) => (xs.length ? round(xs.reduce((s, v) => s + v, 0) / xs.length) : null);
  return [...bySource.entries()].map(([source, list]) => {
    const scored = list.filter(p => finite(p.actualPoints));
    const best = scored.reduce((b, p) => (!b || p.actualPoints > b.actualPoints ? p : b), null);
    const worst = scored.reduce((w, p) => (!w || p.actualPoints < w.actualPoints ? p : w), null);
    const withLine = scored.filter(p => finite(lineBySlate.get(`${p.site}|${p.slateId}`)?.cashLine));
    return {
      source,
      isForward: !isBackfillSource(source),
      logged: list.length,
      nights: scored.length,
      avgActual: avg(scored.map(p => p.actualPoints)),
      avgProjected: avg(scored.map(p => p.projectedPoints).filter(finite)),
      best: best ? { gameDate: best.gameDate, actualPoints: best.actualPoints } : null,
      worst: worst ? { gameDate: worst.gameDate, actualPoints: worst.actualPoints } : null,
      avgDnp: avg(scored.map(p => p.dnpCount).filter(finite)),
      avgFieldPercentile: avg(scored.map(p => p.fieldPercentile).filter(finite)),
      nightsWithCashLine: withLine.length,
      cashed: withLine.filter(p => p.actualPoints >= lineBySlate.get(`${p.site}|${p.slateId}`).cashLine).length
    };
  }).sort((a, b) => Number(b.isForward) - Number(a.isForward) || a.source.localeCompare(b.source));
}

/**
 * Model log page payload: picks grouped per night (newest first) with the
 * night's entered contest numbers, and the per-source summary.
 */
export async function pickLogReport(filters = {}) {
  const [picks, nights] = await Promise.all([listPicks(filters), listNights({ site: filters.site ?? null })]);
  const nightBy = new Map(nights.map(n => [`${n.site}|${n.slateId}`, n]));
  const grouped = new Map();
  for (const p of picks) {
    const key = `${p.site}|${p.slateId}|${p.gameDate}`;
    if (!grouped.has(key)) {
      grouped.set(key, { gameDate: p.gameDate, site: p.site, slateId: p.slateId, contest: nightBy.get(`${p.site}|${p.slateId}`) ?? null, picks: [] });
    }
    grouped.get(key).picks.push(p);
  }
  return {
    nights: [...grouped.values()],
    summary: summarizePicks(picks, nights),
    sources: registeredPickers()
  };
}

// ---------------------------------------------------------------------------
// Backfill
// ---------------------------------------------------------------------------

/**
 * Log (source + '_backfill', is_forward 0) and score picks for the saved main
 * slates of [from, to] that already have results (before today, ET). Main
 * slates: slate_catalog is_main with saved snapshots. Existing backfill picks
 * are replaced. Returns [{ gameDate, slateId, results }].
 */
export async function backfillPicks({ from = '2026-10-20', to = null, site = DEFAULT_SITE, sources = [MAX_PROJECTION], now = new Date(), score = true } = {}) {
  const today = easternDate(now);
  const params = [site, from, today];
  let toSql = '';
  if (to) { toSql = ' AND c.game_date <= ?'; params.push(to); }
  const slates = await db.all(
    `SELECT c.slate_id, c.game_date FROM slate_catalog c
     WHERE c.site = ? AND c.is_main = 1 AND c.game_date >= ? AND c.game_date < ?${toSql}
       AND EXISTS (SELECT 1 FROM slate_player_snapshots s WHERE s.site = c.site AND s.slate_id = c.slate_id AND s.game_date = c.game_date)
     ORDER BY c.game_date`, ...params);
  const out = [];
  for (const s of slates) {
    const gameDate = toDateStr(s.game_date);
    let slate;
    try {
      slate = await resolveSlate({ slateId: s.slate_id, slateDate: gameDate, site, now });
    } catch (error) {
      out.push({ gameDate, slateId: String(s.slate_id), results: [{ status: 'error', error: error.message }] });
      continue;
    }
    const logged = await logPicksForSlate(slate, { sources, suffix: BACKFILL_SUFFIX, now, extraMeta: { trigger: 'backfill', backfill: true } });
    out.push({ gameDate, slateId: slate.slateId, results: logged.results });
  }
  if (score) await scorePendingPicks({ now, rescore: true, site, forward: false });
  return out;
}

export default {
  logPick, listPicks, registerPicker, registeredPickers, logPicksForSlate, logLiveSlateNow, liveMainSlate,
  scorePick, scorePendingPicks, setNightResult, listNights, summarizePicks, pickLogReport, backfillPicks, slateLockTime
};
