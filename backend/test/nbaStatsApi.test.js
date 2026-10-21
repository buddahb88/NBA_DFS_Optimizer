import { test, describe, vi, beforeAll as before, afterAll as after, beforeEach } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Every stats.nba.com call goes through this mock; tests never hit the network
const { axiosGet } = vi.hoisted(() => ({ axiosGet: vi.fn() }));
vi.mock('axios', () => ({ default: { get: axiosGet } }));

const resultSet = (name, headers, rows) => ({ name, headers, rowSet: rows });

const DASH_HEADERS = ['PLAYER_ID', 'PLAYER_NAME', 'TEAM_ID', 'TEAM_ABBREVIATION', 'GP', 'MIN'];
const INDEX_HEADERS = ['PERSON_ID', 'PLAYER_LAST_NAME', 'PLAYER_FIRST_NAME', 'TEAM_ABBREVIATION', 'POSITION', 'FROM_YEAR', 'TO_YEAR'];
const LOG_HEADERS = ['SEASON_ID', 'Player_ID', 'Game_ID', 'GAME_DATE', 'MATCHUP', 'WL', 'MIN', 'FGM', 'FGA', 'FG_PCT',
  'FG3M', 'FG3A', 'FG3_PCT', 'FTM', 'FTA', 'FT_PCT', 'OREB', 'DREB', 'REB', 'AST', 'STL', 'BLK', 'TOV', 'PF', 'PTS', 'PLUS_MINUS'];

// Newest first, as playergamelog returns them
const logRow = (gameId, date, matchup, o = {}) => [
  '22024', 1, gameId, date, matchup, 'W', o.min ?? 30, 8, 16, 0.5, 2, 5, 0.4, 4, 5, 0.8, 1, 5, 6, 4, 1, 0, 2, o.pf ?? 3, o.pts ?? 22, 5
];

const SEASON = '2023-24';
const PLAYERS = {
  dash: resultSet('LeagueDashPlayerStats', DASH_HEADERS, [
    [101, 'Kevin Durant', 1610612756, 'PHX', 2, 1000],
    [102, 'Nikola Jokić', 1610612743, 'DEN', 1, 900],
  ]),
  index: resultSet('PlayerIndex', INDEX_HEADERS, [
    [101, 'Durant', 'Kevin', 'HOU', 'F', '2007', '2025'],
    [102, 'Jokić', 'Nikola', 'DEN', 'C', '2015', '2025'],
    [999, 'Retired', 'Someone', null, 'G', '2000', '2010'],
  ]),
  logs: {
    101: resultSet('PlayerGameLog', LOG_HEADERS, [
      logRow('0022300050', 'NOV 02, 2023', 'PHO vs. BRK', { pts: 30 }),
      logRow('0022300040', 'NOV 01, 2023', 'PHO @ GSW', { pf: 5 }),
    ]),
    102: resultSet('PlayerGameLog', LOG_HEADERS, [
      logRow('0022300041', 'Nov 01, 2023', 'DEN vs. LAL'),
    ]),
  },
};

function mockStatsApi() {
  axiosGet.mockImplementation(async (url, { params }) => {
    if (url.endsWith('/leaguedashplayerstats')) return { data: { resultSets: [PLAYERS.dash] } };
    if (url.endsWith('/playerindex')) return { data: { resultSets: [PLAYERS.index] } };
    if (url.endsWith('/playergamelog')) return { data: { resultSets: [PLAYERS.logs[params.PlayerID]] } };
    throw new Error(`unexpected request ${url}`);
  });
}

const callsTo = endpoint => axiosGet.mock.calls.filter(([url]) => url.endsWith(`/${endpoint}`));

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nba-dfs-statsapi-'));
let db;
let svc;

before(async () => {
  process.env.DATABASE_TYPE = 'sqlite';
  process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');
  db = (await import('../src/config/database.js')).default;
  await (await import('../src/config/schema.js')).createTables(db);
  svc = (await import('../src/services/nbaStatsService.js')).default;
  svc.requestDelay = 0;
});

after(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(async () => {
  axiosGet.mockReset();
  mockStatsApi();
  await db.run(`DELETE FROM historical_games`);
});

describe('fetchAllPlayers', () => {
  test('requests the given season, not a hardcoded one', async () => {
    await svc.fetchAllPlayers(SEASON);
    for (const endpoint of ['leaguedashplayerstats', 'playerindex']) {
      const calls = callsTo(endpoint);
      assert.equal(calls.length, 1, endpoint);
      assert.equal(calls[0][1].params.Season, SEASON, endpoint);
    }
  });

  test('returns players who played that season with position and games played', async () => {
    const players = await svc.fetchAllPlayers(SEASON);
    assert.deepEqual(players, [
      { id: 101, name: 'Kevin Durant', team: 'PHX', position: 'F', gamesPlayed: 2 },
      { id: 102, name: 'Nikola Jokić', team: 'DEN', position: 'C', gamesPlayed: 1 },
    ]);
  });

  test('positions are optional when the player index call fails', async () => {
    axiosGet.mockImplementation(async url => {
      if (url.endsWith('/leaguedashplayerstats')) return { data: { resultSets: [PLAYERS.dash] } };
      throw new Error('blocked');
    });
    const players = await svc.fetchAllPlayers(SEASON);
    assert.deepEqual(players.map(p => p.position), [null, null]);
  });
});

describe('fetchPlayerGameLog', () => {
  test('parses shooting percentages, fouls and dates', async () => {
    const games = await svc.fetchPlayerGameLog(101, 'Kevin Durant', SEASON);
    assert.equal(games.length, 2);
    const g = games.find(x => x.game_id === '0022300040');
    assert.equal(g.game_date, '2023-11-01');
    assert.equal(g.season, SEASON);
    assert.equal(g.team, 'PHO');
    assert.equal(g.opponent, 'GSW');
    assert.equal(g.is_home, 0);
    assert.equal(g.fouls, 5);
    assert.equal(g.fg_pct, 0.5);
    assert.equal(g.fg3_pct, 0.4);
    assert.equal(g.ft_pct, 0.8);
    assert.equal(g.minutes, 30);
  });
});

describe('calculateRestDays', () => {
  const games = [{ game_date: '2023-11-05' }, { game_date: '2023-11-02' }, { game_date: '2023-11-03' }];

  test('uses the previous game already in the DB for the first fetched game', () => {
    const sorted = svc.calculateRestDays(games, '2023-11-01');
    assert.deepEqual(sorted.map(g => [g.game_date, g.rest_days, g.is_back_to_back]), [
      ['2023-11-02', 0, 1],
      ['2023-11-03', 0, 1],
      ['2023-11-05', 1, 0],
    ]);
  });

  test('falls back to 3 rest days when there is no previous game', () => {
    const [first] = svc.calculateRestDays(games, null);
    assert.equal(first.rest_days, 3);
    assert.equal(first.is_back_to_back, 0);
  });
});

describe('getPreviousGameDate', () => {
  test('returns the latest DB game before the given date for the player_key', async () => {
    await svc.bulkInsertGames([
      { player_id: '101', game_id: 'a', player_name: 'Kevin Durant', team: 'PHX', opponent: 'LAL', game_date: '2023-10-25', season: SEASON, is_home: 1 },
      { player_id: '101', game_id: 'b', player_name: 'Kevin Durant', team: 'PHX', opponent: 'LAL', game_date: '2023-10-31', season: SEASON, is_home: 1 },
      { player_id: '101', game_id: 'c', player_name: 'Kevin Durant', team: 'PHX', opponent: 'LAL', game_date: '2023-11-10', season: SEASON, is_home: 1 },
    ]);
    assert.equal(await svc.getPreviousGameDate('Kevin Durant', '2023-11-01'), '2023-10-31');
    assert.equal(await svc.getPreviousGameDate('Kevin Durant', '2023-10-25'), null);
    assert.equal(await svc.getPreviousGameDate('Nobody', '2023-11-01'), null);
  });
});

describe('fetchSeasonGameLogs', () => {
  test('stores canonical rows with stats, position and DB-aware rest days', async () => {
    // Durant's previous game (Oct 31) came from an earlier sync
    await svc.bulkInsertGames([
      { player_id: '101', game_id: 'prev', player_name: 'Kevin Durant', team: 'PHX', opponent: 'LAL', game_date: '2023-10-31', season: SEASON, is_home: 1 },
    ]);

    const result = await svc.fetchSeasonGameLogs(SEASON);
    assert.equal(result.players, 2);
    assert.equal(result.games, 3);
    assert.equal(result.skipped, 0);

    const rows = await db.all(`
      SELECT game_date, team, opponent, player_key, position, fouls, fg_pct, fg3_pct, ft_pct, rest_days, is_back_to_back
      FROM historical_games WHERE player_id = '101' AND game_id != 'prev' ORDER BY game_date`);
    assert.deepEqual(rows.map(r => ({ ...r })), [
      { game_date: '2023-11-01', team: 'PHX', opponent: 'GSW', player_key: 'kevin durant', position: 'F', fouls: 5,
        fg_pct: 0.5, fg3_pct: 0.4, ft_pct: 0.8, rest_days: 0, is_back_to_back: 1 },
      { game_date: '2023-11-02', team: 'PHX', opponent: 'BKN', player_key: 'kevin durant', position: 'F', fouls: 3,
        fg_pct: 0.5, fg3_pct: 0.4, ft_pct: 0.8, rest_days: 0, is_back_to_back: 1 },
    ]);
  });

  test('skipComplete skips players whose season games are all stored', async () => {
    await svc.fetchSeasonGameLogs(SEASON);
    axiosGet.mockClear();

    const progress = [];
    const result = await svc.fetchSeasonGameLogs(SEASON, p => progress.push(p), { skipComplete: true });

    assert.equal(callsTo('playergamelog').length, 0);
    assert.deepEqual({ players: result.players, games: result.games, skipped: result.skipped }, { players: 2, games: 0, skipped: 2 });
    assert.deepEqual(progress.at(-1), { processed: 2, total: 2, games: 0, skipped: 2 });
  });

  test('skipComplete refetches players with games missing', async () => {
    await svc.fetchSeasonGameLogs(SEASON);
    await db.run(`DELETE FROM historical_games WHERE player_id = '101' AND game_date = '2023-11-02'`);
    axiosGet.mockClear();

    const result = await svc.fetchSeasonGameLogs(SEASON, null, { skipComplete: true });
    assert.deepEqual(callsTo('playergamelog').map(([, { params }]) => params.PlayerID), [101]);
    assert.equal(result.skipped, 1);
    assert.equal(result.games, 2);
  });
});

describe('fetchIncrementalGameLogs', () => {
  test('only inserts games after lastDate and computes rest from the DB', async () => {
    await svc.bulkInsertGames([
      { player_id: '101', game_id: '0022300040', player_name: 'Kevin Durant', team: 'PHX', opponent: 'GSW', game_date: '2023-11-01', season: SEASON, is_home: 0 },
    ]);

    const result = await svc.fetchIncrementalGameLogs(SEASON, '2023-11-01');
    assert.deepEqual({ players: result.players, games: result.games }, { players: 2, games: 1 });

    const row = await db.get(`SELECT rest_days, is_back_to_back FROM historical_games WHERE game_date = '2023-11-02'`);
    assert.deepEqual({ ...row }, { rest_days: 0, is_back_to_back: 1 });
  });
});
