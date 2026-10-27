import { test, describe, vi, beforeAll as before, afterAll as after, beforeEach } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';

// Rate projection (projected minutes x blended FPPM x environment x teammate
// bump) vs the posted projection, and salary lag vs recent production - all
// from data before the slate date.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nba-dfs-rate-'));
process.env.DATABASE_TYPE = 'sqlite';
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');

const { RATE_CONFIG, blendFppm, environmentFactor, teammateFactor, rateProjection } =
  await import('../src/services/opportunity/rateProjection.js');
const { computeSalaryLag } = await import('../src/services/opportunity/salaryLag.js');
const { replayRateCases, topGapHitRate, mae } = await import('../src/services/opportunity/rateReplay.js');
const { seasonForDate } = await import('../src/utils/season.js');

const close = (actual, expected, eps = 0.002) =>
  assert.ok(Math.abs(actual - expected) <= eps, `expected ${expected}, got ${actual}`);

const addDays = (date, n) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/** Games most recent first; `lines` [minutes, fp] oldest first, every other day before `before`. */
const log = (lines, { season = '2026-27', before = '2026-12-01' } = {}) =>
  lines.map(([minutes, fp], i) => ({ season, game_date: addDays(before, -2 * (lines.length - i)), minutes, fp })).reverse();

describe('blendFppm (L10 vs season, shrunk on small samples)', () => {
  test('a full season: L10 weight grows with L10 minutes, toward L10_WEIGHT', () => {
    // 10 games at 1.0 FPPM, then 10 at 1.2
    const games = log([...Array(10).fill([30, 30]), ...Array(10).fill([30, 36])]);
    const f = blendFppm(games, { season: '2026-27' });
    close(f.recent, 1.2, 1e-9);
    close(f.base, 1.1, 1e-9);
    const w = 0.5 * 300 / (300 + 150);
    close(f.l10_weight, w, 1e-9);
    close(f.fppm, w * 1.2 + (1 - w) * 1.1, 1e-9);
  });

  test('few current-season games: the season base shrinks toward last season', () => {
    const last = log(Array(10).fill([30, 30]), { season: '2025-26', before: '2026-04-10' });
    const current = log(Array(3).fill([30, 36]));
    const f = blendFppm([...current, ...last], { season: '2026-27' });
    close(f.current, 1.2, 1e-9);
    close(f.prior, 1.0, 1e-9);
    close(f.base, (108 + 240 * 1.0) / (90 + 240), 1e-9);
    // L10 is the 3 current games only (splitSample: 3+ current games)
    close(f.recent, 1.2, 1e-9);
    const w = 0.5 * 90 / (90 + 150);
    close(f.fppm, w * 1.2 + (1 - w) * f.base, 1e-9);
  });

  test('under 3 current games: L10 runs on into last season (splitSample fallback)', () => {
    const last = log(Array(10).fill([30, 30]), { season: '2025-26', before: '2026-04-10' });
    const current = log(Array(2).fill([30, 45]));
    const f = blendFppm([...current, ...last], { season: '2026-27' });
    close(f.l10_minutes, 300, 1e-9);
    close(f.recent, (2 * 45 + 8 * 30) / 300, 1e-9);
  });

  test('no prior season: the current season alone; no games at all: null', () => {
    const f = blendFppm(log(Array(4).fill([20, 20])), { season: '2026-27' });
    close(f.base, 1, 1e-9);
    close(f.fppm, 1, 1e-9);
    assert.equal(blendFppm([], { season: '2026-27' }).fppm, null);
  });
});

describe('environment and teammate factors', () => {
  test('implied total vs league average (minutesModel coefficients), capped', () => {
    close(environmentFactor({ impliedTotal: 118 }).factor, 1 + 5 * RATE_CONFIG.impliedPerPoint, 1e-9);
    assert.equal(environmentFactor({ impliedTotal: 118 }).basis, 'implied');
    close(environmentFactor({ impliedTotal: 140 }).factor, 1 + RATE_CONFIG.envCap, 1e-9);
    close(environmentFactor({ impliedTotal: 90 }).factor, 1 - RATE_CONFIG.envCap, 1e-9);
  });

  test('pace proxy only without a Vegas line (0 = no line)', () => {
    const env = environmentFactor({ impliedTotal: 0, paceProxy: 104, leaguePace: 100 });
    assert.equal(env.basis, 'pace');
    close(env.factor, 1 + RATE_CONFIG.paceElasticity * 0.04, 1e-9);
    // Vegas prices pace in: the line wins
    assert.equal(environmentFactor({ impliedTotal: 113, paceProxy: 104, leaguePace: 100 }).factor, 1);
    assert.deepEqual(environmentFactor({}), { factor: 1, basis: null });
  });

  test('teammate bump: confirmed splits only, shrunk by games without, capped', () => {
    const split = { sample: 'confirmed', games_without: 6, fppm_with: 1.0, fppm_without: 1.2, out_names: ['Star'] };
    const t = teammateFactor(split);
    assert.equal(t.applied, true);
    close(t.factor, 1 + 0.2 * 6 / 26, 1e-9);
    assert.equal(teammateFactor({ ...split, sample: 'thin' }).factor, 1);
    assert.equal(teammateFactor(null).applied, false);
    close(teammateFactor({ ...split, games_without: 60, fppm_without: 3 }).factor, 1 + RATE_CONFIG.teammateBumpCap, 1e-9);
    close(teammateFactor({ ...split, games_without: 60, fppm_without: 0.2 }).factor, 1 + RATE_CONFIG.teammateDropCap, 1e-9);
  });
});

describe('rateProjection', () => {
  const fppm = blendFppm(log(Array(10).fill([30, 30])), { season: '2026-27' });

  test('minutes x FPPM x environment x teammate; gap in points and %, value per $1K', () => {
    const adjusted = { sample: 'confirmed', games_without: 5, fppm_with: 1, fppm_without: 1.25, out_names: ['Star'] };
    const r = rateProjection({ fppm, projectedMinutes: 32, projectedPoints: 28, salary: 6000, impliedTotal: 118, adjusted });
    const rate = 32 * 1 * 1.02 * (1 + 0.25 * 5 / 25);
    close(r.rate_projection, rate, 0.05);
    close(r.rate_gap, rate - 28, 0.05);
    close(r.rate_gap_pct, (rate - 28) / 28, 0.001);
    close(r.rate_value, rate / 6, 0.005);
    assert.equal(r.rate_env_basis, 'implied');
    assert.equal(r.rate_teammate_applied, true);
    assert.deepEqual(r.rate_teammate_outs, ['Star']);
    assert.equal(r.rate_reason, null);
  });

  test('null with a reason when minutes or games are missing', () => {
    const noMinutes = rateProjection({ fppm, projectedMinutes: 0, projectedPoints: 20 });
    assert.equal(noMinutes.rate_projection, null);
    assert.equal(noMinutes.rate_reason, 'no_projected_minutes');
    assert.equal(noMinutes.rate_gap, null);
    const noGames = rateProjection({ fppm: blendFppm([], { season: '2026-27' }), projectedMinutes: 30, projectedPoints: 20 });
    assert.equal(noGames.rate_reason, 'no_games');
    assert.equal(noGames.rate_value, null);
  });
});

describe('computeSalaryLag', () => {
  const hot = log([...Array(5).fill([30, 20]), ...Array(5).fill([30, 32])]);

  test('production up materially, salary flat or down: flagged', () => {
    const lag = computeSalaryLag({ salary: 5000, history: [{ game_date: '2026-11-28', salary: 5100 }, { game_date: '2026-11-26', salary: 5000 }], games: hot });
    assert.equal(lag.fp_l5, 32);
    assert.equal(lag.fp_prior_l5, 20);
    assert.equal(lag.production_change, 12);
    assert.equal(lag.production_change_pct, 0.6);
    assert.equal(lag.salary_change_l1, -100);
    assert.equal(lag.salary_change, 0);
    assert.equal(lag.salary_slates, 2);
    assert.equal(lag.salary_lag, true);
    assert.equal(lag.salary_lag_reason, null);
  });

  test('salary already moved up, or production flat: not flagged', () => {
    assert.equal(computeSalaryLag({ salary: 5600, history: [{ game_date: '2026-11-28', salary: 5000 }], games: hot }).salary_lag, false);
    const flat = log(Array(10).fill([30, 30]));
    assert.equal(computeSalaryLag({ salary: 5000, history: [{ game_date: '2026-11-28', salary: 5000 }], games: flat }).salary_lag, false);
  });

  test('uses at most the last 3 earlier slates', () => {
    const history = ['2026-11-28', '2026-11-26', '2026-11-24', '2026-11-22'].map((d, i) => ({ game_date: d, salary: 5000 - 100 * i }));
    const lag = computeSalaryLag({ salary: 5000, history, games: hot });
    assert.equal(lag.salary_slates, 3);
    assert.equal(lag.salary_change, 200);
  });

  test('degrades to null with a reason', () => {
    const none = computeSalaryLag({ salary: 5000, history: [], games: hot });
    assert.equal(none.salary_lag, null);
    assert.equal(none.salary_lag_reason, 'no_prior_snapshots');
    assert.equal(none.fp_l5, 32); // production still reported
    const few = computeSalaryLag({ salary: 5000, history: [{ game_date: '2026-11-28', salary: 5000 }], games: hot.slice(0, 6) });
    assert.equal(few.salary_lag, null);
    assert.equal(few.salary_lag_reason, 'insufficient_games');
    assert.equal(few.salary_change, 0);
    assert.equal(computeSalaryLag({ salary: null, history: [], games: hot }).salary_lag_reason, 'no_salary');
  });

  test('flags a production window that crosses seasons', () => {
    const games = [...log(Array(3).fill([30, 32])), ...log(Array(7).fill([30, 20]), { season: '2025-26', before: '2026-04-10' })];
    assert.equal(computeSalaryLag({ salary: 5000, history: [], games }).production_spans_seasons, true);
    assert.equal(computeSalaryLag({ salary: 5000, history: [], games: hot }).production_spans_seasons, false);
  });
});

describe('replay (no lookahead)', () => {
  const D = '2026-01-15';
  const games = (extra = []) => [
    ...Array.from({ length: 12 }, (_, i) => ({ player_key: 'p', season: '2025-26', game_date: addDays(D, -2 * (i + 1)),
      team: 'BOS', opponent: 'NYK', minutes: 30, fp: 30 + i })),
    { player_key: 'p', season: '2025-26', game_date: D, team: 'BOS', opponent: 'NYK', minutes: 34, fp: 50 },
    ...extra
  ];
  const teamGames = (extra = []) => [
    ...Array.from({ length: 12 }, (_, i) => [
      { team: 'BOS', season: '2025-26', game_date: addDays(D, -2 * (i + 1)), possessions: 104 },
      { team: 'NYK', season: '2025-26', game_date: addDays(D, -2 * (i + 1)), possessions: 96 }
    ]).flat(),
    ...extra
  ];
  const opts = { from: D, to: D, seasonOf: seasonForDate, minPriorGames: 5 };

  test('a case sees only games before its date', () => {
    const [base] = replayRateCases(games(), teamGames(), opts);
    assert.equal(base.game_date, D);
    assert.equal(base.actual, 50);
    // A same-night box score and later games (huge) change nothing
    const later = [
      { player_key: 'p', season: '2025-26', game_date: addDays(D, 2), team: 'BOS', opponent: 'NYK', minutes: 48, fp: 99 }
    ];
    const laterTeams = [{ team: 'BOS', season: '2025-26', game_date: D, possessions: 140 },
      { team: 'BOS', season: '2025-26', game_date: addDays(D, 2), possessions: 140 }];
    const [same] = replayRateCases(games(later), teamGames(laterTeams), opts);
    for (const field of ['fppm', 'env', 'rate', 'posted', 'minutes']) close(same[field], base[field], 1e-9);
  });

  test('posted proxy is prior points per game; actual minutes isolate the FPPM model', () => {
    const [c] = replayRateCases(games(), teamGames(), opts);
    close(c.posted, (30 + 41) / 2, 1e-9);
    const [a] = replayRateCases(games(), teamGames(), { ...opts, minutes: 'actual' });
    assert.equal(a.minutes, 34);
    close(a.rate, 34 * a.fppm * a.env, 1e-9);
    // Pace proxy = league pace here: no environment change
    close(a.env, 1, 1e-9);
  });

  test('topGapHitRate: top positive gaps per night vs the base rate; mae', () => {
    const rows = [
      { game_date: 'd1', gap: 5, posted: 20, actual: 25 },
      { game_date: 'd1', gap: 3, posted: 20, actual: 15 },
      { game_date: 'd1', gap: -2, posted: 20, actual: 30 },
      { game_date: 'd2', gap: 4, posted: 10, actual: 12 }
    ];
    const h = topGapHitRate(rows, { top: 1 });
    assert.equal(h.picks, 2);
    assert.equal(h.hits, 2);
    assert.equal(h.hitRate, 1);
    assert.equal(h.baseRate, 0.75);
    close(h.avgBeat, 3.5, 1e-9);
    assert.equal(mae(rows, r => r.posted), (5 + 5 + 10 + 2) / 4);
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

const SLATE_DATE = '2026-12-20';
const NOW = new Date('2026-12-25T16:00:00Z'); // the slate is in the past: backtest
const GAMES = 20;
const gameDate = (g) => addDays(SLATE_DATE, -2 * (GAMES + 1 - g));
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

async function teamGame(date, team, opp) {
  const gameId = `${date}-${[team, opp].sort().join('-')}`;
  for (const [t, o] of [[team, opp], [opp, team]]) {
    await db.run(`
      INSERT OR IGNORE INTO team_game_stats (game_id, game_date, season, season_type, team, opponent,
        minutes, fgm, fga, fta, tov, oreb, dreb, possessions)
      VALUES (?, ?, '2026-27', 'regular', ?, ?, 240, 40, 90, 25, 14, 10, 35, 100)
    `, gameId, date, t, o);
  }
  return gameId;
}

// [minutes, FGA, TOV, DK points]
async function box(name, team, opp, date, [minutes, fga, tov, fp]) {
  const gameId = await teamGame(date, team, opp);
  await db.run(`
    INSERT INTO historical_games (player_name, player_key, team, opponent, game_id, game_date, season, season_type,
      minutes, points, rebounds, assists, steals, blocks, turnovers, fouls, fg_made, fg_attempted, fg3_made, fg3_attempted,
      ft_made, ft_attempted, oreb, dreb, is_starter, dk_fantasy_points, fd_fantasy_points, yahoo_fantasy_points)
    VALUES (?, ?, ?, ?, ?, ?, '2026-27', 'regular', ?, ?, 0, 0, 0, 0, ?, 2, ?, ?, 0, 0, 0, 0, 0, 0, 1, ?, ?, ?)
  `, name, playerKey(name), team, opp, gameId, date, minutes, fga, tov, Math.floor(fga / 2), fga, fp, fp + 5, fp);
}

async function listing(name, team, opp, date, status) {
  const gameId = await teamGame(date, team, opp);
  await db.run(`INSERT INTO game_player_status (game_id, game_date, team, player_key, player_name, status, reason)
    VALUES (?, ?, ?, ?, ?, ?, NULL)`, gameId, date, team, playerKey(name), name, status);
}

async function snapshot(name, team, opp, { date = SLATE_DATE, salary, projected = 30, minutes = 30, implied = 118, injury = null }) {
  await db.run(`
    INSERT INTO slate_player_snapshots (snapshot_date, game_date, site, slate_id, player_key, player_name, team, opponent, position,
      salary, projected_points, projected_minutes, vegas_implied_total, vegas_spread, over_under, injury_status)
    VALUES (?, ?, 'draftkings', ?, ?, ?, ?, ?, 'SF', ?, ?, ?, ?, -3, 230, ?)
  `, date, date, `S-${date}`, playerKey(name), name, team, opp, salary, projected, minutes, implied, injury);
}

const STAR = [34, 22, 3, 45];
const WING = [30, 12, 2, 30];      // 1.0 FPPM with Star
const WING_UP = [36, 18, 3, 42];   // 1.167 without
const ALPHA = [30, 18, 2, 40];
const CHARLIE = [30, 10, 2, 30];
const CHARLIE_UP = [34, 14, 2, 44];
const STAR_OUT = range(4, 9);      // 6 games: confirmed
const ALPHA_OUT = range(3, 12);    // 10 games: confirmed

async function seed() {
  for (const g of range(1, GAMES)) {
    const date = gameDate(g);
    if (!STAR_OUT.includes(g)) await box('Star Guard', 'BOS', 'NYK', date, STAR);
    await box('Wing Man', 'BOS', 'NYK', date, STAR_OUT.includes(g) ? WING_UP : WING);
    // Hot Hand: 20 points a game, then 35 over the last 5
    await box('Hot Hand', 'NYK', 'BOS', date, [25, 10, 1, g > 15 ? 35 : 20]);
    if (!ALPHA_OUT.includes(g)) await box('Alpha Nyk', 'NYK', 'BOS', date, ALPHA);
    await box('Charlie Nyk', 'NYK', 'BOS', date, ALPHA_OUT.includes(g) ? CHARLIE_UP : CHARLIE);
  }
  // Slate night (results the projection must not see): Alpha inactive, Wing plays big
  await listing('Alpha Nyk', 'NYK', 'BOS', SLATE_DATE, 'INACTIVE');
  await box('Wing Man', 'BOS', 'NYK', SLATE_DATE, WING_UP);
  await box('Charlie Nyk', 'NYK', 'BOS', SLATE_DATE, CHARLIE_UP);
  // After the slate
  await box('Wing Man', 'BOS', 'NYK', addDays(SLATE_DATE, 2), [48, 40, 2, 90]);

  // Tonight: Star OUT pre-lock; Alpha active on the slate (only the night's listing knows)
  await snapshot('Star Guard', 'BOS', 'NYK', { salary: 9000, projected: 0, minutes: 0, injury: 'OUT' });
  await snapshot('Wing Man', 'BOS', 'NYK', { salary: 6000, projected: 30, minutes: 32 });
  await snapshot('Hot Hand', 'NYK', 'BOS', { salary: 4400, projected: 22, minutes: 25, implied: 112 });
  await snapshot('Charlie Nyk', 'NYK', 'BOS', { salary: 5500, projected: 30, minutes: 30, implied: 112 });
  await snapshot('Alpha Nyk', 'NYK', 'BOS', { salary: 7000, projected: 35, minutes: 30, implied: 112 });
  await snapshot('No Minutes', 'NYK', 'BOS', { salary: 3000, projected: 10, minutes: null, implied: 112 });
  await snapshot('No History', 'NYK', 'BOS', { salary: 3000, projected: 10, minutes: 15, implied: 112 });
  // Earlier slates (salary history) and a later one (lookahead)
  await snapshot('Wing Man', 'BOS', 'NYK', { date: addDays(SLATE_DATE, -4), salary: 6200 });
  await snapshot('Wing Man', 'BOS', 'NYK', { date: addDays(SLATE_DATE, -2), salary: 6100 });
  await snapshot('Hot Hand', 'NYK', 'BOS', { date: addDays(SLATE_DATE, -2), salary: 4500 });
  await snapshot('Wing Man', 'BOS', 'NYK', { date: addDays(SLATE_DATE, 2), salary: 9000 });
  await snapshot('Hot Hand', 'NYK', 'BOS', { date: addDays(SLATE_DATE, 2), salary: 3000 });
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
const load = async () => byName((await metrics.getOpportunityMetrics({ slateDate: SLATE_DATE, site: 'draftkings', now: NOW })).players);

describe('getOpportunityMetrics: rate projection (backtest date)', () => {
  test('slate minutes x blended FPPM (prior games only) x implied total x pre-lock teammate bump', async () => {
    const wing = (await load())['Wing Man'];
    // 14 games at 30 min / 30 pts, 6 without Star at 36 / 42; L10 (games 11-20) all with Star
    const base = (14 * 30 + 6 * 42) / (14 * 30 + 6 * 36);
    const w = 0.5 * 300 / 450;
    const fppm = w * 1 + (1 - w) * base;
    close(wing.rate_fppm, fppm, 0.0005);
    assert.equal(wing.rate_env_basis, 'implied');
    close(wing.rate_env_factor, 1.02, 1e-9);
    assert.equal(wing.rate_teammate_applied, true);
    assert.deepEqual(wing.rate_teammate_outs, ['Star Guard']);
    // O2's split rounds FPPM to 3 decimals (1.167 without)
    const bump = 1 + (42 / 36 - 1) * 6 / 26;
    close(wing.rate_teammate_factor, bump, 0.001);
    const rate = 32 * fppm * 1.02 * bump;
    close(wing.rate_projection, rate, 0.1);
    close(wing.rate_gap, rate - 30, 0.05);
    close(wing.rate_gap_pct, (rate - 30) / 30, 0.002);
    close(wing.rate_value, rate / 6, 0.01);
    assert.equal(wing.league_pace, 100);
  });

  test('no lookahead: the night\'s listings, box scores and later games are not used', async () => {
    const rows = await load();
    // Alpha's inactive listing is only known after lock: no teammate bump for Charlie
    const charlie = rows['Charlie Nyk'];
    assert.equal(charlie.rate_teammate_applied, false);
    assert.equal(charlie.rate_teammate_factor, 1);
    // ...though the post-lock O2 view (backtest) sees Alpha out
    const { getTeammateOpportunity } = await import('../src/services/opportunity/teammateService.js');
    const o2 = byName((await getTeammateOpportunity({ slateDate: SLATE_DATE, site: 'draftkings', now: NOW })).players);
    assert.equal(o2['Charlie Nyk'].adjusted.sample, 'confirmed');
    // Wing's 48-minute game after the slate is not in his FPPM
    assert.ok(rows['Wing Man'].rate_fppm_recent === 1);
    assert.equal(rows['Wing Man'].actual_points, 42);
  });

  test('teammate-out fields (pre-lock outs): who is out, the split sample and the usage absorbed', async () => {
    const rows = await load();
    const wing = rows['Wing Man'];
    assert.deepEqual(wing.teammate_out_names, ['Star Guard']);
    assert.equal(wing.teammate_sample, 'confirmed');
    assert.equal(wing.teammate_games_without, 6);
    // 12 -> 18 FGA and 2 -> 3 TOV out of 115 team plays
    close(wing.teammate_play_share_delta, (21 - 14) / 115, 0.002);
    assert.ok(wing.teammate_absorbed_pct > 0);
    close(wing.teammate_min_delta, 6, 0.05);
    assert.ok(wing.team_vacated_usage > 0);
    assert.deepEqual(wing.team_out_names, ['Star Guard']);
    // Alpha's absence is only known after lock
    assert.equal(rows['Charlie Nyk'].teammate_sample, null);
    assert.deepEqual(rows['Charlie Nyk'].team_out_names, []);
    // Slate ranges ride along for the radar
    assert.ok('floor' in wing && 'ceiling' in wing);
  });

  test('null rate with a reason when minutes or games are missing', async () => {
    const rows = await load();
    assert.equal(rows['No Minutes'].rate_projection, null);
    assert.equal(rows['No Minutes'].rate_reason, 'no_projected_minutes');
    assert.equal(rows['No History'].rate_projection, null);
    assert.equal(rows['No History'].rate_reason, 'no_games');
  });
});

describe('getOpportunityMetrics: salary lag (backtest date)', () => {
  test('salary vs earlier slates (before the slate date only) and L5 vs prior L5 production', async () => {
    const rows = await load();
    const hot = rows['Hot Hand'];
    assert.equal(hot.fp_l5, 35);
    assert.equal(hot.fp_prior_l5, 20);
    assert.equal(hot.salary_change, -100);
    assert.equal(hot.salary_slates, 1);
    assert.equal(hot.salary_lag, true);

    const wing = rows['Wing Man'];
    assert.equal(wing.salary_change_l1, -100);
    assert.equal(wing.salary_change, -200);
    assert.equal(wing.salary_slates, 2);
    assert.equal(wing.salary_lag, false);

    const charlie = rows['Charlie Nyk'];
    assert.equal(charlie.salary_lag, null);
    assert.equal(charlie.salary_lag_reason, 'no_prior_snapshots');
  });
});

describe('cache follows injury statuses', () => {
  test('a changed status on the slate recomputes', async () => {
    const first = await metrics.getOpportunityMetrics({ slateDate: SLATE_DATE, site: 'draftkings', now: NOW });
    assert.equal(first.cached, false);
    const again = await metrics.getOpportunityMetrics({ slateDate: SLATE_DATE, site: 'draftkings', now: NOW });
    assert.equal(again.cached, true);
    await db.run(`UPDATE slate_player_snapshots SET injury_status = 'GTD' WHERE player_name = 'Wing Man' AND game_date = ?`, SLATE_DATE);
    const changed = await metrics.getOpportunityMetrics({ slateDate: SLATE_DATE, site: 'draftkings', now: NOW });
    assert.equal(changed.cached, false);
    await db.run(`UPDATE slate_player_snapshots SET injury_status = NULL WHERE player_name = 'Wing Man' AND game_date = ?`, SLATE_DATE);
  });
});

describe('GET /api/opportunity/metrics', () => {
  test('rows carry the rate projection and salary lag fields', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    let body;
    try {
      const res = await fetch(`${baseUrl}/api/opportunity/metrics?slateDate=${SLATE_DATE}&site=draftkings`);
      assert.equal(res.status, 200);
      body = await res.json();
    } finally {
      vi.useRealTimers();
    }
    const wing = byName(body.players)['Wing Man'];
    for (const field of ['rate_projection', 'rate_gap', 'rate_gap_pct', 'rate_value', 'rate_fppm', 'rate_env_factor',
      'rate_teammate_factor', 'salary_change', 'salary_lag', 'fp_l5', 'fp_prior_l5']) {
      assert.ok(field in wing, `missing ${field}`);
    }
  });
});
