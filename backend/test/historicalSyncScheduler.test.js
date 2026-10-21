import { test, describe, vi, beforeAll as before, afterAll as after, beforeEach, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nba-dfs-sync-scheduler-'));
process.env.DATABASE_TYPE = 'sqlite';
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');

let db;
let syncRuns;
let espn;
let scheduler;

before(async () => {
  db = (await import('../src/config/database.js')).default;
  await (await import('../src/config/schema.js')).createTables(db);
  syncRuns = (await import('../src/services/syncRunService.js')).default;
  espn = (await import('../src/services/espnBoxScoreService.js')).default;
  scheduler = await import('../src/services/historicalSyncScheduler.js');
});

after(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await db.run('DELETE FROM sync_runs');
  await db.run('DELETE FROM historical_games');
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// Local noon, so "yesterday" is unambiguous in any timezone
const at = date => new Date(`${date}T12:00:00`);

describe('sync_runs persistence', () => {
  test('a run is active until finished, then reports its result', async () => {
    const id = await syncRuns.start({ source: 'espn', season: '2026-27' });
    assert.equal((await syncRuns.active()).id, id);

    await syncRuns.progress(id, 7);
    let run = await syncRuns.latest();
    assert.equal(run.games_inserted, 7);
    assert.equal(run.finished_at, null);

    await syncRuns.finish(id, { gamesInserted: 12 });
    run = await syncRuns.latest();
    assert.equal(await syncRuns.active(), null);
    assert.equal(run.source, 'espn');
    assert.equal(run.season, '2026-27');
    assert.equal(run.games_inserted, 12);
    assert.equal(run.error, null);
    assert.ok(run.started_at <= run.finished_at);
  });

  test('errors are stored and recent() lists newest first', async () => {
    const first = await syncRuns.start({ source: 'nba-api' });
    await syncRuns.finish(first, { gamesInserted: 0, error: 'HTTP 403' });
    const second = await syncRuns.start({ source: 'espn', season: '2026-27' });

    const runs = await syncRuns.recent(5);
    assert.deepEqual(runs.map(r => r.id), [second, first]);
    assert.equal(runs[1].error, 'HTTP 403');
  });

  test('failInterrupted closes runs left open by a crash', async () => {
    const id = await syncRuns.start({ source: 'espn', season: '2026-27' });
    assert.equal(await syncRuns.failInterrupted(), 1);
    const run = await syncRuns.latest();
    assert.equal(run.id, id);
    assert.ok(run.finished_at);
    assert.match(run.error, /interrupted/);
    assert.equal(await syncRuns.active(), null);
  });

  test('toProgress summarizes a run for /sync/status', () => {
    const base = { id: 1, source: 'espn', season: '2026-27', started_at: '2026-10-21T10:00:00.000Z', games_inserted: 5 };
    assert.equal(syncRuns.toProgress({ ...base, finished_at: null, error: null }).status, 'syncing');
    const done = syncRuns.toProgress({ ...base, finished_at: '2026-10-21T10:00:30.000Z', error: null });
    assert.equal(done.status, 'complete');
    assert.equal(done.mode, 'espn');
    assert.equal(done.games, 5);
    assert.equal(done.elapsed, '30.0');
    const failed = syncRuns.toProgress({ ...base, finished_at: '2026-10-21T10:00:01.000Z', error: 'boom' });
    assert.equal(failed.status, 'error');
    assert.equal(failed.error, 'boom');
    assert.equal(syncRuns.toProgress(null), null);
  });
});

describe('catchUpRanges', () => {
  const catchUpRanges = (...args) => scheduler.catchUpRanges(...args);

  test('resumes from the last loaded date through yesterday', () => {
    assert.deepEqual(catchUpRanges('2026-10-20', at('2026-10-21')), [
      { season: '2026-27', start: '2026-10-20', end: '2026-10-20' },
    ]);
  });

  test('catches up several missed days', () => {
    assert.deepEqual(catchUpRanges('2026-11-02', at('2026-11-06')), [
      { season: '2026-27', start: '2026-11-02', end: '2026-11-05' },
    ]);
  });

  test('starts at opening night when nothing is loaded', () => {
    assert.deepEqual(catchUpRanges(null, at('2026-10-23')), [
      { season: '2026-27', start: '2026-10-20', end: '2026-10-22' },
    ]);
  });

  test('skips the offseason between the last loaded season and the current one', () => {
    assert.deepEqual(catchUpRanges('2026-06-10', at('2026-10-22')), [
      { season: '2025-26', start: '2026-06-10', end: '2026-06-30' },
      { season: '2026-27', start: '2026-10-20', end: '2026-10-21' },
    ]);
  });

  test('is empty when up to date or before opening night', () => {
    assert.deepEqual(catchUpRanges('2026-10-21', at('2026-10-21')), []);
    assert.deepEqual(catchUpRanges('2026-06-20', at('2026-10-15')), [
      { season: '2025-26', start: '2026-06-20', end: '2026-06-30' },
    ]);
    assert.deepEqual(catchUpRanges(null, at('2026-10-15')), []);
  });
});

describe('runIncrementalSync', () => {
  const result = (o = {}) => ({ dates: 1, games: 3, rows: 75, skipped: 0, failed: [], elapsed: '1.0', ...o });

  test('loads from the latest historical_games date and records a run per season', async () => {
    await db.run(`INSERT INTO historical_games (player_name, team, opponent, game_date) VALUES ('A', 'BOS', 'NYK', '2026-10-20')`);
    const syncDates = vi.spyOn(espn, 'syncDates').mockResolvedValue(result());

    const runs = await scheduler.runIncrementalSync({ now: at('2026-10-23') });

    assert.equal(syncDates.mock.calls.length, 1);
    assert.deepEqual(syncDates.mock.calls[0].slice(0, 2), ['2026-10-20', '2026-10-22']);
    assert.equal(syncDates.mock.calls[0][2].skipLoaded, true);
    assert.equal(runs.length, 1);
    const [run] = await syncRuns.recent(5);
    assert.equal(run.source, 'espn-scheduled');
    assert.equal(run.season, '2026-27');
    assert.equal(run.games_inserted, 3);
    assert.equal(run.error, null);
    assert.ok(run.finished_at);
  });

  test('records failed games and thrown errors on the run', async () => {
    vi.spyOn(espn, 'syncDates')
      .mockResolvedValueOnce(result({ failed: [{ game_date: '2026-10-21', game_id: '401', error: 'HTTP 500' }] }));
    await scheduler.runIncrementalSync({ now: at('2026-10-22') });
    let [run] = await syncRuns.recent(1);
    assert.match(run.error, /1 failed.*HTTP 500/);
    assert.equal(run.games_inserted, 3);

    espn.syncDates.mockRejectedValueOnce(new Error('ESPN down'));
    await scheduler.runIncrementalSync({ now: at('2026-10-22') });
    [run] = await syncRuns.recent(1);
    assert.equal(run.error, 'ESPN down');
    assert.ok(run.finished_at);
  });

  test('refreshes team_archetype_defense for each synced season, even after a failure', async () => {
    vi.spyOn(espn, 'syncDates').mockRejectedValueOnce(new Error('ESPN down')).mockResolvedValueOnce(result());
    const refreshDefense = vi.fn().mockRejectedValueOnce(new Error('db busy')).mockResolvedValue({});

    const runs = await scheduler.runIncrementalSync({ now: at('2026-10-22'), refreshDefense });
    assert.equal(runs.length, 1);
    assert.deepEqual(refreshDefense.mock.calls, [['2026-27']]);

    await db.run(`INSERT INTO historical_games (player_name, team, opponent, game_date) VALUES ('A', 'BOS', 'NYK', '2026-06-10')`);
    await scheduler.runIncrementalSync({ now: at('2026-10-22'), refreshDefense });
    assert.deepEqual(refreshDefense.mock.calls.slice(1), [['2025-26'], ['2026-27']]);
  });

  test('skips when another sync is running', async () => {
    await syncRuns.start({ source: 'espn', season: '2026-27' });
    const syncDates = vi.spyOn(espn, 'syncDates');
    assert.equal(await scheduler.runIncrementalSync({ now: at('2026-10-22') }), null);
    assert.equal(syncDates.mock.calls.length, 0);
  });

  test('does nothing when already up to date', async () => {
    await db.run(`INSERT INTO historical_games (player_name, team, opponent, game_date) VALUES ('A', 'BOS', 'NYK', '2026-10-21')`);
    const syncDates = vi.spyOn(espn, 'syncDates');
    assert.deepEqual(await scheduler.runIncrementalSync({ now: at('2026-10-21') }), []);
    assert.equal(syncDates.mock.calls.length, 0);
    assert.deepEqual(await syncRuns.recent(5), []);
  });
});

describe('startHistoricalSyncScheduler', () => {
  test('is off unless an expression is configured', () => {
    const saved = process.env.HISTORICAL_SYNC_CRON;
    delete process.env.HISTORICAL_SYNC_CRON;
    try {
      assert.equal(scheduler.startHistoricalSyncScheduler(), null);
    } finally {
      if (saved !== undefined) process.env.HISTORICAL_SYNC_CRON = saved;
    }
  });

  test('is off in tests even when the env var is set', () => {
    process.env.HISTORICAL_SYNC_CRON = '30 6 * * *';
    try {
      assert.equal(scheduler.startHistoricalSyncScheduler(), null);
    } finally {
      delete process.env.HISTORICAL_SYNC_CRON;
    }
  });

  test('rejects an invalid expression', () => {
    assert.equal(scheduler.startHistoricalSyncScheduler({ expression: 'not a cron' }), null);
  });

  test('runs the sync at the scheduled time', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-21T06:29:50'));
    const run = vi.fn().mockResolvedValue([]);
    const task = scheduler.startHistoricalSyncScheduler({ expression: '30 6 * * *', run });
    try {
      assert.ok(task);
      await vi.advanceTimersByTimeAsync(5_000);
      assert.equal(run.mock.calls.length, 0);
      await vi.advanceTimersByTimeAsync(10_000);
      assert.equal(run.mock.calls.length, 1);
      // Not again until the next day
      await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
      assert.equal(run.mock.calls.length, 1);
    } finally {
      task?.stop();
    }
  });

  test('a failing sync does not stop the schedule', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-21T06:29:59'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const run = vi.fn().mockRejectedValue(new Error('boom'));
    const task = scheduler.startHistoricalSyncScheduler({ expression: '* * * * *', run });
    try {
      await vi.advanceTimersByTimeAsync(2 * 60 * 1000 + 1000);
      assert.ok(run.mock.calls.length >= 2);
    } finally {
      task?.stop();
    }
  });
});
