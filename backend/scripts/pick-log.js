#!/usr/bin/env node
/**
 * Forward-test pick log (services/pickLogService.js) from the command line.
 *
 *   node scripts/pick-log.js log-now [--slate <id>]   log the live DK main slate's picks now (refused after lock)
 *   node scripts/pick-log.js score [--rescore]        score finished nights from historical_games
 *   node scripts/pick-log.js backfill [--from YYYY-MM-DD] [--to YYYY-MM-DD]
 *        log + score max_projection_backfill picks for the saved main slates
 *        (not forward tests: the models may have seen those slates)
 *   node scripts/pick-log.js list                     per-source summary
 *
 * Writes to the configured database: back up backend/data/nba_dfs.db first.
 */

import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../.env') });

const { default: db } = await import('../src/config/database.js');
const { migratePickLog } = await import('../src/config/pickLogMigrations.js');
const pickLog = await import('../src/services/pickLogService.js');

const args = process.argv.slice(2);
const command = args[0];
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : null;
};

await migratePickLog(db);
// The optimizer logs every solve
const quiet = () => { const log = console.log; console.log = () => {}; return () => { console.log = log; }; };

try {
  if (command === 'log-now') {
    const restore = quiet();
    let out;
    try { out = await pickLog.logLiveSlateNow({ slateId: opt('slate') }); } finally { restore(); }
    console.log(`Slate ${out.slateId} (${out.slateDate}), lock ${out.lockTime}`);
    console.table(out.results);
  } else if (command === 'score') {
    console.log(await pickLog.scorePendingPicks({ rescore: args.includes('--rescore') }));
  } else if (command === 'backfill') {
    const restore = quiet();
    let out;
    try { out = await pickLog.backfillPicks({ from: opt('from') ?? '2026-10-20', to: opt('to') }); } finally { restore(); }
    console.table(out.flatMap(n => n.results.map(r => ({ gameDate: n.gameDate, slateId: n.slateId, ...r }))));
    const report = await pickLog.pickLogReport({ forward: false });
    console.table(report.summary);
  } else if (command === 'list') {
    const report = await pickLog.pickLogReport();
    console.table(report.summary);
  } else {
    console.log('Usage: node scripts/pick-log.js log-now [--slate id] | score [--rescore] | backfill [--from d] [--to d] | list');
    process.exitCode = 1;
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  db.close?.();
}
