#!/usr/bin/env node
/**
 * One-time fix (idempotent): catalog every slate in slate_player_snapshots
 * or slates that has no slate_catalog row (services/slateCatalogService.js),
 * recomputing each touched date's main slate. Live syncs catalog their slate
 * themselves from now on. Prints slate_catalog counts per date before/after.
 *
 * Usage: node scripts/catalog-live-slates.js [--dry-run]
 */

import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../.env') });

const { default: db } = await import('../src/config/database.js');
const { migrateSlateCatalog } = await import('../src/config/snapshotMigrations.js');
const { catalogMissingSlates } = await import('../src/services/slateCatalogService.js');

const dryRun = process.argv.includes('--dry-run');

const countsByDate = async () => db.all(`
  SELECT game_date, site, COUNT(*) AS slates, SUM(CASE WHEN is_main = 1 THEN 1 ELSE 0 END) AS main
  FROM slate_catalog GROUP BY game_date, site ORDER BY game_date, site`);

await migrateSlateCatalog(db);
console.log('slate_catalog before:');
console.table(await countsByDate());

if (dryRun) {
  const missing = await db.all(`
    SELECT DISTINCT s.site, s.slate_id, s.game_date FROM slate_player_snapshots s
    WHERE NOT EXISTS (SELECT 1 FROM slate_catalog c WHERE c.site = s.site AND c.slate_id = s.slate_id)
    ORDER BY s.game_date, s.slate_id`);
  console.log('Dry run, uncataloged snapshot slates:');
  console.table(missing);
} else {
  const { cataloged } = await catalogMissingSlates();
  console.log(`Cataloged ${cataloged.length} slate(s):`);
  console.table(cataloged);
  console.log('slate_catalog after:');
  console.table(await countsByDate());
}

db.close();
