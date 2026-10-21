import { DATABASE_TYPE } from './database.js';

/**
 * sync_runs migration (idempotent, runs on every startup)
 *
 * One row per historical_games sync (services/syncRunService.js). A row with
 * no finished_at is the sync in progress; error is set when the run threw or
 * some games failed. source: 'espn', 'espn-scheduled', 'nba-api' or 'blob'.
 */
export async function migrateSyncRuns(db) {
  if (DATABASE_TYPE === 'azuresql') {
    await db.exec(`
      IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='sync_runs' AND xtype='U')
      CREATE TABLE sync_runs (
        id INT IDENTITY(1,1) PRIMARY KEY,
        source NVARCHAR(50) NOT NULL,
        season NVARCHAR(20),
        started_at DATETIME2 NOT NULL,
        finished_at DATETIME2,
        games_inserted INT DEFAULT 0,
        error NVARCHAR(MAX)
      )
    `);
  } else {
    await db.exec(`
      CREATE TABLE IF NOT EXISTS sync_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source TEXT NOT NULL,
        season TEXT,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        games_inserted INTEGER DEFAULT 0,
        error TEXT
      );
    `);
  }
}
