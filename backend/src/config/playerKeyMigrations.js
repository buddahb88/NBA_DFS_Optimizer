import { DATABASE_TYPE } from './database.js';
import { playerKey } from '../utils/playerKey.js';

/**
 * historical_games.player_key migration (idempotent, runs on every startup)
 *
 * player_key = playerKey(player_name): accent/punctuation/suffix-free match
 * key so "Luka Dončić" and "Luka Doncic" resolve to the same player. Rows
 * with a NULL key are backfilled; existing keys are left alone. Also adds
 * the (player_key, game_date) index, which needs the column to exist first.
 */
export async function migratePlayerKey(db) {
  if (DATABASE_TYPE === 'azuresql') {
    await db.exec(`
      IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('historical_games') AND name = 'player_key')
        ALTER TABLE historical_games ADD player_key NVARCHAR(255);
    `);
  } else {
    const existing = new Set((await db.all(`PRAGMA table_info(historical_games)`)).map(c => c.name));
    if (!existing.has('player_key')) {
      await db.exec(`ALTER TABLE historical_games ADD COLUMN player_key TEXT`);
    }
  }

  // Separate batch from the ALTER: SQL Server can't compile a reference to a
  // column in the same batch that adds it
  if (DATABASE_TYPE === 'azuresql') {
    await db.exec(`
      IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'idx_historical_player_key_date')
        CREATE INDEX idx_historical_player_key_date ON historical_games(player_key, game_date);
    `);
  } else {
    await db.exec(`CREATE INDEX IF NOT EXISTS idx_historical_player_key_date ON historical_games(player_key, game_date)`);
  }

  const updated = await backfillPlayerKeys(db);
  if (updated > 0) {
    console.log(`✓ Backfilled player_key for ${updated} historical game row(s)`);
  }
}

/**
 * Set player_key on rows where it is NULL. The key is computed in JS (no SQL
 * equivalent for accent stripping), one UPDATE per distinct player_name.
 * Returns the number of rows updated.
 */
export async function backfillPlayerKeys(db) {
  const names = await db.all(`SELECT DISTINCT player_name FROM historical_games WHERE player_key IS NULL`);
  let updated = 0;
  for (const { player_name } of names) {
    const result = await db.run(
      `UPDATE historical_games SET player_key = ? WHERE player_name = ? AND player_key IS NULL`,
      playerKey(player_name), player_name
    );
    updated += result?.changes || 0;
  }
  return updated;
}
