import db, { DATABASE_TYPE } from '../config/database.js';
import { DEFAULT_SITE, getEligibleSlots, isValidSite } from '../config/sites.js';
import { SNAPSHOT_DETAIL_COLUMNS } from '../config/snapshotMigrations.js';
import { playerKey } from '../utils/playerKey.js';
import { seasonForDate } from '../utils/season.js';

/**
 * SLATE PLAYER SNAPSHOTS
 *
 * Copies a slate's current players rows into slate_player_snapshots so
 * salary, projection, ownership, Vegas and injury history survives the
 * delete-and-reinsert of a slate sync. Called before the sync wipe, after a
 * fresh RotoWire load and after a salary CSV import. Upserts on
 * (game_date, site, slate_id, player_key): re-syncs keep the latest values.
 *
 * Rows hold everything a rebuild needs (SNAPSHOT_DETAIL_COLUMNS). Once a
 * player's game has started the row is locked: a later capture (e.g. the
 * snapshot before the next day's sync wipe) only fills columns that are
 * still NULL and never writes the range columns, which may have been
 * recomputed after lock. Pre-lock values are what a backtest has to see.
 * Every snapshotted slate is also cataloged (slateCatalogService).
 */

export { SNAPSHOT_DETAIL_COLUMNS };

// YYYY-MM-DD in US Eastern, the date NBA slates are named by
export const easternDate = (d) => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit'
}).format(d);

// Eastern date of slates.start_time when it is a full timestamp, else null
export function startTimeDate(startTime) {
  if (startTime instanceof Date && !isNaN(startTime)) return easternDate(startTime);
  if (typeof startTime === 'string' && /^\d{4}-\d{2}-\d{2}/.test(startTime)) {
    const parsed = new Date(startTime);
    if (!isNaN(parsed)) return easternDate(parsed);
  }
  return null;
}

/**
 * Slate game date: Eastern date of slates.start_time when it is a full
 * timestamp (salary imports), else the Eastern date of capture (RotoWire
 * syncs store only a time of day like "7:00 PM").
 */
export function slateGameDate(startTime, now = new Date()) {
  return startTimeDate(startTime) ?? easternDate(now);
}

/**
 * RotoWire game date for a players row: the date part of raw_data
 * game.dateTime (Eastern wall time, e.g. "2026-10-20 21:30:00"), else null.
 */
export function rotowireGameDate(rawData) {
  let raw = rawData;
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw); } catch { return null; }
  }
  const value = raw?.game?.dateTime ?? raw?.game?.date;
  const m = typeof value === 'string' ? value.match(/^(\d{4}-\d{2}-\d{2})/) : null;
  return m ? m[1] : null;
}

/**
 * Game date for one snapshot row: a full slate start_time (salary imports,
 * authoritative for that slate), else the player's RotoWire game.dateTime
 * (so a slate synced the day after its games keeps the real date), else the
 * Eastern capture date.
 */
export function playerGameDate(player, startTime, now = new Date()) {
  return startTimeDate(startTime) ?? rotowireGameDate(player.raw_data) ?? easternDate(now);
}

// Offset (ms) of America/New_York from UTC at a given instant
export const easternOffsetMs = (ts) => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'
  }).formatToParts(new Date(ts)).map(p => [p.type, p.value]));
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return asUtc - ts;
};

/** ISO UTC instant for an Eastern wall-clock time. */
export function easternToIso(year, month, day, hour, minute, second = 0) {
  const guess = Date.UTC(year, month - 1, day, hour, minute, second);
  return new Date(guess - easternOffsetMs(guess)).toISOString();
}

const parseJson = (raw) => {
  if (typeof raw !== 'string') return raw ?? null;
  try { return JSON.parse(raw); } catch { return null; }
};

/**
 * Game start (ISO UTC) for a players row: RotoWire raw_data game.dateTime
 * (Eastern wall time), else a DFS CSV game_info "AWY@HOM MM/DD/YYYY HH:MMPM ET",
 * else a full slates.start_time, else null.
 */
export function playerGameStart(player, startTime = null) {
  const value = parseJson(player.raw_data)?.game?.dateTime;
  let m = typeof value === 'string' ? /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(value) : null;
  if (m) return easternToIso(+m[1], +m[2], +m[3], +m[4], +m[5], +(m[6] || 0));
  m = /(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})\s*([AP]M)/i.exec(String(player.game_info || ''));
  if (m) {
    const hour = (parseInt(m[4], 10) % 12) + (m[6].toUpperCase() === 'PM' ? 12 : 0);
    return easternToIso(+m[3], +m[1], +m[2], hour, +m[5]);
  }
  return startTimeDate(startTime) ? new Date(startTime).toISOString() : null;
}

export function isHomeFlag(player) {
  const raw = parseJson(player.raw_data);
  if (typeof raw?.isHome === 'boolean') return raw.isHome ? 1 : 0;
  const teams = /([A-Za-z]{2,4})\s*@\s*([A-Za-z]{2,4})/.exec(String(player.game_info || ''));
  if (teams && player.team) return teams[2].toUpperCase() === String(player.team).toUpperCase() ? 1 : 0;
  return null;
}

/** Slash-delimited slots: the stored roster_positions, else derived from position. */
export function rosterPositionsFor(player, site = DEFAULT_SITE) {
  if (player.roster_positions) return player.roster_positions;
  if (!isValidSite(site)) return null;
  const slots = getEligibleSlots(site, player.position);
  return slots.length ? slots.join('/') : null;
}

/** True once the player's game has started (or, without a start time, its date has passed). */
export function isLocked(row, now = new Date()) {
  if (row.game_start_time) return now.getTime() >= Date.parse(row.game_start_time);
  return easternDate(now) > row.game_date;
}

const KEY_COLUMNS = ['game_date', 'site', 'slate_id', 'player_key'];
const BASE_COLUMNS = [
  'snapshot_date', 'game_date', 'slate_id', 'site', 'player_key', 'player_name', 'team', 'opponent', 'position',
  'salary', 'projected_points', 'projected_minutes', 'floor', 'ceiling', 'rostership',
  'vegas_implied_total', 'vegas_spread', 'over_under', 'injury_status', 'is_confirmed', 'captured_at'
];
export const SNAPSHOT_COLUMNS = [...BASE_COLUMNS, ...SNAPSHOT_DETAIL_COLUMNS.map(c => c.name)];
/** Pre-lock range columns: a locked capture never writes these. */
export const RANGE_COLUMNS = ['floor', 'ceiling', 'std_dev', 'volatility', 'boom_probability', 'bust_probability', 'leverage_score'];
// A locked row only gains detail columns that are still NULL (NULL is a real
// value for the base columns, e.g. injury_status of a healthy player)
const LOCKED_FILL_COLUMNS = SNAPSHOT_DETAIL_COLUMNS.map(c => c.name).filter(c => !RANGE_COLUMNS.includes(c));

function upsertSql(locked) {
  const insertCols = locked ? SNAPSHOT_COLUMNS.filter(c => !RANGE_COLUMNS.includes(c)) : SNAPSHOT_COLUMNS;
  const updateCols = locked ? LOCKED_FILL_COLUMNS : SNAPSHOT_COLUMNS.filter(c => !KEY_COLUMNS.includes(c));
  if (DATABASE_TYPE === 'azuresql') {
    const set = updateCols.map(c => (locked ? `[${c}] = COALESCE(target.[${c}], @${c})` : `[${c}] = @${c}`));
    return {
      cols: insertCols,
      sql: `
        MERGE INTO slate_player_snapshots AS target
        USING (SELECT @game_date AS game_date, @site AS site, @slate_id AS slate_id, @player_key AS player_key) AS source
        ON target.game_date = source.game_date AND target.site = source.site
          AND target.slate_id = source.slate_id AND target.player_key = source.player_key
        WHEN MATCHED THEN UPDATE SET ${set.join(', ')}
        WHEN NOT MATCHED THEN
          INSERT (${insertCols.map(c => `[${c}]`).join(', ')})
          VALUES (${insertCols.map(c => `@${c}`).join(', ')});`
    };
  }
  const set = updateCols.map(c => (locked
    ? `${c} = COALESCE(slate_player_snapshots.${c}, excluded.${c})`
    : `${c} = excluded.${c}`));
  return {
    cols: insertCols,
    sql: `
      INSERT INTO slate_player_snapshots (${insertCols.join(', ')})
      VALUES (${insertCols.map(() => '?').join(', ')})
      ON CONFLICT(game_date, site, slate_id, player_key) DO UPDATE SET ${set.join(', ')}`
  };
}

const confirmedFlag = (v) => (v === null || v === undefined ? null : (v ? 1 : 0));
const orNull = (v) => (v === undefined ? null : v);

/** Snapshot row (column -> value) for one players row. */
export function snapshotRowFor(p, { slate, site, now, archetype = null, matchup = null }) {
  return {
    snapshot_date: easternDate(now),
    game_date: playerGameDate(p, slate.start_time, now),
    slate_id: String(slate.slate_id),
    site,
    player_key: playerKey(p.name),
    player_name: p.name,
    team: orNull(p.team),
    opponent: orNull(p.opponent),
    position: orNull(p.position),
    salary: orNull(p.salary),
    projected_points: orNull(p.projected_points),
    projected_minutes: orNull(p.projected_minutes),
    floor: orNull(p.floor),
    ceiling: orNull(p.ceiling),
    rostership: orNull(p.rostership),
    vegas_implied_total: orNull(p.vegas_implied_total),
    vegas_spread: orNull(p.vegas_spread),
    over_under: orNull(p.vegas_over_under),
    injury_status: orNull(p.injury_status),
    is_confirmed: confirmedFlag(p.lineup_confirmed),
    captured_at: DATABASE_TYPE === 'azuresql' ? now : now.toISOString(),
    player_id: p.player_id == null ? null : String(p.player_id),
    site_player_id: p.site_player_id == null ? null : String(p.site_player_id),
    roster_positions: rosterPositionsFor(p, site),
    game_info: orNull(p.game_info),
    game_start_time: playerGameStart(p, slate.start_time),
    is_home: isHomeFlag(p),
    std_dev: orNull(p.std_dev),
    volatility: orNull(p.volatility),
    boom_probability: orNull(p.boom_probability),
    bust_probability: orNull(p.bust_probability),
    leverage_score: orNull(p.leverage_score),
    blowout_risk: orNull(p.blowout_risk),
    fppm: orNull(p.fppm),
    value: orNull(p.value),
    value_gpp: orNull(p.value_gpp),
    per: orNull(p.per),
    usage: orNull(p.usage),
    fpts_last3: orNull(p.fpts_last3),
    fpts_last5: orNull(p.fpts_last5),
    fpts_last7: orNull(p.fpts_last7),
    fpts_last14: orNull(p.fpts_last14),
    vegas_win_prob: orNull(p.vegas_win_prob),
    rest_days: orNull(p.rest_days),
    dvp_pts_allowed: orNull(p.dvp_pts_allowed),
    opp_def_eff: orNull(p.opp_def_eff),
    rotowire_projection: orNull(p.rotowire_projection),
    headshot: orNull(p.headshot),
    raw_data: p.raw_data == null ? null : (typeof p.raw_data === 'string' ? p.raw_data : JSON.stringify(p.raw_data)),
    archetype,
    matchup_grouping: matchup?.grouping ?? null,
    matchup_group_key: matchup?.group_key ?? null,
    matchup_season: matchup?.season ?? null,
    matchup_delta: matchup?.delta ?? null,
    matchup_rank: matchup?.rank ?? null,
    matchup_teams: matchup?.teams ?? null,
    matchup_adjusted_edge: matchup?.adjusted_edge ?? null
  };
}

/**
 * Upsert one snapshotRowFor row. locked: only fill detail columns that are
 * still NULL and never write the range columns (see the header comment).
 */
export async function upsertSnapshotRow(row, { locked = false } = {}) {
  const { sql, cols } = upsertSql(locked);
  if (DATABASE_TYPE === 'azuresql') {
    await db.run(sql, Object.fromEntries(cols.map(c => [c, row[c]])));
  } else {
    await db.run(sql, ...cols.map(c => row[c]));
  }
}

// (player_key, game date) -> archetype for the game's season (prior season fallback)
async function archetypeLookup() {
  const { loadArchetypeLookup } = await import('./archetypeDefenseService.js');
  const bySeason = new Map();
  return async (key, gameDate) => {
    const season = seasonForDate(gameDate);
    if (!bySeason.has(season)) bySeason.set(season, await loadArchetypeLookup(season));
    return bySeason.get(season)(key) ?? null;
  };
}

// player_id -> { archetype, matchup } for the slate as of now; empty when it cannot be built
async function slateMatchups(slateId, site) {
  try {
    const { getSlateMatchups } = await import('./archetypeDefenseService.js');
    return await getSlateMatchups(slateId, { site });
  } catch (error) {
    console.warn(`  Snapshot matchups unavailable for slate ${slateId}: ${error.message}`);
    return new Map();
  }
}

/**
 * Snapshot every player on a slate. Options: { now } (Date, for tests).
 * Returns the number of rows written (0 for an unknown or empty slate).
 */
export async function snapshotSlate(slateId, { now = new Date() } = {}) {
  const slate = await db.get(`SELECT slate_id, site, start_time FROM slates WHERE slate_id = ?`, slateId);
  if (!slate) return 0;
  const players = await db.all(`SELECT * FROM players WHERE slate_id = ?`, slateId);
  if (!players.length) return 0;

  const site = slate.site || DEFAULT_SITE;
  const archetypeOf = await archetypeLookup();
  const matchups = await slateMatchups(slateId, site);

  let written = 0;
  for (const p of players) {
    if (!playerKey(p.name)) continue;
    const base = snapshotRowFor(p, { slate, site, now });
    const locked = isLocked(base, now);
    const archetype = await archetypeOf(base.player_key, base.game_date);
    let matchup = matchups.get(String(p.player_id))?.matchup ?? null;
    // A grid rebuilt after lock already holds this slate's games, unless it is a prior season's
    if (matchup && locked && !(matchup.season < seasonForDate(base.game_date))) matchup = null;
    await upsertSnapshotRow(snapshotRowFor(p, { slate, site, now, archetype, matchup }), { locked });
    written++;
  }
  await catalogSlate(site, slateId, now);
  return written;
}

// Catalog the snapshotted slate (slate_catalog) so the night stays backtestable; a failure only warns
async function catalogSlate(site, slateId, now) {
  try {
    const { catalogLiveSlate } = await import('./slateCatalogService.js');
    await catalogLiveSlate(site, slateId, { now });
  } catch (error) {
    console.warn(`  Slate catalog update failed for slate ${slateId}: ${error.message}`);
  }
}

/** Snapshot every slate currently in the players table (before a sync wipe). */
export async function snapshotAllSlates(options = {}) {
  const slates = await db.all(`SELECT slate_id FROM slates`);
  let written = 0;
  for (const { slate_id } of slates) {
    written += await snapshotSlate(slate_id, options);
  }
  return written;
}

export default {
  snapshotSlate, snapshotAllSlates, slateGameDate, playerGameDate, rotowireGameDate, playerGameStart, isLocked
};
