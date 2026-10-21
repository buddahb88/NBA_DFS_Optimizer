#!/usr/bin/env node

/**
 * BACKFILL historical_games FROM ESPN BOX SCORES
 *
 * Walks every season from --from (default 2024-25) through the current one,
 * oldest first so each season's opener gets rest days from the prior season's
 * last game. Each season runs from opening night (utils/season.js) through
 * June 30, capped at yesterday. Games already fully loaded are skipped, so an
 * interrupted run resumes where it left off. Also fills team_game_stats and
 * game_player_status.
 *
 * Usage:
 *   node scripts/backfill-espn.js [--from 2024-25] [--season 2025-26]
 *                                 [--start 2025-01-01 --end 2025-01-31] [--delay 400] [--force]
 *
 *   --from    first season to backfill (default 2024-25)
 *   --season  backfill only this season
 *   --start/--end  backfill only this date range (YYYY-MM-DD, inclusive)
 *   --delay   ms between ESPN requests (default 400, minimum 250)
 *   --force   refetch games that are already loaded
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
const { default: espn } = await import('../src/services/espnBoxScoreService.js');
const { listSeasons } = await import('../src/utils/season.js');

const MIN_DELAY_MS = 250;

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const only = arg('season');
const start = arg('start');
const end = arg('end');
const seasons = only ? [only] : listSeasons(arg('from') || '2024-25').reverse();
const skipLoaded = !process.argv.includes('--force');
espn.requestDelay = Math.max(MIN_DELAY_MS, Number(arg('delay')) || espn.requestDelay);

if (Boolean(start) !== Boolean(end)) {
  console.error('❌ --start and --end go together');
  process.exit(1);
}

try {
  // Ensures historical_games, team_game_stats, game_player_status and their migrations exist
  await createTables(db);

  const failed = [];
  if (start) {
    console.log(`Backfilling ${start} → ${end} (${espn.requestDelay}ms between requests${skipLoaded ? '' : ', force'})`);
    const result = await espn.syncDates(start, end, { skipLoaded });
    failed.push(...result.failed);
  } else {
    console.log(`Backfilling ${seasons.join(', ')} (${espn.requestDelay}ms between requests${skipLoaded ? '' : ', force'})`);
    for (const season of seasons) {
      try {
        const result = await espn.syncSeason(season, { skipLoaded });
        console.log(`✓ ${season}: ${result.games} games loaded (${result.rows} player rows), ${result.skipped} already loaded, ${result.failed.length} failed`);
        failed.push(...result.failed);
      } catch (error) {
        console.error(`❌ ${season} failed: ${error.message}`);
        process.exitCode = 1;
      }
    }
  }

  console.log('\nhistorical_games by season:');
  console.table(await db.all(`
    SELECT season, season_type, COUNT(*) AS rows, COUNT(DISTINCT player_key) AS players,
           COUNT(DISTINCT game_id) AS games, MIN(game_date) AS first_game, MAX(game_date) AS last_game
    FROM historical_games
    GROUP BY season, season_type
    ORDER BY season, season_type
  `));
  console.log('team_game_stats / game_player_status by season:');
  console.table(await db.all(`
    SELECT t.season, COUNT(*) AS team_rows, COUNT(DISTINCT t.game_id) AS games,
           (SELECT COUNT(*) FROM game_player_status s
            WHERE s.game_id IN (SELECT game_id FROM team_game_stats WHERE season = t.season)) AS status_rows
    FROM team_game_stats t
    GROUP BY t.season
    ORDER BY t.season
  `));

  if (failed.length > 0) {
    console.log(`\n${failed.length} failed (rerun to retry; loaded games are skipped):`);
    console.table(failed);
    process.exitCode = 1;
  } else {
    console.log('\nNo failed games.');
  }
} catch (error) {
  console.error('❌ Backfill failed:', error.message);
  process.exitCode = 1;
} finally {
  db.close();
}
