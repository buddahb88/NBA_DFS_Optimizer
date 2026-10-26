import { test, describe, vi, beforeAll as before, afterAll as after, beforeEach } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';

// Opportunity metrics: per-player minutes / usage / FPPM / shot volume /
// shooting / role / value / rest / environment, from games before the slate date.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nba-dfs-opportunity-'));
process.env.DATABASE_TYPE = 'sqlite';
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');

const { computePlayerMetrics, splitSample } = await import('../src/services/opportunity/playerMetrics.js');
const { computeTeamContext, gameEnvironment } = await import('../src/services/opportunity/teamContext.js');

const close = (actual, expected, eps = 0.002) =>
  assert.ok(Math.abs(actual - expected) <= eps, `expected ${expected}, got ${actual}`);

const addDays = (date, n) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

// Team totals for every seeded game: 115 plays (90 FGA + 0.44*25 FTA + 14 TOV)
const TEAM = { tm_minutes: 240, tm_fgm: 40, tm_fga: 90, tm_fta: 25, tm_tov: 14, tm_oreb: 10, tm_dreb: 35,
  opp_fga: 88, opp_fg3a: 35, opp_oreb: 10, opp_dreb: 33, opp_possessions: 100 };
const BENCH = { minutes: 18, is_starter: 0, fg_made: 4, fg_attempted: 8, fg3_attempted: 2, ft_made: 0, ft_attempted: 0,
  turnovers: 2, points: 10, fouls: 2, fp: 22 };
const STARTER = { minutes: 36, is_starter: 1, fg_made: 9, fg_attempted: 18, fg3_attempted: 6, ft_made: 4, ft_attempted: 5,
  turnovers: 3, points: 24, fouls: 3, fp: 40 };

/** Games most recent first; `lines` oldest first, one per game, every other day before `before`. */
function log(lines, { season = '2026-27', before = '2026-11-20' } = {}) {
  return lines.map((line, i) => ({
    player_key: 'riser', season, game_date: addDays(before, -2 * (lines.length - i)),
    assists: 2, steals: 1, blocks: 0, oreb: 1, dreb: 4, fg3_made: 1, ...TEAM, ...line
  })).reverse();
}

// 9 bench games, then 3 starts
const RISER = log([...Array(9).fill(BENCH), ...Array(3).fill(STARTER)]);

// Usage as playerProfileService: Σ(FGA + 0.44 FTA + TOV) / Σ share·TmPlays
function usage(games) {
  let used = 0;
  let plays = 0;
  for (const g of games) {
    used += g.fg_attempted + 0.44 * g.ft_attempted + g.turnovers;
    plays += (g.minutes / 48) * (90 + 0.44 * 25 + 14);
  }
  return used / plays;
}
const sum = (games, f) => games.reduce((s, g) => s + f(g), 0);
const tsa = (g) => g.fg_attempted + 0.44 * g.ft_attempted;

describe('computePlayerMetrics', () => {
  const m = computePlayerMetrics(RISER, { season: '2026-27', salary: 5000 });
  const l5 = RISER.slice(0, 5);
  const l10 = RISER.slice(0, 10);

  test('minutes trend: L3 / L5 / L10 / season and deltas', () => {
    assert.equal(m.min_l3, 36);
    close(m.min_l5, (3 * 36 + 2 * 18) / 5);
    close(m.min_l10, (3 * 36 + 7 * 18) / 10);
    close(m.min_season, (3 * 36 + 9 * 18) / 12);
    close(m.min_delta_l3, 36 - 22.5);
    close(m.min_delta_l5, 28.8 - 22.5);
    assert.equal(m.games_l3, 3);
    assert.equal(m.games_l5, 5);
    assert.equal(m.games_l10, 10);
    assert.equal(m.games_season, 12);
  });

  test('starting role: started last game, starts in L5, moved into the lineup', () => {
    assert.equal(m.started_last_game, true);
    assert.equal(m.starts_l5, 3);
    assert.equal(m.starter_change, 'into');

    const benched = computePlayerMetrics(log([...Array(5).fill(STARTER), BENCH]), { season: '2026-27' });
    assert.equal(benched.started_last_game, false);
    assert.equal(benched.starter_change, 'out');

    // The flip happened four games ago: not a change in the last 3
    const settled = computePlayerMetrics(log([BENCH, BENCH, STARTER, STARTER, STARTER, STARTER]), { season: '2026-27' });
    assert.equal(settled.starter_change, null);
  });

  test('usage L5 vs season uses the profile formula with team totals', () => {
    close(m.usg_l5, usage(l5), 0.0005);
    close(m.usg_season, usage(RISER), 0.0005);
    close(m.usg_delta, usage(l5) - usage(RISER), 0.0005);
  });

  test('FPPM L10 vs season on the site points', () => {
    close(m.fppm_l10, sum(l10, g => g.fp) / sum(l10, g => g.minutes));
    close(m.fppm_season, sum(RISER, g => g.fp) / sum(RISER, g => g.minutes));
    close(m.fppm_delta, m.fppm_l10 - m.fppm_season, 0.003);
  });

  test('shot volume: true shot attempts and 3PA per 36, L5 vs season', () => {
    close(m.tsa36_l5, 36 * sum(l5, tsa) / sum(l5, g => g.minutes), 0.05); // per-36 values are rounded to 0.1
    close(m.tsa36_season, 36 * sum(RISER, tsa) / sum(RISER, g => g.minutes), 0.05); // per-36 values are rounded to 0.1
    close(m.fg3a36_l5, 36 * sum(l5, g => g.fg3_attempted) / sum(l5, g => g.minutes), 0.05); // per-36 values are rounded to 0.1
    close(m.fg3a36_season, 36 * sum(RISER, g => g.fg3_attempted) / sum(RISER, g => g.minutes), 0.05); // per-36 values are rounded to 0.1
  });

  test('shooting: TS% L5 vs season and the gap', () => {
    close(m.ts_l5, sum(l5, g => g.points) / (2 * sum(l5, tsa)));
    close(m.ts_season, sum(RISER, g => g.points) / (2 * sum(RISER, tsa)));
    close(m.ts_gap, m.ts_l5 - m.ts_season, 0.002);
  });

  test('role stability: minutes stdev, games under 20 minutes, fouls per 36 (L10)', () => {
    const mins = l10.map(g => g.minutes);
    const mean = mins.reduce((a, b) => a + b, 0) / mins.length;
    const sd = Math.sqrt(mins.reduce((s, x) => s + (x - mean) ** 2, 0) / mins.length);
    close(m.min_sd_l10, sd, 0.01);
    assert.equal(m.under20_l10, 7);
    close(m.fouls36_l10, 36 * sum(l10, g => g.fouls) / sum(l10, g => g.minutes), 0.05); // per-36 values are rounded to 0.1
  });

  test('value hit rates at tonight\'s salary over L10', () => {
    // $5,000: 4x = 20 (bench 22 and starter 40 hit), 5x = 25 and 6x = 30 (starters only)
    assert.equal(m.value_games_l10, 10);
    assert.equal(m.hit4x_l10, 1);
    assert.equal(m.hit5x_l10, 0.3);
    assert.equal(m.hit6x_l10, 0.3);
    const noSalary = computePlayerMetrics(RISER, { season: '2026-27' });
    assert.equal(noSalary.hit5x_l10, null);
  });

  test('shooting flag: bounce-back when volume holds but TS% sags >= 6 pts, fade when it runs hot', () => {
    const cold = { ...BENCH, fg_made: 2, points: 5 };
    const hot = { ...BENCH, fg_made: 6, points: 15 };
    const bounce = computePlayerMetrics(log([...Array(10).fill(BENCH), ...Array(5).fill(cold)]), { season: '2026-27' });
    assert.ok(bounce.ts_gap <= -0.06);
    assert.equal(bounce.shooting_flag, 'bounce_back');
    const fade = computePlayerMetrics(log([...Array(10).fill(BENCH), ...Array(5).fill(hot)]), { season: '2026-27' });
    assert.equal(fade.shooting_flag, 'fade');
    // Cold, but on half the volume: not a like-for-like regression signal
    const lowVolume = { ...BENCH, fg_attempted: 4, fg_made: 1, points: 2 };
    const changed = computePlayerMetrics(log([...Array(10).fill(BENCH), ...Array(5).fill(lowVolume)]), { season: '2026-27' });
    assert.ok(changed.ts_gap <= -0.06);
    assert.equal(changed.shooting_flag, null);
    assert.equal(m.shooting_flag, null);
  });

  test('no games: every metric null, sample sizes 0', () => {
    const empty = computePlayerMetrics([], { season: '2026-27', salary: 5000 });
    assert.equal(empty.games_season, 0);
    assert.equal(empty.games_l10, 0);
    assert.equal(empty.min_l3, null);
    assert.equal(empty.usg_l5, null);
    assert.equal(empty.hit5x_l10, null);
    assert.equal(empty.started_last_game, null);
    assert.equal(empty.season_fallback, false);
  });
});

describe('splitSample (current season first, last season under 3 games)', () => {
  const last = log(Array(10).fill(BENCH), { season: '2025-26', before: '2026-04-10' });

  test('3+ current-season games: current season only', () => {
    const s = splitSample([...RISER, ...last], '2026-27');
    assert.equal(s.fallback, false);
    assert.equal(s.baselineSeason, '2026-27');
    assert.equal(s.recent.length, 12);
    assert.equal(s.baseline.length, 12);
  });

  test('under 3 current-season games: recent windows span both seasons, baseline is last season, flagged', () => {
    const current = RISER.slice(0, 2);
    const s = splitSample([...current, ...last], '2026-27');
    assert.equal(s.fallback, true);
    assert.equal(s.baselineSeason, '2025-26');
    assert.equal(s.currentGames, 2);
    assert.equal(s.recent.length, 12);
    assert.deepEqual(s.recent.slice(0, 2), current);
    assert.equal(s.baseline.length, 10);
    assert.ok(s.baseline.every(g => g.season === '2025-26'));

    const m = computePlayerMetrics([...current, ...last], { season: '2026-27' });
    assert.equal(m.season_fallback, true);
    assert.equal(m.baseline_season, '2025-26');
    assert.equal(m.current_season_games, 2);
    close(m.min_l3, (36 + 36 + 18) / 3);
    assert.equal(m.min_season, 18);
  });

  test('a rookie with under 3 games and no prior season is not flagged', () => {
    const s = splitSample(RISER.slice(0, 2), '2026-27');
    assert.equal(s.fallback, false);
    assert.equal(s.baselineSeason, '2026-27');
    assert.equal(s.baseline.length, 2);
  });
});

describe('team context and game environment', () => {
  const teamGames = (n, { before = '2026-11-20', poss = 100, season = '2026-27', gap = 2 } = {}) =>
    Array.from({ length: n }, (_, i) => ({ season, game_date: addDays(before, -gap * (i + 1)), possessions: poss + i }));

  test('pace is the L10 average of possessions; rest from the last team game', () => {
    const ctx = computeTeamContext(teamGames(12), { season: '2026-27', slateDate: '2026-11-20' });
    close(ctx.pace_l10, 104.5);
    assert.equal(ctx.pace_games, 10);
    assert.equal(ctx.last_game_date, '2026-11-18');
    assert.equal(ctx.rest_days, 1);
    assert.equal(ctx.back_to_back, false);

    const b2b = computeTeamContext(teamGames(5, { gap: 1 }), { season: '2026-27', slateDate: '2026-11-20' });
    assert.equal(b2b.rest_days, 0);
    assert.equal(b2b.back_to_back, true);
  });

  test('environment: implied total, O/U, spread, blowout flag, pace proxy', () => {
    const team = computeTeamContext(teamGames(10, { poss: 100 }), { season: '2026-27', slateDate: '2026-11-20' });
    const opp = computeTeamContext(teamGames(10, { poss: 90 }), { season: '2026-27', slateDate: '2026-11-20' });
    const env = gameEnvironment({ vegas_implied_total: 118.5, vegas_over_under: 229, vegas_spread: -10.5 }, team, opp);
    assert.equal(env.implied_total, 118.5);
    assert.equal(env.over_under, 229);
    assert.equal(env.spread, -10.5);
    assert.equal(env.blowout, true);
    close(env.team_pace_l10, 104.5);
    close(env.opp_pace_l10, 94.5);
    close(env.pace_proxy, 99.5);
    assert.equal(gameEnvironment({ vegas_spread: 9.5 }, team, opp).blowout, false);
    assert.equal(gameEnvironment({}, null, null).blowout, null);
  });
});

// ---------------------------------------------------------------------------
// Service + route against a seeded DB
// ---------------------------------------------------------------------------

let db;
let metrics;
let playerKey;
let server;
let baseUrl;

const SLATE_DATE = '2026-11-20';
const NOW = new Date('2026-11-25T16:00:00Z'); // the slate is in the past: backtest

async function boxScore(name, team, opp, date, line, { season = '2026-27', fp } = {}) {
  const gameId = `${date}-${[team, opp].sort().join('-')}`;
  const pts = fp ?? line.fp;
  await db.run(`
    INSERT INTO historical_games (player_name, player_key, team, opponent, game_id, game_date, season, season_type,
      minutes, points, rebounds, assists, steals, blocks, turnovers, fouls, fg_made, fg_attempted, fg3_made, fg3_attempted,
      ft_made, ft_attempted, oreb, dreb, is_starter, dk_fantasy_points, fd_fantasy_points, yahoo_fantasy_points)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'regular', ?, ?, 5, 2, 1, 0, ?, ?, ?, ?, 1, ?, ?, ?, 1, 4, ?, ?, ?, ?)
  `, name, playerKey(name), team, opp, gameId, date, season, line.minutes, line.points, line.turnovers, line.fouls,
  line.fg_made, line.fg_attempted, line.fg3_attempted, line.ft_made, line.ft_attempted, line.is_starter,
  pts, pts + 5, pts + 2);
  for (const [t, o, poss] of [[team, opp, 100], [opp, team, 96]]) {
    await db.run(`
      INSERT OR IGNORE INTO team_game_stats (game_id, game_date, season, season_type, team, opponent,
        minutes, fgm, fga, fta, tov, oreb, dreb, possessions)
      VALUES (?, ?, ?, 'regular', ?, ?, 240, 40, 90, 25, 14, 10, 35, ?)
    `, gameId, date, season, t, o, poss);
  }
}

async function snapshot(name, team, opp, { salary, implied, spread, ou = 230, site = 'draftkings', slateId = 'S1' }) {
  await db.run(`
    INSERT INTO slate_player_snapshots (snapshot_date, game_date, site, slate_id, player_key, player_name, team, opponent, position,
      salary, projected_points, projected_minutes, vegas_implied_total, vegas_spread, over_under)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'SF', ?, 30, 30, ?, ?, ?)
  `, SLATE_DATE, SLATE_DATE, site, slateId, playerKey(name), name, team, opp, salary, implied, spread, ou);
}

async function seed() {
  // Riser: 9 bench games then 3 starts, all before the slate date
  for (const [i, line] of [...Array(9).fill(BENCH), ...Array(3).fill(STARTER)].entries()) {
    await boxScore('Riser Guy', 'BOS', 'NYK', addDays(SLATE_DATE, -2 * (12 - i)), line);
  }
  // Last season (ignored: 12 current-season games) and games on / after the slate date (lookahead)
  await boxScore('Riser Guy', 'BOS', 'NYK', '2026-03-01', { ...STARTER, minutes: 48 }, { season: '2025-26' });
  await boxScore('Riser Guy', 'BOS', 'NYK', SLATE_DATE, { ...STARTER, minutes: 48, fp: 90 });
  await boxScore('Riser Guy', 'BOS', 'NYK', addDays(SLATE_DATE, 2), { ...STARTER, minutes: 48, fp: 90 });

  // Fallback Guy: two current-season games, ten last season
  for (let i = 0; i < 10; i++) {
    await boxScore('Fallback Guy', 'BOS', 'NYK', addDays('2026-04-01', -2 * i), BENCH, { season: '2025-26' });
  }
  for (const date of [addDays(SLATE_DATE, -4), addDays(SLATE_DATE, -2)]) {
    await boxScore('Fallback Guy', 'BOS', 'NYK', date, STARTER);
  }

  await snapshot('Riser Guy', 'BOS', 'NYK', { salary: 5000, implied: 118, spread: -11 });
  await snapshot('Fallback Guy', 'BOS', 'NYK', { salary: 4000, implied: 118, spread: -11 });
  await snapshot('No History', 'NYK', 'BOS', { salary: 3000, implied: 107, spread: 11 });
  // Same night on FanDuel (smaller slate)
  await snapshot('Riser Guy', 'BOS', 'NYK', { salary: 7000, implied: 118, spread: -11, site: 'fanduel', slateId: 'F1' });
}

before(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  db = (await import('../src/config/database.js')).default;
  await (await import('../src/config/schema.js')).createTables(db);
  metrics = await import('../src/services/opportunity/metricsService.js');
  ({ playerKey } = await import('../src/utils/playerKey.js'));
  await seed();

  const router = (await import('../src/routes/opportunity.js')).default;
  const app = express();
  app.use('/api/opportunity', router);
  await new Promise(resolve => { server = app.listen(0, resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  vi.restoreAllMocks();
  await new Promise(resolve => server.close(resolve));
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => metrics.clearOpportunityCache());

const byName = (rows) => Object.fromEntries(rows.map(r => [r.name, r]));

describe('getOpportunityMetrics (backtest date)', () => {
  test('one row per slate player with metrics and sample sizes', async () => {
    const result = await metrics.getOpportunityMetrics({ slateDate: SLATE_DATE, site: 'draftkings', now: NOW });
    assert.equal(result.source.isBacktest, true);
    assert.equal(result.slateDate, SLATE_DATE);
    assert.equal(result.season, '2026-27');
    assert.equal(result.players.length, 3);

    const rows = byName(result.players);
    const riser = rows['Riser Guy'];
    assert.equal(riser.games_season, 12);
    assert.equal(riser.min_l3, 36);
    assert.equal(riser.starter_change, 'into');
    assert.equal(riser.hit4x_l10, 1);
    assert.equal(riser.season_fallback, false);
    assert.equal(riser.salary, 5000);

    const none = rows['No History'];
    assert.equal(none.games_season, 0);
    assert.equal(none.min_l3, null);
  });

  test('no lookahead: games on or after the slate date are ignored', async () => {
    const { players } = await metrics.getOpportunityMetrics({ slateDate: SLATE_DATE, site: 'draftkings', now: NOW });
    const riser = byName(players)['Riser Guy'];
    // 48-minute games on the slate date and after it would lift L3 above 36
    assert.equal(riser.min_l3, 36);
    assert.equal(riser.games_l10, 10);
    assert.equal(riser.days_since_last_game, 2);
    // ...but backtests carry the actual result for that night
    assert.equal(riser.actual_points, 90);
    assert.equal(riser.actual_minutes, 48);
  });

  test('sample-size fallback: under 3 current-season games uses last season and flags it', async () => {
    const { players } = await metrics.getOpportunityMetrics({ slateDate: SLATE_DATE, site: 'draftkings', now: NOW });
    const fb = byName(players)['Fallback Guy'];
    assert.equal(fb.season_fallback, true);
    assert.equal(fb.baseline_season, '2025-26');
    assert.equal(fb.current_season_games, 2);
    assert.equal(fb.games_season, 10);
    assert.equal(fb.min_season, 18);
    close(fb.min_l3, (36 + 36 + 18) / 3);
    close(fb.min_delta_l3, 30 - 18);
  });

  test('site-aware points: FPPM and value hit rates use the site column', async () => {
    const dk = byName((await metrics.getOpportunityMetrics({ slateDate: SLATE_DATE, site: 'draftkings', now: NOW })).players)['Riser Guy'];
    // FD points are seeded DK + 5 per game
    const fdResult = await metrics.getOpportunityMetrics({ slateDate: SLATE_DATE, site: 'fanduel', now: NOW });
    assert.equal(fdResult.source.site, 'fanduel');
    assert.equal(fdResult.players.length, 1);
    const fd = fdResult.players[0];
    close(fd.fppm_l10 - dk.fppm_l10, 50 / (3 * 36 + 7 * 18));
    // $7,000 FD: 5x = 35, only the 3 starts (45 FD points) clear it
    assert.equal(fd.hit5x_l10, 0.3);
  });

  test('environment and rest from the slate and team schedule', async () => {
    const { players } = await metrics.getOpportunityMetrics({ slateDate: SLATE_DATE, site: 'draftkings', now: NOW });
    const riser = byName(players)['Riser Guy'];
    assert.equal(riser.implied_total, 118);
    assert.equal(riser.over_under, 230);
    assert.equal(riser.spread, -11);
    assert.equal(riser.blowout, true);
    assert.equal(riser.team_pace_l10, 100);
    assert.equal(riser.opp_pace_l10, 96);
    assert.equal(riser.pace_proxy, 98);
    assert.equal(riser.rest_days, 1);
    assert.equal(riser.back_to_back, false);
  });

  test('cached per slate until refreshed', async () => {
    const first = await metrics.getOpportunityMetrics({ slateDate: SLATE_DATE, site: 'draftkings', now: NOW });
    assert.equal(first.cached, false);
    const second = await metrics.getOpportunityMetrics({ slateDate: SLATE_DATE, site: 'draftkings', now: NOW });
    assert.equal(second.cached, true);
    const fresh = await metrics.getOpportunityMetrics({ slateDate: SLATE_DATE, site: 'draftkings', now: NOW, refresh: true });
    assert.equal(fresh.cached, false);
  });

  test('a finished historical sync clears the cache (new box scores)', async () => {
    const syncRunService = (await import('../src/services/syncRunService.js')).default;
    await metrics.getOpportunityMetrics({ slateDate: SLATE_DATE, site: 'draftkings', now: NOW });
    const runId = await syncRunService.start({ source: 'espn', season: '2026-27' });
    await syncRunService.finish(runId, { gamesInserted: 0 });
    const after = await metrics.getOpportunityMetrics({ slateDate: SLATE_DATE, site: 'draftkings', now: NOW });
    assert.equal(after.cached, false);
  });
});

describe('live slate and post-sync precompute', () => {
  test('primeOpportunityMetrics caches the synced live slate', async () => {
    await db.run(`INSERT INTO slates (slate_id, name, sport, start_time, site) VALUES ('L1', 'Main', 'NBA', '7:00 PM', 'draftkings')`);
    await db.run(`
      INSERT INTO players (slate_id, player_id, name, team, opponent, position, salary, projected_points, projected_minutes,
        vegas_implied_total, vegas_spread, vegas_over_under, raw_data)
      VALUES ('L1', 'rw1', 'Riser Guy', 'BOS', 'NYK', 'SF', 6000, 30, 34, 116, -4, 228, ?)
    `, JSON.stringify({ game: { dateTime: `${SLATE_DATE} 19:00:00` } }));
    const liveNow = new Date(`${SLATE_DATE}T16:00:00Z`);

    const primed = await metrics.primeOpportunityMetrics('L1', { now: liveNow });
    assert.equal(primed.players.length, 1);
    const result = await metrics.getOpportunityMetrics({ slateId: 'L1', now: liveNow });
    assert.equal(result.cached, true);
    assert.equal(result.source.isBacktest, false);
    const riser = result.players[0];
    assert.equal(riser.salary, 6000);
    assert.equal(riser.min_l3, 36);
    assert.equal(riser.blowout, false);
    assert.equal(riser.over_under, 228);
    assert.equal(riser.actual_points, undefined);

    // Slate fields are re-read on a cache hit: a moved line shows without a recompute
    await db.run(`UPDATE players SET vegas_spread = -12, projected_points = 33 WHERE slate_id = 'L1'`);
    const moved = await metrics.getOpportunityMetrics({ slateId: 'L1', now: liveNow });
    assert.equal(moved.cached, true);
    assert.equal(moved.players[0].blowout, true);
    assert.equal(moved.players[0].projected_points, 33);
    // A new salary changes value hit rates: recomputed
    await db.run(`UPDATE players SET salary = 4000 WHERE slate_id = 'L1'`);
    assert.equal((await metrics.getOpportunityMetrics({ slateId: 'L1', now: liveNow })).cached, false);

    await db.run(`DELETE FROM players`);
    await db.run(`DELETE FROM slates`);
  });
});

describe('GET /api/opportunity/metrics', () => {
  test('returns the slate source fields and one row per player', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    try {
      const res = await fetch(`${baseUrl}/api/opportunity/metrics?slateDate=${SLATE_DATE}&site=draftkings`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.success, true);
      assert.equal(body.isBacktest, true);
      assert.equal(body.slateDate, SLATE_DATE);
      assert.equal(body.players.length, 3);
      assert.ok(body.players.every(p => 'min_delta_l3' in p && 'games_season' in p));
    } finally {
      vi.useRealTimers();
    }
  });

  test('a date with no saved slate is a 404, a bad date a 400', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    try {
      assert.equal((await fetch(`${baseUrl}/api/opportunity/metrics?slateDate=2026-11-01`)).status, 404);
      assert.equal((await fetch(`${baseUrl}/api/opportunity/metrics?slateDate=11/01/2026`)).status, 400);
    } finally {
      vi.useRealTimers();
    }
  });
});
