import { test, vi, beforeAll as before, afterAll as after, beforeEach, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';

// The route module opens the database on import; keep it off the real DB file
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nba-dfs-historical-route-'));
let db;
let nbaStatsService;
let server;
let baseUrl;

before(async () => {
  process.env.DATABASE_TYPE = 'sqlite';
  process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');
  db = (await import('../src/config/database.js')).default;
  nbaStatsService = (await import('../src/services/nbaStatsService.js')).default;
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

let status;
beforeEach(() => {
  status = { hasData: true, totalGames: 10, latestGame: '2026-10-21' };
  vi.spyOn(nbaStatsService, 'getDataStatus').mockImplementation(async () => status);
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

test('nba-api sync reports games/players from the service result', async () => {
  const incremental = vi.spyOn(nbaStatsService, 'fetchIncrementalGameLogs')
    .mockResolvedValue({ players: 450, games: 1234, newGames: 1234, elapsed: '1.0' });

  const res = await post('/sync/nba-api', { season: '2026-27' });
  assert.equal(res.status, 200);
  const progress = await waitForSync();

  assert.deepEqual(incremental.mock.calls[0].slice(0, 2), ['2026-27', '2026-10-21']);
  assert.equal(progress.status, 'complete');
  assert.equal(progress.games, 1234);
  assert.equal(progress.players, 450);
  assert.match(progress.message, /1234 games from 450 players/);
});

test('nba-api sync of an older season ignores the latest game from another season', async () => {
  const full = vi.spyOn(nbaStatsService, 'fetchSeasonGameLogs')
    .mockResolvedValue({ players: 500, games: 25000, skipped: 0, elapsed: '9.0' });
  const incremental = vi.spyOn(nbaStatsService, 'fetchIncrementalGameLogs');

  await post('/sync/nba-api', { season: '2024-25' });
  const progress = await waitForSync();

  assert.equal(incremental.mock.calls.length, 0);
  assert.equal(full.mock.calls[0][0], '2024-25');
  assert.equal(progress.games, 25000);
});

test('nba-api sync survives a failing getDataStatus', async () => {
  nbaStatsService.getDataStatus.mockRejectedValue(new Error('db down'));
  const full = vi.spyOn(nbaStatsService, 'fetchSeasonGameLogs')
    .mockResolvedValue({ players: 1, games: 2, skipped: 0, elapsed: '0.1' });

  const res = await post('/sync/nba-api', { season: '2026-27' });
  assert.equal(res.status, 200);
  const progress = await waitForSync();
  assert.equal(full.mock.calls.length, 1);
  assert.equal(progress.games, 2);
});

test('blob sync still starts when getDataStatus fails', async () => {
  process.env.BLOB_STORAGE_URL = 'http://127.0.0.1:1/blob';
  nbaStatsService.getDataStatus.mockRejectedValue(new Error('db down'));
  try {
    const res = await post('/sync', { source: 'blob' });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).lastGameDate, null);
    await waitForSync();
  } finally {
    delete process.env.BLOB_STORAGE_URL;
  }
});
