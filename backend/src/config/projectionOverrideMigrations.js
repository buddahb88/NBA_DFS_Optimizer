import { DATABASE_TYPE } from './database.js';

/**
 * Manual projection overrides (idempotent, runs on every startup)
 *
 * - projection_overrides  one row per slate + player
 *     minutes      forced minutes (0 = OUT, his minutes go to teammates)
 *     points       forced fantasy points (wins over minutes)
 *     base_points  players.projected_points before a points override was
 *                  written, so clearing the override can restore it
 */
export async function migrateProjectionOverrides(db) {
  if (DATABASE_TYPE === 'azuresql') {
    await db.exec(`
      IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='projection_overrides' AND xtype='U')
      CREATE TABLE projection_overrides (
        id INT IDENTITY(1,1) PRIMARY KEY,
        slate_id NVARCHAR(100) NOT NULL,
        player_id NVARCHAR(100) NOT NULL,
        minutes FLOAT,
        points FLOAT,
        base_points FLOAT,
        note NVARCHAR(500),
        created_at DATETIME2 DEFAULT GETDATE(),
        updated_at DATETIME2 DEFAULT GETDATE(),
        CONSTRAINT UQ_projection_overrides_slate_player UNIQUE(slate_id, player_id)
      )
    `);
  } else {
    await db.exec(`
      CREATE TABLE IF NOT EXISTS projection_overrides (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        slate_id TEXT NOT NULL,
        player_id TEXT NOT NULL,
        minutes REAL,
        points REAL,
        base_points REAL,
        note TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(slate_id, player_id)
      )
    `);
  }
}
