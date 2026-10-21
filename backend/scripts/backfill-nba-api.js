#!/usr/bin/env node

/**
 * BACKFILL historical_games FROM THE NBA STATS API
 *
 * Walks every season from --from (default 2024-25) through the current one,
 * oldest first so each season's opener gets rest days from the prior season's
 * last game. Players whose stored games already match their games played are
 * skipped, so an interrupted run resumes where it left off.
 *
 * Usage:
 *   node scripts/backfill-nba-api.js [--from 2024-25] [--season 2025-26] [--delay 1500]
 *
 *   --from    first season to backfill (default 2024-25)
 *   --season  backfill only this season
 *   --delay   ms between player requests (default 1500, minimum 600)
 *   --force   refetch every player, even ones already complete
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
const { default: nbaStatsService } = await import('../src/services/nbaStatsService.js');
const { listSeasons } = await import('../src/utils/season.js');

const MIN_DELAY_MS = 600;
const SEASON_PAUSE_MS = 10000;

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const only = arg('season');
const seasons = only ? [only] : listSeasons(arg('from') || '2024-25').reverse();
const force = process.argv.includes('--force');
nbaStatsService.requestDelay = Math.max(MIN_DELAY_MS, Number(arg('delay')) || nbaStatsService.requestDelay);

try {
  // Ensures historical_games and its migrations (player_key) exist
  await createTables(db);

  console.log(`Backfilling ${seasons.join(', ')} (${nbaStatsService.requestDelay}ms between requests${force ? ', force' : ''})`);

  for (const [i, season] of seasons.entries()) {
    try {
      const result = await nbaStatsService.fetchSeasonGameLogs(season, null, { skipComplete: !force });
      console.log(`✓ ${season}: ${result.games} rows written, ${result.skipped} of ${result.players} players already complete`);
    } catch (error) {
      console.error(`❌ ${season} failed: ${error.message}`);
      process.exitCode = 1;
    }
    if (i < seasons.length - 1) await nbaStatsService.sleep(SEASON_PAUSE_MS);
  }

  const counts = await db.all(`
    SELECT season, COUNT(*) AS games, COUNT(DISTINCT player_id) AS players,
           MIN(game_date) AS first_game, MAX(game_date) AS last_game
    FROM historical_games
    GROUP BY season
    ORDER BY season
  `);
  console.log('\nhistorical_games by season:');
  console.table(counts);
} catch (error) {
  console.error('❌ Backfill failed:', error.message);
  process.exitCode = 1;
} finally {
  db.close();
}
