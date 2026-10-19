import db, { DATABASE_TYPE } from '../config/database.js';

const NOW = DATABASE_TYPE === 'azuresql' ? 'GETDATE()' : 'CURRENT_TIMESTAMP';

const toNum = (v) => (v === null || v === undefined || v === '' ? null : Number(v));

const toOverride = (row) => ({
  slate_id: String(row.slate_id),
  player_id: String(row.player_id),
  minutes: toNum(row.minutes),
  points: toNum(row.points),
  base_points: toNum(row.base_points),
  note: row.note ?? null,
  updated_at: row.updated_at ?? null
});

/**
 * Manual per-slate projection overrides (minutes and/or points).
 * Positional ? params work on both engines (database.js converts them).
 */
class ProjectionOverrideModel {
  async getBySlate(slateId) {
    const rows = await db.all(`
      SELECT slate_id, player_id, minutes, points, base_points, note, updated_at
      FROM projection_overrides
      WHERE slate_id = ?
    `, String(slateId));
    return rows.map(toOverride);
  }

  async get(slateId, playerId) {
    const row = await db.get(`
      SELECT slate_id, player_id, minutes, points, base_points, note, updated_at
      FROM projection_overrides
      WHERE slate_id = ? AND player_id = ?
    `, String(slateId), String(playerId));
    return row ? toOverride(row) : null;
  }

  /**
   * Insert or replace the override for one player.
   */
  async upsert(slateId, playerId, { minutes = null, points = null, basePoints = null, note = null }) {
    const result = await db.run(`
      UPDATE projection_overrides
      SET minutes = ?, points = ?, base_points = ?, note = ?, updated_at = ${NOW}
      WHERE slate_id = ? AND player_id = ?
    `, minutes, points, basePoints, note, String(slateId), String(playerId));

    if (!result?.changes) {
      await db.run(`
        INSERT INTO projection_overrides (slate_id, player_id, minutes, points, base_points, note)
        VALUES (?, ?, ?, ?, ?, ?)
      `, String(slateId), String(playerId), minutes, points, basePoints, note);
    }
    return this.get(slateId, playerId);
  }

  /**
   * Write a player's projected_points directly (used for points overrides so
   * the optimizer sees them without a recalculation). Keeps the original
   * RotoWire number in rotowire_projection, like playerModel.updateProjection.
   */
  async setPlayerPoints(slateId, playerId, points) {
    return db.run(`
      UPDATE players SET
        rotowire_projection = COALESCE(rotowire_projection, projected_points),
        projected_points = ?,
        updated_at = ${NOW}
      WHERE slate_id = ? AND player_id = ?
    `, points, String(slateId), String(playerId));
  }

  async remove(slateId, playerId) {
    const result = await db.run(`
      DELETE FROM projection_overrides WHERE slate_id = ? AND player_id = ?
    `, String(slateId), String(playerId));
    return result?.changes || 0;
  }
}

export default new ProjectionOverrideModel();
