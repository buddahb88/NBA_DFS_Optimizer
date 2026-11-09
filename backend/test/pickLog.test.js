/**
 * Forward-test pick log (services/pickLogService.js, pickLogScheduler.js,
 * routes/pickLog.js) on a temp SQLite DB: logging window, replace before
 * lock, refusal after lock, restart safety (no duplicates, no post-lock
 * logging), scoring from historical_games, backfill, nights, the route.
 */

import { test, describe, beforeAll as before, afterAll as after, beforeEach, vi } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nba-dfs-pick-log-'));
process.env.DATABASE_TYPE = 'sqlite';
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');
process.env.PROJECTION_SANITY = 'false';
process.env.INJURY_RISK_DISCOUNT = 'false';

let db;
let pickLog;
let scheduler;
let historicalScheduler;
let playerKey;
let server;
let baseUrl;

// 10 DK-eligible players: 2 PG, 2 SG, 2 SF, 2 PF, 2 C
const POOL = [
  ['Alpha Guard', 'PG', 'AAA', 'BBB', 9000, 50, 30],
  ['Beta Guard', 'PG', 'CCC', 'DDD', 5000, 20, 10],
  ['Gamma Wing', 'SG', 'AAA', 'BBB', 7000, 38, 22],
  ['Delta Wing', 'SG', 'CCC', 'DDD', 4500, 15, 8],
  ['Echo Forward', 'SF', 'AAA', 'BBB', 6500, 34, 18],
  ['Fox Forward', 'SF', 'CCC', 'DDD', 4800, 16, 6],
  ['Golf Big', 'PF', 'AAA', 'BBB', 6000, 31, 15],
  ['Hotel Big', 'PF', 'CCC', 'DDD', 4600, 14, 5],
  ['India Center', 'C', 'AAA', 'BBB', 8000, 42, 25],
  ['Juliet Center', 'C', 'CCC', 'DDD', 4000, 12, 4]
];

const PAST_DATE = '2026-10-21';
const PAST_SLATE = '900';
const PAST_LOCK = '2026-10-21T23:00:00.000Z';
const LIVE_DATE = '2026-11-09';
const LIVE_SLATE = '901';
const LIVE_LOCK = '2026-11-10T00:00:00.000Z'; // 7:00 PM ET on LIVE_DATE
const minutesBefore = (iso, m) => new Date(Date.parse(iso) - m * 60_000);

async function seedPastSlate() {
  for (const [name, position, team, opponent, salary, proj, own] of POOL) {
    await db.run(
      `INSERT INTO slate_player_snapshots (snapshot_date, game_date, slate_id, site, player_key, player_name, team, opponent,
         position, salary, projected_points, floor, ceiling, rostership, game_start_time)
       VALUES (?, ?, ?, 'draftkings', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      PAST_DATE, PAST_DATE, PAST_SLATE, playerKey(name), name, team, opponent, position, salary, proj, proj * 0.6, proj * 1.5, own, PAST_LOCK);
  }
  await db.run(
    `INSERT INTO slate_catalog (site, slate_id, game_date, name, contest_type, games, first_game_time, is_main, source)
     VALUES ('draftkings', ?, ?, 'Main', 'classic', 1, ?, 1, 'live')`, PAST_SLATE, PAST_DATE, PAST_LOCK);
}

async function seedBoxScores(date, { skip = [] } = {}) {
  for (const [name, , team, opponent, , proj] of POOL) {
    if (skip.includes(name)) continue;
    await db.run(
      `INSERT INTO historical_games (player_name, player_key, team, opponent, game_date, minutes, points, dk_fantasy_points, fd_fantasy_points, yahoo_fantasy_points)
       VALUES (?, ?, ?, ?, ?, 30, 10, ?, ?, ?)`,
      name, playerKey(name), team, opponent, date, proj + 5, proj, proj);
  }
}

async function seedLiveSlate() {
  await db.run(`INSERT INTO slates (slate_id, name, sport, start_time, site) VALUES (?, 'All', 'NBA', NULL, 'draftkings')`, LIVE_SLATE);
  for (const [name, position, team, opponent, salary, proj, own] of POOL) {
    const raw = JSON.stringify({ game: { dateTime: `${LIVE_DATE} 19:00:00` } });
    await db.run(
      `INSERT INTO players (slate_id, player_id, name, team, opponent, position, salary, projected_points, floor, ceiling, rostership, raw_data)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      LIVE_SLATE, `p-${playerKey(name)}`, name, team, opponent, position, salary, proj, proj * 0.6, proj * 1.5, own, raw);
  }
}

const lineupOf = (names = POOL.slice(0, 8).map(p => p[0])) => names.map(n => {
  const p = POOL.find(x => x[0] === n);
  return { name: p[0], position: p[1], team: p[2], salary: p[4], projected_points: p[5], rostership: p[6] };
});

before(async () => {
  db = (await import('../src/config/database.js')).default;
  await (await import('../src/config/schema.js')).createTables(db);
  ({ playerKey } = await import('../src/utils/playerKey.js'));
  pickLog = await import('../src/services/pickLogService.js');
  scheduler = await import('../src/services/pickLogScheduler.js');
  historicalScheduler = await import('../src/services/historicalSyncScheduler.js');
  const router = (await import('../src/routes/pickLog.js')).default;
  const app = express();
  app.use(express.json());
  app.use('/api/pick-log', router);
  await new Promise(resolve => { server = app.listen(0, resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}/api/pick-log`;
});

after(async () => {
  await new Promise(resolve => server.close(resolve));
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(async () => {
  for (const t of ['pick_log', 'pick_log_nights', 'slate_player_snapshots', 'slate_catalog', 'historical_games', 'players', 'slates']) {
    await db.run(`DELETE FROM ${t}`);
  }
  await seedPastSlate();
});

const quiet = (fn) => async (...a) => {
  const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try { return await fn(...a); } finally { spy.mockRestore(); warn.mockRestore(); }
};

describe('migration', () => {
  test('is idempotent', async () => {
    const { migratePickLog } = await import('../src/config/pickLogMigrations.js');
    await migratePickLog(db);
    await migratePickLog(db);
    const cols = (await db.all('PRAGMA table_info(pick_log)')).map(c => c.name);
    for (const c of ['slate_id', 'game_date', 'site', 'source', 'logged_at', 'lineup_json', 'meta_json', 'actual_points', 'dnp_count', 'field_percentile', 'scored_at']) {
      assert.ok(cols.includes(c), c);
    }
  });
});

describe('logPick', () => {
  test('lock time is the earliest known game start', async () => {
    assert.equal(await pickLog.slateLockTime({ slateId: PAST_SLATE, site: 'draftkings' }), PAST_LOCK);
    await seedLiveSlate();
    assert.equal(await pickLog.slateLockTime({ slateId: LIVE_SLATE, site: 'draftkings' }), LIVE_LOCK);
    assert.equal(await pickLog.slateLockTime({ slateId: 'nope', site: 'draftkings' }), null);
  });

  test('logs before lock with totals, refuses at / after lock', async () => {
    const { pick, replaced } = await pickLog.logPick({
      slateId: PAST_SLATE, slateDate: PAST_DATE, source: 'max_projection', lineup: lineupOf(),
      meta: { contestSize: 100 }, now: minutesBefore(PAST_LOCK, 10)
    });
    assert.equal(replaced, false);
    assert.equal(pick.isForward, true);
    assert.equal(pick.lockTime, PAST_LOCK);
    assert.equal(pick.lineup.length, 8);
    assert.equal(pick.lineup[0].player_key, 'alpha guard');
    assert.equal(pick.totalSalary, 9000 + 5000 + 7000 + 4500 + 6500 + 4800 + 6000 + 4600);
    assert.equal(pick.projectedPoints, 50 + 20 + 38 + 15 + 34 + 16 + 31 + 14);
    assert.deepEqual(pick.meta, { contestSize: 100 });

    for (const now of [new Date(PAST_LOCK), minutesBefore(PAST_LOCK, -60)]) {
      await assert.rejects(
        pickLog.logPick({ slateId: PAST_SLATE, slateDate: PAST_DATE, source: 'late', lineup: lineupOf(), now }),
        e => e.status === 409 && /locked/.test(e.message));
    }
    assert.equal((await db.get('SELECT COUNT(*) AS n FROM pick_log')).n, 1);
  });

  test('re-logging the same slate + source before lock replaces the pick and clears results', async () => {
    const first = await pickLog.logPick({ slateId: PAST_SLATE, slateDate: PAST_DATE, source: 'max_projection', lineup: lineupOf(), now: minutesBefore(PAST_LOCK, 30) });
    await db.run('UPDATE pick_log SET actual_points = 1, scored_at = ? WHERE id = ?', 'x', first.pick.id);
    const names = [...POOL.slice(0, 7).map(p => p[0]), 'India Center'];
    const second = await pickLog.logPick({ slateId: PAST_SLATE, slateDate: PAST_DATE, source: 'max_projection', lineup: lineupOf(names), now: minutesBefore(PAST_LOCK, 5) });
    assert.equal(second.replaced, true);
    assert.equal(second.pick.id, first.pick.id);
    assert.equal(second.pick.lineup[7].name, 'India Center');
    assert.equal(second.pick.actualPoints, null);
    assert.equal(second.pick.scoredAt, null);
    assert.equal(second.pick.loggedAt, minutesBefore(PAST_LOCK, 5).toISOString());
    // A different source is its own pick
    await pickLog.logPick({ slateId: PAST_SLATE, slateDate: PAST_DATE, source: 'gpp_sim_win', lineup: lineupOf(), now: minutesBefore(PAST_LOCK, 5) });
    assert.equal((await db.get('SELECT COUNT(*) AS n FROM pick_log')).n, 2);
  });

  test('a _backfill source may be logged after lock and is not forward', async () => {
    const { pick } = await pickLog.logPick({ slateId: PAST_SLATE, slateDate: PAST_DATE, source: 'max_projection_backfill', lineup: lineupOf(), now: new Date('2026-11-09T12:00:00Z') });
    assert.equal(pick.isForward, false);
  });

  test('validates input; a forward pick needs a known lock time', async () => {
    const base = { slateId: PAST_SLATE, slateDate: PAST_DATE, source: 'x', lineup: lineupOf(), now: minutesBefore(PAST_LOCK, 10) };
    await assert.rejects(pickLog.logPick({ ...base, lineup: lineupOf().slice(0, 7) }), /8 players/);
    await assert.rejects(pickLog.logPick({ ...base, lineup: [...lineupOf().slice(0, 7), lineupOf()[0]] }), /duplicate/);
    await assert.rejects(pickLog.logPick({ ...base, source: 'bad source!' }), /source/);
    await assert.rejects(pickLog.logPick({ ...base, slateDate: '10/21' }), /YYYY-MM-DD/);
    await assert.rejects(pickLog.logPick({ ...base, slateId: 'unknown' }), e => e.status === 409 && /unknown/.test(e.message));
  });

  test('concurrent first logs of the same pick end as one row', async () => {
    const now = minutesBefore(PAST_LOCK, 10);
    await Promise.all([1, 2, 3].map(() =>
      pickLog.logPick({ slateId: PAST_SLATE, slateDate: PAST_DATE, source: 'max_projection', lineup: lineupOf(), now })));
    assert.equal((await db.get('SELECT COUNT(*) AS n FROM pick_log')).n, 1);
  });
});

describe('pickers and the live slate', () => {
  test('max_projection picks the max-projection valid DK lineup', () => {
    const players = POOL.map(([name, position, team, opponent, salary, proj, own], i) =>
      ({ id: i + 1, name, position, team, opponent, salary, projected_points: proj, rostership: own }));
    const picked = pickLog.maxProjectionPicker({ players });
    assert.equal(picked.lineup.length, 8);
    const salary = picked.lineup.reduce((s, p) => s + p.salary, 0);
    assert.ok(salary <= 50000 && salary >= 49000, String(salary));
    assert.ok(picked.lineup.every(p => p.slot));
    // Players from both games (DK needs 2+). Best feasible: drop Beta + Hotel ($49.8K, 238 pts); the
    // cheaper-to-lose pairs that reach $49K leave the G (Beta + Delta) or F (Fox + Hotel) slot empty
    assert.equal(new Set(picked.lineup.map(p => p.team)).size, 2);
    assert.equal(picked.lineup.reduce((s, p) => s + p.projected_points, 0), 238);
    assert.deepEqual(picked.lineup.map(p => p.name).filter(n => n === 'Beta Guard' || n === 'Hotel Big'), []);
  });

  test('liveMainSlate finds the synced DK slate and its lock', async () => {
    await seedLiveSlate();
    const live = await pickLog.liveMainSlate();
    assert.equal(live.slate.slateId, LIVE_SLATE);
    assert.equal(live.slate.slateDate, LIVE_DATE);
    assert.equal(live.slate.isBacktest, false);
    assert.equal(live.lockTime, LIVE_LOCK);
  });

  test('logLiveSlateNow logs every registered picker with a projection signature; refused after lock', quiet(async () => {
    await seedLiveSlate();
    const unregister = pickLog.registerPicker('test_cheapest', ({ players }) => ({
      lineup: [...players].sort((a, b) => a.salary - b.salary).slice(0, 8), meta: { picker: 'test' }
    }));
    try {
      const out = await pickLog.logLiveSlateNow({ now: minutesBefore(LIVE_LOCK, 10) });
      const bySource = Object.fromEntries(out.results.map(r => [r.source, r]));
      assert.equal(bySource.max_projection.status, 'logged');
      assert.equal(bySource.test_cheapest.status, 'logged');
      const [pick] = await pickLog.listPicks({ source: 'max_projection' });
      assert.equal(pick.slateId, LIVE_SLATE);
      assert.equal(pick.gameDate, LIVE_DATE);
      assert.equal(pick.meta.projectionSource, 'rotowire');
      assert.equal(pick.meta.trigger, 'manual');
      assert.match(pick.meta.poolSignature, /^[0-9a-f]{12}$/);
      assert.equal(pick.meta.poolSize, POOL.length);

      await assert.rejects(pickLog.logLiveSlateNow({ now: new Date(LIVE_LOCK) }), e => e.status === 409);
    } finally {
      unregister();
    }
    assert.deepEqual(pickLog.registeredPickers(), ['max_projection']);
  }));
});

describe('auto-log scheduler', () => {
  test('lockWindow classifies early / window / locked / unknown', () => {
    assert.equal(scheduler.lockWindow(LIVE_LOCK, minutesBefore(LIVE_LOCK, 60), 20), 'early');
    assert.equal(scheduler.lockWindow(LIVE_LOCK, minutesBefore(LIVE_LOCK, 20), 20), 'window');
    assert.equal(scheduler.lockWindow(LIVE_LOCK, minutesBefore(LIVE_LOCK, 0.1), 20), 'window');
    assert.equal(scheduler.lockWindow(LIVE_LOCK, new Date(LIVE_LOCK), 20), 'locked');
    assert.equal(scheduler.lockWindow(null, new Date(), 20), 'unknown');
  });

  test('env: default cron, off, lead minutes', () => {
    assert.equal(scheduler.pickLogExpression({}), scheduler.DEFAULT_PICK_LOG_CRON);
    assert.equal(scheduler.pickLogExpression({ PICK_LOG_CRON: 'off' }), null);
    assert.equal(scheduler.leadMinutes({ PICK_LOG_LEAD_MINUTES: '30' }), 30);
    assert.equal(scheduler.leadMinutes({ PICK_LOG_LEAD_MINUTES: 'x' }), scheduler.DEFAULT_LEAD_MINUTES);
  });

  test('ticks log only inside the window; repeated ticks and restarts keep one pick per source', quiet(async () => {
    await seedLiveSlate();
    const tick = (m) => scheduler.runAutoLog({
      now: minutesBefore(LIVE_LOCK, m), lead: 20,
      logPicks: (slate, opts) => pickLog.logPicksForSlate(slate, { ...opts, now: minutesBefore(LIVE_LOCK, m) })
    });
    assert.equal((await tick(60)).status, 'early');
    assert.equal((await db.get('SELECT COUNT(*) AS n FROM pick_log')).n, 0);

    assert.equal((await tick(15)).status, 'logged');
    // Restart inside the window: run-on-start ticks again
    const again = await tick(5);
    assert.equal(again.status, 'logged');
    assert.equal(again.results[0].status, 'replaced');
    const rows = await db.all('SELECT * FROM pick_log');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].logged_at, minutesBefore(LIVE_LOCK, 5).toISOString());
    assert.equal(JSON.parse(rows[0].meta_json).trigger, 'auto');

    // Restart after lock: nothing more is logged, the pre-lock pick stays
    assert.equal((await tick(-30)).status, 'locked');
    const after = await db.all('SELECT * FROM pick_log');
    assert.equal(after.length, 1);
    assert.equal(after[0].logged_at, rows[0].logged_at);
  }));

  test('a slow pick that finishes after lock is refused at write time', quiet(async () => {
    await seedLiveSlate();
    const out = await scheduler.runAutoLog({
      now: minutesBefore(LIVE_LOCK, 1), lead: 20,
      // The tick started inside the window; the write happens after lock
      logPicks: (slate, opts) => pickLog.logPicksForSlate(slate, { ...opts, now: minutesBefore(LIVE_LOCK, -1) })
    });
    assert.equal(out.status, 'logged');
    assert.equal(out.results[0].status, 'error');
    assert.equal(out.results[0].code, 409);
    assert.equal((await db.get('SELECT COUNT(*) AS n FROM pick_log')).n, 0);
  }));

  test('no synced slate', async () => {
    assert.equal((await scheduler.runAutoLog({ now: new Date() })).status, 'no_slate');
  });

  test('startPickLogScheduler is off under tests without an expression and rejects bad cron', () => {
    assert.equal(scheduler.startPickLogScheduler(), null);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    assert.equal(scheduler.startPickLogScheduler({ expression: 'not cron' }), null);
    warn.mockRestore();
  });
});

describe('scoring', () => {
  const logPast = (source = 'max_projection', names) => pickLog.logPick({
    slateId: PAST_SLATE, slateDate: PAST_DATE, source, lineup: lineupOf(names), now: minutesBefore(PAST_LOCK, 10)
  });

  test('stays pending without box scores', async () => {
    await logPast();
    const out = await pickLog.scorePendingPicks({ now: new Date('2026-10-22T15:00:00Z') });
    assert.deepEqual({ scored: out.scored, pending: out.pending }, { scored: 0, pending: 1 });
    const [pick] = await pickLog.listPicks();
    assert.equal(pick.scoredAt, null);
  });

  test('does not score tonight (the night is not over)', async () => {
    await logPast();
    await seedBoxScores(PAST_DATE);
    const out = await pickLog.scorePendingPicks({ now: new Date('2026-10-21T23:30:00Z') });
    assert.equal(out.scored + out.pending, 0);
  });

  test('fills actual points per player, total, DNPs and a field percentile', async () => {
    await logPast();
    // Beta Guard has no box row while his team played: DNP, 0 points
    await seedBoxScores(PAST_DATE, { skip: ['Beta Guard'] });
    const now = new Date('2026-10-22T15:00:00Z');
    const out = await pickLog.scorePendingPicks({ now });
    assert.equal(out.scored, 1);
    const [pick] = await pickLog.listPicks();
    const expected = [50, 38, 15, 34, 16, 31, 14].reduce((s, v) => s + v + 5, 0);
    assert.equal(pick.actualPoints, expected);
    assert.equal(pick.dnpCount, 1);
    const beta = pick.lineup.find(p => p.name === 'Beta Guard');
    assert.equal(beta.actual_points, 0);
    assert.notEqual(beta.status, 'PLAYED');
    assert.equal(pick.lineup.find(p => p.name === 'Alpha Guard').actual_points, 55);
    assert.equal(pick.scoredAt, now.toISOString());
    assert.ok(pick.fieldPercentile === null || (pick.fieldPercentile >= 0 && pick.fieldPercentile <= 100));

    // Scored picks are skipped unless rescored
    assert.equal((await pickLog.scorePendingPicks({ now })).scored, 0);
    assert.equal((await pickLog.scorePendingPicks({ now, rescore: true })).scored, 1);
  });

  test('the historical scheduler runs afterRun after each sync, even a failed one', async () => {
    const calls = [];
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const task = historicalScheduler.startHistoricalSyncScheduler({
      expression: '0 0 1 1 *',
      runOnStart: true,
      run: async () => { calls.push('sync'); throw new Error('boom'); },
      afterRun: async () => { calls.push('score'); }
    });
    await vi.waitFor(() => assert.deepEqual(calls, ['sync', 'score']));
    task.stop();
    err.mockRestore();
    log.mockRestore();
  });
});

describe('backfill, nights and summary', () => {
  test('backfill logs and scores _backfill picks for saved main slates with results', quiet(async () => {
    await seedBoxScores(PAST_DATE);
    const out = await pickLog.backfillPicks({ from: '2026-10-20', now: new Date('2026-11-09T15:00:00Z') });
    assert.equal(out.length, 1);
    assert.equal(out[0].results[0].source, 'max_projection_backfill');
    assert.equal(out[0].results[0].status, 'logged');
    const [pick] = await pickLog.listPicks({ forward: false });
    assert.equal(pick.isForward, false);
    assert.equal(pick.meta.backfill, true);
    assert.ok(pick.actualPoints > 0);
    assert.equal(pick.dnpCount, 0);
    // Re-running replaces, never duplicates
    await pickLog.backfillPicks({ from: '2026-10-20', now: new Date('2026-11-09T15:00:00Z') });
    assert.equal((await db.get('SELECT COUNT(*) AS n FROM pick_log')).n, 1);
  }));

  test('nights store the entered cash line; the summary counts cashes per source', async () => {
    await pickLog.logPick({ slateId: PAST_SLATE, slateDate: PAST_DATE, source: 'max_projection', lineup: lineupOf(), now: minutesBefore(PAST_LOCK, 10) });
    await seedBoxScores(PAST_DATE);
    await pickLog.scorePendingPicks({ now: new Date('2026-10-22T15:00:00Z') });
    const night = await pickLog.setNightResult({ slateId: PAST_SLATE, gameDate: PAST_DATE, cashLine: 230.5, winningScore: '310' });
    assert.equal(night.cashLine, 230.5);
    assert.equal(night.winningScore, 310);
    await pickLog.setNightResult({ slateId: PAST_SLATE, gameDate: PAST_DATE, cashLine: 230.5, winningScore: null });
    await assert.rejects(pickLog.setNightResult({ slateId: PAST_SLATE, gameDate: PAST_DATE, cashLine: 'abc' }), /numbers/);

    const report = await pickLog.pickLogReport();
    assert.equal(report.nights.length, 1);
    assert.equal(report.nights[0].contest.cashLine, 230.5);
    assert.equal(report.nights[0].contest.winningScore, null);
    const [s] = report.summary;
    assert.equal(s.source, 'max_projection');
    assert.equal(s.nights, 1);
    assert.equal(s.avgActual, 258);
    assert.equal(s.nightsWithCashLine, 1);
    assert.equal(s.cashed, 1);
    assert.equal(s.best.actualPoints, 258);
  });

  test('summarizePicks: avg / best / worst per source, forward sources first', () => {
    const p = (source, gameDate, actualPoints) => ({ source, gameDate, site: 'draftkings', slateId: gameDate, actualPoints, projectedPoints: 250, dnpCount: 0, fieldPercentile: 50 });
    const out = pickLog.summarizePicks([
      p('max_projection_backfill', '2026-10-21', 200),
      p('max_projection', '2026-11-09', 300), p('max_projection', '2026-11-10', 250), p('max_projection', '2026-11-11', null)
    ], [{ site: 'draftkings', slateId: '2026-11-09', cashLine: 280 }]);
    assert.deepEqual(out.map(s => s.source), ['max_projection', 'max_projection_backfill']);
    assert.equal(out[0].logged, 3);
    assert.equal(out[0].nights, 2);
    assert.equal(out[0].avgActual, 275);
    assert.deepEqual(out[0].best, { gameDate: '2026-11-09', actualPoints: 300 });
    assert.deepEqual(out[0].worst, { gameDate: '2026-11-10', actualPoints: 250 });
    assert.equal(out[0].cashed, 1);
    assert.equal(out[1].isForward, false);
  });
});

describe('routes', () => {
  test('POST logs, GET lists, PUT nights, 409 after lock, 400 bad input', async () => {
    await seedLiveSlate();
    const body = { slateId: LIVE_SLATE, slateDate: LIVE_DATE, source: 'max_projection', lineup: lineupOf() };
    // The past slate is locked: a forward pick is refused, its backfill accepted
    let res = await fetch(baseUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...body, slateId: PAST_SLATE, slateDate: PAST_DATE }) });
    assert.equal(res.status, 409);
    res = await fetch(baseUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...body, slateId: PAST_SLATE, slateDate: PAST_DATE, source: 'max_projection_backfill' }) });
    assert.equal(res.status, 201);
    res = await fetch(baseUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...body, lineup: [] }) });
    assert.equal(res.status, 400);

    res = await fetch(`${baseUrl}/nights`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ slateId: PAST_SLATE, gameDate: PAST_DATE, cashLine: 240 }) });
    assert.equal(res.status, 200);
    res = await fetch(`${baseUrl}?forward=false`);
    const data = await res.json();
    assert.equal(data.nights.length, 1);
    assert.equal(data.nights[0].picks[0].source, 'max_projection_backfill');
    assert.equal(data.nights[0].contest.cashLine, 240);
    assert.deepEqual(data.sources, ['max_projection']);

    res = await fetch(`${baseUrl}?from=bad`);
    assert.equal(res.status, 400);
    res = await fetch(`${baseUrl}/score`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(res.status, 200);
  });
});
