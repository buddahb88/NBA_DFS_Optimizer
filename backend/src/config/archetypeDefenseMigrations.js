import { DATABASE_TYPE } from './database.js';

/**
 * team_archetype_defense migration (idempotent, runs on every startup)
 *
 * One row per (season, site, group_by, team, group_key): how players of an
 * archetype (group_by 'archetype') or G/F/C position (group_by 'position')
 * scored against `team` relative to their own season-to-date baseline
 * (services/archetypeDefenseService.js). Full-season numbers only; windowed
 * views are computed on request.
 */
const COLUMNS = [
  // [name, azure type, sqlite type]
  ['season', 'NVARCHAR(20) NOT NULL', 'TEXT NOT NULL'],
  ['site', 'NVARCHAR(20) NOT NULL', 'TEXT NOT NULL'],
  ['group_by', 'NVARCHAR(20) NOT NULL', 'TEXT NOT NULL'],
  ['team', 'NVARCHAR(10) NOT NULL', 'TEXT NOT NULL'],
  ['group_key', 'NVARCHAR(50) NOT NULL', 'TEXT NOT NULL'],
  ['games', 'INT', 'INTEGER'],
  ['player_games', 'INT', 'INTEGER'],
  ['avg_minutes', 'FLOAT', 'REAL'],
  ['avg_fp', 'FLOAT', 'REAL'],
  ['avg_expected_fp', 'FLOAT', 'REAL'],
  ['fp_over_expectation_raw', 'FLOAT', 'REAL'],
  ['shrink', 'FLOAT', 'REAL'],
  ['fp_over_expectation', 'FLOAT', 'REAL'],
  ['pts_delta', 'FLOAT', 'REAL'],
  ['reb_delta', 'FLOAT', 'REAL'],
  ['ast_delta', 'FLOAT', 'REAL'],
  ['fg3m_delta', 'FLOAT', 'REAL'],
  ['stocks_delta', 'FLOAT', 'REAL'],
];

export const DEFENSE_COLUMNS = COLUMNS.map(([name]) => name);

export async function migrateTeamArchetypeDefense(db) {
  if (DATABASE_TYPE === 'azuresql') {
    await db.exec(`
      IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='team_archetype_defense' AND xtype='U')
      CREATE TABLE team_archetype_defense (
        id INT IDENTITY(1,1) PRIMARY KEY,
        ${COLUMNS.map(([name, azure]) => `${name} ${azure}`).join(',\n        ')},
        updated_at DATETIME2 DEFAULT GETDATE(),
        CONSTRAINT UQ_team_archetype_defense UNIQUE (season, site, group_by, team, group_key)
      )
    `);
    return;
  }

  await db.exec(`
    CREATE TABLE IF NOT EXISTS team_archetype_defense (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ${COLUMNS.map(([name, , sqlite]) => `${name} ${sqlite}`).join(',\n      ')},
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (season, site, group_by, team, group_key)
    );
  `);
}
