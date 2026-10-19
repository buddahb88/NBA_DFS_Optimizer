import { DATABASE_TYPE } from './database.js';
import { NEW_SITE_POINTS_SITES, SITE_POINTS_COLUMNS, fantasyPointsSql } from '../services/scoring.js';

/**
 * Per-site fantasy points migration (idempotent, runs on every startup)
 *
 * - historical_games.fd_fantasy_points     FanDuel points
 * - historical_games.yahoo_fantasy_points  Yahoo points
 *
 * Both are computed from the stored box score stats with the weights in
 * config/sites.js. dk_fantasy_points is left untouched.
 */
export async function migrateSiteFantasyPoints(db) {
  const columns = NEW_SITE_POINTS_SITES.map(site => SITE_POINTS_COLUMNS[site]);

  if (DATABASE_TYPE === 'azuresql') {
    await db.exec(columns.map(c => `
      IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('historical_games') AND name = '${c}')
        ALTER TABLE historical_games ADD ${c} FLOAT;
    `).join(''));
  } else {
    const existing = new Set((await db.all(`PRAGMA table_info(historical_games)`)).map(c => c.name));
    for (const c of columns) {
      if (!existing.has(c)) {
        await db.exec(`ALTER TABLE historical_games ADD COLUMN ${c} REAL`);
      }
    }
  }

  // Separate statements from the ALTERs: SQL Server can't compile a reference
  // to a column in the same batch that adds it
  const updated = await backfillSiteFantasyPoints(db);
  if (updated > 0) {
    console.log(`✓ Backfilled FanDuel/Yahoo fantasy points for ${updated} historical game row(s)`);
  }
}

/**
 * Fill fd/yahoo points from box score stats. Only touches rows where the
 * column is NULL unless force is true. Rows with no stats (points NULL) are
 * skipped. Returns the number of column values written.
 */
export async function backfillSiteFantasyPoints(db, { force = false, sites = NEW_SITE_POINTS_SITES } = {}) {
  let updated = 0;
  for (const site of sites) {
    const column = SITE_POINTS_COLUMNS[site];
    const result = await db.run(`
      UPDATE historical_games SET ${column} = ${fantasyPointsSql(site)}
      WHERE points IS NOT NULL${force ? '' : ` AND ${column} IS NULL`}
    `);
    updated += result?.changes || 0;
  }
  return updated;
}
