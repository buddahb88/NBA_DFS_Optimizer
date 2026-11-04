#!/usr/bin/env node
/**
 * Injury-tag play probability calibration (read-only on the database).
 *
 * Every saved slate's player-nights (slate_player_snapshots, the tag at the
 * last sync) joined to historical_games on player_key + game_date (no box
 * score with minutes on a night his team played = DNP); P(play) per tag and
 * salary band, shrunk toward the tag rate / fallback
 * (services/projections/injuryRisk.js). Prints the table and writes
 * src/config/injuryRiskTable.json, which config/injuryRisk.js reads (commit it).
 *
 * Usage: npm run calibrate:injury-risk [-- --dry-run] [--before=YYYY-MM-DD]
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../.env') });

const { calibrateFromDb } = await import('../src/services/projections/injuryRiskService.js');
const { formatTable } = await import('../src/services/projections/injuryRisk.js');
const { TABLE_FILE } = await import('../src/config/injuryRisk.js');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const before = args.find(a => a.startsWith('--before='))?.split('=')[1] ?? null;

const table = await calibrateFromDb({ before });
console.log(`\nInjury-tag play probability: ${table.rows} player-nights, ${table.dates.nights} nights (${table.dates.first} .. ${table.dates.last})`);
console.log(`Shrinkage: tag rate toward fallback with ${table.pseudo.tag} pseudo-rows, band rate toward tag rate with ${table.pseudo.band}\n`);
console.log(formatTable(table));

if (dryRun) {
  console.log('\n(dry run: table not written)');
} else {
  fs.writeFileSync(TABLE_FILE, `${JSON.stringify(table, null, 2)}\n`);
  console.log(`\nWrote ${path.relative(process.cwd(), TABLE_FILE)}`);
}
process.exit(0);
