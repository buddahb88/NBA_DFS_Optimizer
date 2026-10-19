import { DATABASE_TYPE } from './database.js';

/**
 * Per-slate player controls set on the Player Pool page (idempotent, runs on every startup)
 *
 * player_settings is keyed by (slate_id, player_id) where player_id is the
 * RotoWire ID (players.player_id), NOT players.id: a slate resync deletes and
 * re-inserts every player row, so players.id is not stable across syncs.
 * No foreign key to slates for the same reason; settings outlive a resync.
 *
 * Columns mirror the per-player optimizer contract in
 * services/optimizer/constraints/exposure.js (lock, exclude, min/max exposure %,
 * projection override). NULL means "use the default".
 */
export async function migratePlayerSettings(db) {
  if (DATABASE_TYPE === 'azuresql') {
    await db.exec(`
      IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='player_settings' AND xtype='U')
      CREATE TABLE player_settings (
        id INT IDENTITY(1,1) PRIMARY KEY,
        slate_id NVARCHAR(100) NOT NULL,
        player_id NVARCHAR(100) NOT NULL,
        locked BIT NOT NULL DEFAULT 0,
        excluded BIT NOT NULL DEFAULT 0,
        min_exposure FLOAT,
        max_exposure FLOAT,
        projection_override FLOAT,
        updated_at DATETIME2 DEFAULT GETDATE(),
        CONSTRAINT UQ_player_settings_slate_player UNIQUE (slate_id, player_id)
      )
    `);
  } else {
    await db.exec(`
      CREATE TABLE IF NOT EXISTS player_settings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        slate_id TEXT NOT NULL,
        player_id TEXT NOT NULL,
        locked INTEGER NOT NULL DEFAULT 0,
        excluded INTEGER NOT NULL DEFAULT 0,
        min_exposure REAL,
        max_exposure REAL,
        projection_override REAL,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(slate_id, player_id)
      )
    `);
  }
}
