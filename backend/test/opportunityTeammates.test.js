import { test, describe, vi, beforeAll as before, afterAll as after } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';

// Teammate-out opportunity: vacated usage per team, each slate player's usage /
// minutes / FPPM / points with each OUT teammate off the floor, and the share
// of the vacated usage he historically absorbs.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nba-dfs-teammates-'));
process.env.DATABASE_TYPE = 'sqlite';
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');

const { splitStats, computeSplit, combineSplits, sampleLabel } = await import('../src/services/opportunity/teammateSplits.js');

const close = (actual, expected, eps = 0.002) =>
  assert.ok(Math.abs(actual - expected) <= eps, `expected ${expected}, got ${actual}`);

const addDays = (date, n) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

// Team totals for every seeded game: 115 plays (90 FGA + 0.44*25 FTA + 14 TOV)
const PLAYS = 115;
const TEAM = { tm_minutes: 240, tm_fgm: 40, tm_fga: 90, tm_fta: 25, tm_tov: 14, tm_oreb: 10, tm_dreb: 35,
  opp_fga: 88, opp_fg3a: 35, opp_oreb: 10, opp_dreb: 33, opp_possessions: 100 };
const line = (minutes, fga, tov, fp) => ({ minutes, fg_attempted: fga, ft_attempted: 0, turnovers: tov, fp,
  fg_made: Math.floor(fga / 2), points: fga, fg3_attempted: 0, assists: 0, steals: 0, blocks: 0, oreb: 0, dreb: 0, ...TEAM });

describe('teammate split math', () => {
  const withGames = Array.from({ length: 4 }, (_, i) => ({ game_date: `2026-11-0${i + 1}`, ...line(30, 12, 2, 30) }));
  const withoutGames = Array.from({ length: 5 }, (_, i) => ({ game_date: `2026-11-1${i}`, ...line(36, 18, 3, 42) }));

  test('splitStats: usage (profile formula), minutes, FPPM, points and share of team plays', () => {
    const s = splitStats(withoutGames);
    assert.equal(s.games, 5);
    assert.equal(s.min_pg, 36);
    close(s.usg_pct, 21 / ((36 / 48) * PLAYS), 0.0005);
    close(s.play_share, 21 / PLAYS, 0.0005);
    close(s.fppm, 42 / 36);
    assert.equal(s.fpts_pg, 42);
    assert.equal(splitStats([]).usg_pct, null);
  });

  test('computeSplit: with vs without, deltas and absorbed share of the vacated plays', () => {
    const absent = new Set(withoutGames.map(g => g.game_date));
    const played = new Set(withGames.map(g => g.game_date));
    const split = computeSplit([...withoutGames, ...withGames], { absent, played, vacatedShare: 25.2 / PLAYS });
    assert.equal(split.games_without, 5);
    assert.equal(split.games_with, 4);
    assert.equal(split.sample, 'confirmed');
    assert.equal(split.min_with, 30);
    assert.equal(split.min_without, 36);
    assert.equal(split.min_delta, 6);
    close(split.usg_delta, 21 / (0.75 * PLAYS) - 14 / ((30 / 48) * PLAYS), 0.001);
    assert.equal(split.fpts_delta, 12);
    close(split.absorbed_pct, 7 / 25.2, 0.002);
  });

  test('sample: 5+ games without is confirmed, 2-4 thin, fewer (or under 3 with) none', () => {
    assert.equal(sampleLabel(5, 10), 'confirmed');
    assert.equal(sampleLabel(4, 10), 'thin');
    assert.equal(sampleLabel(2, 10), 'thin');
    assert.equal(sampleLabel(1, 10), 'none');
    assert.equal(sampleLabel(6, 2), 'none');
  });

  test('combineSplits: same set when confirmed, else the strongest single; never summed', () => {
    const single = (key, usg, sample) => ({ out_key: key, usg_delta: usg, sample });
    const set = (sample) => ({ out_keys: ['a', 'b'], usg_delta: 0.09, sample });

    const sameSet = combineSplits([single('a', 0.04, 'confirmed'), single('b', 0.05, 'confirmed')], set('confirmed'));
    assert.equal(sameSet.basis, 'same_set');
    assert.equal(sameSet.usg_delta, 0.09);

    const strongest = combineSplits([single('a', 0.04, 'confirmed'), single('b', 0.06, 'thin')], set('thin'));
    assert.equal(strongest.basis, 'strongest_single');
    assert.deepEqual(strongest.out_keys, ['a']);
    assert.equal(strongest.usg_delta, 0.04);

    const thin = combineSplits([single('a', 0.04, 'none'), single('b', 0.06, 'thin')], set('none'));
    assert.equal(thin.basis, 'strongest_single');
    assert.equal(thin.sample, 'thin');
    assert.deepEqual(thin.out_keys, ['b']);

    const one = combineSplits([single('a', 0.04, 'confirmed')], null);
    assert.equal(one.basis, 'single');
    assert.equal(combineSplits([single('a', 0.04, 'none')], null), null);
  });
});

// ---------------------------------------------------------------------------
// Service + route against a seeded DB
// ---------------------------------------------------------------------------

let db;
let service;
let playerKey;
let server;
let baseUrl;

const SLATE_DATE = '2026-12-20';
const NOW = new Date('2026-12-25T16:00:00Z'); // the slate is in the past: backtest
const GAMES = 20;
// BOS vs NYK every other day before the slate date (g = 1..20), the slate date, and one game after it
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

async function box(name, team, opp, date, [minutes, fga, tov, fp]) {
  const gameId = await teamGame(date, team, opp);
  await db.run(`
    INSERT INTO historical_games (player_name, player_key, team, opponent, game_id, game_date, season, season_type,
      minutes, points, rebounds, assists, steals, blocks, turnovers, fouls, fg_made, fg_attempted, fg3_made, fg3_attempted,
      ft_made, ft_attempted, oreb, dreb, is_starter, dk_fantasy_points, fd_fantasy_points, yahoo_fantasy_points)
    VALUES (?, ?, ?, ?, ?, ?, '2026-27', 'regular', ?, ?, 0, 0, 0, 0, ?, 2, ?, ?, 0, 0, 0, 0, 0, 0, 1, ?, ?, ?)
  `, name, playerKey(name), team, opp, gameId, date, minutes, fga, tov, Math.floor(fga / 2), fga, fp, fp + 5, fp);
}

async function listing(name, team, opp, date, status, reason) {
  const gameId = await teamGame(date, team, opp);
  await db.run(`INSERT INTO game_player_status (game_id, game_date, team, player_key, player_name, status, reason)
    VALUES (?, ?, ?, ?, ?, ?, ?)`, gameId, date, team, playerKey(name), name, status, reason);
}

async function snapshot(name, team, opp, { salary, projected = 30, injury = null }) {
  await db.run(`
    INSERT INTO slate_player_snapshots (snapshot_date, game_date, site, slate_id, player_key, player_name, team, opponent, position,
      salary, projected_points, projected_minutes, injury_status)
    VALUES (?, ?, 'draftkings', 'S1', ?, ?, ?, ?, 'SF', ?, ?, 30, ?)
  `, SLATE_DATE, SLATE_DATE, playerKey(name), name, team, opp, salary, projected, injury);
}

// Lines: [minutes, FGA, TOV, DK points]. Plays used = FGA + TOV (no FTA).
const STAR = [34, 22, 3, 45];      // 25 plays
const WING = [30, 12, 2, 30];      // 14
const WING_UP = [36, 18, 3, 42];   // 21 with Star out
const BIG = [28, 10, 1, 28];
const SIXTH = [22, 8, 1, 20];      // 9
const RESERVE = [18, 6, 1, 15];    // 7
const BENCH = [8, 2, 0, 5];        // not a regular
const A = [30, 18, 2, 40];         // 20
const B = [28, 13, 2, 32];         // 15
const C = [30, 10, 2, 30];         // 12
const C_A_OUT = [34, 14, 2, 38];   // 16
const C_BOTH_OUT = [38, 20, 2, 50]; // 22

const STAR_OUT = range(4, 9);              // 6 games: confirmed
const SIXTH_OUT = [9, 15, 16];             // 3 games: thin
const A_OUT = range(3, 12);
const B_OUT = [...range(8, 12), 16];       // with A: 8-12 (5 games, the same set)

async function seed() {
  for (const g of range(1, GAMES)) {
    const date = gameDate(g);
    if (!STAR_OUT.includes(g)) await box('Star Guard', 'BOS', 'NYK', date, STAR);
    await box('Wing Man', 'BOS', 'NYK', date, STAR_OUT.includes(g) ? WING_UP : WING);
    // Big sat out 5 of Star's 6 absences: one game without him, no sample
    if (!range(4, 8).includes(g)) await box('Big Fella', 'BOS', 'NYK', date, BIG);
    if (!SIXTH_OUT.includes(g)) await box('Sixth Man', 'BOS', 'NYK', date, SIXTH);
    await box('Reserve Guy', 'BOS', 'NYK', date, RESERVE);
    await box('Bench Warmer', 'BOS', 'NYK', date, BENCH);
    // Traded after six games: no longer a Celtic
    await box('Traded Guy', g <= 6 ? 'BOS' : 'MIA', g <= 6 ? 'NYK' : 'ORL', date, RESERVE);
    // A regular elsewhere, listed by BOS tonight: no usage to vacate in Boston
    await box('Mover Guy', 'MIA', 'ORL', date, SIXTH);

    if (!A_OUT.includes(g)) await box('Alpha Nyk', 'NYK', 'BOS', date, A);
    if (!B_OUT.includes(g)) await box('Beta Nyk', 'NYK', 'BOS', date, B);
    const aOut = A_OUT.includes(g);
    const bOut = B_OUT.includes(g);
    await box('Charlie Nyk', 'NYK', 'BOS', date, aOut && bOut ? C_BOTH_OUT : aOut ? C_A_OUT : C);
  }

  // Slate night: Star absent from the box score with no listing, Sixth ruled OUT pre-lock,
  // Reserve DNP-CD, Bench absent (not a regular), Alpha inactive, Beta absent
  await box('Wing Man', 'BOS', 'NYK', SLATE_DATE, WING_UP);
  await box('Big Fella', 'BOS', 'NYK', SLATE_DATE, BIG);
  await listing('Sixth Man', 'BOS', 'NYK', SLATE_DATE, 'INACTIVE', 'LEFT ANKLE');
  await listing('Reserve Guy', 'BOS', 'NYK', SLATE_DATE, 'DNP', "COACH'S DECISION");
  await listing('Mover Guy', 'BOS', 'NYK', SLATE_DATE, 'DNP', "COACH'S DECISION");
  await box('Traded Guy', 'MIA', 'ORL', SLATE_DATE, RESERVE);
  await listing('Alpha Nyk', 'NYK', 'BOS', SLATE_DATE, 'INACTIVE', 'RIGHT KNEE');
  await box('Charlie Nyk', 'NYK', 'BOS', SLATE_DATE, C_BOTH_OUT);

  // After the slate (lookahead): Star out again, Wing explodes
  await box('Wing Man', 'BOS', 'NYK', addDays(SLATE_DATE, 2), [48, 40, 2, 90]);

  await snapshot('Wing Man', 'BOS', 'NYK', { salary: 6000 });
  await snapshot('Big Fella', 'BOS', 'NYK', { salary: 5000 });
  await snapshot('Sixth Man', 'BOS', 'NYK', { salary: 4000, projected: 0, injury: 'OUT' });
  await snapshot('Charlie Nyk', 'NYK', 'BOS', { salary: 5500 });
}

before(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  db = (await import('../src/config/database.js')).default;
  await (await import('../src/config/schema.js')).createTables(db);
  service = await import('../src/services/opportunity/teammateService.js');
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

const byKey = (rows, key = 'name') => Object.fromEntries(rows.map(r => [r[key], r]));

describe('getTeammateOpportunity (backtest date)', () => {
  let result;
  before(async () => {
    result = await service.getTeammateOpportunity({ slateDate: SLATE_DATE, site: 'draftkings', now: NOW });
  });

  test('who is out: pre-lock status, listings, and regulars absent from the box score', () => {
    assert.equal(result.source.isBacktest, true);
    const teams = byKey(result.teams, 'team');
    const bos = byKey(teams.BOS.out);
    assert.deepEqual(Object.keys(bos).sort(), ['Reserve Guy', 'Sixth Man', 'Star Guard']);
    assert.equal(bos['Star Guard'].status_source, 'absent');
    assert.equal(bos['Star Guard'].prelock, false);
    assert.equal(bos['Sixth Man'].status_source, 'injury_status');
    assert.equal(bos['Sixth Man'].prelock, true);
    assert.equal(bos['Reserve Guy'].status_source, 'dnp');

    const nyk = byKey(teams.NYK.out);
    assert.deepEqual(Object.keys(nyk).sort(), ['Alpha Nyk', 'Beta Nyk']);
    assert.equal(nyk['Alpha Nyk'].status_source, 'inactive');
    assert.equal(nyk['Alpha Nyk'].reason, 'RIGHT KNEE');
    assert.equal(nyk['Beta Nyk'].status_source, 'absent');
  });

  test('vacated usage, minutes and points per game per team (regulars only)', () => {
    const bos = byKey(result.teams, 'team').BOS;
    const star = byKey(bos.out)['Star Guard'];
    assert.equal(star.games, 14);
    assert.equal(star.min_pg, 34);
    close(star.play_share, 25 / PLAYS, 0.0005);
    close(star.usg_pct, 25 / ((34 / 48) * PLAYS), 0.0005);
    close(bos.vacated_usage, (25 + 9 + 7) / PLAYS, 0.001);
    assert.equal(bos.vacated_minutes, 34 + 22 + 18);
    assert.equal(bos.vacated_fpts, 45 + 20 + 15);
  });

  test('adjusted usage with each OUT teammate off the floor (games without, before the slate)', () => {
    const wing = byKey(result.players)['Wing Man'];
    const vsStar = byKey(wing.splits, 'out_name')['Star Guard'];
    // The slate-night game and the post-slate game are not counted
    assert.equal(vsStar.games_without, 6);
    assert.equal(vsStar.games_with, 14);
    assert.equal(vsStar.sample, 'confirmed');
    assert.equal(vsStar.min_without, 36);
    assert.equal(vsStar.min_with, 30);
    close(vsStar.usg_without, 21 / (0.75 * PLAYS), 0.0005);
    close(vsStar.usg_with, 14 / ((30 / 48) * PLAYS), 0.0005);
    close(vsStar.fppm_without, 42 / 36);
    assert.equal(vsStar.fpts_without, 42);
    assert.equal(vsStar.fpts_with, 30);
    close(vsStar.absorbed_pct, 7 / 25, 0.002);

    const vsSixth = byKey(wing.splits, 'out_name')['Sixth Man'];
    assert.equal(vsSixth.games_without, 3);
    assert.equal(vsSixth.sample, 'thin');

    // Reserve never missed a game
    const vsReserve = byKey(wing.splits, 'out_name')['Reserve Guy'];
    assert.equal(vsReserve.games_without, 0);
    assert.equal(vsReserve.sample, 'none');

    // Several out, never all together: the strongest confirmed single
    assert.equal(wing.adjusted.basis, 'strongest_single');
    assert.deepEqual(wing.adjusted.out_names, ['Star Guard']);
    assert.equal(wing.adjusted.fpts_delta, 12);
  });

  test('two teammates out together: the same-set split wins when confirmed', () => {
    const charlie = byKey(result.players)['Charlie Nyk'];
    assert.equal(charlie.adjusted.basis, 'same_set');
    assert.deepEqual([...charlie.adjusted.out_names].sort(), ['Alpha Nyk', 'Beta Nyk']);
    assert.equal(charlie.adjusted.games_without, 5);
    assert.equal(charlie.adjusted.games_with, 9);
    assert.equal(charlie.adjusted.fpts_delta, 20);
    close(charlie.adjusted.absorbed_pct, 10 / 35, 0.002);
    // Singles still reported: Alpha out 10 games (5 alone, 5 with Beta)
    assert.equal(byKey(charlie.splits, 'out_name')['Alpha Nyk'].games_without, 10);
  });

  test('absorbed-by list per out player, biggest share first', () => {
    const star = byKey(byKey(result.teams, 'team').BOS.out)['Star Guard'];
    assert.equal(star.absorbed_by[0].name, 'Wing Man');
    close(star.absorbed_by[0].absorbed_pct, 7 / 25, 0.002);
    assert.equal(star.absorbed_by[0].sample, 'confirmed');
    // Big's one game without Star is no sample: not listed
    assert.deepEqual(star.absorbed_by.map(a => a.name), ['Wing Man']);
  });

  test('players with no OUT teammates and backtest actuals', () => {
    const big = byKey(result.players)['Big Fella'];
    close(big.adjusted.usg_delta, 0, 0.0005);
    assert.equal(big.actual_points, 28);
    // Out players are not slate rows
    assert.equal(byKey(result.players)['Sixth Man'], undefined);
  });
});

describe('getTeammateOpportunity (live slate)', () => {
  test('OUT injury status plus roster regulars missing from the slate', async () => {
    await db.run(`INSERT INTO slates (slate_id, name, sport, start_time, site) VALUES ('L1', 'Main', 'NBA', '7:00 PM', 'draftkings')`);
    const raw = JSON.stringify({ game: { dateTime: `${SLATE_DATE} 19:00:00` } });
    for (const [name, team, opp, proj, injury] of [
      ['Wing Man', 'BOS', 'NYK', 30, null], ['Big Fella', 'BOS', 'NYK', 28, null],
      ['Sixth Man', 'BOS', 'NYK', 0, 'OUT'], ['Charlie Nyk', 'NYK', 'BOS', 30, null], ['Alpha Nyk', 'NYK', 'BOS', 30, 'Doubtful']
    ]) {
      await db.run(`INSERT INTO players (slate_id, player_id, name, team, opponent, position, salary, projected_points, injury_status, raw_data)
        VALUES ('L1', ?, ?, ?, ?, 'SF', 5000, ?, ?, ?)`, name, name, team, opp, proj, injury, raw);
    }
    try {
      const live = await service.getTeammateOpportunity({ slateId: 'L1', now: new Date(`${SLATE_DATE}T16:00:00Z`) });
      assert.equal(live.source.isBacktest, false);
      const teams = byKey(live.teams, 'team');
      const bos = byKey(teams.BOS.out);
      // Traded Guy and Bench Warmer are not missing regulars
      assert.deepEqual(Object.keys(bos).sort(), ['Reserve Guy', 'Sixth Man', 'Star Guard']);
      assert.equal(bos['Sixth Man'].status_source, 'injury_status');
      assert.equal(bos['Star Guard'].status_source, 'not_on_slate');
      const nyk = byKey(teams.NYK.out);
      assert.equal(nyk['Alpha Nyk'].status_source, 'injury_status');
      assert.equal(nyk['Beta Nyk'].status_source, 'not_on_slate');
      assert.equal(byKey(live.players)['Alpha Nyk'], undefined);
    } finally {
      await db.run(`DELETE FROM players`);
      await db.run(`DELETE FROM slates`);
    }
  });
});

describe('GET /api/opportunity/teammates', () => {
  test('returns the slate source fields, teams and players', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    try {
      const res = await fetch(`${baseUrl}/api/opportunity/teammates?slateDate=${SLATE_DATE}&site=draftkings`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.success, true);
      assert.equal(body.isBacktest, true);
      assert.equal(body.slateDate, SLATE_DATE);
      assert.equal(body.teams.length, 2);
      assert.equal(body.players.length, 3);
    } finally {
      vi.useRealTimers();
    }
  });

  test('a date with no saved slate is a 404', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    try {
      assert.equal((await fetch(`${baseUrl}/api/opportunity/teammates?slateDate=2026-11-01`)).status, 404);
    } finally {
      vi.useRealTimers();
    }
  });
});
