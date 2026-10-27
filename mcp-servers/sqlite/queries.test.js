import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { archetypeMatchups, gppPlays, matchupSeason, playerHistory, playerProfile, valuePlays } from './queries.js';

function seed() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE slates (slate_id TEXT, name TEXT, site TEXT, start_time TEXT, created_at TEXT);
    CREATE TABLE players (id INTEGER PRIMARY KEY, slate_id TEXT, name TEXT, position TEXT, team TEXT, opponent TEXT,
      salary INTEGER, projected_points REAL, rostership REAL, injury_status TEXT);
    CREATE TABLE historical_games (player_key TEXT, player_name TEXT, team TEXT, opponent TEXT, game_date TEXT,
      season TEXT, season_type TEXT, is_home INTEGER, is_starter INTEGER, is_back_to_back INTEGER, minutes REAL,
      points INTEGER, rebounds INTEGER, assists INTEGER, steals INTEGER, blocks INTEGER, turnovers INTEGER,
      fg3_made INTEGER, dk_fantasy_points REAL, fd_fantasy_points REAL, yahoo_fantasy_points REAL, usg_pct REAL);
    CREATE TABLE player_season_profiles (season TEXT, player_key TEXT, player_name TEXT, team TEXT, position TEXT,
      games INTEGER, starts INTEGER, minutes_pg REAL, usg_pct REAL, ast_pct REAL, reb_pct REAL, three_pa_rate REAL,
      ts_pct REAL, dk_fppm REAL, fd_fppm REAL, pts_per36 REAL, reb_per36 REAL, ast_per36 REAL, fg3m_per36 REAL);
    CREATE TABLE player_archetypes (season TEXT, player_key TEXT, archetype TEXT, secondary_archetype TEXT);
    CREATE TABLE team_archetype_defense (season TEXT, site TEXT, group_by TEXT, team TEXT, group_key TEXT,
      games INTEGER, player_games INTEGER, fp_over_expectation REAL, pts_delta REAL, reb_delta REAL, ast_delta REAL);
  `);
  db.prepare(`INSERT INTO slates VALUES ('s1', 'Main', 'draftkings', '2026-10-21 19:00', '2026-10-21')`).run();
  const player = db.prepare(`INSERT INTO players (slate_id, name, position, team, opponent, salary, projected_points, rostership, injury_status)
    VALUES ('s1', ?, ?, ?, ?, ?, ?, ?, ?)`);
  player.run('Jaren Jackson Jr.', 'PF/C', 'MEM', 'LAL', 8000, 40, 20, null);
  player.run('Luka Doncic', 'PG', 'LAL', 'MEM', 11000, 55, 30, null);
  player.run('Hurt Guy', 'SG', 'LAL', 'MEM', 5000, 20, 5, 'OUT');

  const profile = db.prepare(`INSERT INTO player_season_profiles (season, player_key, player_name, team, position, games, minutes_pg, usg_pct, dk_fppm)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const archetype = db.prepare(`INSERT INTO player_archetypes VALUES (?, ?, ?, NULL)`);
  for (const season of ['2025-26', '2026-27']) {
    profile.run(season, 'jaren jackson', 'Jaren Jackson Jr.', 'MEM', 'F', 60, 30, 0.27, 1.3);
    profile.run(season, 'luka doncic', 'Luka Dončić', 'LAL', 'G', 60, 36, 0.36, 1.6);
    profile.run(season, 'hurt guy', 'Hurt Guy', 'LAL', 'G', 60, 20, 0.15, 0.9);
    archetype.run(season, 'jaren jackson', 'stretch_big');
    archetype.run(season, 'luka doncic', 'primary_creator');
    archetype.run(season, 'hurt guy', 'role_player');
  }

  const defense = db.prepare(`INSERT INTO team_archetype_defense (season, site, group_by, team, group_key, games, fp_over_expectation)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);
  // 2025-26: 20 full defenses; 2026-27: one game in
  for (let i = 0; i < 20; i++) defense.run('2025-26', 'draftkings', 'position', `T${i}`, 'G', 60, 0);
  defense.run('2026-27', 'draftkings', 'position', 'LAL', 'F', 1, 0.1);
  defense.run('2025-26', 'draftkings', 'archetype', 'LAL', 'stretch_big', 60, 1.8);
  defense.run('2025-26', 'draftkings', 'archetype', 'MEM', 'primary_creator', 60, -1.2);
  defense.run('2025-26', 'draftkings', 'archetype', 'MEM', 'role_player', 60, 3);
  defense.run('2025-26', 'fanduel', 'archetype', 'LAL', 'stretch_big', 60, -4);
  defense.run('2026-27', 'draftkings', 'archetype', 'LAL', 'stretch_big', 1, 0.2);
  defense.run('2025-26', 'draftkings', 'position', 'LAL', 'F', 60, 0.9);
  defense.run('2025-26', 'draftkings', 'position', 'MEM', 'G', 60, -0.4);

  const game = db.prepare(`INSERT INTO historical_games (player_key, player_name, team, opponent, game_date, season, season_type, minutes, dk_fantasy_points, fd_fantasy_points)
    VALUES (?, ?, 'LAL', 'MEM', ?, '2025-26', ?, ?, ?, ?)`);
  game.run('luka doncic', 'Luka Dončić', '2026-04-10', 'regular', 36, 60, 55);
  game.run('luka doncic', 'Luka Dončić', '2026-04-20', 'playoffs', 40, 70, 65);
  game.run('luka doncic', 'Luka Dončić', '2026-04-12', 'regular', 0, 0, 0);
  return db;
}

test('matchupSeason falls back to the latest season with 20+ defenses at 10+ games', () => {
  const db = seed();
  assert.equal(matchupSeason(db, 'draftkings'), '2025-26');
  assert.equal(matchupSeason(db, 'yahoo'), null);
});

test('archetypeMatchups joins tonight\'s healthy players to their archetype defense', () => {
  const db = seed();
  const result = archetypeMatchups(db, {});
  assert.equal(result.season, '2025-26');
  assert.equal(result.site, 'draftkings');
  assert.deepEqual(result.players.map(p => [p.name, p.archetype, p.fp_over_expectation, p.position_group, p.position_fp_over_expectation]), [
    ['Jaren Jackson Jr.', 'stretch_big', 1.8, 'F', 0.9],
    ['Luka Doncic', 'primary_creator', -1.2, 'G', -0.4],
  ]);
});

test('archetypeMatchups honours explicit site and season', () => {
  const db = seed();
  const fd = archetypeMatchups(db, { site: 'fanduel', season: '2025-26' });
  assert.deepEqual(fd.players.map(p => [p.name, p.fp_over_expectation]), [['Jaren Jackson Jr.', -4]]);
  const current = archetypeMatchups(db, { season: '2026-27' });
  assert.deepEqual(current.players.map(p => [p.name, p.fp_over_expectation, p.games]), [['Jaren Jackson Jr.', 0.2, 1]]);
});

test('playerProfile matches on player_key so suffixes and accents resolve', () => {
  const db = seed();
  const jjj = playerProfile(db, 'Jaren Jackson Jr.');
  assert.deepEqual(jjj.map(r => [r.season, r.archetype, r.usg_pct]), [['2026-27', 'stretch_big', 0.27], ['2025-26', 'stretch_big', 0.27]]);
  assert.equal(playerProfile(db, 'Luka Dončić').length, 2);
});

test('playerHistory matches by player_key, skips DNPs and summarises the regular season', () => {
  const db = seed();
  const { recentGames, seasonStats } = playerHistory(db, 'Luka Doncic', 10);
  assert.deepEqual(recentGames.map(g => [g.game_date, g.season_type]), [['2026-04-20', 'playoffs'], ['2026-04-10', 'regular']]);
  assert.ok(!('usg_pct' in recentGames[0]));
  assert.deepEqual(seasonStats.map(s => [s.season, s.games, s.avg_dk]), [['2025-26', 1, 60]]);
});

function seedSlates() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE slates (slate_id TEXT, name TEXT, site TEXT, start_time TEXT, created_at TEXT);
    CREATE TABLE players (id INTEGER PRIMARY KEY, slate_id TEXT, name TEXT, position TEXT, team TEXT, opponent TEXT,
      salary INTEGER, projected_points REAL, projected_minutes REAL, vegas_spread REAL, floor REAL, ceiling REAL, rostership REAL,
      leverage_score REAL, boom_probability REAL);
    CREATE TABLE slate_player_snapshots (id INTEGER PRIMARY KEY, game_date TEXT, slate_id TEXT, site TEXT, player_key TEXT,
      player_name TEXT, position TEXT, team TEXT, opponent TEXT, salary INTEGER, projected_points REAL, projected_minutes REAL,
      vegas_spread REAL, floor REAL, ceiling REAL, rostership REAL, leverage_score REAL, boom_probability REAL);
    CREATE TABLE historical_games (player_key TEXT, game_date TEXT, minutes REAL, dk_fantasy_points REAL);
  `);
  db.prepare(`INSERT INTO slates VALUES ('live', 'Main', 'draftkings', NULL, '2026-10-23')`).run();
  db.prepare(`INSERT INTO players (slate_id, name, position, team, opponent, salary, projected_points, ceiling, rostership, leverage_score)
    VALUES ('live', 'Cheap Live', 'PG', 'LAL', 'MEM', 4000, 24, 45, 5, 3)`).run();
  const snap = db.prepare(`INSERT INTO slate_player_snapshots (game_date, slate_id, site, player_key, player_name, position, team, opponent,
    salary, projected_points, ceiling, rostership, leverage_score) VALUES ('2026-10-21', 'past', 'draftkings', ?, ?, 'SG', 'GSW', 'LAL', ?, ?, ?, ?, ?)`);
  snap.run('cheap past', 'Cheap Past', 4000, 22, 44, 4, 5);
  snap.run('pricey past', 'Pricey Past', 9000, 45, 60, 30, 1);
  db.prepare(`INSERT INTO historical_games VALUES ('cheap past', '2026-10-21', 28, 31.5)`).run();
  return db;
}

test('valuePlays reads the live slate, or a past date\'s saved slate with actual points', () => {
  const db = seedSlates();
  assert.deepEqual(valuePlays(db, {}).plays.map(p => p.name), ['Cheap Live']);
  const past = valuePlays(db, { slateDate: '2026-10-21' });
  assert.equal(past.backtest, true);
  assert.equal(past.slateId, 'past');
  assert.deepEqual(past.plays.map(p => [p.name, p.actual_points]), [['Cheap Past', 31.5]]);
  assert.equal(valuePlays(db, { slateDate: '2020-01-01' }).plays.length, 0);
});

test('gppPlays reads the live slate, or a past date\'s saved slate with actual points', () => {
  const db = seedSlates();
  assert.deepEqual(gppPlays(db, {}).plays.map(p => p.name), ['Cheap Live']);
  const past = gppPlays(db, { slateDate: '2026-10-21' });
  assert.deepEqual(past.plays.map(p => [p.name, p.actual_points]), [['Cheap Past', 31.5]]);
});

test('valuePlays / gppPlays use the projection sanity layer (blowout trim, env setting); the posted value is kept', () => {
  const db = seedSlates();
  const add = db.prepare(`INSERT INTO players (slate_id, name, position, team, opponent, salary, projected_points, projected_minutes,
    vegas_spread, ceiling, rostership, leverage_score) VALUES ('live', ?, 'SF', ?, ?, 5000, ?, ?, ?, 50, 3, ?)`);
  // 6.8 / $1K posted, but a 16-point underdog starter: trimmed below Steady Wing's 6.4
  add.run('Dog Starter', 'WAS', 'BOS', 34, 34, 16, 2);
  add.run('Steady Wing', 'NYK', 'MIA', 32, 30, -2, 1);

  const on = valuePlays(db, {}).plays;
  assert.deepEqual(on.map(p => p.name), ['Steady Wing', 'Dog Starter', 'Cheap Live']);
  const dog = on.find(p => p.name === 'Dog Starter');
  assert.equal(dog.projection_raw, 34);
  assert.ok(dog.projected_points < 34);
  assert.equal(dog.value, Math.round(dog.projected_points / 5000 * 1000 * 100) / 100);
  assert.match(dog.projection_reasons[0], /^blowout \+16\.0: /);
  assert.deepEqual(on.find(p => p.name === 'Steady Wing').projection_reasons, []);
  assert.ok(gppPlays(db, {}).plays.find(p => p.name === 'Dog Starter').projected_points < 34);

  process.env.PROJECTION_SANITY = 'off';
  try {
    const off = valuePlays(db, {}).plays;
    assert.deepEqual(off.map(p => p.name), ['Dog Starter', 'Steady Wing', 'Cheap Live']);
    assert.equal(off[0].projected_points, 34);
    assert.equal(off[0].projection_sanity, undefined);
  } finally {
    delete process.env.PROJECTION_SANITY;
  }
});
