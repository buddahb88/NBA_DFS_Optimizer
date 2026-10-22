import { test, describe, beforeAll as before, afterAll as after } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

// Value-pick backtest (scripts/agent-value-backtest.js): the agent's top 5
// value plays at <= $6,500 vs (a) top 5 projected points per $1K
// ($3,500-6,500, not OUT) and (b) the average player in the $4,500-6,500 band
// who played. Scoring math is pinned to the real 2026-10-21 slate (fixture).
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nba-dfs-value-backtest-'));
process.env.DATABASE_TYPE = 'sqlite';
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/agentEval/valuePool-2026-10-21.json'), 'utf8'));
const POOL = FIXTURE.players;

let bt;
let db;
let playerKey;

before(async () => {
  bt = await import('../src/services/agentValueBacktest.js');
  db = (await import('../src/config/database.js')).default;
  await (await import('../src/config/schema.js')).createTables(db);
  ({ playerKey } = await import('../src/utils/playerKey.js'));
});

after(() => {
  db?.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const byNames = (names) => names.map(n => POOL.find(p => p.playerKey === playerKey(n)));

describe('scoring math (2026-10-21 reference)', () => {
  test('assistant picks: 98.75 DK, 3.71 per 1K, 0/5 at 5x', () => {
    const picks = byNames(['Isaiah Jackson', 'Gui Santos', 'Cedric Coward', 'Ryan Rollins', 'Kelly Oubre Jr.']);
    const s = bt.scorePicks(picks);
    assert.equal(s.players.length, 5);
    assert.equal(s.totalDk, 98.75);
    assert.equal(s.totalSalary, 26600);
    assert.equal(s.valuePer1k, 3.71);
    assert.equal(s.hits5x, 0);
    assert.equal(s.hit5x, 0);
    assert.equal(s.projectedMinutes, 30.2); // per player: 151 / 5
    assert.equal(s.actualMinutes, 24); // 120 / 5
  });

  test('baseline (a): top 5 projected per 1K at 3500-6500, not OUT', () => {
    const picks = bt.topProjectedValue(POOL);
    assert.deepEqual(picks.map(p => p.name), ['Dennis Schroder', 'Jalen Smith', 'Isaiah Jackson', 'Draymond Green', 'Grayson Allen']);
    const s = bt.scorePicks(picks);
    assert.equal(s.totalDk, 133);
    assert.equal(s.valuePer1k, 5.99);
    assert.equal(s.hits5x, 3);
    assert.equal(s.hit5x, 0.6);
  });

  test('baseline (a) skips OUT players and salaries outside the band', () => {
    const pool = [
      { name: 'Out Guy', playerKey: 'out guy', salary: 3500, projectedPoints: 40, injuryStatus: 'OUT', status: 'INACTIVE', actual: null },
      { name: 'Cheap', playerKey: 'cheap', salary: 3400, projectedPoints: 30, status: 'PLAYED', actual: 10 },
      { name: 'Pricey', playerKey: 'pricey', salary: 6600, projectedPoints: 60, status: 'PLAYED', actual: 10 },
      { name: 'Ok', playerKey: 'ok', salary: 5000, projectedPoints: 25, status: 'PLAYED', actual: 10 },
    ];
    assert.deepEqual(bt.topProjectedValue(pool).map(p => p.name), ['Ok']);
  });

  test('baseline (b): average played player at 4500-6500 = 4.14 per 1K, 31% hit 5x', () => {
    const b = bt.bandAverage(POOL);
    assert.equal(b.valuePer1k, 4.14);
    assert.equal(b.hit5x, 0.31);
    assert.equal(b.players, 94);
    // A 5-player set at the band's average
    assert.equal(b.avgDk, 22.43);
    assert.equal(b.totalDk, 112.17);
  });

  test('a DNP / INACTIVE pick scores 0 and counts as a 5x miss', () => {
    const s = bt.scorePicks(byNames(['Malik Monk', 'Dennis Schroder']));
    assert.equal(s.totalDk, 31.5);
    assert.equal(s.hits5x, 1);
    assert.equal(s.hit5x, 0.5);
    assert.equal(s.actualMinutes, 17.5);
  });
});

describe('agent value ranking', () => {
  test('ranks get_archetype_matchups rows by matchup-adjusted points per 1K at <= 6500, not OUT', () => {
    const rows = [
      { name: 'Star', salary: 9000, projectedPoints: 60, adjustedEdge: 5 },
      { name: 'Hurt', salary: 4000, projectedPoints: 30, adjustedEdge: 3, injuryStatus: 'OUT' },
      { name: 'A', salary: 5000, projectedPoints: 30, adjustedEdge: 1 }, // 6.2
      { name: 'B', salary: 4000, projectedPoints: 24, adjustedEdge: 2 }, // 6.5
      { name: 'C', salary: 6500, projectedPoints: 30, adjustedEdge: 0.5 }, // 4.69
      { name: 'D', salary: 3000, projectedPoints: 9, adjustedEdge: 0 }, // 3
      { name: 'E', salary: 6000, projectedPoints: 36, adjustedEdge: 1.2 }, // 6.2
      { name: 'F', salary: 4500, projectedPoints: 20, adjustedEdge: 1 }, // 4.67
    ];
    assert.deepEqual(bt.agentValuePicks(rows).map(p => p.name), ['B', 'E', 'A', 'C', 'F']);
  });
});

describe('live answers', () => {
  test('namesFromAnswer reads pool players in order of first mention, at most 5', () => {
    const text = `1. **Grayson Allen** ($4,300)
2. Isaiah Jackson
3. dennis schroder
4. Kelly Oubre Jr.
5. Jalen Smith
6. Draymond Green
Also Grayson Allen again.`;
    assert.deepEqual(bt.namesFromAnswer(text, POOL), ['Grayson Allen', 'Isaiah Jackson', 'Dennis Schroder', 'Kelly Oubre', 'Jalen Smith']);
  });
});

describe('summary', () => {
  test('cumulative totals and whether the agent beats baseline (a)', () => {
    const day = (date, agent, baseline) => ({
      date,
      methods: {
        agent: { totalDk: agent[0], totalSalary: agent[1], hits5x: agent[2], picks: 5, projectedMinutes: 30, actualMinutes: 28 },
        baseline_value: { totalDk: baseline[0], totalSalary: baseline[1], hits5x: baseline[2], picks: 5, projectedMinutes: 28, actualMinutes: 29 },
        band_average: { totalDk: 100, valuePer1k: 4, hit5x: 0.3, players: 10, hits5x: 3, valueSum: 40, projectedMinutes: 25, actualMinutes: 24 },
      },
    });
    const s = bt.summarize([day('2026-10-20', [120, 25000, 2], [100, 22000, 1]), day('2026-10-21', [98.75, 26600, 0], [133, 22200, 3])]);
    assert.equal(s.agent.totalDk, 218.75);
    assert.equal(s.agent.valuePer1k, 4.24); // 218.75 / 51.6
    assert.equal(s.agent.hit5x, 0.2);
    assert.equal(s.baseline_value.totalDk, 233);
    assert.equal(s.baseline_value.valuePer1k, 5.27); // 233 / 44.2
    assert.equal(s.baseline_value.hit5x, 0.4);
    assert.equal(s.band_average.valuePer1k, 4);
    assert.equal(s.band_average.hit5x, 0.3);
    assert.equal(s.agentBeatsBaseline, false);
  });
});

describe('runValueBacktest (sqlite)', () => {
  const DATE = '2026-01-05';

  before(async () => {
    const snap = (name, salary, projected, injury = null) => db.run(`
      INSERT INTO slate_player_snapshots (snapshot_date, game_date, slate_id, site, player_key, player_name, team, opponent,
        position, salary, projected_points, projected_minutes, injury_status)
      VALUES (?, ?, 'past1', 'draftkings', ?, ?, 'BOS', 'NYK', 'SF', ?, ?, 30, ?)`,
    DATE, DATE, playerKey(name), name, salary, projected, injury);
    const box = (name, minutes, dk) => db.run(`
      INSERT INTO historical_games (player_name, player_key, team, opponent, game_id, game_date, season, season_type, minutes, dk_fantasy_points)
      VALUES (?, ?, 'BOS', 'NYK', 'g1', ?, '2025-26', 'regular', ?, ?)`, name, playerKey(name), DATE, minutes, dk);
    const players = [
      ['Alpha One', 4000, 28, 30], ['Bravo Two', 4500, 27, 20], ['Charlie Three', 5000, 30, 35],
      ['Delta Four', 5500, 30, 25], ['Echo Five', 6000, 33, 31], ['Foxtrot Six', 6500, 30, 26], ['Golf Seven', 3500, 15, 10],
    ];
    for (const [name, salary, proj, dk] of players) {
      await snap(name, salary, proj);
      await box(name, 30, dk);
    }
    await snap('Hotel Out', 3600, 40, 'OUT');
  });

  test('scores every method per date, persists to agent_value_backtests and summarizes', async () => {
    const runAt = '2026-10-22T12:00:00.000Z';
    const result = await bt.runValueBacktest({
      site: 'draftkings',
      runAt,
      // Deterministic stand-in for the chat agent's picks
      agentPicker: async ({ pool }) => ({ source: 'test', names: pool.filter(p => p.salary >= 5000).map(p => p.name) }),
    });

    assert.equal(result.dates.length, 1);
    const [d] = result.dates;
    assert.equal(d.date, DATE);
    // The picker kept pool order (getPlayerResults: actual points, highest first)
    assert.deepEqual(d.methods.agent.names, ['Charlie Three', 'Echo Five', 'Foxtrot Six', 'Delta Four']);
    assert.equal(d.methods.agent.totalDk, 117);
    // 7.0, 6.0 (30 proj), 6.0 (27 proj), 5.5, 5.45 (Hotel is OUT, Golf is lowest)
    assert.deepEqual(d.methods.baseline_value.names, ['Alpha One', 'Charlie Three', 'Bravo Two', 'Echo Five', 'Delta Four']);
    assert.equal(d.methods.baseline_value.totalDk, 141);
    assert.equal(d.methods.band_average.players, 5);

    const rows = await db.all('SELECT * FROM agent_value_backtests WHERE run_at = ? ORDER BY method', runAt);
    assert.deepEqual(rows.map(r => r.method), ['agent', 'band_average', 'baseline_value']);
    const agent = rows.find(r => r.method === 'agent');
    assert.equal(agent.game_date, DATE);
    assert.equal(agent.total_dk, 117);
    assert.equal(agent.value_per_1k, 5.09); // 117 / 23
    assert.equal(agent.hit_5x, 0.5); // Charlie 35 >= 25, Echo 31 >= 30
    assert.equal(agent.source, 'test');
    assert.deepEqual(JSON.parse(agent.players).map(p => p.name), d.methods.agent.names);

    assert.equal(result.summary.agentBeatsBaseline, false);
  });

  test('persist: false leaves the table alone', async () => {
    const before = (await db.get('SELECT COUNT(*) AS n FROM agent_value_backtests')).n;
    await bt.runValueBacktest({ site: 'draftkings', persist: false, agentPicker: async () => ({ source: 'test', names: [] }) });
    assert.equal((await db.get('SELECT COUNT(*) AS n FROM agent_value_backtests')).n, before);
  });
});
