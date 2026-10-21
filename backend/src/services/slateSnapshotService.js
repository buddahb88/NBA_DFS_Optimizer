import db, { DATABASE_TYPE } from '../config/database.js';
import { DEFAULT_SITE } from '../config/sites.js';
import { playerKey } from '../utils/playerKey.js';

/**
 * SLATE PLAYER SNAPSHOTS
 *
 * Copies a slate's current players rows into slate_player_snapshots so
 * salary, projection, ownership, Vegas and injury history survives the
 * delete-and-reinsert of a slate sync. Called before the sync wipe, after a
 * fresh RotoWire load and after a salary CSV import. Upserts on
 * (game_date, site, slate_id, player_key): re-syncs keep the latest values.
 */

// YYYY-MM-DD in US Eastern, the date NBA slates are named by
const easternDate = (d) => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit'
}).format(d);

// Eastern date of slates.start_time when it is a full timestamp, else null
function startTimeDate(startTime) {
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

const UPSERT_SQLITE = `
  INSERT INTO slate_player_snapshots (
    snapshot_date, game_date, slate_id, site, player_key, player_name, team, opponent, position,
    salary, projected_points, projected_minutes, floor, ceiling, rostership,
    vegas_implied_total, vegas_spread, over_under, injury_status, is_confirmed, captured_at
  )
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(game_date, site, slate_id, player_key) DO UPDATE SET
    snapshot_date = excluded.snapshot_date,
    player_name = excluded.player_name,
    team = excluded.team,
    opponent = excluded.opponent,
    position = excluded.position,
    salary = excluded.salary,
    projected_points = excluded.projected_points,
    projected_minutes = excluded.projected_minutes,
    floor = excluded.floor,
    ceiling = excluded.ceiling,
    rostership = excluded.rostership,
    vegas_implied_total = excluded.vegas_implied_total,
    vegas_spread = excluded.vegas_spread,
    over_under = excluded.over_under,
    injury_status = excluded.injury_status,
    is_confirmed = excluded.is_confirmed,
    captured_at = excluded.captured_at
`;

const UPSERT_AZURE = `
  MERGE INTO slate_player_snapshots AS target
  USING (SELECT @gameDate AS game_date, @site AS site, @slateId AS slate_id, @playerKey AS player_key) AS source
  ON target.game_date = source.game_date AND target.site = source.site
    AND target.slate_id = source.slate_id AND target.player_key = source.player_key
  WHEN MATCHED THEN
    UPDATE SET snapshot_date = @snapshotDate, player_name = @playerName, team = @team, opponent = @opponent,
      position = @position, salary = @salary, projected_points = @projectedPoints,
      projected_minutes = @projectedMinutes, floor = @floor, ceiling = @ceiling, rostership = @rostership,
      vegas_implied_total = @vegasImpliedTotal, vegas_spread = @vegasSpread, over_under = @overUnder,
      injury_status = @injuryStatus, is_confirmed = @isConfirmed, captured_at = @capturedAt
  WHEN NOT MATCHED THEN
    INSERT (snapshot_date, game_date, slate_id, site, player_key, player_name, team, opponent, position,
      salary, projected_points, projected_minutes, floor, ceiling, rostership,
      vegas_implied_total, vegas_spread, over_under, injury_status, is_confirmed, captured_at)
    VALUES (@snapshotDate, @gameDate, @slateId, @site, @playerKey, @playerName, @team, @opponent, @position,
      @salary, @projectedPoints, @projectedMinutes, @floor, @ceiling, @rostership,
      @vegasImpliedTotal, @vegasSpread, @overUnder, @injuryStatus, @isConfirmed, @capturedAt);
`;

const confirmedFlag = (v) => (v === null || v === undefined ? null : (v ? 1 : 0));

/**
 * Snapshot every player on a slate. Options: { now } (Date, for tests).
 * Returns the number of rows written (0 for an unknown or empty slate).
 */
export async function snapshotSlate(slateId, { now = new Date() } = {}) {
  const slate = await db.get(`SELECT slate_id, site, start_time FROM slates WHERE slate_id = ?`, slateId);
  if (!slate) return 0;
  const players = await db.all(`SELECT * FROM players WHERE slate_id = ?`, slateId);

  const site = slate.site || DEFAULT_SITE;
  const snapshotDate = easternDate(now);
  const capturedAt = DATABASE_TYPE === 'azuresql' ? now : now.toISOString();

  let written = 0;
  for (const p of players) {
    const key = playerKey(p.name);
    if (!key) continue;
    const row = {
      snapshotDate, gameDate: playerGameDate(p, slate.start_time, now), slateId, site, playerKey: key,
      playerName: p.name,
      team: p.team ?? null,
      opponent: p.opponent ?? null,
      position: p.position ?? null,
      salary: p.salary ?? null,
      projectedPoints: p.projected_points ?? null,
      projectedMinutes: p.projected_minutes ?? null,
      floor: p.floor ?? null,
      ceiling: p.ceiling ?? null,
      rostership: p.rostership ?? null,
      vegasImpliedTotal: p.vegas_implied_total ?? null,
      vegasSpread: p.vegas_spread ?? null,
      overUnder: p.vegas_over_under ?? null,
      injuryStatus: p.injury_status ?? null,
      isConfirmed: confirmedFlag(p.lineup_confirmed),
      capturedAt
    };
    if (DATABASE_TYPE === 'azuresql') {
      await db.run(UPSERT_AZURE, row);
    } else {
      await db.run(UPSERT_SQLITE, ...Object.values(row));
    }
    written++;
  }
  return written;
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

export default { snapshotSlate, snapshotAllSlates, slateGameDate, playerGameDate, rotowireGameDate };
