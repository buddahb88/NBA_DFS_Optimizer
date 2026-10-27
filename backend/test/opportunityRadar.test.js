import { test, describe, vi, beforeAll as before, afterAll as after, beforeEach } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';

// Opportunity Radar: O1-O3 metrics scored 0-100 per slate player (Cash / GPP)
// with a reason line; backtests add actuals and the top-decile 5x check.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nba-dfs-radar-'));
process.env.DATABASE_TYPE = 'sqlite';
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');

const addDays = (date, n) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

let db;
let metrics;
let radar;
let playerKey;
let server;
let baseUrl;

const SLATE_DATE = '2026-12-20';
const NOW = new Date('2026-12-25T16:00:00Z'); // the slate is in the past: backtest
const GAMES = 20;
const gameDate = (g) => addDays(SLATE_DATE, -2 * (GAMES + 1 - g));
const STAR_OUT = [4, 5, 6, 7, 8, 9]; // 6 games without Star: a confirmed split

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

// [minutes, FGA, TOV, DK points, starter]
async function box(name, team, opp, date, [minutes, fga, tov, fp, starter = 1]) {
  const gameId = await teamGame(date, team, opp);
  await db.run(`
    INSERT INTO historical_games (player_name, player_key, team, opponent, game_id, game_date, season, season_type,
      minutes, points, rebounds, assists, steals, blocks, turnovers, fouls, fg_made, fg_attempted, fg3_made, fg3_attempted,
      ft_made, ft_attempted, oreb, dreb, is_starter, dk_fantasy_points, fd_fantasy_points, yahoo_fantasy_points)
    VALUES (?, ?, ?, ?, ?, ?, '2026-27', 'regular', ?, ?, 0, 0, 0, 0, ?, 2, ?, ?, 0, 0, 0, 0, 0, 0, ?, ?, ?, ?)
  `, name, playerKey(name), team, opp, gameId, date, minutes, Math.floor(fga / 2), tov, Math.floor(fga / 2), fga,
  starter, fp, fp + 5, fp);
}

async function snapshot(name, team, opp, { salary, projected = 30, minutes = 30, own = 10, floor = 20, ceiling = 40, injury = null }) {
  await db.run(`
    INSERT INTO slate_player_snapshots (snapshot_date, game_date, site, slate_id, player_key, player_name, team, opponent, position,
      salary, projected_points, projected_minutes, floor, ceiling, rostership, vegas_implied_total, vegas_spread, over_under, injury_status)
    VALUES (?, ?, 'draftkings', 'S1', ?, ?, ?, ?, 'SF', ?, ?, ?, ?, ?, ?, 116, -3, 230, ?)
  `, SLATE_DATE, SLATE_DATE, playerKey(name), name, team, opp, salary, projected, minutes, floor, ceiling, own, injury);
}

async function seed() {
  for (let g = 1; g <= GAMES; g++) {
    const date = gameDate(g);
    if (!STAR_OUT.includes(g)) await box('Star Guard', 'BOS', 'NYK', date, [34, 22, 3, 45]);
    // Wing: bench 22 minutes with Star, 34 without; moved into the lineup for the last 3
    const wing = STAR_OUT.includes(g) ? [34, 18, 3, 42, 0] : g > GAMES - 3 ? [34, 16, 2, 38, 1] : [22, 10, 2, 22, 0];
    await box('Wing Man', 'BOS', 'NYK', date, wing);
    // Fading Vet: 30 minutes, then 16 over the last 3
    await box('Fading Vet', 'NYK', 'BOS', date, g > GAMES - 3 ? [16, 6, 1, 12] : [30, 12, 2, 30]);
  }
  // The slate night: Wing smashes 5x, the vet does not
  await box('Wing Man', 'BOS', 'NYK', SLATE_DATE, [36, 20, 2, 44]);
  await box('Fading Vet', 'NYK', 'BOS', SLATE_DATE, [15, 5, 1, 10]);

  await snapshot('Star Guard', 'BOS', 'NYK', { salary: 9000, projected: 0, minutes: 0, injury: 'OUT' });
  await snapshot('Wing Man', 'BOS', 'NYK', { salary: 6000, projected: 30, minutes: 34, own: 4, floor: 24, ceiling: 48 });
  await snapshot('Fading Vet', 'NYK', 'BOS', { salary: 6000, projected: 28, minutes: 26, own: 25, floor: 15, ceiling: 36 });
}

before(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  db = (await import('../src/config/database.js')).default;
  await (await import('../src/config/schema.js')).createTables(db);
  metrics = await import('../src/services/opportunity/metricsService.js');
  radar = await import('../src/services/opportunity/radarService.js');
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

const load = (mode = 'cash') => radar.getOpportunityRadar({ slateDate: SLATE_DATE, site: 'draftkings', mode, now: NOW });

describe('getOpportunityRadar (backtest date)', () => {
  test('scores every slate player, best first, with both modes and the mode\'s components', async () => {
    const result = await load('cash');
    assert.equal(result.mode, 'cash');
    assert.equal(result.source.isBacktest, true);
    assert.deepEqual(result.players.map(p => p.name), ['Wing Man', 'Fading Vet']);
    const [wing, vet] = result.players;
    assert.equal(wing.score, wing.cash_score);
    assert.ok(wing.score > 50 && vet.score < 50, `wing ${wing.score}, vet ${vet.score}`);
    assert.ok(wing.components.minutes > 0.5 && vet.components.minutes < 0.5);
    assert.ok(wing.components.vacated > 0.5);
    assert.equal(vet.components.vacated, null);
    assert.ok(wing.coverage > 0.9);
    // Metrics fields ride along for the table
    assert.equal(wing.teammate_sample, 'confirmed');
    assert.equal(wing.salary, 6000);

    const gpp = await load('gpp');
    assert.equal(gpp.mode, 'gpp');
    assert.equal(gpp.players[0].score, gpp.players[0].gpp_score);
    assert.deepEqual(gpp.weights, (await import('../src/services/opportunity/radarConfig.js')).RADAR_WEIGHTS.gpp);
  });

  test('reason line: minutes jump, starter date, usage absorbed from the pre-lock out', async () => {
    const [wing, vet] = (await load()).players;
    assert.match(wing.reason, /^\+\d+\.\d min L3, starter since \d+\/\d+, absorbs ~\d+% of Guard usage \(OUT\)/);
    assert.equal(wing.starter_since, gameDate(GAMES - 2));
    assert.match(vet.reason, /^-\d+\.\d min L3/);
  });

  test('backtest: actual points / result (withActuals naming) and the top-decile 5x check per mode', async () => {
    const { players, validation } = await load();
    const wing = players[0];
    assert.equal(wing.actualPoints, 44);
    assert.equal(wing.actualMinutes, 36);
    assert.equal(wing.resultStatus, 'PLAYED');
    for (const mode of ['cash', 'gpp']) {
      const v = validation[mode];
      assert.equal(v.multiple, 5);
      assert.equal(v.players, 2);
      assert.equal(v.top.players, 1);
      assert.equal(v.top.hits, 1); // Wing: 44 >= 30
      assert.equal(v.slate.hitRate, 0.5);
      assert.equal(v.lift, 2);
    }
  });

  test('an unknown mode is a 400', async () => {
    await assert.rejects(() => load('showdown'), (e) => e.status === 400);
  });
});

describe('live slate', () => {
  test('no actuals and no validation', async () => {
    await db.run(`INSERT INTO slates (slate_id, name, sport, start_time, site) VALUES ('L1', 'Main', 'NBA', '7:00 PM', 'draftkings')`);
    await db.run(`
      INSERT INTO players (slate_id, player_id, name, team, opponent, position, salary, projected_points, projected_minutes,
        floor, ceiling, rostership, vegas_implied_total, vegas_spread, vegas_over_under, raw_data)
      VALUES ('L1', 'rw1', 'Wing Man', 'BOS', 'NYK', 'SF', 6000, 30, 34, 24, 48, 4, 116, -3, 230, ?)
    `, JSON.stringify({ game: { dateTime: `${SLATE_DATE} 19:00:00` } }));
    const result = await radar.getOpportunityRadar({ slateId: 'L1', now: new Date(`${SLATE_DATE}T16:00:00Z`) });
    assert.equal(result.source.isBacktest, false);
    assert.equal(result.validation, null);
    assert.equal(result.players.length, 1);
    assert.equal(result.players[0].actualPoints, undefined);
    assert.ok(result.players[0].score > 50);
    await db.run(`DELETE FROM players`);
    await db.run(`DELETE FROM slates`);
  });
});

describe('GET /api/opportunity/radar', () => {
  test('returns source fields, mode, weights, validation and scored players', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    try {
      const res = await fetch(`${baseUrl}/api/opportunity/radar?slateDate=${SLATE_DATE}&site=draftkings&mode=gpp`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.success, true);
      assert.equal(body.isBacktest, true);
      assert.equal(body.slateDate, SLATE_DATE);
      assert.equal(body.mode, 'gpp');
      assert.equal(body.count, 2);
      assert.ok(body.weights.leverage > 0);
      assert.equal(body.validation.gpp.top.hits, 1);
      for (const key of ['score', 'cash_score', 'gpp_score', 'components', 'reason', 'actualPoints', 'resultStatus']) {
        assert.ok(key in body.players[0], key);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  test('defaults to cash; a bad mode is a 400, a date with no slate a 404', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    try {
      const body = await (await fetch(`${baseUrl}/api/opportunity/radar?slateDate=${SLATE_DATE}`)).json();
      assert.equal(body.mode, 'cash');
      assert.equal((await fetch(`${baseUrl}/api/opportunity/radar?slateDate=${SLATE_DATE}&mode=nope`)).status, 400);
      assert.equal((await fetch(`${baseUrl}/api/opportunity/radar?slateDate=2026-11-01`)).status, 404);
    } finally {
      vi.useRealTimers();
    }
  });
});
