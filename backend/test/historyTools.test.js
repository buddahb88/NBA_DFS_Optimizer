import { test, describe, beforeAll as before, afterAll as after } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

// Shared chat history tools (aiChatService + AnalystAgent): names resolve to
// player_key, averages are regular season / minutes > 0, "games without" uses
// the insights roster window.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nba-dfs-history-tools-'));
process.env.DATABASE_TYPE = 'sqlite';
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');

let db;
let playerKey;
let seasonForDate;
let resolvePlayer;
let tools;

const addDays = (date, n) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const d = (i) => addDays('2026-03-01', i);       // 2025-26
const jan = (i) => addDays('2026-01-05', 2 * i); // 2025-26, before Oubre joined PHI
const lastSeason = (i) => addDays('2025-02-01', 2 * i); // 2024-25
const gameId = (date, team, opp) => `${date}-${[team, opp].sort().join('-')}`;

async function game(name, team, opp, date, minutes, dk, { fd = dk, seasonType = 'regular', home = 1, points = Math.round(dk) } = {}) {
  await db.run(`
    INSERT INTO historical_games (player_name, player_key, team, opponent, game_id, game_date, season, season_type,
      is_home, minutes, points, rebounds, assists, dk_fantasy_points, fd_fantasy_points, yahoo_fantasy_points)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 5, 3, ?, ?, ?)
  `, name, playerKey(name), team, opp, gameId(date, team, opp), date, seasonForDate(date), seasonType,
  home, minutes, points, dk, fd, dk);
  for (const [t, o] of [[team, opp], [opp, team]]) {
    await db.run(`
      INSERT OR IGNORE INTO team_game_stats (game_id, game_date, season, season_type, team, opponent)
      VALUES (?, ?, ?, ?, ?, ?)
    `, gameId(date, team, opp), date, seasonForDate(date), seasonType, t, o);
  }
}

async function status(name, team, opp, date, value) {
  await db.run(`
    INSERT INTO game_player_status (game_id, game_date, team, player_key, player_name, status, reason)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `, gameId(date, team, opp), date, team, playerKey(name), name, value, value === 'DNP' ? "Coach's Decision" : 'Injury');
}

async function seed() {
  // Luka: ESPN spelling with the diacritic, one row with the DK spelling,
  // a playoff game and a minutes = 0 listing that must not count
  for (let i = 0; i < 6; i++) {
    await game(i === 5 ? 'Luka Doncic' : 'Luka Dončić', 'LAL', i < 2 ? 'BOS' : 'SAC', d(1 + 2 * i), 36, i < 2 ? 60 : 40, { fd: 50, home: i % 2 });
  }
  await game('Luka Dončić', 'LAL', 'SAC', d(13), 0, 0);
  await game('Luka Dončić', 'LAL', 'DEN', addDays('2026-04-25', 0), 40, 90, { seasonType: 'playoffs' });
  for (const i of [0, 1]) await game('Luka Dončić', 'DAL', 'BOS', lastSeason(i), 36, 70);

  // Jaren Jackson Jr. vs Reggie Jackson: same last name, different players
  for (let i = 0; i < 4; i++) {
    await game('Jaren Jackson Jr.', 'MEM', 'NOP', d(2 * i), 32, 40);
    await game('Reggie Jackson', 'MEM', 'NOP', d(2 * i), 15, 10);
  }

  // Hyphenated name
  for (let i = 0; i < 3; i++) await game('Shai Gilgeous-Alexander', 'OKC', 'UTA', d(2 * i), 34, 55);

  // PHI: Oubre is missing from the box score entirely (no game_player_status
  // rows except one DNP). P0..P13 in March, out for the season from P11.
  const P = Array.from({ length: 15 }, (_, i) => d(2 * i));
  const ABSENT = new Set([2, 5, 8]);
  for (const [i, date] of P.entries()) {
    const out = ABSENT.has(i) || i >= 11;
    if (!out || i === 12 || i === 13) await game('Kelly Oubre Jr.', 'PHI', 'ORL', date, 30, 18);
    await game('Tyrese Maxey', 'PHI', 'ORL', date, 36, i === 14 ? 30 : (out && i !== 12 && i !== 13) ? 15 : 10);
    await game('Paul George', 'PHI', 'ORL', date, 30, out && i !== 12 && i !== 13 ? 35 : 25);
  }
  await status('Kelly Oubre Jr.', 'PHI', 'ORL', P[11], 'DNP');
  // January: Oubre not on PHI yet; these must not count as "without"
  for (const i of [0, 1, 2]) await game('Tyrese Maxey', 'PHI', 'ORL', jan(i), 36, 50);
}

before(async () => {
  db = (await import('../src/config/database.js')).default;
  await (await import('../src/config/schema.js')).createTables(db);
  ({ playerKey } = await import('../src/utils/playerKey.js'));
  ({ seasonForDate } = await import('../src/utils/season.js'));
  const mod = await import('../src/services/chatTools/historyTools.js');
  resolvePlayer = mod.resolvePlayer;
  tools = new Map(mod.createHistoryTools().map(t => [t.name, t]));
  await seed();
});

after(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const run = (name, args) => tools.get(name).execute(args);

describe('resolvePlayer', () => {
  test('diacritics and plain spellings resolve to the same player_key', async () => {
    for (const name of ['Luka Doncic', 'Luka Dončić', 'luka doncic', '  LUKA  DONCIC ']) {
      const p = await resolvePlayer(name);
      assert.equal(p.found, true, name);
      assert.equal(p.key, 'luka doncic');
      assert.equal(p.team, 'LAL');
    }
  });

  test('Jr. suffix resolves and does not match a same-last-name teammate', async () => {
    for (const name of ['Jaren Jackson Jr.', 'Jaren Jackson Jr', 'Jaren Jackson']) {
      const p = await resolvePlayer(name);
      assert.equal(p.key, 'jaren jackson', name);
      assert.equal(p.name, 'Jaren Jackson Jr.');
    }
    assert.equal((await resolvePlayer('Reggie Jackson')).key, 'reggie jackson');
  });

  test('hyphenated names resolve with or without the hyphen', async () => {
    for (const name of ['Shai Gilgeous-Alexander', 'Shai Gilgeous Alexander']) {
      const p = await resolvePlayer(name);
      assert.equal(p.found, true, name);
      assert.equal(p.name, 'Shai Gilgeous-Alexander');
    }
  });

  test('unresolved names return the closest matches instead of a partial match', async () => {
    const typo = await resolvePlayer('Luka Doncik');
    assert.equal(typo.found, false);
    assert.equal(typo.suggestions[0].name, 'Luka Dončić');

    const lastName = await resolvePlayer('Jackson');
    assert.equal(lastName.found, false);
    const names = lastName.suggestions.map(s => s.name);
    assert.ok(names.includes('Jaren Jackson Jr.') && names.includes('Reggie Jackson'), names.join(', '));
  });
});

describe('get_player_history', () => {
  test('averages are regular season, minutes > 0, for the latest season, with the season labelled', async () => {
    const r = await run('get_player_history', { playerName: 'Luka Doncic' });
    assert.equal(r.success, true, r.message);
    assert.equal(r.player.name, 'Luka Dončić');
    assert.equal(r.season, '2025-26');
    assert.equal(r.seasonType, 'regular');
    assert.equal(r.site, 'draftkings');
    // 6 regular-season games (both spellings); playoff 90 and the 0-minute row excluded
    assert.equal(r.averages.games, 6);
    assert.equal(r.averages.avgFpts, round1((60 * 2 + 40 * 4) / 6));
    assert.equal(r.averages.ceiling, 60);
    assert.equal(r.averages.floor, 40);
    assert.deepEqual(r.bySeason.map(s => [s.season, s.games]), [['2025-26', 6], ['2024-25', 2]]);
    assert.ok(r.recentGames.every(g => g.minutes > 0 && g.season));
    assert.ok(!r.recentGames.some(g => g.fpts === 90));
  });

  test('site switches the fantasy points column; seasonType can include playoffs', async () => {
    const fd = await run('get_player_history', { playerName: 'Luka Dončić', site: 'fanduel' });
    assert.equal(fd.site, 'fanduel');
    assert.equal(fd.averages.avgFpts, 50);
    const playoffs = await run('get_player_history', { playerName: 'Luka Doncic', seasonType: 'playoffs' });
    assert.equal(playoffs.averages.games, 1);
    assert.equal(playoffs.averages.avgFpts, 90);
  });

  test('unknown player: clear not-found message with closest matches', async () => {
    const r = await run('get_player_history', { playerName: 'Luka Doncik' });
    assert.equal(r.success, false);
    assert.match(r.message, /not found/i);
    assert.equal(r.closestMatches[0], 'Luka Dončić');
  });
});

describe('get_matchup_history', () => {
  test('matches on player_key and canonical opponent, compared with the season average', async () => {
    const r = await run('get_matchup_history', { playerName: 'Luka Doncic', opponent: 'bos' });
    assert.equal(r.success, true);
    assert.equal(r.opponent, 'BOS');
    // 2 regular-season games in 2025-26 and 2 in 2024-25 (for DAL)
    assert.equal(r.gamesPlayed, 4);
    const now = r.bySeason.find(s => s.season === '2025-26');
    assert.equal(now.gamesVs, 2);
    assert.equal(now.avgVs, 60);
    assert.equal(now.seasonAvg, round1(280 / 6));
    assert.ok(r.games.every(g => g.season));
  });
});

describe('get_usage_without_teammate', () => {
  test('games without come from the team schedule even with no game_player_status rows', async () => {
    const r = await run('get_usage_without_teammate', { playerName: 'Tyrese Maxey', teammateName: 'Kelly Oubre' });
    assert.equal(r.success, true, r.message);
    assert.equal(r.team, 'PHI');
    assert.equal(r.season, '2025-26');
    assert.equal(r.teammate.name, 'Kelly Oubre Jr.');
    // P2, P5, P8 (no rows at all) + P11 (DNP) + P14 (after his last game).
    // January is before he joined PHI and must not count.
    assert.equal(r.withoutTeammate.games, 5);
    assert.equal(r.withTeammate.games, 10);
    assert.equal(r.withoutTeammate.avgFpts, 18);
    assert.equal(r.withTeammate.avgFpts, 10);
    assert.equal(r.usageBump.percentBoost, 80);
    assert.equal(r.withoutTeammate.teammateDnp, 1);
    assert.equal(r.withoutTeammate.teammateOut, 4);
    assert.equal(r.absenceReason, 'MIXED');
    assert.equal(r.recentGamesWithout[0].date, d(28));
  });

  test('unknown teammate is reported with suggestions', async () => {
    const r = await run('get_usage_without_teammate', { playerName: 'Tyrese Maxey', teammateName: 'Kely Oubre' });
    assert.equal(r.success, false);
    assert.match(r.message, /Kely Oubre.*not found/i);
    assert.ok(r.closestMatches.includes('Kelly Oubre Jr.'));
  });
});

describe('analyze_roster_context', () => {
  test('teammates in games where every absent player was out vs the other games', async () => {
    const r = await run('analyze_roster_context', { team: 'PHI', absentPlayers: ['Kelly Oubre Jr'], activePlayers: ['Paul George'] });
    assert.equal(r.success, true, r.message);
    assert.equal(r.season, '2025-26');
    assert.equal(r.matchingGames.count, 5);
    const george = r.usageBumps.find(p => p.player === 'Paul George');
    assert.equal(george.gamesInContext, 5);
    assert.equal(george.contextAvgFpts, 35);
    assert.equal(george.otherAvgFpts, 25);
    assert.equal(george.percentBoost, 40);
    assert.deepEqual(r.activePlayerSplits.map(p => p.player), ['Paul George']);
  });
});

describe('get_team_roster / get_historical_summary / compare_players', () => {
  test('roster groups by player_key (one row for both Luka spellings)', async () => {
    const r = await run('get_team_roster', { team: 'LAL' });
    assert.equal(r.success, true);
    assert.equal(r.season, '2025-26');
    assert.equal(r.roster.length, 1);
    assert.equal(r.roster[0].games, 6);
  });

  test('summary reports seasons and top performers by player_key', async () => {
    const r = await run('get_historical_summary', { topN: 3, minGames: 3 });
    assert.equal(r.success, true);
    assert.equal(r.season, '2025-26');
    assert.ok(r.seasons.some(s => s.season === '2024-25'));
    assert.equal(r.topPerformers[0].name, 'Shai Gilgeous-Alexander');
  });

  test('compare_players resolves each name and reports misses', async () => {
    const r = await run('compare_players', { playerNames: ['Luka Doncic', 'Jaren Jackson Jr.', 'Nobody Atall'] });
    assert.equal(r.success, true);
    assert.deepEqual(r.comparison.map(p => p.name), ['Luka Dončić', 'Jaren Jackson Jr.']);
    assert.ok(r.comparison.every(p => p.season === '2025-26'));
    assert.equal(r.notFound[0].query, 'Nobody Atall');
  });
});

describe('shared by both chat paths', () => {
  test('aiChatService and AnalystAgent expose the same history tool set', async () => {
    const { HISTORY_TOOL_NAMES } = await import('../src/services/chatTools/historyTools.js');
    const aiChatService = (await import('../src/services/aiChatService.js')).default;
    const AnalystAgent = (await import('../src/agents/AnalystAgent.js')).default;
    const chatNames = aiChatService.createTools().map(t => t.name);
    const analystNames = new AnalystAgent().tools.map(t => t.name);
    for (const name of HISTORY_TOOL_NAMES) {
      assert.ok(chatNames.includes(name), `aiChatService has ${name}`);
      assert.ok(analystNames.includes(name), `AnalystAgent has ${name}`);
    }
    assert.deepEqual([...analystNames].sort(), [...HISTORY_TOOL_NAMES].sort());
    // aiChatService hands the shared JSON schema to OpenAI unchanged
    const chatTool = aiChatService.createTools().find(t => t.name === 'get_usage_without_teammate');
    const fn = aiChatService.convertToolToFunction(chatTool);
    assert.deepEqual(fn.parameters, tools.get('get_usage_without_teammate').parameters);
    const out = JSON.parse(await chatTool.func({ playerName: 'Tyrese Maxey', teammateName: 'Kelly Oubre Jr.' }));
    assert.equal(out.withoutTeammate.games, 5);
  });

  test('history tool queries never match names with LIKE or LOWER(name)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'chatTools', 'historyTools.js'), 'utf8');
    assert.doesNotMatch(src, /\bLIKE\b/);
    assert.doesNotMatch(src, /LOWER\(/);
  });
});

// Runs last: adds a 2026-27 game
describe('early in a season', () => {
  test('usage without falls back to the previous season when the new one is thin', async () => {
    await game('Tyrese Maxey', 'PHI', 'ORL', '2026-10-21', 36, 44);
    await game('Kelly Oubre Jr.', 'PHI', 'ORL', '2026-10-21', 30, 20);
    const r = await run('get_usage_without_teammate', { playerName: 'Tyrese Maxey', teammateName: 'Kelly Oubre Jr.' });
    assert.equal(r.season, '2025-26');
    assert.equal(r.withoutTeammate.games, 5);
    assert.match(r.note, /2026-27 has only 1 games/);
    const current = await run('get_usage_without_teammate', { playerName: 'Tyrese Maxey', teammateName: 'Kelly Oubre Jr.', season: '2026-27' });
    assert.equal(current.season, '2026-27');
    assert.equal(current.withTeammate.games, 1);
  });
});

function round1(x) {
  return Math.round(x * 10) / 10;
}
