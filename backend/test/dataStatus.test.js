import { test, describe, vi, beforeAll as before, afterAll as after, beforeEach, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';

// The route module opens the database on import; keep it off the real DB file
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nba-dfs-data-status-'));
let db;
let espn;
let syncRuns;
let dataStatus;
let currentSeason;
let server;
let baseUrl;

before(async () => {
  process.env.DATABASE_TYPE = 'sqlite';
  process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');
  db = (await import('../src/config/database.js')).default;
  await (await import('../src/config/schema.js')).createTables(db);
  syncRuns = (await import('../src/services/syncRunService.js')).default;
  espn = (await import('../src/services/espnBoxScoreService.js')).default;
  dataStatus = (await import('../src/services/dataStatusService.js')).default;
  currentSeason = (await import('../src/utils/season.js')).getCurrentSeason();
  const router = (await import('../src/routes/historical.js')).default;

  const app = express();
  app.use(express.json());
  app.use('/api/historical', router);
  await new Promise(resolve => { server = app.listen(0, resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}/api/historical`;
});

after(async () => {
  await new Promise(resolve => server.close(resolve));
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await db.run('DELETE FROM sync_runs');
  await db.run('DELETE FROM historical_games');
  await db.run('DELETE FROM slate_player_snapshots');
});
afterEach(() => vi.restoreAllMocks());

const post = (url, body) => fetch(`${baseUrl}${url}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
});

async function waitForSync() {
  for (let i = 0; i < 100; i++) {
    const { isSyncing, progress } = await (await fetch(`${baseUrl}/sync/status`)).json();
    if (!isSyncing && progress?.status !== 'syncing') return progress;
    await new Promise(r => setTimeout(r, 10));
  }
  throw new Error('sync did not finish');
}

async function addGame(player_name, game_id, game_date, season) {
  await db.run(
    `INSERT INTO historical_games (player_name, team, opponent, game_id, game_date, season, dk_fantasy_points)
     VALUES (@player_name, 'DEN', 'LAL', @game_id, @game_date, @season, 40)`,
    { player_name, game_id, game_date, season });
}

async function addSnapshot(slate_id, site, player_key, game_date) {
  await db.run(
    `INSERT INTO slate_player_snapshots (snapshot_date, game_date, slate_id, site, player_key, player_name, captured_at)
     VALUES (@game_date, @game_date, @slate_id, @site, @player_key, @player_key, @captured_at)`,
    { slate_id, site, player_key, game_date, captured_at: `${game_date} 18:00:00` });
}

const at = date => new Date(`${date}T12:00:00`);

describe('dataStatusService', () => {
  test('historical_games coverage per season, newest first, with empty seasons listed', async () => {
    await addGame('Nikola Jokic', 'g1', '2024-10-22', '2024-25');
    await addGame('Jamal Murray', 'g1', '2024-10-22', '2024-25');
    await addGame('Nikola Jokic', 'g2', '2025-04-13', '2024-25');
    await addGame('Nikola Jokic', 'g3', '2026-10-20', '2026-27');

    const { coverage, currentSeason: current } = await dataStatus.getDataStatus({ now: at('2026-10-21') });
    assert.equal(current, '2026-27');
    assert.equal(coverage.error, null);
    assert.deepEqual(coverage.seasons.map(s => s.season), ['2026-27', '2025-26', '2024-25']);

    const [s2627, s2526, s2425] = coverage.seasons;
    assert.deepEqual(s2425, {
      season: '2024-25', current: false, games: 2, playerGames: 3, players: 2,
      earliestGame: '2024-10-22', latestGame: '2025-04-13',
    });
    assert.equal(s2526.games, 0);
    assert.equal(s2526.latestGame, null);
    assert.equal(s2627.current, true);
    assert.equal(s2627.games, 1);
    assert.deepEqual(coverage.totals, {
      games: 3, playerGames: 4, players: 2, earliestGame: '2024-10-22', latestGame: '2026-10-20',
    });
  });

  test('sync section reports the last run, last success and last error', async () => {
    const failed = await syncRuns.start({ source: 'espn', season: '2025-26' });
    await syncRuns.finish(failed, { gamesInserted: 3, error: '2 failed (first: 2026-01-01 g9: HTTP 500)' });
    const ok = await syncRuns.start({ source: 'espn-scheduled', season: '2026-27' });
    await syncRuns.finish(ok, { gamesInserted: 5 });

    const { sync } = await dataStatus.getDataStatus();
    assert.equal(sync.error, null);
    assert.equal(sync.isSyncing, false);
    assert.equal(sync.lastRun.id, ok);
    assert.equal(sync.lastRun.status, 'complete');
    assert.equal(sync.lastSuccess.id, ok);
    assert.equal(sync.lastError.id, failed);
    assert.match(sync.lastError.error, /HTTP 500/);
    assert.deepEqual(sync.recentRuns.map(r => r.id), [ok, failed]);
  });

  test('snapshot coverage totals and per site', async () => {
    await addSnapshot('s1', 'draftkings', 'nikola-jokic', '2026-10-20');
    await addSnapshot('s1', 'draftkings', 'jamal-murray', '2026-10-20');
    await addSnapshot('s2', 'draftkings', 'nikola-jokic', '2026-10-21');
    await addSnapshot('f1', 'fanduel', 'nikola-jokic', '2026-10-21');

    const { snapshots } = await dataStatus.getDataStatus();
    assert.equal(snapshots.error, null);
    assert.equal(snapshots.rows, 4);
    assert.equal(snapshots.slates, 3);
    assert.equal(snapshots.players, 2);
    assert.equal(snapshots.gameDates, 2);
    assert.equal(snapshots.earliestGameDate, '2026-10-20');
    assert.equal(snapshots.latestGameDate, '2026-10-21');
    assert.equal(snapshots.lastCapturedAt, '2026-10-21 18:00:00');
    assert.deepEqual(snapshots.bySite, [
      { site: 'draftkings', rows: 3, slates: 2, gameDates: 2, latestGameDate: '2026-10-21' },
      { site: 'fanduel', rows: 1, slates: 1, gameDates: 1, latestGameDate: '2026-10-21' },
    ]);
  });

  test('a failing section reports its error instead of failing silently', async () => {
    vi.spyOn(syncRuns, 'recent').mockRejectedValue(new Error('no such table: sync_runs'));
    const status = await dataStatus.getDataStatus();
    assert.equal(status.sync.error, 'no such table: sync_runs');
    assert.equal(status.coverage.error, null);
    assert.equal(status.snapshots.error, null);
  });
});

describe('GET /data-status', () => {
  test('returns coverage, sync and snapshot sections', async () => {
    await addGame('Nikola Jokic', 'g3', '2026-10-20', currentSeason);
    const res = await fetch(`${baseUrl}/data-status`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.currentSeason, currentSeason);
    assert.equal(body.coverage.seasons[0].season, currentSeason);
    assert.equal(body.coverage.seasons[0].playerGames, 1);
    assert.equal(body.sync.lastRun, null);
    assert.equal(body.snapshots.rows, 0);
  });
});

describe('POST /sync/incremental', () => {
  test('runs the ESPN incremental sync as a manual espn run', async () => {
    await addGame('Nikola Jokic', 'g3', '2026-10-20', '2026-27');
    const syncDates = vi.spyOn(espn, 'syncDates').mockResolvedValue({ dates: 2, games: 4, rows: 90, skipped: 1, failed: [] });

    const res = await post('/sync/incremental', {});
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.mode, 'espn');
    assert.ok(body.runId);

    const progress = await waitForSync();
    assert.equal(progress.status, 'complete');
    assert.equal(progress.games, 4);
    assert.equal(syncDates.mock.calls[0][0], '2026-10-20'); // resumes at the latest stored date
    assert.equal(syncDates.mock.calls[0][2].skipLoaded, true);
    const [run] = await syncRuns.recent(1);
    assert.equal(run.id, body.runId);
    assert.equal(run.source, 'espn');
  });

  test('says so when historical_games is already current', async () => {
    const syncDates = vi.spyOn(espn, 'syncDates');
    vi.spyOn(espn, 'seasonDateRange').mockReturnValue(null);

    const body = await (await post('/sync/incremental', {})).json();
    assert.equal(body.success, true);
    assert.equal(body.upToDate, true);
    assert.equal(body.runId, null);
    assert.equal(syncDates.mock.calls.length, 0);
    assert.equal((await syncRuns.recent(1)).length, 0);
  });

  test('a running sync blocks it with 409', async () => {
    const id = await syncRuns.start({ source: 'espn-scheduled', season: currentSeason });
    try {
      const res = await post('/sync/incremental', {});
      assert.equal(res.status, 409);
      assert.equal((await res.json()).progress.mode, 'espn-scheduled');
    } finally {
      await syncRuns.finish(id, { gamesInserted: 0 });
    }
  });

  test('failures before the first run starts return 500', async () => {
    vi.spyOn(db, 'get').mockRejectedValueOnce(new Error('database is locked'));
    const res = await post('/sync/incremental', {});
    assert.equal(res.status, 500);
    assert.equal((await res.json()).error, 'database is locked');
  });
});

describe('POST /sync', () => {
  test('backfill walks the whole current season instead of resuming from the latest date', async () => {
    const syncSeason = vi.spyOn(espn, 'syncSeason')
      .mockResolvedValue({ dates: 1, games: 0, rows: 0, skipped: 3, failed: [] });
    await post('/sync', { seasons: [currentSeason], backfill: true });
    await waitForSync();
    assert.equal(syncSeason.mock.calls[0][0], currentSeason);
    assert.equal(syncSeason.mock.calls[0][1].resumeFromLatest, false);
    assert.equal(syncSeason.mock.calls[0][1].skipLoaded, true);
  });

  test('the legacy blob source is gone', async () => {
    const syncSeason = vi.spyOn(espn, 'syncSeason');
    const res = await post('/sync', { source: 'blob' });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /blob/);
    assert.equal(syncSeason.mock.calls.length, 0);
    assert.equal((await syncRuns.recent(1)).length, 0);
  });
});
