/**
 * Fill slate_player_snapshots.rest_days where it is NULL from the
 * historical_games schedule (days since the player's previous game - 1;
 * pre-game, no lookahead). Idempotent: only NULL rows are written.
 * See services/snapshotRestDays.js.
 *
 * Usage: node scripts/fill-snapshot-rest-days.js [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--dry-run]
 */

import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../.env') });

const { default: db } = await import('../src/config/database.js');
const { fillSnapshotRestDays } = await import('../src/services/snapshotRestDays.js');

const args = process.argv.slice(2);
const arg = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const dryRun = args.includes('--dry-run');
const result = await fillSnapshotRestDays({ from: arg('from') ?? null, to: arg('to') ?? null, dryRun });
console.log(`rest_days: ${result.candidates} NULL row(s), ${dryRun ? 'would fill' : 'filled'} ${result.filled}, ${result.noPriorGame} with no earlier game (left NULL)`);
db.close?.();
