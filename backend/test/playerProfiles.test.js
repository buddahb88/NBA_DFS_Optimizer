import { test, beforeAll as before, afterAll as after, beforeEach } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Keep the service off the real DB file
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nba-dfs-profiles-'));
let db;
let profiles;

before(async () => {
  process.env.DATABASE_TYPE = 'sqlite';
  process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');
  db = (await import('../src/config/database.js')).default;
  await (await import('../src/config/schema.js')).createTables(db);
  profiles = await import('../src/services/playerProfileService.js');
});

after(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const close = (actual, expected, label) =>
  assert.ok(Math.abs(actual - expected) < 1e-9, `${label}: expected ${expected}, got ${actual}`);

function team(game_id, game_date, team, opponent, stats, season = '2025-26', season_type = 'regular') {
  return db.run(
    `INSERT INTO team_game_stats (game_id, game_date, season, season_type, team, opponent, minutes,
       pts, fgm, fga, fg3m, fg3a, ftm, fta, oreb, dreb, ast, tov, stl, blk, pf, possessions)
     VALUES (@game_id, @game_date, @season, @season_type, @team, @opponent, @minutes,
       0, @fgm, @fga, 0, @fg3a, 0, @fta, @oreb, @dreb, 0, @tov, 0, 0, 0, @possessions)`,
    { game_id, game_date, season, season_type, team, opponent, minutes: 240, ...stats });
}

const ZERO = { points: 0, fgm: 0, fga: 0, fg3m: 0, fg3a: 0, ftm: 0, fta: 0, oreb: 0, dreb: 0,
  ast: 0, stl: 0, blk: 0, tov: 0, dk: 0, fd: 0 };

function player(name, game_id, game_date, team, opponent, minutes, stats = {}, extra = {}) {
  const s = { ...ZERO, ...stats };
  return db.run(
    `INSERT INTO historical_games (player_name, player_key, espn_player_id, team, opponent, position, game_id,
       game_date, season, season_type, is_starter, minutes, points, rebounds, assists, steals, blocks, turnovers,
       fg_made, fg_attempted, fg3_made, fg3_attempted, ft_made, ft_attempted, oreb, dreb,
       dk_fantasy_points, fd_fantasy_points)
     VALUES (@name, @key, @espn, @team, @opponent, @position, @game_id, @game_date, @season, @season_type,
       @starter, @minutes, @points, @reb, @ast, @stl, @blk, @tov, @fgm, @fga, @fg3m, @fg3a, @ftm, @fta,
       @oreb, @dreb, @dk, @fd)`,
    {
      name, key: name.toLowerCase(), espn: extra.espn ?? '1', team, opponent, position: extra.position ?? 'G',
      game_id, game_date, season: extra.season ?? '2025-26', season_type: extra.season_type ?? 'regular',
      starter: extra.starter ?? 1, minutes, ...s, reb: s.oreb + s.dreb,
    });
}

// Two AAA vs BBB games. Team MP is 240 (5 x 48), so TmMP/5 = 48.
const AAA1 = { fgm: 40, fga: 80, fg3a: 30, fta: 20, oreb: 10, dreb: 30, tov: 12, possessions: 100 };
const BBB1 = { fgm: 38, fga: 90, fg3a: 35, fta: 25, oreb: 12, dreb: 28, tov: 14, possessions: 104 };
const AAA2 = { fgm: 42, fga: 85, fg3a: 33, fta: 22, oreb: 8, dreb: 34, tov: 10, possessions: 98 };
const BBB2 = { fgm: 36, fga: 88, fg3a: 40, fta: 18, oreb: 14, dreb: 31, tov: 15, possessions: 99 };

const X1 = { points: 27, fgm: 10, fga: 20, fg3m: 3, fg3a: 6, ftm: 4, fta: 5, oreb: 2, dreb: 6, ast: 5,
  stl: 2, blk: 1, tov: 3, dk: 40, fd: 38 };
const X2 = { points: 31, fgm: 11, fga: 24, fg3m: 4, fg3a: 10, ftm: 5, fta: 6, oreb: 1, dreb: 9, ast: 8,
  stl: 1, blk: 2, tov: 4, dk: 50.5, fd: 47 };

beforeEach(async () => {
  await db.exec('DELETE FROM historical_games; DELETE FROM team_game_stats; DELETE FROM player_season_profiles;');

  await team('g1', '2025-11-01', 'AAA', 'BBB', AAA1);
  await team('g1', '2025-11-01', 'BBB', 'AAA', BBB1);
  await team('g2', '2025-11-03', 'AAA', 'BBB', AAA2);
  await team('g2', '2025-11-03', 'BBB', 'AAA', BBB2);

  // Player X: 24 then 36 minutes for AAA
  await player('Player X', 'g1', '2025-11-01', 'AAA', 'BBB', 24, X1);
  await player('Player X', 'g2', '2025-11-03', 'AAA', 'BBB', 36, X2, { starter: 0 });
  // Listed with 0 minutes: excluded from every average
  await player('Player Y', 'g1', '2025-11-01', 'AAA', 'BBB', 0, {}, { espn: '2' });
  // Traded: g1 for AAA (F), g2 for BBB (C, C is the more frequent position)
  await player('Player Z', 'g1', '2025-11-01', 'AAA', 'BBB', 10, { points: 4, fga: 3 }, { espn: '3', position: 'F' });
  await player('Player Z', 'g2', '2025-11-03', 'BBB', 'AAA', 20, { points: 8, fga: 6 }, { espn: '3', position: 'C' });
  await player('Player Z', 'g3', '2025-11-05', 'BBB', 'CCC', 20, { points: 8, fga: 6 }, { espn: '3', position: 'C' });
  await team('g3', '2025-11-05', 'BBB', 'CCC', BBB1);
  await team('g3', '2025-11-05', 'CCC', 'BBB', AAA1);
  // Playoff and other-season games are left out of the 2025-26 profile
  await team('p1', '2026-04-20', 'AAA', 'BBB', AAA1, '2025-26', 'playoffs');
  await team('p1', '2026-04-20', 'BBB', 'AAA', BBB1, '2025-26', 'playoffs');
  await player('Player X', 'p1', '2026-04-20', 'AAA', 'BBB', 48, X1, { season_type: 'playoffs' });
});

async function profileFor(key) {
  return db.get('SELECT * FROM player_season_profiles WHERE season = ? AND player_key = ?', '2025-26', key);
}

test('refreshSeasonProfiles writes one row per player who played, skipping 0-minute and playoff games', async () => {
  const result = await profiles.refreshSeasonProfiles('2025-26');
  assert.equal(result.season, '2025-26');
  assert.equal(result.players, 2);

  const rows = await db.all('SELECT player_key FROM player_season_profiles ORDER BY player_key');
  assert.deepEqual(rows.map(r => r.player_key), ['player x', 'player z']);

  const x = await profileFor('player x');
  assert.equal(x.player_name, 'Player X');
  assert.equal(x.espn_player_id, '1');
  assert.equal(x.games, 2);
  assert.equal(x.starts, 1);
  close(x.minutes, 60, 'minutes');
  close(x.minutes_pg, 30, 'minutes_pg');
  assert.ok(x.updated_at);
});

test('usage rate: sum(FGA + 0.44 FTA + TOV) / sum(MP / (TmMP/5) * (TmFGA + 0.44 TmFTA + TmTOV))', async () => {
  await profiles.refreshSeasonProfiles('2025-26');
  const x = await profileFor('player x');
  const used = (20 + 0.44 * 5 + 3) + (24 + 0.44 * 6 + 4);
  const teamPlays = (24 / 48) * (80 + 0.44 * 20 + 12) + (36 / 48) * (85 + 0.44 * 22 + 10);
  close(x.usg_pct, used / teamPlays, 'usg_pct');
  // Single-game sanity: game 1 alone is exactly 50%
  close((20 + 0.44 * 5 + 3) / ((24 / 48) * (80 + 0.44 * 20 + 12)), 0.5, 'game-1 usage');
});

test('assist rate: AST / sum(MP / (TmMP/5) * TmFGM - FGM)', async () => {
  await profiles.refreshSeasonProfiles('2025-26');
  const x = await profileFor('player x');
  const teammateFgm = ((24 / 48) * 40 - 10) + ((36 / 48) * 42 - 11);
  close(x.ast_pct, (5 + 8) / teammateFgm, 'ast_pct');
});

test('rebound rates use team and opponent rebounds', async () => {
  await profiles.refreshSeasonProfiles('2025-26');
  const x = await profileFor('player x');
  const share1 = 24 / 48;
  const share2 = 36 / 48;
  close(x.oreb_pct, (2 + 1) / (share1 * (10 + 28) + share2 * (8 + 31)), 'oreb_pct');
  close(x.dreb_pct, (6 + 9) / (share1 * (30 + 12) + share2 * (34 + 14)), 'dreb_pct');
  close(x.reb_pct, (8 + 10) / (share1 * (40 + 40) + share2 * (42 + 45)), 'reb_pct');
});

test('steal rate uses opponent possessions, block rate opponent 2-point attempts', async () => {
  await profiles.refreshSeasonProfiles('2025-26');
  const x = await profileFor('player x');
  const share1 = 24 / 48;
  const share2 = 36 / 48;
  close(x.stl_pct, (2 + 1) / (share1 * 104 + share2 * 99), 'stl_pct');
  close(x.blk_pct, (1 + 2) / (share1 * (90 - 35) + share2 * (88 - 40)), 'blk_pct');
});

test('shooting profile: 3PA rate, FT rate and true shooting', async () => {
  await profiles.refreshSeasonProfiles('2025-26');
  const x = await profileFor('player x');
  close(x.three_pa_rate, (6 + 10) / (20 + 24), 'three_pa_rate');
  close(x.ft_rate, (5 + 6) / (20 + 24), 'ft_rate');
  close(x.ts_pct, (27 + 31) / (2 * ((20 + 24) + 0.44 * (5 + 6))), 'ts_pct');
});

test('fantasy points per minute and per-36 box score rates', async () => {
  await profiles.refreshSeasonProfiles('2025-26');
  const x = await profileFor('player x');
  close(x.dk_fppm, (40 + 50.5) / 60, 'dk_fppm');
  close(x.fd_fppm, (38 + 47) / 60, 'fd_fppm');
  close(x.pts_per36, 36 * (27 + 31) / 60, 'pts_per36');
  close(x.reb_per36, 36 * (8 + 10) / 60, 'reb_per36');
  close(x.ast_per36, 36 * (5 + 8) / 60, 'ast_per36');
  close(x.fg3m_per36, 36 * (3 + 4) / 60, 'fg3m_per36');
});

test('traded player: latest team, every team in order, most frequent position', async () => {
  await profiles.refreshSeasonProfiles('2025-26');
  const z = await profileFor('player z');
  assert.equal(z.team, 'BBB');
  assert.equal(z.teams, 'AAA,BBB');
  assert.equal(z.position, 'C');
  assert.equal(z.games, 3);
  assert.equal(z.starts, 3);
  // Per-game team context follows the team he played for in each game
  const plays = (10 / 48) * (80 + 0.44 * 20 + 12) + (20 / 48) * (88 + 0.44 * 18 + 15) + (20 / 48) * (90 + 0.44 * 25 + 14);
  close(z.usg_pct, 15 / plays, 'usg_pct');
});

test('rates with a zero denominator are null', async () => {
  await profiles.refreshSeasonProfiles('2025-26');
  const z = await profileFor('player z');
  // No free throws or 3s attempted: rates are 0, not null (FGA > 0)
  assert.equal(z.three_pa_rate, 0);
  assert.equal(z.ft_rate, 0);

  await db.exec('DELETE FROM historical_games; DELETE FROM player_season_profiles;');
  await player('Player W', 'g1', '2025-11-01', 'AAA', 'BBB', 5, { points: 0 });
  await profiles.refreshSeasonProfiles('2025-26');
  const w = await profileFor('player w');
  assert.equal(w.three_pa_rate, null);
  assert.equal(w.ft_rate, null);
  assert.equal(w.ts_pct, null);
  close(w.usg_pct, 0, 'usg_pct');
});

test('refreshing a season replaces its rows and leaves other seasons alone', async () => {
  await db.run(
    `INSERT INTO player_season_profiles (season, player_key, player_name, games) VALUES ('2024-25', 'player x', 'Player X', 70)`);
  await profiles.refreshSeasonProfiles('2025-26');
  await db.run(`DELETE FROM historical_games WHERE player_key = 'player z'`);
  const result = await profiles.refreshSeasonProfiles('2025-26');

  assert.equal(result.players, 1);
  const rows = await db.all('SELECT season, player_key, games FROM player_season_profiles ORDER BY season');
  assert.deepEqual(rows.map(r => ({ ...r })), [
    { season: '2024-25', player_key: 'player x', games: 70 },
    { season: '2025-26', player_key: 'player x', games: 2 },
  ]);
});
