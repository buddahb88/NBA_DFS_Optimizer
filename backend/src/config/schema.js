export const createTables = (db) => {
  console.log('🔄 Initializing database schema...');

  // Helper function to check if table exists
  const tableExists = (tableName) => {
    const result = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(tableName);
    return !!result;
  };

  // Check existing tables
  const tables = ['slates', 'players', 'lineups', 'lineup_players', 'chat_sessions', 'chat_messages', 'team_defense_rankings', 'team_defense_vs_position'];
  const existingTables = tables.filter(t => tableExists(t));
  const newTables = tables.filter(t => !tableExists(t));

  if (existingTables.length > 0) {
    console.log(`✓ Found ${existingTables.length} existing table(s): ${existingTables.join(', ')}`);
  }
  if (newTables.length > 0) {
    console.log(`⚡ Creating ${newTables.length} new table(s): ${newTables.join(', ')}`);
  }

  // Slates table - stores different DFS slates (Main, Showdown, etc.)
  db.exec(`
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

  // Players table - stores player information for each slate
  db.exec(`
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

  // Add new columns if they don't exist (for existing databases)
  const columnsToAdd = [
    { name: 'projected_minutes', type: 'REAL' },
    { name: 'per', type: 'REAL' },
    { name: 'usage', type: 'REAL' },
    { name: 'rest_days', type: 'INTEGER' },
    { name: 'fpts_last3', type: 'REAL' },
    { name: 'fpts_last5', type: 'REAL' },
    { name: 'fpts_last7', type: 'REAL' },
    { name: 'fpts_last14', type: 'REAL' },
    { name: 'vegas_implied_total', type: 'REAL' },
    { name: 'vegas_spread', type: 'REAL' },
    { name: 'vegas_over_under', type: 'REAL' },
    { name: 'vegas_win_prob', type: 'REAL' },
    { name: 'rostership', type: 'REAL' },
    { name: 'value_gpp', type: 'REAL' },
    { name: 'headshot', type: 'TEXT' },
    { name: 'dvp_pts_allowed', type: 'REAL' },
    { name: 'opp_def_eff', type: 'REAL' },
    // Advanced projection metrics
    { name: 'floor', type: 'REAL' },                    // 25th percentile projection
    { name: 'ceiling', type: 'REAL' },                  // 75th percentile projection
    { name: 'volatility', type: 'REAL' },               // Standard deviation / mean
    { name: 'boom_probability', type: 'REAL' },         // % chance of exceeding value by 10+ pts
    { name: 'bust_probability', type: 'REAL' },         // % chance of failing to meet value
    { name: 'fppm', type: 'REAL' },                     // Weighted fantasy points per minute
    { name: 'leverage_score', type: 'REAL' },           // GPP leverage (boom prob / ownership)
    { name: 'blowout_risk', type: 'REAL' },             // Blowout risk adjustment
    { name: 'std_dev', type: 'REAL' },                  // Standard deviation of recent games
    { name: 'rotowire_projection', type: 'REAL' }       // Original RotoWire projection (baseline)
  ];

  columnsToAdd.forEach(({ name, type }) => {
    try {
      db.exec(`ALTER TABLE players ADD COLUMN ${name} ${type}`);
    } catch (e) {
      // Column already exists, ignore
    }
  });

  // Lineups table - stores user-created lineups
  db.exec(`
    CREATE TABLE IF NOT EXISTS lineups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slate_id TEXT NOT NULL,
      name TEXT NOT NULL,
      total_salary INTEGER NOT NULL,
      projected_points REAL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (slate_id) REFERENCES slates(slate_id) ON DELETE CASCADE
    )
  `);

  // Lineup players - junction table for lineups and players
  db.exec(`
    CREATE TABLE IF NOT EXISTS lineup_players (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lineup_id INTEGER NOT NULL,
      player_id INTEGER NOT NULL,
      position_slot TEXT NOT NULL,
      FOREIGN KEY (lineup_id) REFERENCES lineups(id) ON DELETE CASCADE,
      FOREIGN KEY (player_id) REFERENCES players(id) ON DELETE CASCADE
    )
  `);

  // Chat sessions - stores AI chat conversations
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT,
      slate_id TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (slate_id) REFERENCES slates(slate_id) ON DELETE SET NULL
    )
  `);

  // Chat messages - stores individual messages in conversations
  db.exec(`
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

  // Team defense rankings - stores team defensive efficiency and advanced stats
  db.exec(`
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

  // Team defense vs position - position-specific defensive rankings
  db.exec(`
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

  // Create indexes for better query performance
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_players_slate_id ON players(slate_id);
    CREATE INDEX IF NOT EXISTS idx_players_position ON players(position);
    CREATE INDEX IF NOT EXISTS idx_players_salary ON players(salary);
    CREATE INDEX IF NOT EXISTS idx_lineups_slate_id ON lineups(slate_id);
    CREATE INDEX IF NOT EXISTS idx_lineup_players_lineup_id ON lineup_players(lineup_id);
    CREATE INDEX IF NOT EXISTS idx_chat_messages_session_id ON chat_messages(session_id);
    CREATE INDEX IF NOT EXISTS idx_chat_sessions_slate_id ON chat_sessions(slate_id);
  `);

  if (newTables.length > 0) {
    console.log(`✅ Database schema ready! Created ${newTables.length} new table(s)`);
  } else {
    console.log('✅ Database schema ready! All tables already exist');
  }
};
