#!/usr/bin/env node
/**
 * Recompute floor / ceiling / std_dev / volatility / boom / bust / leverage for
 * slate players from historical_games (services/variance), without re-syncing.
 *
 * Usage: node scripts/recompute-outcome-ranges.js [slateId ...]   (default: every slate)
 */

import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../.env') });

const { default: db } = await import('../src/config/database.js');
const { recomputeSlateRanges } = await import('../src/services/variance/outcomeRangeService.js');

let slateIds = process.argv.slice(2);
if (slateIds.length === 0) {
  slateIds = (await db.all(`SELECT slate_id FROM slates`)).map((r) => r.slate_id);
}

for (const slateId of slateIds) {
  const n = await recomputeSlateRanges(slateId);
  console.log(`Slate ${slateId}: ${n} player(s) updated`);
}
db.close?.();
