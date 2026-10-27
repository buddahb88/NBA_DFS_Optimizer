/**
 * SLATE SOURCE
 *
 * Where a request's slate players come from: the live players table (the one
 * synced slate) or, for a past night, slate_player_snapshots (backtest). Both
 * return rows in the players-table shape, so the optimizer, portfolio builder,
 * archetype matchups and chat tools run unchanged on a past slate.
 *
 *   resolveSlate({ slateId, slateDate, site })
 *     slateDate before today (ET)  -> backtest from snapshots of that date
 *                                     (slateId / site pick among several)
 *     slateDate today or later     -> the live slate, if it covers that date
 *     slateId only                 -> live when synced, else its latest snapshot
 *     nothing                      -> the latest live slate
 *
 * Backtest slates are read-only: nothing here writes to players. Their player
 * settings (lock / exclude / exposure) live under settingsKey
 * ("backtest:<date>:<slateId>"), so they never reach the live slate's.
 * Snapshot players use the snapshot row id as `id`; it is stable, so locks
 * and exclusions by id keep working across requests.
 */

import db from '../config/database.js';
import { DEFAULT_SITE, isValidSite } from '../config/sites.js';
import slateModel from '../models/slateModel.js';
import playerModel from '../models/playerModel.js';
import { easternDate, rosterPositionsFor } from './slateSnapshotService.js';
import { getSlateDate, slateDateFields } from './slateFreshness.js';
import { getPlayerResultsOnDate } from './resultsService.js';
import { playerKey } from '../utils/playerKey.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export class SlateSourceError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'SlateSourceError';
    this.status = status;
  }
}

// Azure returns DATE columns as Date objects
const toDateStr = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : v ? String(v).slice(0, 10) : null);

export const backtestSettingsKey = (slateDate, slateId) => `backtest:${slateDate}:${slateId}`;

const liveSource = (slate, slateDate) => ({
  mode: 'live',
  isBacktest: false,
  slateId: String(slate.slate_id),
  slateDate: slateDate ?? null,
  site: slate.site || DEFAULT_SITE,
  settingsKey: String(slate.slate_id),
  label: slateDate ? `Live ${slateDate}` : 'Live'
});

const backtestSource = ({ slate_id: slateId, site, game_date: gameDate, players }) => {
  const slateDate = toDateStr(gameDate);
  return {
    mode: 'backtest',
    isBacktest: true,
    slateId: String(slateId),
    slateDate,
    site,
    settingsKey: backtestSettingsKey(slateDate, slateId),
    playerCount: Number(players),
    label: `Backtest ${slateDate}`
  };
};

// slate_catalog main flag and name of a saved slate (catalog rows exist for slates found on RotoWire)
const CATALOG_JOIN = 'LEFT JOIN slate_catalog c ON c.site = s.site AND c.slate_id = s.slate_id';
const IS_MAIN = 'MAX(CAST(COALESCE(c.is_main, 0) AS INT))';

/** Saved slates on a date: [{ slate_id, site, game_date, players, is_main }], the main slate first, then biggest. */
async function snapshotSlatesOn(slateDate, { slateId, site } = {}) {
  let sql = `SELECT s.slate_id, s.site, s.game_date, COUNT(*) AS players, ${IS_MAIN} AS is_main
    FROM slate_player_snapshots s ${CATALOG_JOIN} WHERE s.game_date = ?`;
  const params = [slateDate];
  if (slateId) { sql += ' AND s.slate_id = ?'; params.push(String(slateId)); }
  if (site) { sql += ' AND s.site = ?'; params.push(site); }
  sql += ` GROUP BY s.slate_id, s.site, s.game_date ORDER BY ${IS_MAIN} DESC, COUNT(*) DESC, s.slate_id DESC`;
  return db.all(sql, ...params);
}

/**
 * Resolve which slate a request means. Throws SlateSourceError (404 when no
 * slate matches). Returns { mode, isBacktest, slateId, slateDate, site,
 * settingsKey, label }; null when nothing is synced and nothing was asked for.
 */
export async function resolveSlate({ slateId = null, slateDate = null, site = null, now = new Date() } = {}) {
  if (site && !isValidSite(site)) throw new SlateSourceError(`Unknown site "${site}"`);
  site = site ? site.toLowerCase() : null;
  slateId = slateId === undefined || slateId === null || slateId === '' ? null : String(slateId);
  const today = easternDate(now);

  if (slateDate) {
    if (!DATE_RE.test(slateDate)) throw new SlateSourceError('slateDate must be YYYY-MM-DD');
    if (slateDate < today) {
      const [found] = await snapshotSlatesOn(slateDate, { slateId, site });
      if (!found) {
        throw new SlateSourceError(`No saved slate for ${slateDate}${slateId ? ` (slate ${slateId})` : ''}`, 404);
      }
      return backtestSource(found);
    }
    const slate = slateId ? await slateModel.getById(slateId) : (await slateModel.getAll())[0];
    const liveDate = slate ? await getSlateDate(slate) : null;
    if (!slate || (liveDate && liveDate !== slateDate)) {
      throw new SlateSourceError(`No live slate for ${slateDate}; sync it first`, 404);
    }
    return liveSource(slate, liveDate);
  }

  if (slateId) {
    const slate = await slateModel.getById(slateId);
    if (slate) return liveSource(slate, await getSlateDate(slate));
    const latest = await db.get(
      'SELECT MAX(game_date) AS game_date FROM slate_player_snapshots WHERE slate_id = ?', slateId);
    const date = toDateStr(latest?.game_date);
    if (date) {
      const [found] = await snapshotSlatesOn(date, { slateId, site });
      if (found) return backtestSource(found);
    }
    // Unknown slate: callers report their usual "no players" error
    return { ...liveSource({ slate_id: slateId, site: site || DEFAULT_SITE }, null) };
  }

  const [current] = await slateModel.getAll();
  return current ? liveSource(current, await getSlateDate(current)) : null;
}

// players range column -> snapshot model column (scripts/recompute-snapshot-ranges.js)
const MODEL_RANGES = [
  ['floor', 'floor_model'], ['ceiling', 'ceiling_model'], ['std_dev', 'std_dev_model'],
  ['volatility', 'volatility_model'], ['boom_probability', 'boom_model'], ['bust_probability', 'bust_model'],
  ['leverage_score', 'leverage_model']
];
export const RANGE_OPTIONS = ['model', 'original'];

/**
 * Range columns for a snapshot player. ranges 'model' (default) uses the
 * outcome-model ranges when the row has them, 'original' the pre-lock ones.
 * Both sets stay on the row as <col>_original / <col>_model; range_source
 * says which one the plain columns hold.
 */
function rangeFields(row, ranges) {
  const out = {};
  const hasModel = row.floor_model !== null && row.floor_model !== undefined;
  const useModel = ranges !== 'original' && hasModel;
  for (const [col, modelCol] of MODEL_RANGES) {
    const original = row[col] ?? null;
    const model = row[modelCol] ?? null;
    out[col] = useModel ? model : original;
    out[`${col}_original`] = original;
    out[`${col}_model`] = model;
  }
  out.range_source = useModel ? 'model' : 'original';
  out.range_model_version = row.range_model_version ?? null;
  return out;
}

/** players-table row for one snapshot row (plus player_key, game_date, game_start_time, archetype, range fields). */
export function snapshotToPlayer(row, { ranges = 'model' } = {}) {
  return {
    id: row.id,
    slate_id: String(row.slate_id),
    player_id: row.player_id ?? `snapshot-${row.id}`,
    name: row.player_name,
    team: row.team,
    opponent: row.opponent,
    position: row.position,
    salary: row.salary,
    projected_points: row.projected_points,
    projected_minutes: row.projected_minutes,
    value: row.value ?? null,
    game_info: row.game_info ?? null,
    injury_status: row.injury_status,
    per: row.per ?? null,
    usage: row.usage ?? null,
    fpts_last3: row.fpts_last3 ?? null,
    fpts_last5: row.fpts_last5 ?? null,
    fpts_last7: row.fpts_last7 ?? null,
    fpts_last14: row.fpts_last14 ?? null,
    vegas_implied_total: row.vegas_implied_total,
    vegas_spread: row.vegas_spread,
    vegas_over_under: row.over_under,
    vegas_win_prob: row.vegas_win_prob ?? null,
    rostership: row.rostership,
    value_gpp: row.value_gpp ?? null,
    headshot: row.headshot ?? null,
    raw_data: row.raw_data ?? null,
    created_at: row.captured_at,
    updated_at: row.captured_at,
    rest_days: row.rest_days ?? null,
    dvp_pts_allowed: row.dvp_pts_allowed ?? null,
    opp_def_eff: row.opp_def_eff ?? null,
    floor: row.floor,
    ceiling: row.ceiling,
    volatility: row.volatility ?? null,
    boom_probability: row.boom_probability ?? null,
    bust_probability: row.bust_probability ?? null,
    fppm: row.fppm ?? null,
    leverage_score: row.leverage_score ?? null,
    blowout_risk: row.blowout_risk ?? null,
    std_dev: row.std_dev ?? null,
    rotowire_projection: row.rotowire_projection ?? null,
    site_player_id: row.site_player_id ?? null,
    roster_positions: rosterPositionsFor(row, row.site),
    lineup_confirmed: row.is_confirmed,
    player_key: row.player_key,
    game_date: toDateStr(row.game_date),
    game_start_time: row.game_start_time ?? null,
    archetype: row.archetype ?? null,
    ...rangeFields(row, ranges)
  };
}

const matchesFilters = (p, filters) =>
  (!filters.position || String(p.position || '').includes(filters.position))
  && (!filters.minSalary || p.salary >= filters.minSalary)
  && (!filters.maxSalary || p.salary <= filters.maxSalary)
  && (!filters.team || p.team === filters.team);

/**
 * Slate players for a resolved source, players-table shape, projected
 * players only, best value first (as playerModel.getBySlateId).
 * filters: { position, minSalary, maxSalary, team } (as getBySlateId).
 * includeZero: also players projected 0 (ruled out).
 * ranges: 'model' (default) | 'original' - which floor / ceiling / std_dev /
 * boom / bust a backtest uses (see rangeFields); live slates ignore it.
 */
export async function loadSlatePlayers(source, { filters = {}, includeZero = false, ranges = 'model' } = {}) {
  if (!source) return [];
  if (!source.isBacktest) {
    const rows = includeZero
      ? await db.all('SELECT * FROM players WHERE slate_id = ?', source.slateId)
      : await playerModel.getBySlateId(source.slateId, filters);
    // A fresh sync leaves roster_positions NULL until the next startup backfill
    return rows.map(p => (p.roster_positions ? p : { ...p, roster_positions: rosterPositionsFor(p, source.site) }));
  }
  const rows = await db.all(
    `SELECT * FROM slate_player_snapshots WHERE game_date = ? AND slate_id = ? AND site = ? ORDER BY id`,
    source.slateDate, source.slateId, source.site);
  return rows
    .map(row => snapshotToPlayer(row, { ranges }))
    .filter(p => (includeZero || Number(p.projected_points) > 0) && matchesFilters(p, filters))
    .sort((a, b) => (Number(b.value) || 0) - (Number(a.value) || 0)
      || (Number(b.projected_points) || 0) - (Number(a.projected_points) || 0));
}

/** resolveSlate + loadSlatePlayers. Returns { source, players }. */
export async function getSlatePlayers(request = {}, options = {}) {
  const source = await resolveSlate(request);
  return { source, players: await loadSlatePlayers(source, options) };
}

/**
 * Actual results per player id for a backtest slate:
 * Map(id -> { actualPoints, actualMinutes, resultStatus }). DNP / inactive
 * score 0; a game without box scores yet stays null (PENDING).
 */
export async function loadActuals(source, players) {
  const out = new Map();
  if (!source?.isBacktest || players.length === 0) return out;
  // Callers that trim player objects may drop player_key; the name still resolves
  const keyOf = (p) => p.player_key ?? (p.name ? playerKey(p.name) : null);
  const results = await getPlayerResultsOnDate({
    playerKeys: players.map(keyOf).filter(Boolean), date: source.slateDate, site: source.site
  });
  const byKey = new Map(results.map(r => [r.playerKey, r]));
  for (const p of players) {
    const r = byKey.get(keyOf(p));
    if (!r) continue;
    const played = r.status === 'PLAYED';
    const pending = r.status === 'PENDING';
    out.set(p.id, {
      actualPoints: played ? (r.actual ?? 0) : (pending ? null : 0),
      actualMinutes: played ? r.actualMinutes : (pending ? null : 0),
      resultStatus: r.status
    });
  }
  return out;
}

/** Players with actualPoints / actualMinutes / resultStatus merged in (backtest only). */
export async function withActuals(source, players) {
  const actuals = await loadActuals(source, players);
  if (actuals.size === 0) return players;
  return players.map(p => ({ ...p, ...(actuals.get(p.id) ?? { actualPoints: null, actualMinutes: null, resultStatus: null }) }));
}

const round1 = (x) => Math.round(x * 10) / 10;

/**
 * Lineup actual total from per-slot players carrying actualPoints (see
 * withActuals). Null when any player's result is still pending.
 */
export function lineupActualTotal(players) {
  const list = players.filter(Boolean);
  if (list.length === 0 || list.some(p => p.actualPoints === null || p.actualPoints === undefined)) return null;
  return round1(list.reduce((s, p) => s + Number(p.actualPoints), 0));
}

/**
 * Optimizer-style lineups ({ players: [{ position, player }] }) with actual
 * points on every slot player and `actualPoints` on the lineup (backtest only).
 */
export async function scoreLineups(source, lineups, players) {
  if (!source?.isBacktest || !lineups?.length) return lineups;
  const actuals = await loadActuals(source, players);
  return lineups.map(lineup => {
    const slots = lineup.players.map(slot => (slot.player
      ? { ...slot, player: { ...slot.player, ...(actuals.get(slot.player.id) ?? { actualPoints: null }) } }
      : slot));
    return { ...lineup, players: slots, actualPoints: lineupActualTotal(slots.map(s => s.player)) };
  });
}

/** Fields every backtest-aware response carries. */
export const sourceFields = (source) => (source ? {
  slateSource: source.mode,
  isBacktest: source.isBacktest,
  slateId: source.slateId,
  slateDate: source.slateDate,
  site: source.site,
  settingsKey: source.settingsKey,
  label: source.label,
  ...(source.ranges ? { ranges: source.ranges } : {})
} : {});

/**
 * Date fields for a chat tool answer about an explicit backtest: not stale
 * (the user asked for that night), labelled so the answer says which date
 * it covers.
 */
export function backtestDateFields(source, now = new Date()) {
  return {
    slateDate: source.slateDate,
    today: easternDate(now),
    isStale: false,
    backtest: true,
    label: source.label,
    backtestNote: `BACKTEST: rebuilt from the saved ${source.slateDate} slate (pre-lock salaries, projections, `
      + `ownership). Not tonight's slate - label the answer "${source.label}". Actual results are included.`
  };
}

/**
 * Chat tools: resolve { slateId, slateDate } and the date fields to return.
 * Live slates keep the stale-slate fields (slateDateFields); an explicit
 * slateDate before today is a backtest (backtestDateFields).
 * Returns { source, dateFields } or { error }.
 */
export async function chatSlate({ slateId = null, slateDate = null } = {}) {
  let source;
  try {
    source = await resolveSlate({ slateId, slateDate });
  } catch (error) {
    if (error instanceof SlateSourceError) return { error: error.message };
    throw error;
  }
  if (!source) return { error: 'No slates found in database' };
  const dateFields = source.isBacktest ? backtestDateFields(source) : await slateDateFields(source.slateId);
  return { source, dateFields };
}

/**
 * Saved past slates for the backtest picker, newest first (each date's main
 * slate first): [{ slateDate, slateId, site, players, label, isMain, name }].
 * isMain / name come from slate_catalog (false / null when not cataloged).
 */
export async function listBacktestSlates({ site = null, now = new Date(), limit = 60 } = {}) {
  let sql = `SELECT s.game_date, s.slate_id, s.site, COUNT(*) AS players, ${IS_MAIN} AS is_main, MAX(c.name) AS name
    FROM slate_player_snapshots s ${CATALOG_JOIN} WHERE s.game_date < ?`;
  const params = [easternDate(now)];
  if (site) { sql += ' AND s.site = ?'; params.push(site); }
  sql += ` GROUP BY s.game_date, s.slate_id, s.site ORDER BY s.game_date DESC, ${IS_MAIN} DESC, COUNT(*) DESC`;
  const rows = await db.all(sql, ...params);
  return rows.slice(0, limit).map(r => {
    const s = backtestSource(r);
    return {
      slateDate: s.slateDate, slateId: s.slateId, site: s.site, players: s.playerCount, label: s.label,
      isMain: Number(r.is_main) === 1, name: r.name ?? null
    };
  });
}

export default {
  resolveSlate, loadSlatePlayers, getSlatePlayers, loadActuals, withActuals, scoreLineups,
  lineupActualTotal, listBacktestSlates, sourceFields, backtestSettingsKey, backtestDateFields, chatSlate
};
