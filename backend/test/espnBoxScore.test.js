import { test, describe, vi, beforeAll as before, afterAll as after, beforeEach } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

// Every ESPN call goes through this mock; tests never hit the network
const { axiosGet } = vi.hoisted(() => ({ axiosGet: vi.fn() }));
vi.mock('axios', () => ({ default: { get: axiosGet } }));

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/espn');
const readFixture = name => JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8'));

// Live responses saved 2026-10-21: scoreboard for 2025-01-15 and the
// NY @ PHI overtime game (event 401705127) from that date
const SCOREBOARD = readFixture('scoreboard-20250115.json');
const SUMMARY = readFixture('summary-401705127.json');
const GAME_ID = '401705127';
const DATE = '2025-01-15';

const clone = obj => JSON.parse(JSON.stringify(obj));
const athletes = (summary, teamIndex) => summary.boxscore.players[teamIndex].statistics[0].athletes;
const httpError = status => Object.assign(new Error(`HTTP ${status}`), { response: { status } });

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nba-dfs-espn-'));
let db;
let schema;
let espn;
let parseScoreboard;
let parseSummary;

before(async () => {
  process.env.DATABASE_TYPE = 'sqlite';
  process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');
  db = (await import('../src/config/database.js')).default;
  schema = await import('../src/config/schema.js');
  await schema.createTables(db);
  const mod = await import('../src/services/espnBoxScoreService.js');
  espn = mod.default;
  parseScoreboard = mod.parseScoreboard;
  parseSummary = mod.parseSummary;
  espn.requestDelay = 0;
  espn.retryBaseDelay = 0;
});

after(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(async () => {
  axiosGet.mockReset();
  for (const table of ['historical_games', 'team_game_stats', 'game_player_status']) {
    await db.run(`DELETE FROM ${table}`);
  }
});

const game = (overrides = {}) => ({ ...parseScoreboard(SCOREBOARD, DATE).find(g => g.game_id === GAME_ID), ...overrides });
const parsed = (summary = SUMMARY, meta = game()) => parseSummary(summary, meta);
const playerRow = (name, p = parsed()) => p.players.find(r => r.player_name === name);

describe('parseScoreboard', () => {
  test('lists every completed regular-season game on the queried date', () => {
    const games = parseScoreboard(SCOREBOARD, DATE);
    assert.equal(games.length, 11);
    assert.ok(games.every(g => g.season_type === 'regular' && g.season === '2024-25'));
  });

  test('game_date is the queried (US) date, not the UTC start time', () => {
    // 401705127 starts 2025-01-16T00:00Z, i.e. 7pm ET on the 15th
    assert.equal(game().game_date, DATE);
  });

  test('maps ESPN team codes to canonical NBA codes', () => {
    const teams = parseScoreboard(SCOREBOARD, DATE).flatMap(g => [g.home_team, g.away_team]);
    for (const code of ['NYK', 'GSW', 'NOP', 'SAS', 'UTA', 'BKN']) assert.ok(teams.includes(code), code);
    for (const code of ['NY', 'GS', 'NO', 'SA', 'UTAH']) assert.ok(!teams.includes(code), code);
    assert.deepEqual([game().home_team, game().away_team], ['PHI', 'NYK']);
  });

  test('skips unfinished, preseason and All-Star games; flags play-in and playoffs', () => {
    const sb = clone(SCOREBOARD);
    const [scheduled, preseason, allStar, playIn, playoff] = sb.events;
    scheduled.status.type.completed = false;
    preseason.season.type = 1;
    allStar.competitions[0].type = { id: '4', abbreviation: 'ALLSTAR' };
    playIn.season.type = 5;
    playoff.season.type = 3;

    const byId = Object.fromEntries(parseScoreboard(sb, DATE).map(g => [g.game_id, g]));
    assert.equal(Object.keys(byId).length, 8);
    for (const e of [scheduled, preseason, allStar]) assert.equal(byId[e.id], undefined);
    assert.equal(byId[playIn.id].season_type, 'play-in');
    assert.equal(byId[playoff.id].season_type, 'playoffs');
  });

  test('skips games involving non-NBA teams', () => {
    const sb = clone(SCOREBOARD);
    sb.events[0].competitions[0].competitors[0].team.abbreviation = 'RMD';
    assert.equal(parseScoreboard(sb, DATE).length, 10);
  });
});

describe('parseSummary players', () => {
  test('one row per player who played; DNP players get no stat line', () => {
    const p = parsed();
    assert.equal(p.players.length, 17); // 8 NYK + 9 PHI
    assert.equal(playerRow('Matt Ryan'), undefined);
    assert.equal(playerRow('Andre Drummond'), undefined);
  });

  test('parses a full stat line', () => {
    const r = playerRow('Jalen Brunson');
    assert.deepEqual(
      {
        game_id: r.game_id, game_date: r.game_date, season: r.season, season_type: r.season_type,
        espn_player_id: r.espn_player_id, player_id: r.player_id, position: r.position, is_starter: r.is_starter,
        team: r.team, opponent: r.opponent, is_home: r.is_home, minutes: r.minutes,
        points: r.points, rebounds: r.rebounds, assists: r.assists, steals: r.steals, blocks: r.blocks,
        turnovers: r.turnovers, fouls: r.fouls, oreb: r.oreb, dreb: r.dreb, plus_minus: r.plus_minus,
        fg_made: r.fg_made, fg_attempted: r.fg_attempted, fg_pct: r.fg_pct,
        fg3_made: r.fg3_made, fg3_attempted: r.fg3_attempted, fg3_pct: r.fg3_pct,
        ft_made: r.ft_made, ft_attempted: r.ft_attempted, ft_pct: r.ft_pct,
        ts_pct: r.ts_pct, efg_pct: r.efg_pct,
      },
      {
        game_id: GAME_ID, game_date: DATE, season: '2024-25', season_type: 'regular',
        espn_player_id: '3934672', player_id: null, position: 'G', is_starter: 1,
        team: 'NYK', opponent: 'PHI', is_home: 0, minutes: 45,
        points: 38, rebounds: 5, assists: 4, steals: 2, blocks: 0,
        turnovers: 5, fouls: 1, oreb: 1, dreb: 4, plus_minus: 7,
        fg_made: 14, fg_attempted: 22, fg_pct: 0.636,
        fg3_made: 3, fg3_attempted: 6, fg3_pct: 0.5,
        ft_made: 7, ft_attempted: 9, ft_pct: 0.778,
        ts_pct: 0.732, efg_pct: 0.705,
      }
    );
  });

  test('computes DK, FD and Yahoo fantasy points', () => {
    const r = playerRow('Jalen Brunson');
    // 38 + 3*0.5 + 5*1.25 + 4*1.5 + 2*2 - 5*0.5
    assert.equal(r.dk_fantasy_points, 53.25);
    // 38 + 5*1.2 + 4*1.5 + 2*3 - 5
    assert.equal(r.fd_fantasy_points, 51);
    assert.equal(typeof r.yahoo_fantasy_points, 'number');
  });

  test('triple-double bonus (Josh Hart 10 pts / 17 reb / 12 ast)', () => {
    const r = playerRow('Josh Hart');
    // 10 + 17*1.25 + 12*1.5 + 4*2 - 3*0.5 + 1.5 (DD) + 3 (TD)
    assert.equal(r.dk_fantasy_points, 60.25);
  });

  test('keeps overtime minutes (Josh Hart played 49 of 265)', () => {
    assert.equal(playerRow('Josh Hart').minutes, 49);
    assert.equal(playerRow('Paul George').is_home, 1);
    assert.equal(playerRow('Precious Achiuwa').is_starter, 0);
  });

  test('negative plus/minus and zero-attempt percentages', () => {
    const r = playerRow('Jericho Sims');
    assert.equal(r.plus_minus, -3);
    assert.equal(r.fg3_attempted, 0);
    assert.equal(r.fg3_pct, null);
  });

  test('player_key strips suffixes and diacritics', () => {
    const s = clone(SUMMARY);
    athletes(s, 0).find(a => a.athlete.displayName === 'Jalen Brunson').athlete.displayName = 'Luka Dončić';
    const p = parsed(s);
    const luka = playerRow('Luka Dončić', p);
    assert.equal(luka.player_key, 'luka doncic');
    assert.equal(playerRow('Kelly Oubre Jr.', p).player_key, 'kelly oubre');
    assert.equal(playerRow('Ricky Council IV', p).player_key, 'ricky council');
  });

  test('a player listed as playing but with no stats counts as DNP', () => {
    const s = clone(SUMMARY);
    const sims = athletes(s, 0).find(a => a.athlete.displayName === 'Jericho Sims');
    sims.stats = [];
    const p = parsed(s);
    assert.equal(playerRow('Jericho Sims', p), undefined);
    assert.equal(p.statuses.find(st => st.player_name === 'Jericho Sims').status, 'DNP');
  });
});

describe('parseSummary statuses', () => {
  test('records DNP (coach) and inactive (injury) players', () => {
    const { statuses } = parsed();
    assert.equal(statuses.length, 8);
    const ryan = statuses.find(s => s.player_name === 'Matt Ryan');
    assert.deepEqual(ryan, {
      game_id: GAME_ID, game_date: DATE, team: 'NYK', player_key: 'matt ryan',
      player_name: 'Matt Ryan', espn_player_id: '3908336', status: 'DNP', reason: "COACH'S DECISION",
    });
    const drummond = statuses.find(s => s.player_name === 'Andre Drummond');
    assert.equal(drummond.team, 'PHI');
    assert.equal(drummond.status, 'INACTIVE');
    assert.equal(drummond.reason, 'SPRAINED LEFT TOE');
  });
});

describe('parseSummary team totals', () => {
  test('one row per team with box score totals and a possession estimate', () => {
    const { teams, players } = parsed();
    assert.equal(teams.length, 2);
    const nyk = teams.find(t => t.team === 'NYK');
    assert.deepEqual(nyk, {
      game_id: GAME_ID, game_date: DATE, season: '2024-25', season_type: 'regular',
      team: 'NYK', opponent: 'PHI', is_home: 0, minutes: 265,
      pts: 125, fgm: 46, fga: 86, fg3m: 16, fg3a: 37, ftm: 17, fta: 24,
      oreb: 15, dreb: 30, ast: 28, tov: 16, stl: 10, blk: 3, pf: 14,
      // fga - oreb + tov + 0.44 * fta (tov includes 3 team turnovers)
      possessions: 97.6,
    });
    const sum = col => players.filter(p => p.team === 'NYK').reduce((s, p) => s + p[col], 0);
    assert.equal(sum('points'), nyk.pts);
    assert.equal(sum('fg_attempted'), nyk.fga);
    assert.equal(sum('oreb'), nyk.oreb);

    const phi = teams.find(t => t.team === 'PHI');
    assert.equal(phi.pts, 119);
    assert.equal(phi.is_home, 1);
    assert.equal(phi.opponent, 'NYK');
    assert.equal(phi.tov, 12);
  });

  // Seen live: 401704652 totals said 97/91 for a 105-103 final
  test('wrong ESPN team totals fall back to the player sums when those match the final score', () => {
    const s = clone(SUMMARY);
    const totals = s.boxscore.players[0].statistics[0].totals;
    totals[1] = '117'; // points
    totals[2] = '40-80'; // FG
    const nyk = parsed(s).teams.find(t => t.team === 'NYK');
    assert.equal(nyk.pts, 125);
    assert.equal(nyk.fgm, 46);
    assert.equal(nyk.fga, 86);
    // Team turnovers aren't in player lines; still from team stats
    assert.equal(nyk.tov, 16);
  });

  // Seen live: 401810560 listed a CHI player with no id/name and '--' stats
  test('a player line missing from the box keeps ESPN team totals', () => {
    const s = clone(SUMMARY);
    const list = athletes(s, 0);
    list.splice(list.findIndex(a => a.athlete.displayName === 'Jalen Brunson'), 1);
    const nyk = parsed(s).teams.find(t => t.team === 'NYK');
    assert.equal(nyk.pts, 125);
    assert.equal(nyk.fga, 86);
  });

  test('regulation games are 240 team minutes', () => {
    const s = clone(SUMMARY);
    for (const c of s.header.competitions[0].competitors) c.linescores = c.linescores.slice(0, 4);
    assert.equal(parsed(s).teams[0].minutes, 240);
  });
});

const count = async (table, where = '1=1', ...params) =>
  (await db.get(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`, ...params)).n;

describe('saveGame', () => {
  test('writes players, team stats and statuses', async () => {
    await espn.saveGame(parsed());
    assert.equal(await count('historical_games'), 17);
    assert.equal(await count('team_game_stats'), 2);
    assert.equal(await count('game_player_status'), 8);
    const row = await db.get(`SELECT * FROM historical_games WHERE player_key = 'jalen brunson'`);
    assert.equal(row.espn_player_id, '3934672');
    assert.equal(row.is_starter, 1);
    assert.equal(row.season_type, 'regular');
    assert.equal(row.ts_pct, 0.732);
    assert.equal(row.dk_fantasy_points, 53.25);
    assert.equal(row.fd_fantasy_points, 51);
  });

  test('rerunning the same game is idempotent', async () => {
    await espn.saveGame(parsed());
    await espn.saveGame(parsed());
    assert.equal(await count('historical_games'), 17);
    assert.equal(await count('team_game_stats'), 2);
    assert.equal(await count('game_player_status'), 8);
  });

  test('upserts on (player_key, game_date), replacing another source\'s spelling', async () => {
    await db.run(
      `INSERT INTO historical_games (player_name, player_key, team, opponent, game_date, season, points, usg_pct)
       VALUES ('Kelly Oubre', 'kelly oubre', 'PHI', 'NYK', ?, '2024-25', 1, 0.21)`, DATE);
    await espn.saveGame(parsed());
    const rows = await db.all(`SELECT * FROM historical_games WHERE player_key = 'kelly oubre' AND game_date = ?`, DATE);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].player_name, 'Kelly Oubre Jr.');
    assert.equal(rows[0].points, 16);
    // Columns ESPN doesn't supply survive the update
    assert.equal(rows[0].usg_pct, 0.21);
  });
});

describe('rest days', () => {
  test('back-to-back against the previous stored game', async () => {
    await espn.saveGame(parsed(SUMMARY, game({ game_date: '2025-01-14' })));
    await espn.saveGame(parsed());
    const row = await db.get(`SELECT rest_days, is_back_to_back FROM historical_games WHERE player_key = 'jalen brunson' AND game_date = ?`, DATE);
    assert.deepEqual({ ...row }, { rest_days: 0, is_back_to_back: 1 });
  });

  test('a season opener is measured against the prior season\'s last game', async () => {
    await espn.saveGame(parsed(SUMMARY, game({ game_date: '2025-04-13', season: '2024-25' })));
    const opener = parsed(SUMMARY, game({ game_date: '2025-10-21', season: '2025-26' }));
    assert.equal(opener.players[0].season, '2025-26');
    await espn.saveGame(opener);
    const row = await db.get(`SELECT season, rest_days, is_back_to_back FROM historical_games WHERE player_key = 'jalen brunson' AND game_date = '2025-10-21'`);
    assert.deepEqual({ ...row }, { season: '2025-26', rest_days: 190, is_back_to_back: 0 });
  });

  test('previous games from other sources count (matched by player_key)', async () => {
    await db.run(
      `INSERT INTO historical_games (player_name, player_key, team, opponent, game_date, season)
       VALUES ('Jalen Brunson', 'jalen brunson', 'NYK', 'BOS', '2025-01-12', '2024-25')`);
    await espn.saveGame(parsed());
    const row = await db.get(`SELECT rest_days FROM historical_games WHERE player_key = 'jalen brunson' AND game_date = ?`, DATE);
    assert.equal(row.rest_days, 2);
  });
});

// Scoreboard with only the fixture game, so syncs fetch one summary
function mockEspn({ summary = async () => ({ data: SUMMARY }) } = {}) {
  const sb = clone(SCOREBOARD);
  sb.events = sb.events.filter(e => e.id === GAME_ID);
  axiosGet.mockImplementation(async (url, opts) => {
    if (url.includes('/scoreboard')) {
      return { data: opts.params.dates === '20250115' ? sb : { events: [] } };
    }
    if (url.includes('/summary')) return summary(opts.params.event);
    throw new Error(`unexpected request ${url}`);
  });
}
const summaryCalls = () => axiosGet.mock.calls.filter(([url]) => url.includes('/summary'));

describe('syncDates', () => {
  test('walks each date, queries the scoreboard by YYYYMMDD and loads games', async () => {
    mockEspn();
    const result = await espn.syncDates('2025-01-14', '2025-01-16');
    const dates = axiosGet.mock.calls.filter(([url]) => url.includes('/scoreboard')).map(([, o]) => o.params.dates);
    assert.deepEqual(dates, ['20250114', '20250115', '20250116']);
    assert.equal(result.games, 1);
    assert.equal(result.rows, 17);
    assert.deepEqual(result.failed, []);
    assert.equal(await count('historical_games'), 17);
  });

  test('a rerun skips games that are already fully loaded', async () => {
    mockEspn();
    await espn.syncDates(DATE, DATE);
    axiosGet.mockClear();
    const result = await espn.syncDates(DATE, DATE);
    assert.equal(summaryCalls().length, 0);
    assert.equal(result.skipped, 1);
    assert.equal(result.games, 0);
  });

  test('skipLoaded: false refetches loaded games', async () => {
    mockEspn();
    await espn.syncDates(DATE, DATE);
    axiosGet.mockClear();
    await espn.syncDates(DATE, DATE, { skipLoaded: false });
    assert.equal(summaryCalls().length, 1);
    assert.equal(await count('historical_games'), 17);
  });

  test('retries transient errors with backoff', async () => {
    let attempts = 0;
    mockEspn({
      summary: async () => {
        attempts++;
        if (attempts < 3) throw httpError(503);
        return { data: SUMMARY };
      }
    });
    const result = await espn.syncDates(DATE, DATE);
    assert.equal(attempts, 3);
    assert.equal(result.games, 1);
  });

  test('records failed games and keeps going', async () => {
    mockEspn({ summary: async () => { throw httpError(404); } });
    const result = await espn.syncDates(DATE, DATE);
    assert.equal(summaryCalls().length, 1); // 404 is not retried
    assert.equal(result.games, 0);
    assert.equal(result.failed.length, 1);
    assert.equal(result.failed[0].game_id, GAME_ID);
    assert.equal(result.failed[0].game_date, DATE);
    assert.match(result.failed[0].error, /404/);
  });

  test('reports progress', async () => {
    mockEspn();
    const events = [];
    await espn.syncDates(DATE, '2025-01-16', { onProgress: p => events.push(p) });
    const last = events.at(-1);
    assert.equal(last.datesProcessed, 2);
    assert.equal(last.totalDates, 2);
    assert.equal(last.games, 1);
  });
});

describe('seasonDateRange', () => {
  const today = new Date(2026, 9, 21); // 2026-10-21 local

  test('past seasons run from opening night through June 30', () => {
    assert.deepEqual(espn.seasonDateRange('2024-25', today), ['2024-10-22', '2025-06-30']);
  });

  test('the current season stops at yesterday', () => {
    assert.deepEqual(espn.seasonDateRange('2026-27', today), ['2026-10-20', '2026-10-20']);
  });

  test('a season that has not started yet has no dates', () => {
    assert.equal(espn.seasonDateRange('2027-28', today), null);
  });
});

describe('getStatus', () => {
  test('reports loaded games and the latest loaded date', async () => {
    await espn.saveGame(parsed());
    const status = await espn.getStatus();
    assert.equal(status.source, 'espn');
    assert.equal(status.loadedGames, 1);
    assert.equal(status.latestGameDate, DATE);
  });
});

describe('migration', () => {
  test('is idempotent and adds the ESPN columns and tables', async () => {
    await schema.createTables(db);
    const cols = new Set((await db.all(`PRAGMA table_info(historical_games)`)).map(c => c.name));
    for (const c of ['espn_player_id', 'is_starter', 'season_type']) assert.ok(cols.has(c), c);
    const tables = new Set((await db.all(`SELECT name FROM sqlite_master WHERE type = 'table'`)).map(t => t.name));
    assert.ok(tables.has('team_game_stats'));
    assert.ok(tables.has('game_player_status'));
  });
});
