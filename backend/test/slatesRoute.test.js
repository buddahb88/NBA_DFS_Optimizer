import { test, beforeAll as before, afterAll as after } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

// The route module opens the database on import; keep it off the real DB file
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nba-dfs-slates-'));
let db;
let filterSlatesBySite;

before(async () => {
  process.env.DATABASE_TYPE = 'sqlite';
  process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');
  db = (await import('../src/config/database.js')).default;
  ({ filterSlatesBySite } = await import('../src/routes/slates.js'));
});

after(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const slates = [
  { slate_id: '1', site: 'draftkings' },
  { slate_id: '2', site: 'fanduel' },
  { slate_id: '3', site: null },
];

test('filterSlatesBySite keeps only the requested site', () => {
  assert.deepEqual(filterSlatesBySite(slates, 'fanduel').map(s => s.slate_id), ['2']);
  assert.deepEqual(filterSlatesBySite(slates, 'yahoo'), []);
});

test('filterSlatesBySite treats slates without a site as DraftKings', () => {
  assert.deepEqual(filterSlatesBySite(slates, 'DraftKings').map(s => s.slate_id), ['1', '3']);
});
