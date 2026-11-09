/**
 * PICK LOG SCHEDULER
 *
 * Logs the registered pickers' lineups for the live DraftKings main slate
 * shortly before its first game (services/pickLogService.js). On the
 * PICK_LOG_CRON schedule (DEFAULT_PICK_LOG_CRON when unset, 'off' disables)
 * each tick checks the live slate's lock time; inside the final
 * PICK_LOG_LEAD_MINUTES before lock it logs every picker, replacing the
 * previous tick's pick, so the last one logged is the latest pre-lock view.
 *
 * Restart safe: picks upsert on (site, slate, source), so a restart never
 * duplicates one; logPick re-checks the lock at write time, so nothing is
 * logged after the first game starts, however late a tick (or a restart's
 * run-on-start) fires. A server down through the whole window logs nothing
 * for that slate - better no pick than a post-lock one.
 *
 * Scoring runs after the historical box-score sync (server.js passes
 * scorePendingPicks as the historical scheduler's afterRun).
 */

import cron from 'node-cron';
import { liveMainSlate, logPicksForSlate } from './pickLogService.js';

export const DEFAULT_PICK_LOG_CRON = '*/5 * * * *';
export const DEFAULT_LEAD_MINUTES = 20;

/** Cron expression from env: default when unset, null for 'off'. */
export function pickLogExpression(env = process.env) {
  const value = (env.PICK_LOG_CRON || '').trim();
  if (!value) return DEFAULT_PICK_LOG_CRON;
  return value.toLowerCase() === 'off' ? null : value;
}

/** Minutes before lock when auto-logging starts (env PICK_LOG_LEAD_MINUTES, 1-240). */
export function leadMinutes(env = process.env) {
  const n = Number(env.PICK_LOG_LEAD_MINUTES);
  return Number.isFinite(n) && n >= 1 && n <= 240 ? n : DEFAULT_LEAD_MINUTES;
}

/**
 * Where `now` is relative to a lock time: 'unknown' (no lock time), 'early'
 * (before the window), 'window' (within lead minutes before lock), 'locked'.
 */
export function lockWindow(lockTime, now = new Date(), lead = DEFAULT_LEAD_MINUTES) {
  const lock = lockTime ? Date.parse(lockTime) : NaN;
  if (!Number.isFinite(lock)) return 'unknown';
  const t = now.getTime();
  if (t >= lock) return 'locked';
  return lock - t <= lead * 60_000 ? 'window' : 'early';
}

/**
 * One tick: log the live main slate's picks when inside the window.
 * Returns { status: 'no_slate' | 'unknown' | 'early' | 'locked' | 'logged',
 * slateId?, lockTime?, results? }.
 */
export async function runAutoLog({ now = new Date(), lead = leadMinutes(), findSlate = liveMainSlate, logPicks = logPicksForSlate } = {}) {
  const live = await findSlate();
  if (!live) return { status: 'no_slate' };
  const { slate, lockTime } = live;
  const state = lockWindow(lockTime, now, lead);
  if (state !== 'window') return { status: state, slateId: slate.slateId, lockTime };
  const out = await logPicks(slate, { extraMeta: { trigger: 'auto', leadMinutes: lead } });
  const summary = out.results.map(r => `${r.source}: ${r.status}${r.error ? ` (${r.error})` : ''}`).join(', ');
  console.log(`📒 Pick log ${slate.slateDate} slate ${slate.slateId} (lock ${lockTime}): ${summary}`);
  return { status: 'logged', slateId: slate.slateId, lockTime, results: out.results };
}

/**
 * Start the auto-log schedule (never from env under tests unless
 * `expression` is given). runOnStart: one tick now, so a restart inside the
 * window still logs. Returns the cron task, or null when off.
 */
export function startPickLogScheduler({ expression, run = runAutoLog, runOnStart = false } = {}) {
  if (expression === undefined && process.env.NODE_ENV !== 'test' && !process.env.VITEST) {
    expression = pickLogExpression();
  }
  if (!expression) return null;
  if (!cron.validate(expression)) {
    console.warn(`⚠️ PICK_LOG_CRON "${expression}" is not a valid cron expression; pick auto-logging disabled`);
    return null;
  }
  const runSafely = async () => {
    try {
      await run();
    } catch (error) {
      console.error('❌ Pick log auto-log error:', error);
    }
  };
  console.log(`⏰ Pick log auto-log: ${expression}, ${leadMinutes()} min before the DK main slate locks`);
  const task = cron.schedule(expression, runSafely, { name: 'pick-log', noOverlap: true });
  if (runOnStart) runSafely();
  return task;
}
