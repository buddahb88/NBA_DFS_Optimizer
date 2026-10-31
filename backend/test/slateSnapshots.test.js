import { test, describe, vi, beforeAll as before, beforeEach, afterAll as after } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import Database from 'better-sqlite3';

// The sync route scrapes Hashtag Basketball / RotoWire; stub the network
const rotowirePlayers = vi.hoisted(() => ({ list: [] }));
vi.mock('../src/services/rotowireService.js', () => ({
  default: { fetchPlayers: async () => rotowirePlayers.list }
}));
vi.mock('../src/services/hashtagBasketballService.js', () => ({
  default: { fetchAndStorePositionDefense: async () => {} }
}));

const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'salaries');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nba-dfs-snapshots-'));
process.env.DATABASE_TYPE = 'sqlite';
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');

let db;
let createTables;
let snapshots;
let lineupModel;
let server;
let baseUrl;

before(async () => {
  db = (await import('../src/config/database.js')).default;
  ({ createTables } = await import('../src/config/schema.js'));
  await createTables(db);
  snapshots = await import('../src/services/slateSnapshotService.js');
  lineupModel = (await import('../src/models/lineupModel.js')).default;

  const app = express();
  app.use(express.json());
  app.use('/api/players', (await import('../src/routes/players.js')).default);
  await new Promise(resolve => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise(resolve => server.close(resolve));
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(async () => {
  for (const t of ['lineup_players', 'lineups', 'players', 'slates', 'slate_player_snapshots']) {
    await db.run(`DELETE FROM ${t}`);
  }
});

// RotoWire-shaped player as passed to playerModel.bulkCreateOrUpdate
const rwPlayer = (playerId, name, overrides = {}) => ({
  playerId,
  name,
  team: 'LAL',
  opponent: 'DAL',
  position: 'PG',
  salary: 8000,
  projectedPoints: 40,
  projectedMinutes: 34,
  injuryStatus: null,
  lineupConfirmed: 1,
  vegasImpliedTotal: 115.5,
  vegasSpread: -3.5,
  vegasOverUnder: 228,
  rostership: 18.5,
  floor: 30,
  ceiling: 55,
  ...overrides
});

async function seedSlate(slateId, players, { site = 'draftkings', startTime = null } = {}) {
  await db.run(`INSERT INTO slates (slate_id, name, sport, start_time, site) VALUES (?, ?, 'NBA', ?, ?)`,
    slateId, `Slate ${slateId}`, startTime, site);
  const playerModel = (await import('../src/models/playerModel.js')).default;
  await playerModel.bulkCreateOrUpdate(slateId, players);
}

const snapshotRows = () => db.all(`SELECT * FROM slate_player_snapshots ORDER BY slate_id, player_key`);

const sync = (slateId, body = {}) => fetch(`${baseUrl}/api/players/${slateId}/sync`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body)
});

describe('slate_player_snapshots schema', () => {
  test('migration is idempotent and enforces (game_date, site, slate_id, player_key)', async () => {
    await createTables(db);
    await createTables(db);

    const cols = new Set((await db.all(`PRAGMA table_info(slate_player_snapshots)`)).map(c => c.name));
    for (const c of [
      'snapshot_date', 'game_date', 'slate_id', 'site', 'player_key', 'player_name', 'team', 'opponent',
      'position', 'salary', 'projected_points', 'projected_minutes', 'floor', 'ceiling', 'rostership',
      'vegas_implied_total', 'vegas_spread', 'over_under', 'injury_status', 'is_confirmed', 'captured_at'
    ]) {
      assert.ok(cols.has(c), `missing column ${c}`);
    }

    const insert = `INSERT INTO slate_player_snapshots (snapshot_date, game_date, slate_id, site, player_key, player_name)
      VALUES ('2026-10-21', '2026-10-21', 's1', 'draftkings', 'luka doncic', 'Luka Doncic')`;
    await db.run(insert);
    await assert.rejects(() => db.run(insert), /UNIQUE/);
  });
});

describe('snapshotSlate', () => {
  test('writes one row per player with player_key, site and Eastern game date', async () => {
    // 02:30 UTC on the 22nd is 10:30 PM ET on the 21st
    await seedSlate('s1', [
      rwPlayer('rw1', 'Luka Dončić'),
      rwPlayer('rw2', 'Jaren Jackson Jr.', { team: 'MEM', opponent: 'BKN', position: 'PF/C', injuryStatus: 'GTD', lineupConfirmed: 0 })
    ], { site: 'fanduel', startTime: '2026-10-22T02:30:00.000Z' });

    const written = await snapshots.snapshotSlate('s1', { now: new Date('2026-10-21T16:00:00Z') });
    assert.equal(written, 2);

    const rows = await snapshotRows();
    assert.deepEqual(rows.map(r => r.player_key), ['jaren jackson', 'luka doncic']);
    const luka = rows.find(r => r.player_key === 'luka doncic');
    assert.equal(luka.player_name, 'Luka Dončić');
    assert.equal(luka.site, 'fanduel');
    assert.equal(luka.slate_id, 's1');
    assert.equal(luka.game_date, '2026-10-21');
    assert.equal(luka.snapshot_date, '2026-10-21');
    assert.equal(luka.team, 'LAL');
    assert.equal(luka.opponent, 'DAL');
    assert.equal(luka.position, 'PG');
    assert.equal(luka.salary, 8000);
    assert.equal(luka.projected_points, 40);
    assert.equal(luka.projected_minutes, 34);
    assert.equal(luka.floor, 30);
    assert.equal(luka.ceiling, 55);
    assert.equal(luka.rostership, 18.5);
    assert.equal(luka.vegas_implied_total, 115.5);
    assert.equal(luka.vegas_spread, -3.5);
    assert.equal(luka.over_under, 228);
    assert.equal(luka.is_confirmed, 1);
    assert.ok(luka.captured_at);

    const jjj = rows.find(r => r.player_key === 'jaren jackson');
    assert.equal(jjj.injury_status, 'GTD');
    assert.equal(jjj.is_confirmed, 0);
  });

  test('falls back to the Eastern capture date when the slate has no start date', async () => {
    await seedSlate('s1', [rwPlayer('rw1', 'Luka Doncic')], { startTime: '7:00 PM ET' });
    // 03:00 UTC on the 22nd is still the 21st in New York
    await snapshots.snapshotSlate('s1', { now: new Date('2026-10-22T03:00:00Z') });
    const [row] = await snapshotRows();
    assert.equal(row.game_date, '2026-10-21');
    assert.equal(row.snapshot_date, '2026-10-21');
    assert.equal(row.site, 'draftkings');
  });

  test('RotoWire slate synced the day after uses each player\'s game.dateTime, not the capture date', async () => {
    const raw = (dateTime) => JSON.stringify({ game: { dateTime } });
    await seedSlate('s1', [
      rwPlayer('rw1', 'Victor Wembanyama', { rawData: raw('2026-10-20 21:30:00') }),
      // No raw_data date: falls back to the capture date
      rwPlayer('rw2', 'Luka Doncic')
    ], { startTime: '7:00 PM' });
    // 12:41 PM ET on the 21st, after the 20th's games
    await snapshots.snapshotSlate('s1', { now: new Date('2026-10-21T16:41:00Z') });

    const rows = await snapshotRows();
    const wemby = rows.find(r => r.player_key === 'victor wembanyama');
    assert.equal(wemby.game_date, '2026-10-20');
    assert.equal(wemby.snapshot_date, '2026-10-21');
    assert.equal(rows.find(r => r.player_key === 'luka doncic').game_date, '2026-10-21');
  });

  test('a full slate start_time (salary import) wins over RotoWire raw_data', async () => {
    await seedSlate('s1', [rwPlayer('rw1', 'Luka Doncic', { rawData: JSON.stringify({ game: { dateTime: '2026-10-19 19:00:00' } }) })],
      { startTime: '2026-10-22T02:30:00.000Z' });
    await snapshots.snapshotSlate('s1', { now: new Date('2026-10-21T16:00:00Z') });
    const [row] = await snapshotRows();
    assert.equal(row.game_date, '2026-10-21');
  });

  test('re-snapshotting the same slate updates the latest values instead of duplicating', async () => {
    await seedSlate('s1', [rwPlayer('rw1', 'Luka Doncic'), rwPlayer('rw2', 'LeBron James')],
      { startTime: '2026-10-21T23:00:00.000Z' });
    await snapshots.snapshotSlate('s1', { now: new Date('2026-10-21T15:00:00Z') });

    await db.run(`UPDATE players SET salary = 8400, projected_points = 44.5, rostership = 31, injury_status = 'OUT'
      WHERE player_id = 'rw1'`);
    await snapshots.snapshotSlate('s1', { now: new Date('2026-10-21T18:00:00Z') });

    const rows = await snapshotRows();
    assert.equal(rows.length, 2);
    const luka = rows.find(r => r.player_key === 'luka doncic');
    assert.equal(luka.salary, 8400);
    assert.equal(luka.projected_points, 44.5);
    assert.equal(luka.rostership, 31);
    assert.equal(luka.injury_status, 'OUT');
    assert.ok(luka.captured_at >= rows.find(r => r.player_key === 'lebron james').captured_at);
  });

  test('a different game date or slate keeps its own rows', async () => {
    await seedSlate('s1', [rwPlayer('rw1', 'Luka Doncic')], { startTime: '2026-10-21T23:00:00.000Z' });
    await snapshots.snapshotSlate('s1');
    await db.run(`UPDATE slates SET start_time = '2026-10-23T23:00:00.000Z' WHERE slate_id = 's1'`);
    await snapshots.snapshotSlate('s1');

    const rows = await snapshotRows();
    assert.deepEqual(rows.map(r => r.game_date).sort(), ['2026-10-21', '2026-10-23']);
  });

  test('unknown or empty slate writes nothing', async () => {
    assert.equal(await snapshots.snapshotSlate('nope'), 0);
    assert.equal((await snapshotRows()).length, 0);
  });
});

describe('POST /api/players/:slateId/sync', () => {
  test('snapshots the old slate before the wipe and the fresh RotoWire load after', async () => {
    await seedSlate('old', [rwPlayer('rw1', 'Luka Doncic', { salary: 11000 })], { startTime: '2026-10-21T23:00:00.000Z' });

    rotowirePlayers.list = [rwPlayer('rw9', 'Nikola Jokić', { team: 'DEN', opponent: 'UTA', position: 'C', salary: 11800 })];
    const res = await sync('new', { name: 'Main' });
    assert.equal(res.status, 200);

    assert.equal((await db.all(`SELECT * FROM players WHERE slate_id = 'old'`)).length, 0, 'old players wiped');
    const rows = await snapshotRows();
    assert.deepEqual(rows.map(r => [r.slate_id, r.player_key, r.salary]), [
      ['new', 'nikola jokic', 11800],
      ['old', 'luka doncic', 11000]
    ]);
  });

  test('computes team ratings from box scores instead of scraping ESPN', async () => {
    const { getCurrentSeason, seasonStartDate } = await import('../src/utils/season.js');
    const season = getCurrentSeason();
    const date = seasonStartDate(season);
    await db.run('DELETE FROM team_defense_rankings');
    await db.run('DELETE FROM team_game_stats');
    for (const [team, opponent, pts, possessions] of [['DEN', 'UTA', 120, 100], ['UTA', 'DEN', 104, 100]]) {
      await db.run(`INSERT INTO team_game_stats (game_id, game_date, season, season_type, team, opponent, pts, possessions)
        VALUES ('g1', ?, ?, 'regular', ?, ?, ?, ?)`, date, season, team, opponent, pts, possessions);
    }
    rotowirePlayers.list = [rwPlayer('rw9', 'Nikola Jokić', { team: 'DEN', opponent: 'UTA', position: 'C', salary: 11800 })];
    assert.equal((await sync('main')).status, 200);

    const route = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/routes/players.js'), 'utf8');
    assert.ok(!/espn\.com|espnScraper/i.test(route), 'sync route does not scrape ESPN');
    const rows = await db.all('SELECT team, def_eff, off_eff, pace FROM team_defense_rankings ORDER BY team');
    assert.deepEqual(rows, [
      { team: 'DEN', def_eff: 104, off_eff: 120, pace: 100 },
      { team: 'UTA', def_eff: 120, off_eff: 104, pace: 100 }
    ]);
  });

  test('a saved lineup survives a slate resync', async () => {
    const roster = ['PG', 'SG', 'SF', 'PF', 'C', 'PG', 'SF', 'C'].map((position, i) =>
      rwPlayer(`rw${i}`, `Player ${String.fromCharCode(65 + i)}`, { position, salary: 6000 + i * 100 }));
    rotowirePlayers.list = roster;
    assert.equal((await sync('main')).status, 200);

    const players = await db.all(`SELECT * FROM players WHERE slate_id = 'main' ORDER BY player_id`);
    const lineupId = await lineupModel.create({ slateId: 'main', name: 'Keeper', totalSalary: 50800, projectedPoints: 320 });
    await lineupModel.addPlayers(lineupId, players.map((p, i) => ({ playerId: p.id, positionSlot: `S${i}` })));
    const before = await lineupModel.getById(lineupId);
    assert.equal(before.players.length, 8);

    // Resync: same slate, one player's salary moves, one player drops off the feed
    rotowirePlayers.list = roster.slice(1).map(p => (p.playerId === 'rw1' ? { ...p, salary: 7777 } : p));
    assert.equal((await sync('main')).status, 200);

    const after = await lineupModel.getById(lineupId);
    assert.ok(after, 'lineup still exists');
    assert.equal(after.name, 'Keeper');
    assert.equal(after.players.length, 8);
    assert.deepEqual(after.players.map(p => p.name).sort(), before.players.map(p => p.name).sort());

    // Dropped player keeps the saved details
    const dropped = after.players.find(p => p.player_id === 'rw0');
    assert.equal(dropped.name, 'Player A');
    assert.equal(dropped.salary, 6000);
    assert.equal(dropped.team, 'LAL');
    // Players still on the slate pick up the resynced row
    const live = after.players.find(p => p.player_id === 'rw1');
    assert.equal(live.salary, 7777);
    assert.notEqual(live.id, before.players.find(p => p.player_id === 'rw1').id);
  });
});

describe('salary CSV import', () => {
  test('writes snapshots for the imported slate', async () => {
    const { importSalaries } = await import('../src/services/salaryImportService.js');
    const csvText = fs.readFileSync(path.join(fixtureDir, 'DKSalaries.csv'), 'utf8');
    const report = await importSalaries({ csvText, slateId: 'dk-main' });

    const rows = await snapshotRows();
    assert.equal(rows.length, report.total);
    assert.ok(rows.every(r => r.slate_id === 'dk-main' && r.site === 'draftkings'));
    // First game in the file is 10/22/2025 07:30PM ET
    assert.ok(rows.every(r => r.game_date === '2025-10-22'));
    const luka = rows.find(r => r.player_key === 'luka doncic');
    assert.equal(luka.salary, 11200);
  });
});

describe('legacy sqlite lineups schema', () => {
  test('migration drops the slate/player cascades and keeps saved lineups', async () => {
    const legacyPath = path.join(tmpDir, 'legacy.db');
    const legacy = new Database(legacyPath);
    legacy.pragma('foreign_keys = ON');
    legacy.exec(`
      CREATE TABLE slates (id INTEGER PRIMARY KEY AUTOINCREMENT, slate_id TEXT UNIQUE NOT NULL, name TEXT NOT NULL);
      CREATE TABLE players (id INTEGER PRIMARY KEY AUTOINCREMENT, slate_id TEXT NOT NULL, player_id TEXT NOT NULL,
        name TEXT NOT NULL, team TEXT, opponent TEXT, position TEXT NOT NULL, salary INTEGER NOT NULL, projected_points REAL,
        site_player_id TEXT, roster_positions TEXT,
        FOREIGN KEY (slate_id) REFERENCES slates(slate_id) ON DELETE CASCADE);
      CREATE TABLE lineups (id INTEGER PRIMARY KEY AUTOINCREMENT, slate_id TEXT NOT NULL, name TEXT NOT NULL,
        total_salary INTEGER NOT NULL, projected_points REAL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (slate_id) REFERENCES slates(slate_id) ON DELETE CASCADE);
      CREATE TABLE lineup_players (id INTEGER PRIMARY KEY AUTOINCREMENT, lineup_id INTEGER NOT NULL,
        player_id INTEGER NOT NULL, position_slot TEXT NOT NULL,
        FOREIGN KEY (lineup_id) REFERENCES lineups(id) ON DELETE CASCADE,
        FOREIGN KEY (player_id) REFERENCES players(id) ON DELETE CASCADE);
      INSERT INTO slates (slate_id, name) VALUES ('s1', 'S1');
      INSERT INTO players (slate_id, player_id, name, team, opponent, position, salary, projected_points)
        VALUES ('s1', 'rw1', 'Luka Doncic', 'LAL', 'DAL', 'PG', 11000, 52.5);
      INSERT INTO lineups (slate_id, name, total_salary) VALUES ('s1', 'Old', 11000);
      INSERT INTO lineup_players (lineup_id, player_id, position_slot) VALUES (1, 1, 'PG');
    `);

    const { migrateLineupPersistence } = await import('../src/config/lineupMigrations.js');
    const wrap = {
      all: async (q, ...p) => legacy.prepare(q).all(...p),
      run: async (q, ...p) => legacy.prepare(q).run(...p),
      exec: async (q) => legacy.exec(q)
    };
    await migrateLineupPersistence(wrap);
    await migrateLineupPersistence(wrap);

    assert.deepEqual(legacy.pragma('foreign_key_list(lineups)'), []);
    assert.deepEqual(legacy.pragma('foreign_key_list(lineup_players)').map(f => f.table), ['lineups']);
    assert.equal(legacy.pragma('foreign_keys', { simple: true }), 1);

    const lp = legacy.prepare(`SELECT * FROM lineup_players`).get();
    assert.equal(lp.player_external_id, 'rw1');
    assert.equal(lp.name, 'Luka Doncic');
    assert.equal(lp.salary, 11000);
    assert.equal(lp.player_key, 'luka doncic');

    legacy.exec(`DELETE FROM players; DELETE FROM slates;`);
    assert.equal(legacy.prepare(`SELECT COUNT(*) AS n FROM lineups`).get().n, 1);
    assert.equal(legacy.prepare(`SELECT COUNT(*) AS n FROM lineup_players`).get().n, 1);

    legacy.exec(`DELETE FROM lineups`);
    assert.equal(legacy.prepare(`SELECT COUNT(*) AS n FROM lineup_players`).get().n, 0, 'deleting a lineup still cascades');
    legacy.close();
  });
});
