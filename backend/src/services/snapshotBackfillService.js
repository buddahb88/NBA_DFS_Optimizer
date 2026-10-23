/**
 * Complete the snapshot of a slate that is still in the players table after
 * its games locked (scripts/backfill-snapshot-details.js).
 *
 * 1. snapshotSlate in locked mode fills every detail column that is still
 *    NULL (DK slots and IDs, start time, raw_data, archetype ...) and leaves
 *    the pre-lock salary / projection / ownership / floor / ceiling alone.
 * 2. Pre-lock std_dev / volatility / boom / bust / leverage were never
 *    snapshotted. They are rebuilt with the legacy range model (the one the
 *    slate was synced with) and only stored when the rebuild reproduces the
 *    stored pre-lock floor and ceiling. With { legacyRanges: true }, rows
 *    without any pre-lock range get the whole legacy range, floor and
 *    ceiling included (only right for slates synced before the outcome model).
 */

import db from '../config/database.js';
import { playerKey } from '../utils/playerKey.js';
import { snapshotSlate, RANGE_COLUMNS } from './slateSnapshotService.js';
import { legacyPreLockRanges } from './variance/legacyRanges.js';

const MATCH_TOLERANCE = 0.01;
const REQUIRED_COLUMNS = ['salary', 'position', 'roster_positions', 'game_start_time', 'projected_points',
  'floor', 'ceiling', 'std_dev', 'boom_probability', 'bust_probability'];

const close = (a, b) => a != null && b != null && Math.abs(Number(a) - Number(b)) < MATCH_TOLERANCE;

async function fillRanges(id, values, columns) {
  const set = columns.map((c) => `${c} = COALESCE(${c}, ?)`).join(', ');
  await db.run(`UPDATE slate_player_snapshots SET ${set} WHERE id = ?`, ...columns.map((c) => values[c]), id);
}

/**
 * @returns {Promise<{slateId, players, snapshotRows, complete, missing, rangeSource}>}
 */
export async function backfillSlateSnapshot(slateId, { now = new Date(), legacyRanges = false } = {}) {
  slateId = String(slateId);
  const players = await db.all(`SELECT name, raw_data FROM players WHERE slate_id = ?`, slateId);
  await snapshotSlate(slateId, { now });

  const keys = [...new Set(players.map((p) => playerKey(p.name)).filter(Boolean))];
  const rows = keys.length
    ? await db.all(
      `SELECT * FROM slate_player_snapshots WHERE slate_id = ? AND player_key IN (${keys.map(() => '?').join(', ')})`,
      slateId, ...keys)
    : [];

  const rangeSource = { snapshot: 0, legacyVerified: 0, legacyRebuilt: 0, mismatched: 0, unavailable: 0 };
  for (const row of rows) {
    if (row.std_dev != null && row.boom_probability != null) {
      rangeSource.snapshot++;
      continue;
    }
    const legacy = legacyPreLockRanges(row);
    if (!legacy) {
      rangeSource.unavailable++;
    } else if (row.floor != null && row.ceiling != null) {
      if (close(legacy.floor, row.floor) && close(legacy.ceiling, row.ceiling)) {
        await fillRanges(row.id, legacy, RANGE_COLUMNS.filter((c) => c !== 'floor' && c !== 'ceiling'));
        rangeSource.legacyVerified++;
      } else {
        rangeSource.mismatched++;
      }
    } else if (legacyRanges) {
      await fillRanges(row.id, legacy, RANGE_COLUMNS);
      rangeSource.legacyRebuilt++;
    } else {
      rangeSource.unavailable++;
    }
  }

  const final = keys.length
    ? await db.all(
      `SELECT * FROM slate_player_snapshots WHERE slate_id = ? AND player_key IN (${keys.map(() => '?').join(', ')})`,
      slateId, ...keys)
    : [];
  const hasRaw = players.some((p) => p.raw_data);
  const required = hasRaw ? [...REQUIRED_COLUMNS, 'raw_data'] : REQUIRED_COLUMNS;
  const missing = final
    .map((r) => ({ player_key: r.player_key, columns: required.filter((c) => r[c] == null) }))
    .filter((m) => m.columns.length);

  return {
    slateId,
    players: players.length,
    snapshotRows: final.length,
    complete: final.length === players.length && missing.length === 0,
    missing,
    rangeSource
  };
}

export default { backfillSlateSnapshot };
