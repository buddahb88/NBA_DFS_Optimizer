import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nba-dfs-sites-'));
const dbPath = path.join(tmpDir, 'test.db');
let db;
let createTables;

before(async () => {
  // Simulate a pre-migration database: old slates/players schema with data
  const seed = new Database(dbPath);
  seed.exec(`
    CREATE TABLE slates (id INTEGER PRIMARY KEY AUTOINCREMENT, slate_id TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
      sport TEXT DEFAULT 'NBA', start_time DATETIME, created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE players (id INTEGER PRIMARY KEY AUTOINCREMENT, slate_id TEXT NOT NULL, player_id TEXT NOT NULL,
      name TEXT NOT NULL, team TEXT, opponent TEXT, position TEXT NOT NULL, salary INTEGER NOT NULL,
      UNIQUE(slate_id, player_id));
    INSERT INTO slates (slate_id, name) VALUES ('s1', 'Main');
    INSERT INTO players (slate_id, player_id, name, position, salary) VALUES
      ('s1', '1', 'Guard', 'PG,SG', 8000), ('s1', '2', 'Big', 'C', 7000);
  `);
  seed.close();

  process.env.DATABASE_TYPE = 'sqlite';
  process.env.DATABASE_PATH = dbPath;
  db = (await import('../src/config/database.js')).default;
  ({ createTables } = await import('../src/config/schema.js'));
  await createTables(db);
});

after(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('existing slates migrate to draftkings', async () => {
  const slate = await db.get(`SELECT site FROM slates WHERE slate_id = 's1'`);
  assert.equal(slate.site, 'draftkings');
});

test('new slates default to draftkings', async () => {
  await db.run(`INSERT INTO slates (slate_id, name) VALUES ('s2', 'Late')`);
  assert.equal((await db.get(`SELECT site FROM slates WHERE slate_id = 's2'`)).site, 'draftkings');
});

test('existing players get DK roster_positions and null site_player_id', async () => {
  const rows = await db.all(`SELECT player_id, site_player_id, roster_positions FROM players ORDER BY player_id`);
  assert.deepEqual(rows.map(r => ({ ...r })), [
    { player_id: '1', site_player_id: null, roster_positions: 'PG/SG/G/UTIL' },
    { player_id: '2', site_player_id: null, roster_positions: 'C/UTIL' }
  ]);
});

test('migration is idempotent and backfills per slate site', async () => {
  await db.run(`INSERT INTO slates (slate_id, name, site) VALUES ('fd1', 'FD Main', 'fanduel')`);
  await db.run(`INSERT INTO players (slate_id, player_id, name, position, salary) VALUES ('fd1', '3', 'Wing', 'SF,PF', 6000)`);
  await createTables(db);
  const row = await db.get(`SELECT roster_positions FROM players WHERE slate_id = 'fd1'`);
  assert.equal(row.roster_positions, 'SF/PF');
});
