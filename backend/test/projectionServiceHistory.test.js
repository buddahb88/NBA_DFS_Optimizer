import { test, describe, vi, beforeAll as before, afterAll as after, beforeEach } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

// projectionService (enhanced / recalculate projections) history lookups:
// the season average is this season's regular-season games shrunk toward
// last season's (no playoffs, no older seasons), and every lookup matches by
// player_key (accents, suffixes) instead of player_name LIKE.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nba-dfs-projhist-'));
process.env.DATABASE_TYPE = 'sqlite';
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');

let db;
let projectionService;
let playerKey;
let gameId = 0;

const SLATE = '2026-11-10';

async function game(name, date, season, fp, { seasonType = 'regular', opponent = 'NYK', team = 'BOS', minutes = 30 } = {}) {
  await db.run(`INSERT INTO historical_games (player_name, player_key, team, opponent, game_id, game_date, season, season_type,
      minutes, is_home, is_back_to_back, dk_fantasy_points, fd_fantasy_points, yahoo_fantasy_points)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?, ?)`,
  name, playerKey(name), team, opponent, `g${++gameId}`, date, season, seasonType, minutes, fp, fp, fp);
}

before(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  db = (await import('../src/config/database.js')).default;
  await (await import('../src/config/schema.js')).createTables(db);
  projectionService = (await import('../src/services/projectionService.js')).default;
  ({ playerKey } = await import('../src/utils/playerKey.js'));

  // Luka Dončić: 2024-25 at 60 (too old), 2025-26 regular at 50 (20 games) + playoffs at 70, 2026-27 at 40 (5 games)
  for (let i = 0; i < 10; i++) await game('Luka Dončić', `2025-01-${String(10 + i).padStart(2, '0')}`, '2024-25', 60);
  for (let i = 0; i < 20; i++) await game('Luka Dončić', `2026-02-${String(1 + i).padStart(2, '0')}`, '2025-26', 50);
  for (let i = 0; i < 4; i++) await game('Luka Dončić', `2026-05-${String(1 + i).padStart(2, '0')}`, '2025-26', 70, { seasonType: 'playoffs' });
  for (let i = 0; i < 5; i++) await game('Luka Dončić', `2026-11-0${1 + i}`, '2026-27', 40, { opponent: i < 2 ? 'MIA' : 'NYK' });
  // After the slate date: never seen
  await game('Luka Dončić', '2026-11-12', '2026-27', 99);

  // CHI: Star Forward played the first 3 November games (30+ DK), sat 11-04 and 11-05; Role Guy jumps without him
  for (let i = 0; i < 3; i++) await game('Star Forward', `2026-11-0${1 + i}`, '2026-27', 32, { team: 'CHI' });
  for (let i = 0; i < 5; i++) await game('Role Guy', `2026-11-0${1 + i}`, '2026-27', i < 3 ? 20 : 35, { team: 'CHI' });
  // Name LIKE trap: "Jaren Jackson" vs "Jaren Jackson Jr." are one player_key; "Jackson" alone is another player
  for (let i = 0; i < 5; i++) await game('Jaren Jackson Jr.', `2026-11-0${1 + i}`, '2026-27', 35, { team: 'MEM' });
  for (let i = 0; i < 5; i++) await game('Jaren Jackson Jr. II Fake', `2026-11-0${1 + i}`, '2026-27', 5, { team: 'MEM' });
});

after(() => {
  vi.restoreAllMocks();
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => projectionService.clearCache());

const SHRINK = () => projectionService.SEASON_PRIOR_GAMES;

describe('getPlayerHistoricalStats', () => {
  test('season average: this season shrunk toward last regular season (no playoffs, no older seasons)', async () => {
    const h = await projectionService.getPlayerHistoricalStats('Luka Doncic', SLATE);
    const k = SHRINK();
    const expected = (5 * 40 + k * 50) / (5 + k);
    assert.ok(Math.abs(h.seasonAvg - expected) < 1e-9, `got ${h.seasonAvg}, expected ${expected}`);
    assert.equal(h.currentSeasonGames, 5);
    assert.equal(h.priorSeasonGames, 20);
    assert.equal(h.priorSeasonAvg, 50);
    assert.equal(h.seasonGames, 25);
    // Last 3 are this season's, the game after the slate is not seen
    assert.equal(h.last3Avg, 40);
    assert.ok(h.ceiling <= 50, `ceiling ${h.ceiling} must not include playoffs / later games`);
  });

  test('matches by player_key: accents and suffixes resolve, a different player does not leak in', async () => {
    const accented = await projectionService.getPlayerHistoricalStats('Luka Dončić', SLATE);
    projectionService.clearCache();
    const plain = await projectionService.getPlayerHistoricalStats('Luka Doncic', SLATE);
    assert.equal(accented.seasonAvg, plain.seasonAvg);

    const jjj = await projectionService.getPlayerHistoricalStats('Jaren Jackson', SLATE);
    assert.equal(jjj.currentSeasonGames, 5);
    assert.equal(jjj.seasonAvg, 35);
  });

  test('no prior season: this season alone; no slate date: everything up to today', async () => {
    const h = await projectionService.getPlayerHistoricalStats('Jaren Jackson Jr.', SLATE);
    assert.equal(h.priorSeasonGames, 0);
    assert.equal(h.seasonAvg, 35);
  });
});

describe('getMatchupHistory', () => {
  test('by player_key, regular season, before the slate date', async () => {
    const m = await projectionService.getMatchupHistory('Luka Doncic', 'MIA', SLATE);
    assert.equal(m.games, 2);
    assert.equal(m.avgDk, 40);
  });
});

describe('detectUsageBump', () => {
  test('a regular missing from the slate (by player_key) bumps a teammate from his games without him', async () => {
    const bump = await projectionService.detectUsageBump('Role Guy', 'CHI', ['Role Guy'], SLATE);
    assert.equal(bump.hasUsageBump, true);
    assert.equal(bump.bump, 75);
    assert.equal(bump.missingPlayers[0].missingPlayer, 'Star Forward');

    // Listed under an accented / suffixed spelling: on the slate, no bump
    const listed = await projectionService.detectUsageBump('Role Guy', 'CHI', ['Role Guy', 'Star Fórward Jr.'], SLATE);
    assert.equal(listed.hasUsageBump, false);
  });

  test('the 30-day roster window ends at the slate date (no lookahead, not today)', async () => {
    // A month before Star Forward's games: nobody qualifies as a missing regular
    const early = await projectionService.detectUsageBump('Role Guy', 'CHI', ['Role Guy'], '2026-10-25');
    assert.equal(early.hasUsageBump, false);
    assert.deepEqual(early.missingPlayers, []);
  });
});
