import { test, describe, beforeAll as before, afterAll as after } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { playerKey, canonicalTeam } from '../src/utils/playerKey.js';

describe('playerKey', () => {
  test('strips diacritics', () => {
    assert.equal(playerKey('Luka Dončić'), playerKey('Luka Doncic'));
    assert.equal(playerKey('Nikola Jokić'), 'nikola jokic');
    assert.equal(playerKey('Jusuf Nurkić'), playerKey('Jusuf Nurkic'));
  });

  test('lowercases and trims', () => {
    assert.equal(playerKey('  LeBron   James '), 'lebron james');
  });

  test('strips punctuation', () => {
    assert.equal(playerKey("De'Aaron Fox"), playerKey('DeAaron Fox'));
    assert.equal(playerKey('P.J. Washington'), playerKey('PJ Washington'));
    assert.equal(playerKey('Karl-Anthony Towns'), playerKey('Karl Anthony Towns'));
  });

  test('strips Jr./Sr./II/III/IV suffixes', () => {
    assert.equal(playerKey('Jaren Jackson Jr.'), playerKey('Jaren Jackson'));
    assert.equal(playerKey('Jaren Jackson Jr'), 'jaren jackson');
    assert.equal(playerKey('Gary Payton II'), 'gary payton');
    assert.equal(playerKey('Robert Williams III'), playerKey('Robert Williams'));
    assert.equal(playerKey('Marvin Bagley III'), 'marvin bagley');
    assert.equal(playerKey('Larry Nance Sr.'), 'larry nance');
    assert.equal(playerKey('Some Player IV'), 'some player');
  });

  test('shared last names stay distinct', () => {
    const williams = ['Jalen Williams', 'Jaylin Williams', 'Mark Williams', 'Robert Williams III', 'Grant Williams']
      .map(playerKey);
    assert.equal(new Set(williams).size, williams.length);
  });

  test('empty input yields empty key', () => {
    assert.equal(playerKey(null), '');
    assert.equal(playerKey(''), '');
  });
});

describe('canonicalTeam', () => {
  test('collapses site/feed aliases to one code', () => {
    const pairs = [
      ['BRK', 'BKN'], ['BKN', 'BKN'],
      ['CHO', 'CHA'], ['CHA', 'CHA'],
      ['PHO', 'PHX'], ['PHX', 'PHX'],
      ['NO', 'NOP'], ['NOP', 'NOP'],
      ['GS', 'GSW'], ['GSW', 'GSW'],
      ['SA', 'SAS'], ['SAS', 'SAS'],
      ['NY', 'NYK'], ['NYK', 'NYK'],
      ['UTAH', 'UTA'], ['WSH', 'WAS']
    ];
    for (const [alias, canonical] of pairs) {
      assert.equal(canonicalTeam(alias), canonical, alias);
    }
  });

  test('is case/whitespace insensitive and passes unknown codes through', () => {
    assert.equal(canonicalTeam(' pho '), 'PHX');
    assert.equal(canonicalTeam('lal'), 'LAL');
    assert.equal(canonicalTeam('BOS'), 'BOS');
  });

  test('missing team stays null', () => {
    assert.equal(canonicalTeam(null), null);
    assert.equal(canonicalTeam(''), null);
  });
});

describe('historical_games player_key migration and inserts', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nba-dfs-playerkey-'));
  const dbPath = path.join(tmpDir, 'test.db');
  let db;
  let createTables;
  let migratePlayerKey;
  let nbaStatsService;

  before(async () => {
    // Pre-migration historical_games (no player_key) with existing rows
    const seed = new Database(dbPath);
    seed.exec(`
      CREATE TABLE historical_games (
        id INTEGER PRIMARY KEY AUTOINCREMENT, player_id TEXT, player_name TEXT NOT NULL,
        team TEXT NOT NULL, opponent TEXT NOT NULL, position TEXT, game_id TEXT, game_date DATE NOT NULL,
        season TEXT, is_home INTEGER DEFAULT 0, minutes REAL, points INTEGER, rebounds INTEGER,
        assists INTEGER, steals INTEGER, blocks INTEGER, turnovers INTEGER, fouls INTEGER, fg_made INTEGER,
        fg_attempted INTEGER, fg_pct REAL, fg3_made INTEGER, fg3_attempted INTEGER, fg3_pct REAL,
        ft_made INTEGER, ft_attempted INTEGER, ft_pct REAL,
        oreb INTEGER, dreb INTEGER, plus_minus INTEGER, usg_pct REAL, dk_fantasy_points REAL, rest_days INTEGER,
        is_back_to_back INTEGER DEFAULT 0, UNIQUE(player_name, team, game_date));
      INSERT INTO historical_games (player_name, team, opponent, game_date) VALUES
        ('Luka Dončić', 'LAL', 'GSW', '2026-04-01'),
        ('Jaren Jackson Jr.', 'MEM', 'NOP', '2026-04-01'),
        ('Jalen Williams', 'OKC', 'PHX', '2026-04-01'),
        ('Jaylin Williams', 'OKC', 'PHX', '2026-04-01');
    `);
    seed.close();

    process.env.DATABASE_TYPE = 'sqlite';
    process.env.DATABASE_PATH = dbPath;
    db = (await import('../src/config/database.js')).default;
    ({ createTables } = await import('../src/config/schema.js'));
    ({ migratePlayerKey } = await import('../src/config/playerKeyMigrations.js'));
    nbaStatsService = (await import('../src/services/nbaStatsService.js')).default;
    await createTables(db);
  });

  after(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('backfills player_key for existing rows', async () => {
    const rows = await db.all(`SELECT player_name, player_key FROM historical_games ORDER BY id`);
    assert.deepEqual(rows.map(r => r.player_key), ['luka doncic', 'jaren jackson', 'jalen williams', 'jaylin williams']);
  });

  test('creates composite indexes', async () => {
    const indexes = await db.all(`PRAGMA index_list(historical_games)`);
    const cols = {};
    for (const { name } of indexes) {
      cols[name] = (await db.all(`PRAGMA index_info(${name})`)).map(c => c.name);
    }
    const composites = Object.values(cols).map(c => c.join(','));
    assert.ok(composites.includes('player_key,game_date'), composites.join(' | '));
    assert.ok(composites.includes('team,game_date'), composites.join(' | '));
    assert.ok(composites.includes('opponent,game_date'), composites.join(' | '));
  });

  test('migration is idempotent and only fills missing keys', async () => {
    await db.run(`UPDATE historical_games SET player_key = 'custom' WHERE player_name = 'Jalen Williams'`);
    await db.run(`INSERT INTO historical_games (player_name, team, opponent, game_date) VALUES ('Gary Payton II', 'GSW', 'LAL', '2026-04-02')`);
    await migratePlayerKey(db);
    await migratePlayerKey(db);
    assert.equal((await db.get(`SELECT player_key FROM historical_games WHERE player_name = 'Jalen Williams'`)).player_key, 'custom');
    assert.equal((await db.get(`SELECT player_key FROM historical_games WHERE player_name = 'Gary Payton II'`)).player_key, 'gary payton');
  });

  test('insertGameFromBoxScore sets player_key and canonical teams', async () => {
    const inserted = await nbaStatsService.insertGameFromBoxScore({
      player_name: 'Nikola Vučević', team: 'CHO', opponent: 'BRK', game_date: '2026-10-21', is_home: 1, points: 10
    });
    assert.equal(inserted, true);
    const row = await db.get(`SELECT team, opponent, player_key FROM historical_games WHERE game_date = '2026-10-21'`);
    assert.deepEqual({ ...row }, { team: 'CHA', opponent: 'BKN', player_key: 'nikola vucevic' });
  });

  test('insertGameFromBoxScore canonicalizes full team names', async () => {
    await nbaStatsService.insertGameFromBoxScore({
      player_name: 'Stephen Curry', team: 'Golden State Warriors', opponent: 'Phoenix Suns', game_date: '2026-10-22', points: 30
    });
    const row = await db.get(`SELECT team, opponent FROM historical_games WHERE game_date = '2026-10-22'`);
    assert.deepEqual({ ...row }, { team: 'GSW', opponent: 'PHX' });
  });

  test('bulkInsertGames sets player_key and canonical teams', async () => {
    const inserted = await nbaStatsService.bulkInsertGames([
      { player_id: '1', game_id: 'g1', player_name: 'Kelly Oubre Jr.', team: 'PHO', opponent: 'SA', game_date: '2026-10-23', season: '2026-27', is_home: 0, points: 12 },
      { player_id: '2', game_id: 'g1', player_name: 'Zion Williamson', team: 'NO', opponent: 'NY', game_date: '2026-10-23', season: '2026-27', is_home: 1, points: 25 }
    ]);
    assert.equal(inserted, 2);
    const rows = await db.all(`SELECT player_key, team, opponent FROM historical_games WHERE game_date = '2026-10-23' ORDER BY player_id`);
    assert.deepEqual(rows.map(r => ({ ...r })), [
      { player_key: 'kelly oubre', team: 'PHX', opponent: 'SAS' },
      { player_key: 'zion williamson', team: 'NOP', opponent: 'NYK' }
    ]);
  });

  test('service normalizeName uses playerKey', () => {
    assert.equal(nbaStatsService.normalizeName('Jaren Jackson Jr.'), 'jaren jackson');
    assert.equal(nbaStatsService.normalizeName('Luka Dončić'), 'luka doncic');
  });
});
