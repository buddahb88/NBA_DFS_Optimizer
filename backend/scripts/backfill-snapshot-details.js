#!/usr/bin/env node
/**
 * Complete slate_player_snapshots for slates still in the players table
 * (services/snapshotBackfillService.js): DK slots / IDs, game start, raw_data,
 * archetype, and the pre-lock variance metrics rebuilt with the legacy range
 * model when they reproduce the stored pre-lock floor / ceiling. Pre-lock
 * salary, projection, ownership, floor and ceiling are never overwritten.
 * Runs the schema migration first.
 *
 * Usage: node scripts/backfill-snapshot-details.js [--legacy-ranges] [slateId ...]
 *        (default: every slate in the players table)
 */

import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../.env') });

const { default: db } = await import('../src/config/database.js');
const { migrateSlatePlayerSnapshots } = await import('../src/config/snapshotMigrations.js');
const { backfillSlateSnapshot } = await import('../src/services/snapshotBackfillService.js');

const args = process.argv.slice(2);
const legacyRanges = args.includes('--legacy-ranges');
let slateIds = args.filter((a) => !a.startsWith('--'));

await migrateSlatePlayerSnapshots(db);
if (slateIds.length === 0) {
  slateIds = (await db.all(`SELECT DISTINCT slate_id FROM players`)).map((r) => r.slate_id);
}

let ok = true;
for (const slateId of slateIds) {
  const report = await backfillSlateSnapshot(slateId, { legacyRanges });
  ok = ok && report.complete;
  console.log(`Slate ${slateId}: ${report.snapshotRows}/${report.players} snapshot rows, complete=${report.complete}`);
  console.log(`  ranges: ${JSON.stringify(report.rangeSource)}`);
  for (const m of report.missing.slice(0, 20)) console.log(`  missing ${m.player_key}: ${m.columns.join(', ')}`);
}
db.close?.();
process.exitCode = ok ? 0 : 1;
