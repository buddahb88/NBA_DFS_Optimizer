#!/usr/bin/env node
/**
 * Recompute floor / ceiling / std_dev / boom / bust / leverage for saved
 * slates (slate_player_snapshots) with the current outcome model, using only
 * games before each slate date (services/variance/snapshotRangeService.js).
 * Writes the *_model columns and range_model_version; the pre-lock ranges are
 * left as they were. Rebuilds (optimizer, portfolio, chat) use the model
 * ranges by default (ranges: 'original' for the pre-lock ones).
 *
 * Usage: node scripts/recompute-snapshot-ranges.js [YYYY-MM-DD ...] [--site=draftkings]
 *        (default: every saved game date)
 */

import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../.env') });

const { default: db } = await import('../src/config/database.js');
const { migrateSlatePlayerSnapshots } = await import('../src/config/snapshotMigrations.js');
const { recomputeSnapshotRanges, RANGE_MODEL_VERSION } = await import('../src/services/variance/snapshotRangeService.js');

const args = process.argv.slice(2);
const site = args.find((a) => a.startsWith('--site='))?.split('=')[1] || null;
let dates = args.filter((a) => /^\d{4}-\d{2}-\d{2}$/.test(a));

await migrateSlatePlayerSnapshots(db);
if (dates.length === 0) {
  dates = (await db.all(`SELECT DISTINCT game_date FROM slate_player_snapshots ORDER BY game_date`))
    .map((r) => String(r.game_date instanceof Date ? r.game_date.toISOString() : r.game_date).slice(0, 10));
}

console.log(`Range model ${RANGE_MODEL_VERSION}`);
for (const date of dates) {
  const report = await recomputeSnapshotRanges(date, { site });
  const summary = await db.get(
    `SELECT AVG(floor) AS floor, AVG(ceiling) AS ceiling, AVG(floor_model) AS floor_model, AVG(ceiling_model) AS ceiling_model
     FROM slate_player_snapshots WHERE game_date = ? AND projected_points > 0`, date);
  const f = (v) => (v == null ? '-' : Number(v).toFixed(1));
  console.log(`${date}: ${report.rows} row(s) | avg pre-lock ${f(summary?.floor)}-${f(summary?.ceiling)} | avg model ${f(summary?.floor_model)}-${f(summary?.ceiling_model)}`);
}
db.close?.();
