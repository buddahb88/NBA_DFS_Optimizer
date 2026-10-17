#!/usr/bin/env node

/**
 * BACKFILL FANDUEL / YAHOO FANTASY POINTS
 *
 * Adds historical_games.fd_fantasy_points and yahoo_fantasy_points if missing,
 * then computes them from the stored box score stats using the scoring
 * weights in src/config/sites.js. dk_fantasy_points is not changed.
 *
 * Usage:
 *   node scripts/backfill-site-fantasy-points.js [--force]
 *
 *   --force  recompute every row, not only rows where the column is NULL
 *            (use after changing scoring weights in sites.js)
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
const { migrateSiteFantasyPoints, backfillSiteFantasyPoints } = await import('../src/config/scoringMigrations.js');

const force = process.argv.includes('--force');

try {
  // Adds the columns and fills NULL rows
  await migrateSiteFantasyPoints(db);

  if (force) {
    const updated = await backfillSiteFantasyPoints(db, { force: true });
    console.log(`✓ Recomputed ${updated} FanDuel/Yahoo value(s)`);
  }

  const summary = await db.get(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN fd_fantasy_points IS NULL THEN 1 ELSE 0 END) as fd_missing,
      SUM(CASE WHEN yahoo_fantasy_points IS NULL THEN 1 ELSE 0 END) as yahoo_missing,
      AVG(dk_fantasy_points) as avg_dk,
      AVG(fd_fantasy_points) as avg_fd,
      AVG(yahoo_fantasy_points) as avg_yahoo
    FROM historical_games
  `);
  const fmt = (v) => (v === null || v === undefined ? '-' : Number(v).toFixed(2));
  console.log(`historical_games rows: ${summary.total}`);
  console.log(`  missing FD: ${summary.fd_missing || 0}, missing Yahoo: ${summary.yahoo_missing || 0} (rows with no box score stats stay NULL)`);
  console.log(`  avg DK ${fmt(summary.avg_dk)} | FD ${fmt(summary.avg_fd)} | Yahoo ${fmt(summary.avg_yahoo)}`);
} catch (error) {
  console.error('❌ Backfill failed:', error.message);
  process.exitCode = 1;
} finally {
  db.close();
}
