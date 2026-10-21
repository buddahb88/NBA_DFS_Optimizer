import { DATABASE_TYPE } from './database.js';

/**
 * slate_player_snapshots migration (idempotent, runs on every startup)
 *
 * A slate sync wipes players and slates, so every sync / salary import first
 * copies the slate's player rows here (services/slateSnapshotService.js).
 * One row per (game_date, site, slate_id, player_key); re-syncing the same
 * slate overwrites that row with the latest salary, projection, ownership,
 * Vegas and injury values. rostership is projected ownership.
 */
export async function migrateSlatePlayerSnapshots(db) {
  if (DATABASE_TYPE === 'azuresql') {
    await db.exec(`
      IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='slate_player_snapshots' AND xtype='U')
      CREATE TABLE slate_player_snapshots (
        id INT IDENTITY(1,1) PRIMARY KEY,
        snapshot_date DATE NOT NULL,
        game_date DATE NOT NULL,
        slate_id NVARCHAR(100) NOT NULL,
        site NVARCHAR(20) NOT NULL,
        player_key NVARCHAR(255) NOT NULL,
        player_name NVARCHAR(255) NOT NULL,
        team NVARCHAR(50),
        opponent NVARCHAR(50),
        position NVARCHAR(50),
        salary INT,
        projected_points FLOAT,
        projected_minutes FLOAT,
        floor FLOAT,
        ceiling FLOAT,
        rostership FLOAT,
        vegas_implied_total FLOAT,
        vegas_spread FLOAT,
        over_under FLOAT,
        injury_status NVARCHAR(100),
        is_confirmed BIT,
        captured_at DATETIME2 DEFAULT GETDATE(),
        CONSTRAINT UQ_slate_player_snapshots UNIQUE (game_date, site, slate_id, player_key)
      )
    `);
    await db.exec(`
      IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'idx_snapshots_player_key_date')
        CREATE INDEX idx_snapshots_player_key_date ON slate_player_snapshots(player_key, game_date);
    `);
  } else {
    await db.exec(`
      CREATE TABLE IF NOT EXISTS slate_player_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        snapshot_date TEXT NOT NULL,
        game_date TEXT NOT NULL,
        slate_id TEXT NOT NULL,
        site TEXT NOT NULL,
        player_key TEXT NOT NULL,
        player_name TEXT NOT NULL,
        team TEXT,
        opponent TEXT,
        position TEXT,
        salary INTEGER,
        projected_points REAL,
        projected_minutes REAL,
        floor REAL,
        ceiling REAL,
        rostership REAL,
        vegas_implied_total REAL,
        vegas_spread REAL,
        over_under REAL,
        injury_status TEXT,
        is_confirmed INTEGER,
        captured_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(game_date, site, slate_id, player_key)
      );
      CREATE INDEX IF NOT EXISTS idx_snapshots_player_key_date ON slate_player_snapshots(player_key, game_date);
    `);
  }
}
