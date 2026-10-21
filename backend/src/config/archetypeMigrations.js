import { DATABASE_TYPE } from './database.js';

/**
 * player_archetypes migration (idempotent, runs on every startup)
 *
 * One row per (season, player_key) from player_season_profiles, classified by
 * the rules in config/archetypes.js (services/archetypeService.js).
 * archetype / secondary_archetype hold archetype keys; rule_trace is JSON
 * explaining the sample check and every rule evaluated.
 */
export async function migratePlayerArchetypes(db) {
  if (DATABASE_TYPE === 'azuresql') {
    await db.exec(`
      IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='player_archetypes' AND xtype='U')
      CREATE TABLE player_archetypes (
        id INT IDENTITY(1,1) PRIMARY KEY,
        season NVARCHAR(20) NOT NULL,
        player_key NVARCHAR(255) NOT NULL,
        archetype NVARCHAR(50) NOT NULL,
        secondary_archetype NVARCHAR(50),
        rule_trace NVARCHAR(MAX),
        updated_at DATETIME2 DEFAULT GETDATE(),
        CONSTRAINT UQ_player_archetypes UNIQUE (season, player_key)
      )
    `);
    await db.exec(`
      IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'idx_player_archetypes_player')
        CREATE INDEX idx_player_archetypes_player ON player_archetypes(player_key);
    `);
    return;
  }

  await db.exec(`
    CREATE TABLE IF NOT EXISTS player_archetypes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      season TEXT NOT NULL,
      player_key TEXT NOT NULL,
      archetype TEXT NOT NULL,
      secondary_archetype TEXT,
      rule_trace TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (season, player_key)
    );
    CREATE INDEX IF NOT EXISTS idx_player_archetypes_player ON player_archetypes(player_key);
  `);
}
