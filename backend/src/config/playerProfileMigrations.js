import { DATABASE_TYPE } from './database.js';

/**
 * player_season_profiles migration (idempotent, runs on every startup)
 *
 * One row per (season, player_key): regular-season role profile computed
 * in-house from historical_games + team_game_stats
 * (services/playerProfileService.js). Rates (usg_pct, ast_pct, *_reb_pct,
 * stl_pct, blk_pct, ts_pct, three_pa_rate, ft_rate) are fractions (0.31 = 31%).
 * team is the player's latest team, teams every team in order of first game.
 */
const COLUMNS = [
  // [name, azure type, sqlite type]
  ['season', 'NVARCHAR(20) NOT NULL', 'TEXT NOT NULL'],
  ['player_key', 'NVARCHAR(255) NOT NULL', 'TEXT NOT NULL'],
  ['player_name', 'NVARCHAR(255) NOT NULL', 'TEXT NOT NULL'],
  ['espn_player_id', 'NVARCHAR(50)', 'TEXT'],
  ['team', 'NVARCHAR(10)', 'TEXT'],
  ['teams', 'NVARCHAR(100)', 'TEXT'],
  ['position', 'NVARCHAR(10)', 'TEXT'],
  ['games', 'INT', 'INTEGER'],
  ['starts', 'INT', 'INTEGER'],
  ['minutes', 'FLOAT', 'REAL'],
  ['minutes_pg', 'FLOAT', 'REAL'],
  ['usg_pct', 'FLOAT', 'REAL'],
  ['ast_pct', 'FLOAT', 'REAL'],
  ['oreb_pct', 'FLOAT', 'REAL'],
  ['dreb_pct', 'FLOAT', 'REAL'],
  ['reb_pct', 'FLOAT', 'REAL'],
  ['stl_pct', 'FLOAT', 'REAL'],
  ['blk_pct', 'FLOAT', 'REAL'],
  ['three_pa_rate', 'FLOAT', 'REAL'],
  ['ft_rate', 'FLOAT', 'REAL'],
  ['ts_pct', 'FLOAT', 'REAL'],
  ['dk_fppm', 'FLOAT', 'REAL'],
  ['fd_fppm', 'FLOAT', 'REAL'],
  ['pts_per36', 'FLOAT', 'REAL'],
  ['reb_per36', 'FLOAT', 'REAL'],
  ['ast_per36', 'FLOAT', 'REAL'],
  ['fg3m_per36', 'FLOAT', 'REAL'],
];

export const PROFILE_COLUMNS = COLUMNS.map(([name]) => name);

export async function migratePlayerSeasonProfiles(db) {
  if (DATABASE_TYPE === 'azuresql') {
    await db.exec(`
      IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='player_season_profiles' AND xtype='U')
      CREATE TABLE player_season_profiles (
        id INT IDENTITY(1,1) PRIMARY KEY,
        ${COLUMNS.map(([name, type]) => `${name} ${type},`).join('\n        ')}
        updated_at DATETIME2 DEFAULT GETDATE(),
        CONSTRAINT UQ_player_season_profiles UNIQUE (season, player_key)
      )
    `);
    await db.exec(`
      IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'idx_player_season_profiles_player')
        CREATE INDEX idx_player_season_profiles_player ON player_season_profiles(player_key);
    `);
    return;
  }

  await db.exec(`
    CREATE TABLE IF NOT EXISTS player_season_profiles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ${COLUMNS.map(([name, , type]) => `${name} ${type},`).join('\n      ')}
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (season, player_key)
    );
    CREATE INDEX IF NOT EXISTS idx_player_season_profiles_player ON player_season_profiles(player_key);
  `);
}
