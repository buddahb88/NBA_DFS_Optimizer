import { test, vi, beforeAll as before, afterAll as after, beforeEach, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';

// The route module opens the database on import; keep it off the real DB file
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nba-dfs-espn-route-'));
let db;
let espn;
let nbaStatsService;
let currentSeason;
let server;
let baseUrl;

before(async () => {
  process.env.DATABASE_TYPE = 'sqlite';
  process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');
  db = (await import('../src/config/database.js')).default;
  espn = (await import('../src/services/espnBoxScoreService.js')).default;
  nbaStatsService = (await import('../src/services/nbaStatsService.js')).default;
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

const result = (o = {}) => ({ dates: 10, games: 5, rows: 120, skipped: 1, failed: [], elapsed: '1.0', ...o });
let syncSeason;
beforeEach(() => {
  syncSeason = vi.spyOn(espn, 'syncSeason').mockResolvedValue(result());
});
afterEach(() => vi.restoreAllMocks());

const post = (url, body) => fetch(`${baseUrl}${url}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
});

async function waitForSync() {
  for (let i = 0; i < 100; i++) {
    const { isSyncing, progress } = await (await fetch(`${baseUrl}/sync/status`)).json();
    if (!isSyncing && progress?.status !== 'starting' && progress?.status !== 'syncing') return progress;
    await new Promise(r => setTimeout(r, 10));
  }
  throw new Error('sync did not finish');
}

test('POST /sync defaults to ESPN for the current season, resuming from the latest loaded date', async () => {
  const res = await post('/sync', {});
  assert.equal(res.status, 200);
  assert.equal((await res.json()).mode, 'espn');
  const progress = await waitForSync();

  assert.equal(syncSeason.mock.calls.length, 1);
  const [season, options] = syncSeason.mock.calls[0];
  assert.equal(season, currentSeason);
  assert.equal(options.skipLoaded, true);
  assert.equal(options.resumeFromLatest, true);
  assert.equal(progress.status, 'complete');
  assert.equal(progress.mode, 'espn');
  assert.equal(progress.games, 5);
  assert.equal(progress.rows, 120);
});

test('POST /sync walks the requested seasons oldest first and totals the results', async () => {
  syncSeason
    .mockResolvedValueOnce(result({ games: 1000, rows: 26000 }))
    .mockResolvedValueOnce(result({ games: 3, rows: 78, failed: [{ game_id: '1', game_date: '2026-10-20', error: 'HTTP 500' }] }));

  await post('/sync', { seasons: [currentSeason, '2024-25'] });
  const progress = await waitForSync();

  assert.deepEqual(syncSeason.mock.calls.map(c => c[0]), ['2024-25', currentSeason]);
  // Only the current season resumes from its latest date; older seasons fill gaps
  assert.equal(syncSeason.mock.calls[0][1].resumeFromLatest, false);
  assert.equal(progress.games, 1003);
  assert.equal(progress.rows, 26078);
  assert.equal(progress.failed.length, 1);
});

test('forceFullSync refetches games that are already loaded', async () => {
  await post('/sync', { forceFullSync: true, seasons: ['2024-25'] });
  await waitForSync();
  assert.equal(syncSeason.mock.calls[0][1].skipLoaded, false);
});

test('start/end sync an explicit date range', async () => {
  const syncDates = vi.spyOn(espn, 'syncDates').mockResolvedValue(result({ games: 7 }));
  await post('/sync', { start: '2025-01-14', end: '2025-01-15' });
  const progress = await waitForSync();
  assert.deepEqual(syncDates.mock.calls[0].slice(0, 2), ['2025-01-14', '2025-01-15']);
  assert.equal(syncSeason.mock.calls.length, 0);
  assert.equal(progress.games, 7);
});

test('a failing ESPN sync reports an error', async () => {
  syncSeason.mockRejectedValue(new Error('boom'));
  await post('/sync', {});
  const progress = await waitForSync();
  assert.equal(progress.status, 'error');
  assert.equal(progress.error, 'boom');
});

test('GET /status reports the ESPN load', async () => {
  vi.spyOn(nbaStatsService, 'getDataStatus').mockResolvedValue({ hasData: true, totalGames: 26, needsFullSync: false, needsUpdate: false });
  vi.spyOn(espn, 'getStatus').mockResolvedValue({ source: 'espn', loadedGames: 1, latestGameDate: '2025-01-15' });
  const body = await (await fetch(`${baseUrl}/status`)).json();
  assert.equal(body.source, 'espn');
  assert.deepEqual(body.espn, { source: 'espn', loadedGames: 1, latestGameDate: '2025-01-15' });
  assert.equal(body.totalGames, 26);
});
