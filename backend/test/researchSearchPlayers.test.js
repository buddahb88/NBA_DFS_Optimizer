import { test, describe, vi, beforeAll as before, afterAll as after } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

// ResearchAgent.search_players reads players.rostership (there is no
// ownership column) and returns it as `ownership`.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nba-dfs-search-players-'));
process.env.DATABASE_TYPE = 'sqlite';
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');

let db;
let searchPlayers;

before(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  db = (await import('../src/config/database.js')).default;
  await (await import('../src/config/schema.js')).createTables(db);

  await db.run(`INSERT INTO slates (slate_id, name, site) VALUES ('100', 'Main', 'draftkings')`);
  await db.run(
    `INSERT INTO players (id, slate_id, player_id, name, team, opponent, position, salary, projected_points, floor, ceiling, rostership, leverage_score)
     VALUES (1, '100', '1', 'Luka Doncic', 'LAL', 'BOS', 'PG', 11000, 58.5, 45, 72, 31.5, 1.2)`);

  const ResearchAgent = (await import('../src/agents/ResearchAgent.js')).default;
  searchPlayers = new ResearchAgent().tools.find(t => t.name === 'search_players');
});

after(() => {
  vi.restoreAllMocks();
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('ResearchAgent search_players', () => {
  test('finds a player and returns rostership as ownership', async () => {
    const result = await searchPlayers.execute({ playerNames: ['doncic'], slateId: '100' });

    assert.equal(result.success, true);
    assert.deepEqual(result.notFound, []);
    assert.equal(result.found.length, 1);
    assert.equal(result.found[0].name, 'Luka Doncic');
    assert.equal(result.found[0].ownership, 31.5);
    assert.equal(result.found[0].leverage, 1.2);
  });
});
