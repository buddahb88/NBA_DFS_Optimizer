import { test, beforeAll as before, afterAll as after } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nba-dfs-player-settings-'));
let db;
let model;
let normalizeSettings;

before(async () => {
  process.env.DATABASE_TYPE = 'sqlite';
  process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');
  db = (await import('../src/config/database.js')).default;
  const { createTables } = await import('../src/config/schema.js');
  await createTables(db);
  // Second run must be a no-op (migration runs on every startup)
  await createTables(db);
  ({ default: model, normalizeSettings } = await import('../src/models/playerSettingsModel.js'));
});

after(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('normalizeSettings returns null for all-default payloads', () => {
  assert.equal(normalizeSettings({}), null);
  assert.equal(normalizeSettings({ lock: false, minExposure: '', maxExposure: null }), null);
});

test('normalizeSettings rejects invalid combinations', () => {
  assert.throws(() => normalizeSettings({ lock: true, exclude: true }), /both locked and excluded/);
  assert.throws(() => normalizeSettings({ minExposure: 60, maxExposure: 40 }), /minExposure/);
  assert.throws(() => normalizeSettings({ maxExposure: 120 }), /between 0 and 100/);
  assert.throws(() => normalizeSettings({ projectionOverride: 'abc' }), /must be a number/);
});

test('upsert inserts, updates and reads back per slate', async () => {
  await model.upsert('s1', '101', { lock: true, maxExposure: 80 });
  await model.upsert('s1', '102', { exclude: true });
  await model.upsert('s2', '101', { projectionOverride: 42.5 });

  await model.upsert('s1', '101', { minExposure: 20, maxExposure: 60, projectionOverride: '35' });

  assert.deepEqual(await model.getBySlateId('s1'), [
    { playerId: '101', lock: false, exclude: false, minExposure: 20, maxExposure: 60, projectionOverride: 35 },
    { playerId: '102', lock: false, exclude: true, minExposure: null, maxExposure: null, projectionOverride: null }
  ]);
  assert.equal((await model.getBySlateId('s2'))[0].projectionOverride, 42.5);
});

test('an all-default upsert deletes the row; clearSlate removes the slate only', async () => {
  assert.equal(await model.upsert('s1', '102', {}), null);
  assert.deepEqual((await model.getBySlateId('s1')).map(s => s.playerId), ['101']);

  await model.clearSlate('s1');
  assert.deepEqual(await model.getBySlateId('s1'), []);
  assert.equal((await model.getBySlateId('s2')).length, 1);
});
