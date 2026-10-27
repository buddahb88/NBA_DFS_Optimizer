#!/usr/bin/env node
/**
 * Backfill past DraftKings classic slates into slate_player_snapshots from
 * RotoWire (services/rotowireSlateBackfillService.js): every DK classic slate
 * whose games fall in [--from, --to], the main slate of each date flagged in
 * slate_catalog, Vegas from ESPN's pickcenter. Pre-game fields only (no
 * current-season stats). Slates captured live are only completed (NULL
 * columns) unless --force. Run scripts/recompute-snapshot-ranges.js for the
 * same dates afterwards for floor / ceiling.
 *
 * RotoWire's slate list only has current slates, so slate ids are scanned
 * (--ids, default: the known slate ids -30 / +120). Responses are cached on
 * disk (--cache-dir, default <tmp>/nba-dfs-rotowire-slates) and requests are
 * throttled (--delay ms, default 1500).
 *
 * Usage: node scripts/backfill-rotowire-slates.js --from 2026-10-20 --to 2026-10-26
 *          [--dry-run] [--force] [--ids 29780-29960] [--cache-dir DIR] [--delay 1500]
 */

import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../.env') });

const { default: db } = await import('../src/config/database.js');
const { migrateSlatePlayerSnapshots, migrateSlateCatalog } = await import('../src/config/snapshotMigrations.js');
const { backfillRotowireSlates, cachedSlateFetcher } = await import('../src/services/rotowireSlateBackfillService.js');
const { default: espn } = await import('../src/services/espnBoxScoreService.js');

const args = process.argv.slice(2);
const arg = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const from = arg('from');
const to = arg('to') ?? from;
if (!DATE_RE.test(from || '') || !DATE_RE.test(to || '')) {
  console.error('Usage: node scripts/backfill-rotowire-slates.js --from YYYY-MM-DD [--to YYYY-MM-DD] [--dry-run] [--force] [--ids A-B]');
  process.exit(1);
}
const dryRun = args.includes('--dry-run');
const force = args.includes('--force');
const cacheDir = arg('cache-dir') ?? path.join(os.tmpdir(), 'nba-dfs-rotowire-slates');
const delayMs = Number(arg('delay') ?? 1500);

await migrateSlatePlayerSnapshots(db);
await migrateSlateCatalog(db);

async function idRange() {
  const spec = arg('ids');
  if (spec) {
    const [lo, hi] = spec.split('-').map(Number);
    return [lo, hi];
  }
  const known = await db.get(`SELECT MIN(CAST(slate_id AS INT)) AS lo, MAX(CAST(slate_id AS INT)) AS hi FROM (
    SELECT slate_id FROM slate_player_snapshots UNION SELECT slate_id FROM slate_catalog) ids`);
  if (!known?.lo) throw new Error('No known slate ids to scan around; pass --ids A-B');
  return [Number(known.lo) - 30, Number(known.hi) + 120];
}

const counts = async () => new Map((await db.all(
  `SELECT game_date, slate_id, COUNT(*) AS n FROM slate_player_snapshots WHERE game_date BETWEEN ? AND ?
   GROUP BY game_date, slate_id`, from, to)).map(r => [`${String(r.game_date).slice(0, 10)} ${r.slate_id}`, Number(r.n)]));

const [lo, hi] = await idRange();
console.log(`Scanning RotoWire slate ids ${lo}-${hi} for ${from}..${to}${dryRun ? ' (dry run)' : ''}${force ? ' (force)' : ''}; cache ${cacheDir}`);
const before = await counts();
const fetchSlate = cachedSlateFetcher({ cacheDir, delayMs });
const report = await backfillRotowireSlates({
  from, to, slateIds: Array.from({ length: hi - lo + 1 }, (_, i) => String(lo + i)),
  fetchSlate, fetchOdds: (date) => espn.fetchOdds(date), dryRun, force, log: (m) => console.log(`  ${m}`)
});
const after = await counts();

for (const [date, entry] of Object.entries(report.dates).sort()) {
  console.log(`\n${date}: main slate ${entry.mainSlateId ?? '-'} | ESPN Vegas for ${entry.odds?.teams ?? 0} team(s)`);
  console.table(entry.slates.map(s => ({
    slate: s.slateId, name: s.name, main: s.isMain ? 'YES' : '', games: s.games, rotowire: s.rotowirePlayers,
    projected: s.projectedPlayers, mode: s.mode, rows_before: before.get(`${date} ${s.slateId}`) ?? 0,
    rows_after: after.get(`${date} ${s.slateId}`) ?? 0
  })));
  if (entry.skipped.length) {
    const byType = entry.skipped.reduce((m, s) => ({ ...m, [s.contestType]: (m[s.contestType] ?? 0) + 1 }), {});
    console.log(`  skipped (not DK classic): ${JSON.stringify(byType)}`);
  }
}
db.close?.();
