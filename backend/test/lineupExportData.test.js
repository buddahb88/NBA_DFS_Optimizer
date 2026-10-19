import { test, beforeAll as before, afterAll as after } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Loads lineups from a real (temp) sqlite DB and builds the export end to end
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nba-dfs-export-'));
let db;
let loadSavedLineups;
let loadInlineLineups;
let buildLineupExport;
let lineupId;
const playerIds = [];

const PLAYERS = [
  ['Guard One', 'PG', 9500, 'AAA', 'BBB', '39000001', 'PG'],
  ['Wing One', 'SG', 7000, 'BBB', 'AAA', '39000002', 'SG'],
  ['Forward One', 'SF', 6000, 'CCC', 'DDD', '39000003', 'SF'],
  ['Big One', 'PF', 5500, 'DDD', 'CCC', '39000004', 'PF'],
  ['Center One', 'C', 8000, 'AAA', 'BBB', '39000005', 'C'],
  ['Combo Guard', 'PG,SG', 4800, 'CCC', 'DDD', '39000006', 'G'],
  ['Combo Forward', 'SF,PF', 4400, 'BBB', 'AAA', '39000007', 'F'],
  ['Util Big', 'PF,C', 4400, 'DDD', 'CCC', '39000008', 'UTIL']
];

before(async () => {
  process.env.DATABASE_TYPE = 'sqlite';
  process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');
  db = (await import('../src/config/database.js')).default;
  const { createTables } = await import('../src/config/schema.js');
  await createTables(db);
  ({ loadSavedLineups, loadInlineLineups } = await import('../src/services/lineupExportData.js'));
  ({ buildLineupExport } = await import('../src/services/lineupExportService.js'));

  await db.run(`INSERT INTO slates (slate_id, name, site) VALUES ('dk1', 'Main', 'draftkings')`);
  for (const [i, [name, position, salary, team, opponent, siteId]] of PLAYERS.entries()) {
    const r = await db.run(
      `INSERT INTO players (slate_id, player_id, name, team, opponent, position, salary, site_player_id)
       VALUES ('dk1', ?, ?, ?, ?, ?, ?, ?)`,
      `rw${i}`, name, team, opponent, position, salary, siteId
    );
    playerIds.push(Number(r.lastInsertRowid));
  }
  const l = await db.run(`INSERT INTO lineups (slate_id, name, total_salary, projected_points) VALUES ('dk1', 'Saved 1', 49600, 250)`);
  lineupId = Number(l.lastInsertRowid);
  for (const [i, row] of PLAYERS.entries()) {
    await db.run(`INSERT INTO lineup_players (lineup_id, player_id, position_slot) VALUES (?, ?, ?)`, lineupId, playerIds[i], row[6]);
  }
});

after(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('saved lineups export with site IDs from the DB', async () => {
  const lineups = await loadSavedLineups([lineupId, 999999]);
  assert.equal(lineups[0].slateSite, 'draftkings');
  assert.equal(lineups[1].missing, true);

  const ok = buildLineupExport({ site: 'draftkings', mode: 'new', lineups: [lineups[0]] });
  assert.equal(ok.success, true, JSON.stringify(ok.errors));
  assert.equal(ok.csv.split('\r\n')[1], '39000001,39000002,39000003,39000004,39000005,39000006,39000007,39000008');

  const bad = buildLineupExport({ site: 'draftkings', mode: 'new', lineups });
  assert.equal(bad.success, false);
  assert.deepEqual(bad.errors.map(e => [e.index, e.messages[0]]), [[2, 'Lineup not found']]);
});

test('inline lineups use DB values, not client-sent ones', async () => {
  // Optimizer result shape: { position, player }; client lies about salary
  const inline = [{
    name: 'Opt 1',
    players: PLAYERS.map((row, i) => ({ position: row[6], player: { id: playerIds[i], salary: 1 } }))
  }];
  const [lineup] = await loadInlineLineups(inline);
  assert.equal(lineup.players[0].salary, 9500);
  assert.equal(buildLineupExport({ site: 'draftkings', lineups: [lineup] }).success, true);

  const wrongSite = buildLineupExport({ site: 'fanduel', lineups: [lineup] });
  assert.match(wrongSite.errors[0].messages.join(), /from a DraftKings slate, not FanDuel/);

  const [unknown] = await loadInlineLineups([{ players: [{ id: 123456, name: 'Ghost' }] }]);
  assert.deepEqual(unknown.unknownPlayers, ['Ghost']);
});
