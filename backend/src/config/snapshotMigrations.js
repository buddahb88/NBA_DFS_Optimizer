import { DATABASE_TYPE } from './database.js';

/**
 * Columns added so a past slate can be rebuilt (optimizer, portfolio, chat),
 * not just scored: DK slot eligibility and export IDs, the game start time
 * (UTC ISO, for late swap), the pre-lock variance metrics, the RotoWire
 * inputs projection recalculation reads (raw_data keeps the full feed row),
 * and the archetype / opponent matchup cell as known at capture time.
 * Names match the players columns they copy, except the matchup_* fields.
 */
export const SNAPSHOT_DETAIL_COLUMNS = [
  { name: 'player_id', sqlite: 'TEXT', azure: 'NVARCHAR(100)' },
  { name: 'site_player_id', sqlite: 'TEXT', azure: 'NVARCHAR(100)' },
  { name: 'roster_positions', sqlite: 'TEXT', azure: 'NVARCHAR(100)' },
  { name: 'game_info', sqlite: 'TEXT', azure: 'NVARCHAR(255)' },
  { name: 'game_start_time', sqlite: 'TEXT', azure: 'NVARCHAR(40)' },
  { name: 'is_home', sqlite: 'INTEGER', azure: 'BIT' },
  { name: 'std_dev', sqlite: 'REAL', azure: 'FLOAT' },
  { name: 'volatility', sqlite: 'REAL', azure: 'FLOAT' },
  { name: 'boom_probability', sqlite: 'REAL', azure: 'FLOAT' },
  { name: 'bust_probability', sqlite: 'REAL', azure: 'FLOAT' },
  { name: 'leverage_score', sqlite: 'REAL', azure: 'FLOAT' },
  { name: 'blowout_risk', sqlite: 'REAL', azure: 'FLOAT' },
  { name: 'fppm', sqlite: 'REAL', azure: 'FLOAT' },
  { name: 'value', sqlite: 'REAL', azure: 'FLOAT' },
  { name: 'value_gpp', sqlite: 'REAL', azure: 'FLOAT' },
  { name: 'per', sqlite: 'REAL', azure: 'FLOAT' },
  { name: 'usage', sqlite: 'REAL', azure: 'FLOAT' },
  { name: 'fpts_last3', sqlite: 'REAL', azure: 'FLOAT' },
  { name: 'fpts_last5', sqlite: 'REAL', azure: 'FLOAT' },
  { name: 'fpts_last7', sqlite: 'REAL', azure: 'FLOAT' },
  { name: 'fpts_last14', sqlite: 'REAL', azure: 'FLOAT' },
  { name: 'vegas_win_prob', sqlite: 'REAL', azure: 'FLOAT' },
  { name: 'rest_days', sqlite: 'INTEGER', azure: 'INT' },
  { name: 'dvp_pts_allowed', sqlite: 'REAL', azure: 'FLOAT' },
  { name: 'opp_def_eff', sqlite: 'REAL', azure: 'FLOAT' },
  { name: 'rotowire_projection', sqlite: 'REAL', azure: 'FLOAT' },
  { name: 'headshot', sqlite: 'TEXT', azure: 'NVARCHAR(500)' },
  { name: 'raw_data', sqlite: 'TEXT', azure: 'NVARCHAR(MAX)' },
  { name: 'archetype', sqlite: 'TEXT', azure: 'NVARCHAR(50)' },
  { name: 'matchup_grouping', sqlite: 'TEXT', azure: 'NVARCHAR(20)' },
  { name: 'matchup_group_key', sqlite: 'TEXT', azure: 'NVARCHAR(50)' },
  { name: 'matchup_season', sqlite: 'TEXT', azure: 'NVARCHAR(20)' },
  { name: 'matchup_delta', sqlite: 'REAL', azure: 'FLOAT' },
  { name: 'matchup_rank', sqlite: 'INTEGER', azure: 'INT' },
  { name: 'matchup_teams', sqlite: 'INTEGER', azure: 'INT' },
  { name: 'matchup_adjusted_edge', sqlite: 'REAL', azure: 'FLOAT' },
];

/**
 * Ranges recomputed after the fact with the current outcome model
 * (scripts/recompute-snapshot-ranges.js, only games before the slate date).
 * Kept apart from the pre-lock floor / ceiling / std_dev / boom / bust, which
 * stay as they were when the slate was live. Never written by a slate sync.
 */
export const RANGE_MODEL_COLUMNS = [
  { name: 'floor_model', sqlite: 'REAL', azure: 'FLOAT' },
  { name: 'ceiling_model', sqlite: 'REAL', azure: 'FLOAT' },
  { name: 'std_dev_model', sqlite: 'REAL', azure: 'FLOAT' },
  { name: 'volatility_model', sqlite: 'REAL', azure: 'FLOAT' },
  { name: 'boom_model', sqlite: 'REAL', azure: 'FLOAT' },
  { name: 'bust_model', sqlite: 'REAL', azure: 'FLOAT' },
  { name: 'leverage_model', sqlite: 'REAL', azure: 'FLOAT' },
  { name: 'range_model_version', sqlite: 'TEXT', azure: 'NVARCHAR(40)' },
  { name: 'range_model_at', sqlite: 'TEXT', azure: 'NVARCHAR(40)' },
];

/**
 * Where a row came from: NULL for a live capture (slate sync / salary
 * import), 'rotowire_backfill' for a past slate rebuilt from RotoWire after
 * the fact (services/rotowireSlateBackfillService.js). A backfill never
 * overwrites live rows unless forced. Never written by a slate sync.
 */
export const CAPTURE_SOURCE_COLUMNS = [
  { name: 'capture_source', sqlite: 'TEXT', azure: 'NVARCHAR(40)' },
];

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
    for (const { name, azure } of [...SNAPSHOT_DETAIL_COLUMNS, ...RANGE_MODEL_COLUMNS, ...CAPTURE_SOURCE_COLUMNS]) {
      await db.exec(`
        IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('slate_player_snapshots') AND name = '${name}')
          ALTER TABLE slate_player_snapshots ADD [${name}] ${azure};
      `);
    }
    await db.exec(`
      IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'idx_snapshots_slate')
        CREATE INDEX idx_snapshots_slate ON slate_player_snapshots(slate_id, game_date);
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
    const existing = new Set((await db.all(`PRAGMA table_info(slate_player_snapshots)`)).map(c => c.name));
    for (const { name, sqlite } of [...SNAPSHOT_DETAIL_COLUMNS, ...RANGE_MODEL_COLUMNS, ...CAPTURE_SOURCE_COLUMNS]) {
      if (!existing.has(name)) await db.exec(`ALTER TABLE slate_player_snapshots ADD COLUMN ${name} ${sqlite}`);
    }
    await db.exec(`CREATE INDEX IF NOT EXISTS idx_snapshots_slate ON slate_player_snapshots(slate_id, game_date)`);
  }
}

/**
 * slate_catalog migration (idempotent): every RotoWire slate id we know for
 * a past or present date (site, contest type, game count, first lock), with
 * is_main marking the main slate of the date (most games, earliest lock).
 * Kept apart from slates, which holds only the one synced live slate and is
 * wiped by every sync. Backtests use is_main to pick a date's default slate.
 */
export async function migrateSlateCatalog(db) {
  if (DATABASE_TYPE === 'azuresql') {
    await db.exec(`
      IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='slate_catalog' AND xtype='U')
      CREATE TABLE slate_catalog (
        id INT IDENTITY(1,1) PRIMARY KEY,
        site NVARCHAR(20) NOT NULL,
        slate_id NVARCHAR(100) NOT NULL,
        game_date DATE NOT NULL,
        name NVARCHAR(255),
        contest_type NVARCHAR(20),
        games INT,
        players INT,
        first_game_time NVARCHAR(40),
        is_main BIT NOT NULL DEFAULT 0,
        source NVARCHAR(40),
        updated_at NVARCHAR(40),
        CONSTRAINT UQ_slate_catalog UNIQUE (site, slate_id)
      )
    `);
    await db.exec(`
      IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'idx_slate_catalog_date')
        CREATE INDEX idx_slate_catalog_date ON slate_catalog(game_date, site);
    `);
  } else {
    await db.exec(`
      CREATE TABLE IF NOT EXISTS slate_catalog (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        site TEXT NOT NULL,
        slate_id TEXT NOT NULL,
        game_date TEXT NOT NULL,
        name TEXT,
        contest_type TEXT,
        games INTEGER,
        players INTEGER,
        first_game_time TEXT,
        is_main INTEGER NOT NULL DEFAULT 0,
        source TEXT,
        updated_at TEXT,
        UNIQUE(site, slate_id)
      );
      CREATE INDEX IF NOT EXISTS idx_slate_catalog_date ON slate_catalog(game_date, site);
    `);
  }
}
