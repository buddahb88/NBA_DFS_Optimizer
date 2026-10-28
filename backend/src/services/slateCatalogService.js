/**
 * SLATE CATALOG
 *
 * One slate_catalog row per (site, slate_id) for every slate we know of:
 * RotoWire backfills (source 'rotowire', rotowireSlateBackfillService) and
 * every live slate we snapshot (source 'live', slateSnapshotService), so a
 * past night is a backtestable main slate without a backfill run.
 *
 * is_main marks the main slate of each (site, date): most games, then
 * earliest lock, among classic slates. It is recomputed for the whole date
 * whenever a slate of that date is cataloged, so a later bigger slate takes
 * over. A live write never replaces a backfill row's fields (they come from
 * the full RotoWire payload), only fills its NULLs; no write replaces a
 * value with NULL. A write that changes nothing is skipped.
 */

import db, { DATABASE_TYPE } from '../config/database.js';
import { DEFAULT_SITE } from '../config/sites.js';
import { snapshotRowFor } from './slateSnapshotService.js';

export const LIVE_SOURCE = 'live';
const SHOWDOWN_SLOTS = new Set(['CPTN', 'CPT', 'MVP']);
const COLUMNS = ['site', 'slate_id', 'game_date', 'name', 'contest_type', 'games', 'players', 'first_game_time', 'is_main', 'source', 'updated_at'];
const VALUE_COLUMNS = COLUMNS.filter(c => c !== 'updated_at');

/** Main slate order over { games, firstGameTime, players, slateId }: most games, then earliest lock. */
export const mainOrder = (a, b) => b.games - a.games
  || String(a.firstGameTime).localeCompare(String(b.firstGameTime))
  || b.players - a.players
  || Number(a.slateId) - Number(b.slateId);

const lockLabel = (iso) => (iso
  ? new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' }).format(new Date(iso)) + ' ET'
  : null);

/** "Main · 11 games · 7:00 PM ET" / "Classic · 3 games · 10:00 PM ET" */
export function slateName(slate) {
  return [slate.isMain ? 'Main' : 'Classic', `${slate.games} games`, lockLabel(slate.firstGameTime)].filter(Boolean).join(' · ');
}

const ordered = (row) => ({ games: Number(row.games) || 0, firstGameTime: row.first_game_time, players: Number(row.players) || 0, slateId: row.slate_id });

/**
 * Catalog fields for a slate from its snapshot-shaped rows ({ game_date,
 * team, opponent, game_start_time, roster_positions }): the date most rows
 * fall on, distinct games, first lock, and contest type (showdown when a
 * captain slot is listed, classic from 2 games up, else other).
 */
export function summarizeSlateRows(rows) {
  const perDate = new Map();
  for (const r of rows) perDate.set(r.game_date, (perDate.get(r.game_date) || 0) + 1);
  const gameDate = [...perDate].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))[0]?.[0] ?? null;
  const games = new Set(rows.filter(r => r.team && r.opponent).map(r => [r.team, r.opponent].sort().join('@'))).size;
  const starts = rows.map(r => r.game_start_time).filter(Boolean).sort();
  const showdown = rows.some(r => String(r.roster_positions || '').split('/').some(s => SHOWDOWN_SLOTS.has(s.trim())));
  return {
    game_date: gameDate,
    games,
    players: rows.length,
    first_game_time: starts[0] ?? null,
    contest_type: showdown ? 'showdown' : (games >= 2 ? 'classic' : 'other')
  };
}

async function writeRow(row) {
  if (DATABASE_TYPE === 'azuresql') {
    await db.run(`
      MERGE INTO slate_catalog AS target
      USING (SELECT @site AS site, @slate_id AS slate_id) AS source
      ON target.site = source.site AND target.slate_id = source.slate_id
      WHEN MATCHED THEN UPDATE SET ${COLUMNS.filter(c => c !== 'site' && c !== 'slate_id').map(c => `[${c}] = @${c}`).join(', ')}
      WHEN NOT MATCHED THEN INSERT (${COLUMNS.map(c => `[${c}]`).join(', ')}) VALUES (${COLUMNS.map(c => `@${c}`).join(', ')});`, row);
  } else {
    await db.run(`
      INSERT INTO slate_catalog (${COLUMNS.join(', ')}) VALUES (${COLUMNS.map(() => '?').join(', ')})
      ON CONFLICT(site, slate_id) DO UPDATE SET ${COLUMNS.filter(c => c !== 'site' && c !== 'slate_id').map(c => `${c} = excluded.${c}`).join(', ')}`,
    ...COLUMNS.map(c => row[c]));
  }
}

const sameValue = (a, b) => (a == null && b == null) || String(a) === String(b);

/**
 * Recompute is_main for one (site, date): exactly one classic slate is main
 * (none without a classic slate). Live rows are renamed to match their flag.
 */
export async function refreshMainSlate(site, gameDate, { now = new Date() } = {}) {
  const rows = await db.all(`SELECT * FROM slate_catalog WHERE site = ? AND game_date = ?`, site, gameDate);
  const main = rows.filter(r => r.contest_type === 'classic').sort((a, b) => mainOrder(ordered(a), ordered(b)))[0] ?? null;
  const mainId = main ? String(main.slate_id) : null;
  const updatedAt = now.toISOString();
  await db.run(`
    UPDATE slate_catalog SET is_main = CASE WHEN slate_id = ? THEN 1 ELSE 0 END, updated_at = ?
    WHERE site = ? AND game_date = ? AND is_main <> CASE WHEN slate_id = ? THEN 1 ELSE 0 END`,
  mainId, updatedAt, site, gameDate, mainId);
  for (const r of rows.filter(row => row.source === LIVE_SOURCE)) {
    const name = slateName({ ...ordered(r), isMain: String(r.slate_id) === mainId });
    if (r.name !== name) await db.run(`UPDATE slate_catalog SET name = ?, updated_at = ? WHERE id = ?`, name, updatedAt, r.id);
  }
  return mainId;
}

/**
 * Upsert one catalog row (snake_case columns, updated_at set here) and
 * recompute the main slate of its date (and of its old date if it moved).
 * Returns true when the row was written.
 */
export async function upsertCatalogSlate(values, { now = new Date() } = {}) {
  const slateId = String(values.slate_id);
  const existing = await db.get(`SELECT * FROM slate_catalog WHERE site = ? AND slate_id = ?`, values.site, slateId);
  const keepExisting = existing && existing.source !== LIVE_SOURCE && values.source === LIVE_SOURCE;
  const merged = { site: values.site, slate_id: slateId };
  for (const c of VALUE_COLUMNS.filter(col => col !== 'site' && col !== 'slate_id')) {
    const incoming = values[c] ?? null;
    const current = existing?.[c] ?? null;
    merged[c] = keepExisting ? (current ?? incoming) : (incoming ?? current);
  }
  merged.is_main = Number(merged.is_main) ? 1 : 0;

  const changed = !existing || VALUE_COLUMNS.some(c => !sameValue(existing[c], merged[c]));
  if (changed) await writeRow({ ...merged, updated_at: now.toISOString() });
  if (existing && existing.game_date !== merged.game_date) await refreshMainSlate(merged.site, existing.game_date, { now });
  await refreshMainSlate(merged.site, merged.game_date, { now });
  return changed;
}

// Snapshot-shaped rows for a slate: its snapshots, else its live players rows
async function slateRows(site, slateId, now) {
  const rows = await db.all(`
    SELECT game_date, team, opponent, game_start_time, roster_positions
    FROM slate_player_snapshots WHERE site = ? AND slate_id = ?`, site, slateId);
  if (rows.length) return rows;
  const slate = await db.get(`SELECT slate_id, site, start_time FROM slates WHERE slate_id = ?`, slateId);
  if (!slate || (slate.site || DEFAULT_SITE) !== site) return [];
  const players = await db.all(`SELECT * FROM players WHERE slate_id = ?`, slateId);
  return players.map(p => snapshotRowFor(p, { slate, site, now }));
}

/**
 * Catalog a live slate from what we saved of it (source 'live'). Returns the
 * catalog fields, or null when nothing is saved for the slate.
 */
export async function catalogLiveSlate(site, slateId, { now = new Date() } = {}) {
  const rows = await slateRows(site, String(slateId), now);
  const summary = summarizeSlateRows(rows);
  if (!summary.game_date) return null;
  const existing = await db.get(`SELECT is_main FROM slate_catalog WHERE site = ? AND slate_id = ?`, site, String(slateId));
  const isMain = Number(existing?.is_main) === 1;
  const values = {
    site, slate_id: String(slateId), ...summary, is_main: isMain ? 1 : 0, source: LIVE_SOURCE,
    name: slateName({ isMain, games: summary.games, firstGameTime: summary.first_game_time })
  };
  await upsertCatalogSlate(values, { now });
  return values;
}

/**
 * One-time fix (idempotent): catalog every slate in slate_player_snapshots
 * or slates that has no slate_catalog row.
 * Returns { cataloged: [{ site, slateId, gameDate }] }.
 */
export async function catalogMissingSlates({ now = new Date() } = {}) {
  const missing = await db.all(`
    SELECT site, slate_id FROM (
      SELECT DISTINCT site, slate_id FROM slate_player_snapshots
      UNION
      SELECT DISTINCT COALESCE(site, ?) AS site, slate_id FROM slates
    ) ids
    WHERE NOT EXISTS (SELECT 1 FROM slate_catalog c WHERE c.site = ids.site AND c.slate_id = ids.slate_id)
    ORDER BY site, slate_id`, DEFAULT_SITE);
  const cataloged = [];
  for (const { site, slate_id } of missing) {
    const values = await catalogLiveSlate(site, slate_id, { now });
    if (values) cataloged.push({ site, slateId: String(slate_id), gameDate: values.game_date });
  }
  return { cataloged };
}

export default { summarizeSlateRows, upsertCatalogSlate, refreshMainSlate, catalogLiveSlate, catalogMissingSlates, slateName, mainOrder };
