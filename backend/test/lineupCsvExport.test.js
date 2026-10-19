import { test, beforeAll as before, afterAll as after } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { buildLineupCsv } from '../src/services/lineupExport.js';

// routes/lineups.js opens the database on import; keep it off the real DB file
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nba-dfs-export-'));
let db;
let validateLineup;

before(async () => {
  process.env.DATABASE_TYPE = 'sqlite';
  process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');
  db = (await import('../src/config/database.js')).default;
  ({ validateLineup } = await import('../src/routes/lineups.js'));
});

after(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const player = (id, extra = {}) => ({ id, name: `Player ${id}`, site_player_id: `${1000 + id}`, ...extra });
const byId = (players) => new Map(players.map((p) => [p.id, p]));

const DK_SLOTS = ['PG', 'SG', 'SF', 'PF', 'C', 'G', 'F', 'UTIL'];
const FD_SLOTS = ['PG', 'PG', 'SG', 'SG', 'SF', 'SF', 'PF', 'PF', 'C'];
const lineup = (slots, ids) => ({ players: slots.map((slot, i) => ({ slot, playerId: ids[i] })) });

test('DraftKings CSV: slot header and one site ID per cell, in slot order', () => {
  const players = byId([1, 2, 3, 4, 5, 6, 7, 8].map((id) => player(id)));
  // Lineup players out of roster order still land in the right columns
  const scrambled = { players: [...lineup(DK_SLOTS, [1, 2, 3, 4, 5, 6, 7, 8]).players].reverse() };
  const { csv, count, warnings } = buildLineupCsv('draftkings', [scrambled], players);
  assert.equal(count, 1);
  assert.deepEqual(warnings, []);
  assert.equal(csv, 'PG,SG,SF,PF,C,G,F,UTIL\r\n1001,1002,1003,1004,1005,1006,1007,1008\r\n');
});

test('FanDuel CSV: repeated positions and "id:name" cells', () => {
  const players = byId([1, 2, 3, 4, 5, 6, 7, 8, 9].map((id) => player(id, { site_player_id: `123-${id}` })));
  const { csv } = buildLineupCsv('fanduel', [lineup(FD_SLOTS, [1, 2, 3, 4, 5, 6, 7, 8, 9])], players);
  const [header, row] = csv.trim().split('\r\n');
  assert.equal(header, 'PG,PG,SG,SG,SF,SF,PF,PF,C');
  assert.equal(row.split(',')[0], '123-1:Player 1');
  assert.equal(row.split(',')[8], '123-9:Player 9');
});

test('missing site IDs fall back to the name with a warning; names with commas are quoted', () => {
  const players = byId([1, 2, 3, 4, 5, 6, 7, 8].map((id) => player(id)));
  players.set(3, { id: 3, name: 'Smith, Jr.', site_player_id: null });
  const { csv, warnings } = buildLineupCsv('draftkings', [lineup(DK_SLOTS, [1, 2, 3, 4, 5, 6, 7, 8])], players);
  assert.match(csv, /1002,"Smith, Jr\.",1004/);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /No DraftKings player ID for Smith, Jr\./);
});

test('lineups that do not fill the roster are skipped with a warning', () => {
  const players = byId([1, 2, 3, 4, 5, 6, 7, 8].map((id) => player(id)));
  const short = lineup(DK_SLOTS.slice(0, 7), [1, 2, 3, 4, 5, 6, 7]);
  const unknownPlayer = lineup(DK_SLOTS, [1, 2, 3, 4, 5, 6, 7, 99]);
  const good = lineup(DK_SLOTS, [1, 2, 3, 4, 5, 6, 7, 8]);
  const { count, warnings } = buildLineupCsv('draftkings', [short, unknownPlayer, good], players);
  assert.equal(count, 1);
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /Lineup 1/);
});

test('validateLineup uses the site roster size and salary cap', () => {
  const nine = Array.from({ length: 9 }, () => ({ salary: 6000 }));
  assert.equal(validateLineup(nine, 'fanduel').isValid, true);
  assert.equal(validateLineup(nine, 'draftkings').isValid, false);
  assert.equal(validateLineup(nine.slice(0, 8), undefined).isValid, true); // DK default
  const yahoo = Array.from({ length: 8 }, () => ({ salary: 30 }));
  assert.match(validateLineup(yahoo, 'yahoo').errors[0], /exceeds cap \(\$200\)/);
  assert.match(validateLineup(nine, 'pokerstars').errors[0], /Unknown DFS site/);
});
