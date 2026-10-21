import { DATABASE_TYPE } from './database.js';

/**
 * ESPN box score migration (idempotent, runs on every startup)
 *
 * historical_games gets espn_player_id, is_starter and season_type
 * ('regular' | 'play-in' | 'playoffs'), plus a game_id index for resume checks.
 *
 * team_game_stats: one row per (game_id, team) with box score totals and a
 * possession estimate, for usage %, pace and opponent-allowed stats.
 *
 * game_player_status: players listed in a box score who did not play
 * (status 'DNP' for coach's decision, 'INACTIVE' otherwise, ESPN's reason
 * kept as-is), one row per (game_id, player_key).
 */
const NEW_COLUMNS = [
  ['espn_player_id', 'NVARCHAR(50)', 'TEXT'],
  ['is_starter', 'INT', 'INTEGER'],
  ['season_type', 'NVARCHAR(20)', 'TEXT'],
];

export async function migrateEspnBoxScores(db) {
  if (DATABASE_TYPE === 'azuresql') {
    for (const [name, type] of NEW_COLUMNS) {
      await db.exec(`
        IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('historical_games') AND name = '${name}')
          ALTER TABLE historical_games ADD ${name} ${type};
      `);
    }
    await db.exec(`
      IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'idx_historical_game_id')
        CREATE INDEX idx_historical_game_id ON historical_games(game_id);
    `);
    await db.exec(`
      IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='team_game_stats' AND xtype='U')
      CREATE TABLE team_game_stats (
        id INT IDENTITY(1,1) PRIMARY KEY,
        game_id NVARCHAR(100) NOT NULL,
        game_date DATE NOT NULL,
        season NVARCHAR(20),
        season_type NVARCHAR(20),
        team NVARCHAR(10) NOT NULL,
        opponent NVARCHAR(10) NOT NULL,
        is_home INT DEFAULT 0,
        minutes INT,
        pts INT, fgm INT, fga INT, fg3m INT, fg3a INT, ftm INT, fta INT,
        oreb INT, dreb INT, ast INT, tov INT, stl INT, blk INT, pf INT,
        possessions FLOAT,
        created_at DATETIME2 DEFAULT GETDATE(),
        CONSTRAINT UQ_team_game_stats UNIQUE (game_id, team)
      )
    `);
    await db.exec(`
      IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'idx_team_game_stats_team_date')
        CREATE INDEX idx_team_game_stats_team_date ON team_game_stats(team, game_date);
    `);
    await db.exec(`
      IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='game_player_status' AND xtype='U')
      CREATE TABLE game_player_status (
        id INT IDENTITY(1,1) PRIMARY KEY,
        game_id NVARCHAR(100) NOT NULL,
        game_date DATE NOT NULL,
        team NVARCHAR(10) NOT NULL,
        player_key NVARCHAR(255) NOT NULL,
        player_name NVARCHAR(255) NOT NULL,
        espn_player_id NVARCHAR(50),
        status NVARCHAR(20) NOT NULL,
        reason NVARCHAR(255),
        created_at DATETIME2 DEFAULT GETDATE(),
        CONSTRAINT UQ_game_player_status UNIQUE (game_id, player_key)
      )
    `);
    await db.exec(`
      IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'idx_game_player_status_team_date')
        CREATE INDEX idx_game_player_status_team_date ON game_player_status(team, game_date);
    `);
    return;
  }

  const existing = new Set((await db.all(`PRAGMA table_info(historical_games)`)).map(c => c.name));
  for (const [name, , type] of NEW_COLUMNS) {
    if (!existing.has(name)) {
      await db.exec(`ALTER TABLE historical_games ADD COLUMN ${name} ${type}`);
    }
  }
  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_historical_game_id ON historical_games(game_id);

    CREATE TABLE IF NOT EXISTS team_game_stats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      game_id TEXT NOT NULL,
      game_date TEXT NOT NULL,
      season TEXT,
      season_type TEXT,
      team TEXT NOT NULL,
      opponent TEXT NOT NULL,
      is_home INTEGER DEFAULT 0,
      minutes INTEGER,
      pts INTEGER, fgm INTEGER, fga INTEGER, fg3m INTEGER, fg3a INTEGER, ftm INTEGER, fta INTEGER,
      oreb INTEGER, dreb INTEGER, ast INTEGER, tov INTEGER, stl INTEGER, blk INTEGER, pf INTEGER,
      possessions REAL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (game_id, team)
    );
    CREATE INDEX IF NOT EXISTS idx_team_game_stats_team_date ON team_game_stats(team, game_date);

    CREATE TABLE IF NOT EXISTS game_player_status (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      game_id TEXT NOT NULL,
      game_date TEXT NOT NULL,
      team TEXT NOT NULL,
      player_key TEXT NOT NULL,
      player_name TEXT NOT NULL,
      espn_player_id TEXT,
      status TEXT NOT NULL,
      reason TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (game_id, player_key)
    );
    CREATE INDEX IF NOT EXISTS idx_game_player_status_team_date ON game_player_status(team, game_date);
  `);
}
