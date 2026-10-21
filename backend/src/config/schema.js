import { DATABASE_TYPE } from './database.js';
import { migrateSiteColumns } from './siteMigrations.js';
import { migrateSiteFantasyPoints } from './scoringMigrations.js';
import { migrateProjectionOverrides } from './projectionOverrideMigrations.js';
import { migratePlayerSettings } from './playerSettingsMigrations.js';
import { migratePlayerKey } from './playerKeyMigrations.js';
import { migrateLineupPersistence } from './lineupMigrations.js';
import { migrateSlatePlayerSnapshots } from './snapshotMigrations.js';
import { migrateEspnBoxScores } from './espnMigrations.js';
import { migratePlayerSeasonProfiles } from './playerProfileMigrations.js';

/**
 * Create all database tables
 * Supports both SQLite and Azure SQL syntax
 */
export const createTables = async (db) => {
  console.log('🔄 Initializing database schema...');

  const isAzureSql = DATABASE_TYPE === 'azuresql';

  if (isAzureSql) {
    await createAzureSqlTables(db);
  } else {
    await createSqliteTables(db);
  }

  // Multi-site columns (slates.site, players.site_player_id/roster_positions)
  await migrateSiteColumns(db);

  // historical_games.fd_fantasy_points / yahoo_fantasy_points
  await migrateSiteFantasyPoints(db);

  // historical_games.player_key (+ backfill and (player_key, game_date) index)
  await migratePlayerKey(db);

  // ESPN box scores: historical_games.espn_player_id/is_starter/season_type,
  // team_game_stats and game_player_status
  await migrateEspnBoxScores(db);

  // player_season_profiles (per-season role profiles from box scores)
  await migratePlayerSeasonProfiles(db);

  // Saved lineups survive slate resyncs (no slate/player cascades, denormalized players)
  await migrateLineupPersistence(db);

  // slate_player_snapshots (salary/projection/ownership/Vegas history across syncs)
  await migrateSlatePlayerSnapshots(db);

  // projection_overrides (manual minutes/points per slate)
  await migrateProjectionOverrides(db);
  // Per-slate player controls (Player Pool lock/exclude/exposure/override)
  await migratePlayerSettings(db);
};

/**
 * Azure SQL table creation
 */
async function createAzureSqlTables(db) {
  console.log('📊 Creating Azure SQL tables...');

  // Connect to Azure SQL
  await db.connect();

  // Slates table
  await db.exec(`
    IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='slates' AND xtype='U')
    CREATE TABLE slates (
      id INT IDENTITY(1,1) PRIMARY KEY,
      slate_id NVARCHAR(100) UNIQUE NOT NULL,
      name NVARCHAR(255) NOT NULL,
      sport NVARCHAR(50) DEFAULT 'NBA',
      start_time DATETIME2,
      created_at DATETIME2 DEFAULT GETDATE(),
      updated_at DATETIME2 DEFAULT GETDATE()
    )
  `);

  // Players table
  await db.exec(`
    IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='players' AND xtype='U')
    CREATE TABLE players (
      id INT IDENTITY(1,1) PRIMARY KEY,
      slate_id NVARCHAR(100) NOT NULL,
      player_id NVARCHAR(100) NOT NULL,
      name NVARCHAR(255) NOT NULL,
      team NVARCHAR(50),
      opponent NVARCHAR(50),
      position NVARCHAR(50) NOT NULL,
      salary INT NOT NULL,
      projected_points FLOAT,
      projected_minutes FLOAT,
      value FLOAT,
      game_info NVARCHAR(500),
      injury_status NVARCHAR(100),
      per FLOAT,
      [usage] FLOAT,
      rest_days INT,
      fpts_last3 FLOAT,
      fpts_last5 FLOAT,
      fpts_last7 FLOAT,
      fpts_last14 FLOAT,
      vegas_implied_total FLOAT,
      vegas_spread FLOAT,
      vegas_over_under FLOAT,
      vegas_win_prob FLOAT,
      rostership FLOAT,
      value_gpp FLOAT,
      headshot NVARCHAR(500),
      raw_data NVARCHAR(MAX),
      dvp_pts_allowed FLOAT,
      opp_def_eff FLOAT,
      floor FLOAT,
      ceiling FLOAT,
      volatility FLOAT,
      boom_probability FLOAT,
      bust_probability FLOAT,
      fppm FLOAT,
      leverage_score FLOAT,
      blowout_risk FLOAT,
      std_dev FLOAT,
      rotowire_projection FLOAT,
      lineup_confirmed BIT,
      created_at DATETIME2 DEFAULT GETDATE(),
      updated_at DATETIME2 DEFAULT GETDATE(),
      CONSTRAINT UQ_players_slate_player UNIQUE(slate_id, player_id)
    )
  `);

  // Add missing columns to players table if it already exists
  await db.exec(`
    IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('players') AND name = 'rest_days')
      ALTER TABLE players ADD rest_days INT;
  `);
  await db.exec(`
    IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('players') AND name = 'lineup_confirmed')
      ALTER TABLE players ADD lineup_confirmed BIT;
  `);

  // Lineups table
  await db.exec(`
    IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='lineups' AND xtype='U')
    CREATE TABLE lineups (
      id INT IDENTITY(1,1) PRIMARY KEY,
      slate_id NVARCHAR(100) NOT NULL,
      name NVARCHAR(255) NOT NULL,
      total_salary INT NOT NULL,
      projected_points FLOAT,
      created_at DATETIME2 DEFAULT GETDATE(),
      updated_at DATETIME2 DEFAULT GETDATE()
    )
  `);

  // Lineup players junction table
  await db.exec(`
    IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='lineup_players' AND xtype='U')
    CREATE TABLE lineup_players (
      id INT IDENTITY(1,1) PRIMARY KEY,
      lineup_id INT NOT NULL,
      player_id INT NOT NULL,
      position_slot NVARCHAR(50) NOT NULL,
      FOREIGN KEY (lineup_id) REFERENCES lineups(id) ON DELETE CASCADE
    )
  `);

  // Chat sessions
  await db.exec(`
    IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='chat_sessions' AND xtype='U')
    CREATE TABLE chat_sessions (
      id INT IDENTITY(1,1) PRIMARY KEY,
      title NVARCHAR(255),
      slate_id NVARCHAR(100),
      created_at DATETIME2 DEFAULT GETDATE(),
      updated_at DATETIME2 DEFAULT GETDATE()
    )
  `);

  // Chat messages
  await db.exec(`
    IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='chat_messages' AND xtype='U')
    CREATE TABLE chat_messages (
      id INT IDENTITY(1,1) PRIMARY KEY,
      session_id INT NOT NULL,
      role NVARCHAR(50) NOT NULL,
      content NVARCHAR(MAX) NOT NULL,
      metadata NVARCHAR(MAX),
      created_at DATETIME2 DEFAULT GETDATE(),
      FOREIGN KEY (session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE
    )
  `);

  // Team defense rankings
  await db.exec(`
    IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='team_defense_rankings' AND xtype='U')
    CREATE TABLE team_defense_rankings (
      team NVARCHAR(10) PRIMARY KEY,
      def_eff FLOAT NOT NULL,
      off_eff FLOAT,
      pace FLOAT,
      ast_ratio FLOAT,
      to_ratio FLOAT,
      rebr FLOAT,
      eff_fg_pct FLOAT,
      ts_pct FLOAT,
      updated_at DATETIME2 DEFAULT GETDATE()
    )
  `);

  // Team defense vs position
  await db.exec(`
    IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='team_defense_vs_position' AND xtype='U')
    CREATE TABLE team_defense_vs_position (
      id INT IDENTITY(1,1) PRIMARY KEY,
      team NVARCHAR(10) NOT NULL,
      position NVARCHAR(10) NOT NULL,
      rank INT NOT NULL,
      pts_allowed FLOAT,
      fg_pct_allowed FLOAT,
      tpm_allowed FLOAT,
      reb_allowed FLOAT,
      ast_allowed FLOAT,
      stl_allowed FLOAT,
      blk_allowed FLOAT,
      to_allowed FLOAT,
      updated_at DATETIME2 DEFAULT GETDATE(),
      CONSTRAINT UQ_team_position UNIQUE(team, position)
    )
  `);

  // Historical games
  await db.exec(`
    IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='historical_games' AND xtype='U')
    CREATE TABLE historical_games (
      id INT IDENTITY(1,1) PRIMARY KEY,
      player_id NVARCHAR(100),
      player_name NVARCHAR(255) NOT NULL,
      team NVARCHAR(10) NOT NULL,
      opponent NVARCHAR(10) NOT NULL,
      position NVARCHAR(50),
      game_id NVARCHAR(100),
      game_date DATE NOT NULL,
      season NVARCHAR(20),
      is_home INT DEFAULT 0,
      minutes FLOAT,
      points INT,
      rebounds INT,
      assists INT,
      steals INT,
      blocks INT,
      turnovers INT,
      fouls INT,
      fg_made INT,
      fg_attempted INT,
      fg_pct FLOAT,
      fg3_made INT,
      fg3_attempted INT,
      fg3_pct FLOAT,
      ft_made INT,
      ft_attempted INT,
      ft_pct FLOAT,
      oreb INT,
      dreb INT,
      plus_minus INT,
      ts_pct FLOAT,
      efg_pct FLOAT,
      three_par FLOAT,
      ftr FLOAT,
      orb_pct FLOAT,
      drb_pct FLOAT,
      trb_pct FLOAT,
      ast_pct FLOAT,
      stl_pct FLOAT,
      blk_pct FLOAT,
      tov_pct FLOAT,
      usg_pct FLOAT,
      off_rtg FLOAT,
      def_rtg FLOAT,
      bpm FLOAT,
      dk_fantasy_points FLOAT,
      rest_days INT,
      is_back_to_back INT DEFAULT 0,
      created_at DATETIME2 DEFAULT GETDATE(),
      CONSTRAINT UQ_historical_player_date UNIQUE(player_name, team, game_date)
    )
  `);

  // Add missing columns to historical_games if table already exists
  // This handles migrations for existing tables
  await db.exec(`
    IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('historical_games') AND name = 'rest_days')
      ALTER TABLE historical_games ADD rest_days INT;
    IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('historical_games') AND name = 'is_back_to_back')
      ALTER TABLE historical_games ADD is_back_to_back INT DEFAULT 0;
  `);

  // Create indexes
  await db.exec(`
    IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'idx_players_slate_id')
      CREATE INDEX idx_players_slate_id ON players(slate_id);
    IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'idx_players_position')
      CREATE INDEX idx_players_position ON players(position);
    IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'idx_players_salary')
      CREATE INDEX idx_players_salary ON players(salary);
    IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'idx_lineups_slate_id')
      CREATE INDEX idx_lineups_slate_id ON lineups(slate_id);
    IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'idx_lineup_players_lineup_id')
      CREATE INDEX idx_lineup_players_lineup_id ON lineup_players(lineup_id);
    IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'idx_chat_messages_session_id')
      CREATE INDEX idx_chat_messages_session_id ON chat_messages(session_id);
    IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'idx_chat_sessions_slate_id')
      CREATE INDEX idx_chat_sessions_slate_id ON chat_sessions(slate_id);
    IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'idx_historical_player_name')
      CREATE INDEX idx_historical_player_name ON historical_games(player_name);
    IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'idx_historical_game_date')
      CREATE INDEX idx_historical_game_date ON historical_games(game_date);
    IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'idx_historical_season')
      CREATE INDEX idx_historical_season ON historical_games(season);
    IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'idx_historical_team')
      CREATE INDEX idx_historical_team ON historical_games(team);
    IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'idx_historical_team_date')
      CREATE INDEX idx_historical_team_date ON historical_games(team, game_date);
    IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'idx_historical_opponent_date')
      CREATE INDEX idx_historical_opponent_date ON historical_games(opponent, game_date);
  `);

  console.log('✅ Azure SQL schema ready!');
}

/**
 * SQLite table creation (original code)
 */
async function createSqliteTables(db) {
  // Helper function to check if table exists
  const tableExists = async (tableName) => {
    const result = await db.get(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`, tableName);
    return !!result;
  };

  // Check existing tables
  const tables = ['slates', 'players', 'lineups', 'lineup_players', 'chat_sessions', 'chat_messages', 'team_defense_rankings', 'team_defense_vs_position', 'historical_games'];
  const existingTables = [];
  const newTables = [];

  for (const t of tables) {
    if (await tableExists(t)) {
      existingTables.push(t);
    } else {
      newTables.push(t);
    }
  }

  if (existingTables.length > 0) {
    console.log(`✓ Found ${existingTables.length} existing table(s): ${existingTables.join(', ')}`);
  }
  if (newTables.length > 0) {
    console.log(`⚡ Creating ${newTables.length} new table(s): ${newTables.join(', ')}`);
  }

  // Slates table
  await db.exec(`
    CREATE TABLE IF NOT EXISTS slates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slate_id TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      sport TEXT DEFAULT 'NBA',
      start_time DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Players table
  await db.exec(`
    CREATE TABLE IF NOT EXISTS players (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slate_id TEXT NOT NULL,
      player_id TEXT NOT NULL,
      name TEXT NOT NULL,
      team TEXT,
      opponent TEXT,
      position TEXT NOT NULL,
      salary INTEGER NOT NULL,
      projected_points REAL,
      projected_minutes REAL,
      value REAL,
      game_info TEXT,
      injury_status TEXT,
      per REAL,
      usage REAL,
      fpts_last3 REAL,
      fpts_last5 REAL,
      fpts_last7 REAL,
      fpts_last14 REAL,
      vegas_implied_total REAL,
      vegas_spread REAL,
      vegas_over_under REAL,
      vegas_win_prob REAL,
      rostership REAL,
      value_gpp REAL,
      headshot TEXT,
      raw_data TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(slate_id, player_id),
      FOREIGN KEY (slate_id) REFERENCES slates(slate_id) ON DELETE CASCADE
    )
  `);

  // Add new columns if they don't exist (check first to avoid errors)
  const columnsToAdd = [
    { name: 'rest_days', type: 'INTEGER' },
    { name: 'dvp_pts_allowed', type: 'REAL' },
    { name: 'opp_def_eff', type: 'REAL' },
    { name: 'floor', type: 'REAL' },
    { name: 'ceiling', type: 'REAL' },
    { name: 'volatility', type: 'REAL' },
    { name: 'boom_probability', type: 'REAL' },
    { name: 'bust_probability', type: 'REAL' },
    { name: 'fppm', type: 'REAL' },
    { name: 'leverage_score', type: 'REAL' },
    { name: 'blowout_risk', type: 'REAL' },
    { name: 'std_dev', type: 'REAL' },
    { name: 'rotowire_projection', type: 'REAL' },
    { name: 'lineup_confirmed', type: 'INTEGER' }
  ];

  // Get existing columns to check which need to be added
  const existingColumns = await db.all(`PRAGMA table_info(players)`);
  const existingColumnNames = new Set(existingColumns.map(c => c.name));

  for (const { name, type } of columnsToAdd) {
    if (!existingColumnNames.has(name)) {
      try {
        await db.exec(`ALTER TABLE players ADD COLUMN ${name} ${type}`);
      } catch (e) {
        // Column might already exist, ignore
      }
    }
  }

  // Lineups table
  await db.exec(`
    CREATE TABLE IF NOT EXISTS lineups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slate_id TEXT NOT NULL,
      name TEXT NOT NULL,
      total_salary INTEGER NOT NULL,
      projected_points REAL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Lineup players junction table
  await db.exec(`
    CREATE TABLE IF NOT EXISTS lineup_players (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lineup_id INTEGER NOT NULL,
      player_id INTEGER NOT NULL,
      position_slot TEXT NOT NULL,
      FOREIGN KEY (lineup_id) REFERENCES lineups(id) ON DELETE CASCADE
    )
  `);

  // Chat sessions
  await db.exec(`
    CREATE TABLE IF NOT EXISTS chat_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT,
      slate_id TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (slate_id) REFERENCES slates(slate_id) ON DELETE SET NULL
    )
  `);

  // Chat messages
  await db.exec(`
    CREATE TABLE IF NOT EXISTS chat_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system', 'tool')),
      content TEXT NOT NULL,
      metadata TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE
    )
  `);

  // Team defense rankings
  await db.exec(`
    CREATE TABLE IF NOT EXISTS team_defense_rankings (
      team TEXT PRIMARY KEY,
      def_eff REAL NOT NULL,
      off_eff REAL,
      pace REAL,
      ast_ratio REAL,
      to_ratio REAL,
      rebr REAL,
      eff_fg_pct REAL,
      ts_pct REAL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Team defense vs position
  await db.exec(`
    CREATE TABLE IF NOT EXISTS team_defense_vs_position (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      team TEXT NOT NULL,
      position TEXT NOT NULL,
      rank INTEGER NOT NULL,
      pts_allowed REAL,
      fg_pct_allowed REAL,
      tpm_allowed REAL,
      reb_allowed REAL,
      ast_allowed REAL,
      stl_allowed REAL,
      blk_allowed REAL,
      to_allowed REAL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(team, position)
    )
  `);

  // Historical games
  await db.exec(`
    CREATE TABLE IF NOT EXISTS historical_games (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      player_id TEXT,
      player_name TEXT NOT NULL,
      team TEXT NOT NULL,
      opponent TEXT NOT NULL,
      position TEXT,
      game_id TEXT,
      game_date DATE NOT NULL,
      season TEXT,
      is_home INTEGER DEFAULT 0,
      minutes REAL,
      points INTEGER,
      rebounds INTEGER,
      assists INTEGER,
      steals INTEGER,
      blocks INTEGER,
      turnovers INTEGER,
      fouls INTEGER,
      fg_made INTEGER,
      fg_attempted INTEGER,
      fg_pct REAL,
      fg3_made INTEGER,
      fg3_attempted INTEGER,
      fg3_pct REAL,
      ft_made INTEGER,
      ft_attempted INTEGER,
      ft_pct REAL,
      oreb INTEGER,
      dreb INTEGER,
      plus_minus INTEGER,
      ts_pct REAL,
      efg_pct REAL,
      three_par REAL,
      ftr REAL,
      orb_pct REAL,
      drb_pct REAL,
      trb_pct REAL,
      ast_pct REAL,
      stl_pct REAL,
      blk_pct REAL,
      tov_pct REAL,
      usg_pct REAL,
      off_rtg REAL,
      def_rtg REAL,
      bpm REAL,
      dk_fantasy_points REAL,
      rest_days INTEGER,
      is_back_to_back INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(player_name, team, game_date)
    )
  `);

  // Create indexes
  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_players_slate_id ON players(slate_id);
    CREATE INDEX IF NOT EXISTS idx_players_position ON players(position);
    CREATE INDEX IF NOT EXISTS idx_players_salary ON players(salary);
    CREATE INDEX IF NOT EXISTS idx_lineups_slate_id ON lineups(slate_id);
    CREATE INDEX IF NOT EXISTS idx_lineup_players_lineup_id ON lineup_players(lineup_id);
    CREATE INDEX IF NOT EXISTS idx_chat_messages_session_id ON chat_messages(session_id);
    CREATE INDEX IF NOT EXISTS idx_chat_sessions_slate_id ON chat_sessions(slate_id);
    CREATE INDEX IF NOT EXISTS idx_historical_player_name ON historical_games(player_name);
    CREATE INDEX IF NOT EXISTS idx_historical_game_date ON historical_games(game_date);
    CREATE INDEX IF NOT EXISTS idx_historical_season ON historical_games(season);
    CREATE INDEX IF NOT EXISTS idx_historical_team ON historical_games(team);
    CREATE INDEX IF NOT EXISTS idx_historical_opponent ON historical_games(opponent);
    CREATE INDEX IF NOT EXISTS idx_historical_usg_pct ON historical_games(usg_pct);
    CREATE INDEX IF NOT EXISTS idx_historical_team_date ON historical_games(team, game_date);
    CREATE INDEX IF NOT EXISTS idx_historical_opponent_date ON historical_games(opponent, game_date);
  `);

  if (newTables.length > 0) {
    console.log(`✅ Database schema ready! Created ${newTables.length} new table(s)`);
  } else {
    console.log('✅ Database schema ready! All tables already exist');
  }
}
