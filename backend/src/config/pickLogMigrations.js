import { DATABASE_TYPE } from './database.js';

/**
 * pick_log migration (idempotent, runs on every startup)
 *
 * Forward-test log of lineup picks (services/pickLogService.js): one row per
 * (site, slate_id, source), logged before the slate's first game. Re-logging
 * the same slate + source before lock replaces the row. Result columns stay
 * NULL until the box scores exist (scorePick).
 *
 *   source        free text: 'max_projection', 'gpp_sim_win', ...; a
 *                 '_backfill' suffix marks a pick logged after the fact
 *                 (is_forward = 0), never a forward test
 *   lineup_json   [{ player_key, player_id, name, position, team, salary,
 *                  projected_points, ownership }]
 *   meta_json     projection signature, settings, contest size, ...
 *   players_json  per player result once scored: [{ player_key, name,
 *                  status, actual_points, actual_minutes }]
 *   field_percentile  estimated percentile in an ownership-sampled field
 *
 * pick_log_nights: what the real contests needed on a night, entered by hand
 * (cash line, winning score), so the estimated percentiles can be calibrated.
 */
export async function migratePickLog(db) {
  if (DATABASE_TYPE === 'azuresql') {
    await db.exec(`
      IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='pick_log' AND xtype='U')
      CREATE TABLE pick_log (
        id INT IDENTITY(1,1) PRIMARY KEY,
        slate_id NVARCHAR(100) NOT NULL,
        game_date DATE NOT NULL,
        site NVARCHAR(20) NOT NULL,
        source NVARCHAR(100) NOT NULL,
        is_forward BIT NOT NULL DEFAULT 1,
        logged_at NVARCHAR(40) NOT NULL,
        lock_time NVARCHAR(40),
        total_salary INT,
        projected_points FLOAT,
        projected_ownership FLOAT,
        lineup_json NVARCHAR(MAX) NOT NULL,
        meta_json NVARCHAR(MAX),
        actual_points FLOAT,
        players_json NVARCHAR(MAX),
        dnp_count INT,
        field_percentile FLOAT,
        field_size INT,
        scored_at NVARCHAR(40),
        CONSTRAINT UQ_pick_log UNIQUE (site, slate_id, source)
      )
    `);
    await db.exec(`
      IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'idx_pick_log_date')
        CREATE INDEX idx_pick_log_date ON pick_log(game_date, site);
    `);
    await db.exec(`
      IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='pick_log_nights' AND xtype='U')
      CREATE TABLE pick_log_nights (
        id INT IDENTITY(1,1) PRIMARY KEY,
        game_date DATE NOT NULL,
        site NVARCHAR(20) NOT NULL,
        slate_id NVARCHAR(100) NOT NULL,
        cash_line FLOAT,
        winning_score FLOAT,
        contest_name NVARCHAR(255),
        notes NVARCHAR(1000),
        updated_at NVARCHAR(40),
        CONSTRAINT UQ_pick_log_nights UNIQUE (site, slate_id)
      )
    `);
  } else {
    await db.exec(`
      CREATE TABLE IF NOT EXISTS pick_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        slate_id TEXT NOT NULL,
        game_date TEXT NOT NULL,
        site TEXT NOT NULL,
        source TEXT NOT NULL,
        is_forward INTEGER NOT NULL DEFAULT 1,
        logged_at TEXT NOT NULL,
        lock_time TEXT,
        total_salary INTEGER,
        projected_points REAL,
        projected_ownership REAL,
        lineup_json TEXT NOT NULL,
        meta_json TEXT,
        actual_points REAL,
        players_json TEXT,
        dnp_count INTEGER,
        field_percentile REAL,
        field_size INTEGER,
        scored_at TEXT,
        UNIQUE(site, slate_id, source)
      );
      CREATE INDEX IF NOT EXISTS idx_pick_log_date ON pick_log(game_date, site);
      CREATE TABLE IF NOT EXISTS pick_log_nights (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        game_date TEXT NOT NULL,
        site TEXT NOT NULL,
        slate_id TEXT NOT NULL,
        cash_line REAL,
        winning_score REAL,
        contest_name TEXT,
        notes TEXT,
        updated_at TEXT,
        UNIQUE(site, slate_id)
      );
    `);
  }
}
