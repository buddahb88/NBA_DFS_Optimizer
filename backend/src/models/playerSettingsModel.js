import db from '../config/database.js';

/**
 * Per-slate player controls (lock / exclude / exposure / projection override).
 * See config/playerSettingsMigrations.js for why rows are keyed by player_id.
 *
 * API shape (camelCase, matches the optimizer's per-player contract):
 *   { playerId, lock, exclude, minExposure, maxExposure, projectionOverride }
 */

export class PlayerSettingsError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PlayerSettingsError';
    this.status = 400;
  }
}

const optionalNumber = (value, field, { min, max } = {}) => {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new PlayerSettingsError(`${field} must be a number`);
  if ((min != null && n < min) || (max != null && n > max)) {
    throw new PlayerSettingsError(`${field} must be between ${min} and ${max}`);
  }
  return n;
};

/**
 * Validate a settings payload. Returns null when every control is at its
 * default (the row should be deleted rather than stored).
 */
export function normalizeSettings(input = {}) {
  const settings = {
    lock: !!input.lock,
    exclude: !!input.exclude,
    minExposure: optionalNumber(input.minExposure, 'minExposure', { min: 0, max: 100 }),
    maxExposure: optionalNumber(input.maxExposure, 'maxExposure', { min: 0, max: 100 }),
    projectionOverride: optionalNumber(input.projectionOverride, 'projectionOverride', { min: 0, max: 200 })
  };
  if (settings.lock && settings.exclude) {
    throw new PlayerSettingsError('A player cannot be both locked and excluded');
  }
  if (settings.minExposure != null && settings.maxExposure != null && settings.minExposure > settings.maxExposure) {
    throw new PlayerSettingsError('minExposure cannot be greater than maxExposure');
  }
  const isDefault = !settings.lock && !settings.exclude &&
    settings.minExposure == null && settings.maxExposure == null && settings.projectionOverride == null;
  return isDefault ? null : settings;
}

const fromRow = (row) => ({
  playerId: String(row.player_id),
  lock: !!row.locked,
  exclude: !!row.excluded,
  minExposure: row.min_exposure ?? null,
  maxExposure: row.max_exposure ?? null,
  projectionOverride: row.projection_override ?? null
});

class PlayerSettingsModel {
  async getBySlateId(slateId) {
    const rows = await db.all(
      `SELECT * FROM player_settings WHERE slate_id = ? ORDER BY player_id`,
      slateId
    );
    return rows.map(fromRow);
  }

  /**
   * Insert/replace one player's settings. Returns the stored settings, or null
   * if the payload was all defaults (the row is removed).
   */
  async upsert(slateId, playerId, input) {
    const settings = normalizeSettings(input);
    const pid = String(playerId);
    if (!settings) {
      await this.remove(slateId, pid);
      return null;
    }

    const values = [
      settings.lock ? 1 : 0,
      settings.exclude ? 1 : 0,
      settings.minExposure,
      settings.maxExposure,
      settings.projectionOverride
    ];
    // UPDATE-then-INSERT works unchanged on SQLite and Azure SQL
    const result = await db.run(`
      UPDATE player_settings
      SET locked = ?, excluded = ?, min_exposure = ?, max_exposure = ?, projection_override = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE slate_id = ? AND player_id = ?
    `, ...values, slateId, pid);

    if (!result?.changes) {
      await db.run(`
        INSERT INTO player_settings (locked, excluded, min_exposure, max_exposure, projection_override, slate_id, player_id)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `, ...values, slateId, pid);
    }

    return { playerId: pid, ...settings };
  }

  async remove(slateId, playerId) {
    return db.run(`DELETE FROM player_settings WHERE slate_id = ? AND player_id = ?`, slateId, String(playerId));
  }

  async clearSlate(slateId) {
    return db.run(`DELETE FROM player_settings WHERE slate_id = ?`, slateId);
  }
}

export default new PlayerSettingsModel();
