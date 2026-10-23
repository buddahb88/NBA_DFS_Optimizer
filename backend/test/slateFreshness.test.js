import { test, describe, beforeAll as before, beforeEach, afterAll as after } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Slate freshness: which date the latest slate covers vs today's (Eastern) DFS day.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nba-dfs-slate-freshness-'));
process.env.DATABASE_TYPE = 'sqlite';
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');

let db;
let freshness;

before(async () => {
  db = (await import('../src/config/database.js')).default;
  await (await import('../src/config/schema.js')).createTables(db);
  freshness = await import('../src/services/slateFreshness.js');
});

after(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(async () => {
  for (const t of ['players', 'slates', 'slate_player_snapshots']) await db.run(`DELETE FROM ${t}`);
});

const rawGame = (dateTime) => JSON.stringify({ game: { dateTime } });
const addSlate = (slateId, { startTime = null, createdAt = '2026-10-21 21:24:37' } = {}) => db.run(
  `INSERT INTO slates (slate_id, name, site, start_time, created_at) VALUES (?, 'All', 'draftkings', ?, ?)`,
  slateId, startTime, createdAt);
const addPlayer = (slateId, name, rawData = null) => db.run(
  `INSERT INTO players (slate_id, player_id, name, position, salary, raw_data) VALUES (?, ?, ?, 'PG', 5000, ?)`,
  slateId, name, name, rawData);

describe('slateFreshness (pure)', () => {
  test('just before midnight ET the slate for that night is not stale', () => {
    // 2026-10-22 03:30Z = 2026-10-21 23:30 EDT
    const f = freshness.slateFreshness('2026-10-21', new Date('2026-10-22T03:30:00Z'));
    assert.equal(f.today, '2026-10-21');
    assert.equal(f.isStale, false);
    assert.equal(f.daysOld, 0);
    assert.equal(f.warning, null);
  });

  test('just after midnight ET the same slate is a day old', () => {
    // 2026-10-22 04:30Z = 2026-10-22 00:30 EDT
    const f = freshness.slateFreshness('2026-10-21', new Date('2026-10-22T04:30:00Z'));
    assert.equal(f.today, '2026-10-22');
    assert.equal(f.isStale, true);
    assert.equal(f.daysOld, 1);
  });

  test('a stale slate carries a plain-English sync warning naming both dates', () => {
    const f = freshness.slateFreshness('2026-10-21', new Date('2026-10-23T16:00:00Z'), { slateId: '29805' });
    assert.equal(f.isStale, true);
    assert.equal(f.daysOld, 2);
    assert.match(f.warning, /2026-10-21/);
    assert.match(f.warning, /2026-10-23/);
    assert.match(f.warning, /29805/);
    assert.match(f.warning, /sync/i);
    assert.match(f.warning, /not tonight/i);
  });

  test('an unknown slate date is never reported stale', () => {
    const f = freshness.slateFreshness(null, new Date('2026-10-23T16:00:00Z'));
    assert.equal(f.slateDate, null);
    assert.equal(f.isStale, false);
    assert.equal(f.daysOld, null);
  });
});

describe('getSlateDate', () => {
  test('uses a full slates.start_time (Eastern date)', async () => {
    await addSlate('a', { startTime: '2026-10-22T23:00:00Z' });
    await addPlayer('a', 'P1', rawGame('2026-10-21 19:00:00'));
    assert.equal(await freshness.getSlateDate('a'), '2026-10-22');
  });

  test('else the earliest RotoWire game.dateTime of the slate players', async () => {
    await addSlate('b', { startTime: '7:00 PM' });
    await addPlayer('b', 'P1', rawGame('2026-10-21 22:00:00'));
    await addPlayer('b', 'P2', rawGame('2026-10-21 19:30:00'));
    assert.equal(await freshness.getSlateDate('b'), '2026-10-21');
  });

  test('else the snapshot game_date', async () => {
    await addSlate('c');
    await addPlayer('c', 'P1');
    await db.run(`INSERT INTO slate_player_snapshots (snapshot_date, game_date, slate_id, site, player_key, player_name)
      VALUES ('2026-10-20', '2026-10-20', 'c', 'draftkings', 'p1', 'P1')`);
    assert.equal(await freshness.getSlateDate('c'), '2026-10-20');
  });

  test('else the Eastern date the slate was created (UTC timestamp)', async () => {
    await addSlate('d', { createdAt: '2026-10-22 02:00:00' }); // 2026-10-21 22:00 EDT
    assert.equal(await freshness.getSlateDate('d'), '2026-10-21');
  });

  test('unknown slate is null', async () => {
    assert.equal(await freshness.getSlateDate('nope'), null);
  });
});

describe('getCurrentSlateInfo', () => {
  test('returns the latest slate with its date, today and staleness', async () => {
    await addSlate('old', { createdAt: '2026-10-20 20:00:00' });
    await addSlate('29805', { createdAt: '2026-10-21 21:24:37' });
    await addPlayer('29805', 'P1', rawGame('2026-10-21 19:30:00'));

    const info = await freshness.getCurrentSlateInfo({ now: new Date('2026-10-23T16:00:00Z') });
    assert.equal(info.slateId, '29805');
    assert.equal(info.playerCount, 1);
    assert.equal(info.slateDate, '2026-10-21');
    assert.equal(info.today, '2026-10-23');
    assert.equal(info.isStale, true);
    assert.equal(info.daysOld, 2);
    assert.match(info.warning, /29805/);
  });

  test('a slate for today is not stale', async () => {
    await addSlate('29900');
    await addPlayer('29900', 'P1', rawGame('2026-10-23 19:00:00'));
    const info = await freshness.getCurrentSlateInfo({ now: new Date('2026-10-23T16:00:00Z') });
    assert.equal(info.isStale, false);
    assert.equal(info.warning, null);
  });

  test('no slates returns null', async () => {
    assert.equal(await freshness.getCurrentSlateInfo(), null);
  });
});

describe('slateDateFields', () => {
  test('stale slate: date, today, flag and warning for tool outputs', async () => {
    await addSlate('29805');
    await addPlayer('29805', 'P1', rawGame('2026-10-21 19:30:00'));
    const fields = await freshness.slateDateFields('29805', { now: new Date('2026-10-23T16:00:00Z') });
    assert.equal(fields.slateDate, '2026-10-21');
    assert.equal(fields.today, '2026-10-23');
    assert.equal(fields.isStale, true);
    assert.match(fields.staleWarning, /2026-10-21/);
  });

  test('current slate: no warning key', async () => {
    await addSlate('29900');
    await addPlayer('29900', 'P1', rawGame('2026-10-23 19:00:00'));
    const fields = await freshness.slateDateFields('29900', { now: new Date('2026-10-23T16:00:00Z') });
    assert.deepEqual(fields, { slateDate: '2026-10-23', today: '2026-10-23', isStale: false });
  });
});
