import { test, describe, vi, beforeAll as before, afterAll as after, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nba-dfs-insights-'));
process.env.DATABASE_TYPE = 'sqlite';
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');

let db;
let insights;
let playerKey;
let seasonForDate;
let server;
let baseUrl;

// Seeded "current season" is 2025-26; every call passes endDate = END unless
// it is testing the default anchor (the latest game_date in the data).
const END = '2026-03-31';
const addDays = (date, n) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const d = (i) => addDays('2026-03-01', i);   // inside the last 30 days of END
const jan = (i) => addDays('2026-01-05', 2 * i); // 2025-26, outside the last 30 days
const lastSeason = (i) => addDays('2025-02-01', 2 * i); // 2024-25

const gameId = (date, team, opp) => `${date}-${[team, opp].sort().join('-')}`;

async function game(name, team, opp, date, minutes, dk, { fd = dk, yahoo = dk } = {}) {
  await db.run(`
    INSERT INTO historical_games (player_name, player_key, team, opponent, game_id, game_date, season,
      minutes, points, dk_fantasy_points, fd_fantasy_points, yahoo_fantasy_points)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, name, playerKey(name), team, opp, gameId(date, team, opp), date, seasonForDate(date),
  minutes, Math.round(dk), dk, fd, yahoo);
}

async function status(name, team, opp, date, value = 'INACTIVE') {
  await db.run(`
    INSERT INTO game_player_status (game_id, game_date, team, player_key, player_name, status, reason)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `, gameId(date, team, opp), date, team, playerKey(name), name, value, value === 'DNP' ? "Coach's Decision" : 'Injury');
}

async function seed() {
  // ── MEM: usage bumps / missing players ─────────────────────────────
  // G0..G10 every other day in March; J0..J4 in January before JJJ joined
  const G = Array.from({ length: 11 }, (_, i) => d(2 * i));
  const J = Array.from({ length: 5 }, (_, i) => jan(i));
  for (const [i, date] of G.entries()) {
    if (i < 8) await game('Jaren Jackson Jr.', 'MEM', 'NOP', date, 32, i % 2 ? 44 : 36);
    await game('Ja Morant', 'MEM', 'NOP', date, 34, i < 8 ? 20 : 30);
    await game('Reggie Jackson', 'MEM', 'NOP', date, 15, 10);
    if (i < 6) await game('Six Game Guy', 'MEM', 'NOP', date, 25, 30);
    if (i < 5) await game('Traded Guy', 'MEM', 'NOP', date, 28, 25);
  }
  // JJJ listed but did not play: a minutes=0 row, then INACTIVE and DNP
  await game('Jaren Jackson Jr.', 'MEM', 'NOP', G[8], 0, 0);
  await status('Jaren Jackson Jr.', 'MEM', 'NOP', G[9], 'INACTIVE');
  await status('Jaren Jackson Jr.', 'MEM', 'NOP', G[10], 'DNP');
  // January: JJJ not on MEM yet (not in the box score at all)
  for (const date of J) {
    await game('Ja Morant', 'MEM', 'NOP', date, 34, 50);
    await game('Old Guy', 'MEM', 'NOP', date, 30, 30);
  }
  // Traded Guy finishes the window on LAL
  for (const i of [11, 13, 15, 17, 19]) await game('Traded Guy', 'LAL', 'PHX', d(i), 28, 10);
  // Last season JJJ was out and Morant went off; must not leak into 2025-26
  for (const i of [0, 1]) {
    await game('Ja Morant', 'MEM', 'NOP', lastSeason(i), 34, 100);
    await status('Jaren Jackson Jr.', 'MEM', 'NOP', lastSeason(i), 'INACTIVE');
  }

  // ── Streaks (BOS) ──────────────────────────────────────────────────
  const S = Array.from({ length: 8 }, (_, i) => d(2 * i));
  for (const [i, date] of S.entries()) {
    await game('Hot Guy', 'BOS', 'DET', date, 30, i < 5 ? 20 : 40, { fd: 30 });
    await game('Cold Guy', 'BOS', 'DET', date, 30, i < 5 ? 40 : 20);
    await game('Mild Guy', 'BOS', 'DET', date, 30, i < 5 ? 25 : 30);
    // Deep bench: +88% on a 4.25-point average is noise, not a streak
    await game('Bench Guy', 'BOS', 'DET', date, 8, i < 5 ? 2 : 8);
    await game('Bench Cold', 'BOS', 'DET', date, 8, i < 5 ? 8 : 2);
    // Traded mid-season: 4 games for DET then 4 for BOS, one player
    if (i < 4) await game('Traded Hot', 'DET', 'BOS', date, 30, 20);
    else await game('Traded Hot', 'BOS', 'DET', date, 30, i === 4 ? 20 : 40);
  }
  // Hot Guy's latest row is a minutes=0 listing; it must not drag last-3 down
  await game('Hot Guy', 'BOS', 'DET', d(16), 0, 0);
  // Big prior-season games must not inflate the 2025-26 season average
  for (const i of [0, 1, 2, 3]) await game('Hot Guy', 'BOS', 'DET', lastSeason(i), 36, 60);

  // ── Consistency / boom-bust (PHX, CHA) ─────────────────────────────
  for (let i = 0; i < 10; i++) {
    await game('Steady Eddie', 'PHX', 'CHA', d(2 * i), 30, 30);
    await game('Outlier Al', 'PHX', 'CHA', d(2 * i), 30, i === 9 ? 50 : 30);
    await game('Swingy Sam', 'PHX', 'CHA', d(2 * i), 30, i % 2 ? 38 : 22);
    await game('Boom Bob', 'CHA', 'PHX', d(2 * i), 30, i % 2 ? 65 : 5);
  }

  // ── Diacritics (LAL) ───────────────────────────────────────────────
  for (let i = 0; i < 8; i++) {
    const opp = i < 2 ? 'BOS' : 'SAC';
    await game('Luka Dončić', 'LAL', opp, d(1 + 2 * i), 36, i < 2 ? 60 : 40);
  }
  for (const i of [0, 1]) await game('Luka Dončić', 'LAL', 'BOS', lastSeason(i), 36, 70);

  // Latest game in the data is on END (default window anchor)
  await game('Filler Guy', 'UTA', 'SAS', END, 10, 5);
}

before(async () => {
  db = (await import('../src/config/database.js')).default;
  const { createTables } = await import('../src/config/schema.js');
  await createTables(db);
  ({ playerKey } = await import('../src/utils/playerKey.js'));
  ({ seasonForDate } = await import('../src/utils/season.js'));
  insights = (await import('../src/services/insightsService.js')).default;
  await seed();

  const app = express();
  app.use(express.json());
  app.use('/api/historical', (await import('../src/routes/historical.js')).default);
  await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}/api/historical`;
});

after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  db?.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

afterEach(() => vi.restoreAllMocks());

const names = (rows, field = 'player_name') => rows.map(r => r[field]);

describe('resolveWindow', () => {
  test('lastNDays counts back from endDate', async () => {
    const w = await insights.resolveWindow({ endDate: '2026-03-31', lastNDays: 30 });
    assert.equal(w.startDate, '2026-03-01');
    assert.equal(w.endDate, '2026-03-31');
    assert.equal(w.season, '2025-26');
    assert.equal(w.seasonStartDate, '2025-10-21');
  });

  test('without endDate, anchors on the latest game in the data (not the wall clock)', async () => {
    const w = await insights.resolveWindow({ lastNDays: 7 });
    assert.equal(w.endDate, END);
    assert.equal(w.startDate, '2026-03-24');
  });

  test('defaultLastNDays applies only when no start is given', async () => {
    assert.equal((await insights.resolveWindow({ endDate: END }, { defaultLastNDays: 30 })).startDate, '2026-03-01');
    assert.equal((await insights.resolveWindow({ endDate: END, startDate: '2026-02-01' }, { defaultLastNDays: 30 })).startDate, '2026-02-01');
    assert.equal((await insights.resolveWindow({ endDate: END })).startDate, null);
  });

  test('rejects malformed dates and windows', async () => {
    await assert.rejects(insights.resolveWindow({ endDate: '03/31/2026' }), e => e.status === 400);
    await assert.rejects(insights.resolveWindow({ lastNDays: 0 }), e => e.status === 400);
    await assert.rejects(insights.resolveWindow({ startDate: '2026-04-01', endDate: '2026-03-01' }), e => e.status === 400);
  });
});

describe('streaks', () => {
  test('hot streaks: last 3 vs current-season average, ignoring minutes=0 rows', async () => {
    const hot = await insights.getHotStreaks({ endDate: END, minGames: 5 });
    const guy = hot.find(r => r.player_name === 'Hot Guy');
    assert.ok(guy, 'Hot Guy should be hot');
    assert.equal(guy.total_games, 8);
    assert.equal(guy.season_avg, 27.5); // 2024-25 60s excluded
    assert.equal(guy.last3_avg, 40);    // minutes=0 row excluded
    assert.equal(guy.hot_streak_pct, 45.5);
    assert.equal(guy.team, 'BOS');
  });

  test('one threshold (15%) for hot and cold', async () => {
    const hot = await insights.getHotStreaks({ endDate: END, minGames: 5 });
    assert.ok(!names(hot).includes('Mild Guy'), '+11.6% is below the 15% threshold');
    const cold = await insights.getColdStreaks({ endDate: END, minGames: 5 });
    const guy = cold.find(r => r.player_name === 'Cold Guy');
    assert.equal(guy.cold_streak_pct, -38.5);
    assert.ok(cold.every(r => r.cold_streak_pct <= -15));
    assert.ok(hot.every(r => r.hot_streak_pct >= 15));
    assert.equal(insights.STREAK_THRESHOLD_PCT, 15);
  });

  test('minAvg (default 15) drops low-average players from both cards', async () => {
    assert.equal(insights.STREAK_MIN_AVG, 15);
    const hot = await insights.getHotStreaks({ endDate: END, minGames: 5 });
    const cold = await insights.getColdStreaks({ endDate: END, minGames: 5 });
    assert.ok(!names(hot).includes('Bench Guy'));
    assert.ok(!names(cold).includes('Bench Cold'));
    assert.ok(hot.every(r => r.season_avg >= 15));
    assert.ok(cold.every(r => r.season_avg >= 15));

    const allHot = await insights.getHotStreaks({ endDate: END, minGames: 5, minAvg: 0 });
    assert.equal(allHot.find(r => r.player_name === 'Bench Guy').hot_streak_pct, 88.2);
    const allCold = await insights.getColdStreaks({ endDate: END, minGames: 5, minAvg: 0 });
    assert.ok(names(allCold).includes('Bench Cold'));

    // Cold Guy averages 32.5
    const strict = await insights.getColdStreaks({ endDate: END, minGames: 5, minAvg: 33 });
    assert.ok(!names(strict).includes('Cold Guy'));
  });

  test('groups a traded player by player_key, not (name, team)', async () => {
    const hot = await insights.getHotStreaks({ endDate: END, minGames: 8 });
    const traded = hot.find(r => r.player_name === 'Traded Hot');
    assert.ok(traded, 'needs all 8 games across DET and BOS');
    assert.equal(traded.total_games, 8);
    assert.equal(traded.team, 'BOS');
  });

  test('uses the requested site column', async () => {
    const dk = await insights.getHotStreaks({ endDate: END, minGames: 5, site: 'dk' });
    const fd = await insights.getHotStreaks({ endDate: END, minGames: 5, site: 'fd' });
    assert.ok(names(dk).includes('Hot Guy'));
    assert.ok(!names(fd).includes('Hot Guy'), 'flat 30 FD points is not a streak');
  });

  test('sorted hottest / coldest first and limited', async () => {
    const hot = await insights.getHotStreaks({ endDate: END, minGames: 5, limit: 1 });
    assert.equal(hot.length, 1);
    const all = await insights.getHotStreaks({ endDate: END, minGames: 5 });
    assert.deepEqual(all.map(r => r.hot_streak_pct), [...all.map(r => r.hot_streak_pct)].sort((a, b) => b - a));
  });
});

describe('consistency and boom/bust', () => {
  test('sd = 0 scores 100 instead of Infinity', async () => {
    const leaders = await insights.getConsistencyLeaders({ endDate: END });
    const eddie = leaders.find(r => r.player_name === 'Steady Eddie');
    assert.equal(eddie.std_dev, 0);
    assert.equal(eddie.consistency_score, 100);
    assert.equal(leaders[0].player_name, 'Steady Eddie');
  });

  test('leaders are picked and ordered by coefficient of variation, not range', async () => {
    // Outlier Al: one 50 among 30s (range/avg .625, cv .1875)
    // Swingy Sam: 22/38 alternating (range/avg .533, cv .267)
    const leaders = await insights.getConsistencyLeaders({ endDate: END, limit: 4 });
    assert.deepEqual(names(leaders), ['Steady Eddie', 'Mild Guy', 'Jaren Jackson Jr.', 'Outlier Al']);
    const al = leaders[3];
    assert.equal(al.std_dev, 6);
    assert.equal(al.consistency_score, 81.3);
    assert.equal(al.games, 10);
    const full = await insights.getConsistencyLeaders({ endDate: END });
    assert.ok(names(full).indexOf('Outlier Al') < names(full).indexOf('Swingy Sam'));
    const scores = full.map(r => r.consistency_score);
    assert.deepEqual(scores, [...scores].sort((a, b) => b - a));
  });

  test('boom/bust ranks by standard deviation with boom and bust rates', async () => {
    const players = await insights.getBoomBustPlayers({ endDate: END });
    assert.equal(players[0].player_name, 'Boom Bob');
    assert.equal(players[0].std_dev, 30);
    assert.equal(players[0].boom_rate, 50);
    assert.equal(players[0].bust_rate, 50);
    assert.equal(players[0].upside_score, 30);
    const sds = players.map(r => r.std_dev);
    assert.deepEqual(sds, [...sds].sort((a, b) => b - a));
  });

  test('date window limits the games considered', async () => {
    // Only Outlier Al's last game (the 50) is after 2026-03-18
    const leaders = await insights.getConsistencyLeaders({ startDate: '2026-03-01', endDate: '2026-03-17', minGames: 8 });
    const al = leaders.find(r => r.player_name === 'Outlier Al');
    assert.equal(al.games, 9);
    assert.equal(al.consistency_score, 100);
  });
});

describe('slate insights', () => {
  const slate = [
    { name: 'Luka Doncic', team: 'LAL', opponent: 'BOS', salary: 11000, projected_points: 52 },
    { name: 'Jaren Jackson', team: 'MEM', opponent: 'NOP' },
    { name: 'Hot Guy', team: 'BOS', opponent: 'LAL' },
    { name: 'Cold Guy', team: 'BOS', opponent: 'LAL' },
    { name: 'Steady Eddie', team: 'PHX', opponent: 'CHA' },
    { name: 'Boom Bob', team: 'CHA', opponent: 'PHX' },
  ];

  test('matches history by player_key (diacritics, Jr.)', async () => {
    const result = await insights.getSlateInsights(slate, { endDate: END });
    const all = Object.values(result).flat();
    const luka = all.find(p => p.name === 'Luka Doncic');
    assert.ok(luka, 'Luka Dončić history should match "Luka Doncic"');
    assert.equal(luka.games, 8);
    assert.equal(luka.seasonAvg, 45);
    assert.equal(luka.salary, 11000);
    assert.equal(luka.projection, 52);
    // vs BOS over the whole window: two 60s this season, two 70s last season
    assert.equal(luka.matchupGames, 4);
    assert.equal(luka.matchupAvg, 65);
    assert.ok(result.matchupAdvantages.some(p => p.name === 'Luka Doncic'));
    assert.ok(all.some(p => p.name === 'Jaren Jackson'), 'Jaren Jackson Jr. should match "Jaren Jackson"');
  });

  test('sorts players into each card with shared definitions', async () => {
    const result = await insights.getSlateInsights(slate, { endDate: END });
    assert.deepEqual(Object.keys(result).sort(), [
      'boomCandidates', 'coldStreaks', 'consistentPlays', 'hotStreaks', 'matchupAdvantages', 'recentPerformers'
    ]);
    const hot = result.hotStreaks.find(p => p.name === 'Hot Guy');
    assert.equal(hot.hotStreakPct, 45.5);
    assert.equal(hot.last3Avg, 40);
    assert.equal(hot.last3Scores, '40,40,40');
    assert.ok(result.coldStreaks.some(p => p.name === 'Cold Guy'));
    const eddie = result.consistentPlays.find(p => p.name === 'Steady Eddie');
    assert.equal(eddie.consistencyScore, 100);
    const bob = result.boomCandidates.find(p => p.name === 'Boom Bob');
    assert.equal(bob.boomRate, 50);
    assert.ok(result.recentPerformers.some(p => p.name === 'Luka Doncic'));
    assert.ok(!result.recentPerformers.some(p => p.name === 'Cold Guy'));
  });

  test('hot/cold cards use the same minimum average', async () => {
    const bench = [{ name: 'Bench Guy', team: 'BOS' }, { name: 'Bench Cold', team: 'BOS' }];
    const result = await insights.getSlateInsights(bench, { endDate: END });
    assert.deepEqual(result.hotStreaks, []);
    assert.deepEqual(result.coldStreaks, []);
    const loose = await insights.getSlateInsights(bench, { endDate: END, minAvg: 0 });
    assert.deepEqual(loose.hotStreaks.map(p => p.name), ['Bench Guy']);
    assert.deepEqual(loose.coldStreaks.map(p => p.name), ['Bench Cold']);
  });

  test('accepts a trimmed payload (names and teams only)', async () => {
    const result = await insights.getSlateInsights(
      [{ name: 'Hot Guy', team: 'BOS' }, { name: 'Luka Doncic', team: 'LAL' }], { endDate: END }
    );
    assert.ok(result.hotStreaks.some(p => p.name === 'Hot Guy'));
    const luka = Object.values(result).flat().find(p => p.name === 'Luka Doncic');
    assert.equal(luka.matchupGames, 0);
    assert.equal(luka.salary, null);
  });

  test('query count does not grow with the slate size', async () => {
    const all = vi.spyOn(db, 'all');
    const get = vi.spyOn(db, 'get');
    await insights.getSlateInsights(slate.slice(0, 2), { endDate: END });
    const small = all.mock.calls.length + get.mock.calls.length;
    all.mockClear(); get.mockClear();
    await insights.getSlateInsights(slate, { endDate: END });
    const large = all.mock.calls.length + get.mock.calls.length;
    assert.equal(large, small);
    assert.ok(large <= 3, `expected a few set-based queries, got ${large}`);
  });
});

describe('missing players and usage bumps', () => {
  const memSlate = [{ name: 'Ja Morant', team: 'MEM', salary: 9000, projected_points: 40 }, { name: 'Reggie Jackson', team: 'MEM' }];

  test('missing players match on player_key, not last name', async () => {
    // Old code treated "Reggie Jackson" on the slate as Jaren Jackson Jr.
    const report = await insights.getMissingPlayersReport(memSlate, { endDate: END });
    assert.equal(report.length, 1);
    assert.equal(report[0].team, 'MEM');
    assert.deepEqual(report[0].missingPlayers.map(p => p.name), ['Jaren Jackson Jr.', 'Six Game Guy']);
    const jjj = report[0].missingPlayers[0];
    assert.equal(jjj.games, 8);
    assert.equal(jjj.avgDk, 40);
  });

  test('a player traded away is not missing from his old team', async () => {
    const report = await insights.getMissingPlayersReport(memSlate, { endDate: END });
    assert.ok(!report[0].missingPlayers.some(p => p.name === 'Traded Guy'));
  });

  test('minGames is honored without a hidden cap', async () => {
    const report = await insights.getMissingPlayersReport(memSlate, { endDate: END, minGames: 8 });
    assert.deepEqual(report[0].missingPlayers.map(p => p.name), ['Jaren Jackson Jr.']);
  });

  test('the date window decides who counts as a regular', async () => {
    const recent = await insights.getMissingPlayersReport(memSlate, { endDate: END });
    assert.ok(!recent[0].missingPlayers.some(p => p.name === 'Old Guy'));
    const wide = await insights.getMissingPlayersReport(memSlate, { endDate: END, lastNDays: 120 });
    assert.ok(wide[0].missingPlayers.some(p => p.name === 'Old Guy'));
    // Backtest: anchoring on an old endDate looks at that period, not "now"
    const jan = await insights.getMissingPlayersReport(memSlate, { endDate: '2026-01-31' });
    assert.deepEqual(jan[0].missingPlayers.map(p => p.name), ['Old Guy']);
  });

  test('usage bump compares games with vs without, only while the missing player was on the team', async () => {
    const bumps = await insights.detectUsageBumps(memSlate, { endDate: END });
    assert.equal(bumps.length, 1);
    const ja = bumps[0];
    assert.equal(ja.player, 'Ja Morant');
    assert.equal(ja.missingPlayer, 'Jaren Jackson Jr.');
    // Without: minutes=0 row + INACTIVE + DNP. January (pre-trade) and 2024-25 excluded
    assert.equal(ja.gamesWithout, 3);
    assert.equal(ja.gamesWith, 8);
    assert.equal(ja.avgWithout, 30);
    assert.equal(ja.avgWith, 20);
    assert.equal(ja.pctBump, 50);
    assert.equal(ja.dkBump, 10);
    assert.equal(ja.salary, 9000);
    assert.equal(ja.bumpedProjection, 60);
  });

  test('usage bumps accept a site and trimmed payload', async () => {
    const bumps = await insights.detectUsageBumps(
      [{ name: 'Ja Morant', team: 'MEM' }, { name: 'Reggie Jackson', team: 'MEM' }], { endDate: END, site: 'yahoo' }
    );
    assert.equal(bumps[0].avgWithout, 30);
    assert.equal(bumps[0].bumpedProjection, 30); // no projection supplied: falls back to avgWithout
  });

  test('query count does not grow with the slate size', async () => {
    const all = vi.spyOn(db, 'all');
    await insights.detectUsageBumps(memSlate.slice(0, 1), { endDate: END });
    const small = all.mock.calls.length;
    all.mockClear();
    await insights.detectUsageBumps([...memSlate, { name: 'Hot Guy', team: 'BOS' }, { name: 'Luka Doncic', team: 'LAL' }], { endDate: END });
    assert.equal(all.mock.calls.length, small);
    assert.ok(small <= 3);
  });
});

describe('site handling', () => {
  test('accepts dk/fd/yahoo aliases and rejects unknown sites', () => {
    assert.equal(insights.normalizeSite('dk'), 'draftkings');
    assert.equal(insights.normalizeSite('FD'), 'fanduel');
    assert.equal(insights.normalizeSite('yahoo'), 'yahoo');
    assert.equal(insights.normalizeSite(undefined), undefined);
    assert.throws(() => insights.normalizeSite('superdraft'), e => e.status === 400);
  });
});

describe('routes', () => {
  const post = (url, body) => fetch(`${baseUrl}${url}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });

  test('GET /hot-streaks passes window and site through', async () => {
    const res = await fetch(`${baseUrl}/hot-streaks?endDate=${END}&minGames=5&site=fd`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.site, 'fanduel');
    assert.ok(!body.hotStreaks.some(r => r.player_name === 'Hot Guy'));
    const dk = await (await fetch(`${baseUrl}/hot-streaks?endDate=${END}&minGames=5`)).json();
    assert.ok(dk.hotStreaks.some(r => r.player_name === 'Hot Guy'));
  });

  test('GET hot/cold streaks take minAvg', async () => {
    const strict = await (await fetch(`${baseUrl}/hot-streaks?endDate=${END}&minGames=5`)).json();
    assert.ok(!strict.hotStreaks.some(r => r.player_name === 'Bench Guy'));
    const loose = await (await fetch(`${baseUrl}/hot-streaks?endDate=${END}&minGames=5&minAvg=0`)).json();
    assert.ok(loose.hotStreaks.some(r => r.player_name === 'Bench Guy'));
    assert.equal((await fetch(`${baseUrl}/cold-streaks?minAvg=-1`)).status, 400);
    assert.equal((await fetch(`${baseUrl}/cold-streaks?minAvg=abc`)).status, 400);
  });

  test('GET league cards keep their response keys', async () => {
    const cold = await (await fetch(`${baseUrl}/cold-streaks?endDate=${END}`)).json();
    assert.ok(cold.coldStreaks.some(r => r.player_name === 'Cold Guy'));
    const cons = await (await fetch(`${baseUrl}/consistency-leaders?endDate=${END}&limit=1`)).json();
    assert.equal(cons.leaders[0].player_name, 'Steady Eddie');
    const boom = await (await fetch(`${baseUrl}/boom-bust-players?endDate=${END}`)).json();
    assert.equal(boom.players[0].player_name, 'Boom Bob');
  });

  test('bad site, date or number is a 400', async () => {
    assert.equal((await fetch(`${baseUrl}/hot-streaks?site=nope`)).status, 400);
    assert.equal((await fetch(`${baseUrl}/hot-streaks?endDate=yesterday`)).status, 400);
    assert.equal((await fetch(`${baseUrl}/consistency-leaders?minGames=abc`)).status, 400);
    assert.equal((await post('/slate-insights', { players: [{ team: 'BOS' }] })).status, 400);
  });

  test('POST /slate-insights accepts a trimmed payload', async () => {
    const res = await post('/slate-insights', { players: [{ name: 'Hot Guy', team: 'BOS' }], endDate: END });
    assert.equal(res.status, 200);
    const { insights: result } = await res.json();
    assert.ok(result.hotStreaks.some(p => p.name === 'Hot Guy'));
    assert.equal(result.b2bPlayers, undefined);
  });

  test('POST /usage-bumps and /missing-players take the date window', async () => {
    const players = [{ name: 'Ja Morant', team: 'MEM' }, { name: 'Reggie Jackson', team: 'MEM' }];
    const bumps = await (await post('/usage-bumps', { players, endDate: END })).json();
    assert.equal(bumps.usageBumps[0].missingPlayer, 'Jaren Jackson Jr.');
    const missing = await (await post('/missing-players', { players, endDate: '2026-01-31', lastNDays: 30 })).json();
    assert.deepEqual(missing.report[0].missingPlayers.map(p => p.name), ['Old Guy']);
  });
});
