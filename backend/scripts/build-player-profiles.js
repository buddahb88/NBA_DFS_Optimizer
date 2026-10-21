#!/usr/bin/env node

/**
 * BUILD player_season_profiles FROM BOX SCORES
 *
 * Recomputes per-season role profiles (usage, assist/rebound/steal/block
 * rates, shot profile, fantasy points per minute, per-36) from
 * historical_games + team_game_stats for every season from --from (default
 * 2024-25) through the current one. Each season's rows are replaced.
 *
 * Usage:
 *   node scripts/build-player-profiles.js [--from 2024-25] [--season 2026-27]
 *
 * Works with SQLite (default) or Azure SQL (DATABASE_TYPE=azuresql in backend/.env).
 */

import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Load env before the database module reads DATABASE_TYPE
dotenv.config({ path: path.join(__dirname, '../.env') });

const { default: db } = await import('../src/config/database.js');
const { createTables } = await import('../src/config/schema.js');
const { refreshProfiles, FIRST_PROFILE_SEASON } = await import('../src/services/playerProfileService.js');
const { listSeasons } = await import('../src/utils/season.js');

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const only = arg('season');
const seasons = only ? [only] : listSeasons(arg('from') || FIRST_PROFILE_SEASON).reverse();

try {
  await createTables(db);

  for (const result of await refreshProfiles(seasons)) {
    console.log(`✓ ${result.season}: ${result.players} players from ${result.games} player-games`);
  }

  console.log('\nTop usage (min 20 games, 25 mpg) by season:');
  console.table(await db.all(`
    SELECT season, player_name, team, position, games, ROUND(minutes_pg, 1) AS mpg,
           ROUND(usg_pct * 100, 1) AS usg, ROUND(ast_pct * 100, 1) AS ast,
           ROUND(reb_pct * 100, 1) AS reb, ROUND(dk_fppm, 2) AS dk_fppm
    FROM (
      SELECT p.*, ROW_NUMBER() OVER (PARTITION BY season ORDER BY usg_pct DESC) AS rn
      FROM player_season_profiles p
      WHERE games >= 20 AND minutes_pg >= 25
    ) ranked
    WHERE rn <= 5
    ORDER BY season, usg_pct DESC
  `));
} catch (error) {
  console.error('❌ Profile build failed:', error.message);
  process.exitCode = 1;
} finally {
  db.close();
}
