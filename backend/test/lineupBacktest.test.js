import { test, describe, beforeAll as before } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Services pull in the database module; keep it off the real DB
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nba-dfs-lineup-backtest-'));
let lb;

before(async () => {
  process.env.DATABASE_TYPE = 'sqlite';
  process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');
  lb = await import('../src/services/modelEval/lineupBacktest.js');
});

const POSITIONS = ['PG', 'SG', 'SF', 'PF', 'C', 'PG,SG', 'SF,PF', 'PF,C', 'SG,SF', 'PG'];
const GAMES = [['AAA', 'BBB'], ['CCC', 'DDD']];

/** One synthetic slate: 4 teams x 10 players, seeded actuals; sources 'perfect' (= actual), 'noisy', 'reversed'. */
function slateRows(slateId = 's1') {
  const rows = [];
  let i = 0;
  for (const [home, away] of GAMES) {
    for (const [team, opponent] of [[home, away], [away, home]]) {
      for (let k = 0; k < 10; k++) {
        i++;
        const salary = 3000 + ((i * 37) % 15) * 500;
        const actual = Math.round(((salary / 1000) * 5 + ((i * 53) % 17) - 8) * 10) / 10;
        rows.push({
          slateId, date: '2026-10-21', key: `p${i}`, name: `Player ${i}`, team, opponent, position: POSITIONS[k], salary,
          actual: { dk: actual, minutes: 30 },
          slate: { ownership: 5 + (i % 7) * 3, leverage: 1, injuryStatus: i === 40 ? 'OUT' : null },
          preds: {
            perfect: { dk_points: actual, minutes: 30, p10: actual * 0.6, p90: actual * 1.4 },
            noisy: { dk_points: actual + ((i * 29) % 11) - 5, minutes: 30, p10: actual * 0.6, p90: actual * 1.4, p_boom: 0.2 },
            reversed: { dk_points: 70 - actual, minutes: 30 }
          }
        });
      }
    }
  }
  return rows;
}

describe('lineup backtest', () => {
  test('pools: stable ids across sources, OUT players dropped, leverage from p_boom when given', () => {
    const rows = lb.rosterable(slateRows());
    assert.equal(rows.length, 39);
    const a = lb.poolFor(rows, 'perfect');
    const b = lb.poolFor(rows, 'noisy');
    assert.deepEqual(a.map(p => [p.id, p.name]), b.map(p => [p.id, p.name]));
    assert.equal(a[0].leverage_score, 1);
    assert.equal(b[0].leverage_score, 20 / (rows[0].slate.ownership + 1));
  });

  test('cash: max-projection lineup is valid; with perfect projections it is the hindsight optimal', () => {
    const rows = lb.rosterable(slateRows());
    const perfect = lb.bestLineup(lb.poolFor(rows, 'perfect'));
    const optimal = lb.bestLineup(lb.poolFor(rows, 'perfect'), 'actual');
    assert.equal(perfect.players.length, 8);
    assert.ok(perfect.salary <= 50000 && perfect.salary >= 49000);
    assert.equal(perfect.actual, optimal.actual);
    const reversed = lb.bestLineup(lb.poolFor(rows, 'reversed'));
    assert.ok(reversed.actual < perfect.actual);
  });

  test('field percentile: ownership-sampled valid lineups, ties count half', () => {
    const rows = lb.rosterable(slateRows());
    const field = lb.fieldScores(rows, { size: 300, seed: 'x' });
    assert.equal(field.length, 300);
    for (let i = 1; i < field.length; i++) assert.ok(field[i] >= field[i - 1]);
    assert.equal(lb.percentileIn([1, 2, 3, 4], 3), 62.5); // 2 below + half a tie
    assert.equal(lb.percentileIn([1, 2, 3, 4], 10), 100);
    // Same seed, same field
    assert.deepEqual([...lb.fieldScores(rows, { size: 300, seed: 'x' })], [...field]);
  });

  test('runLineupBacktest: per slate cash / GPP per source and totals', () => {
    const rows = [...slateRows('s1'), ...slateRows('s2').map(r => ({ ...r, date: '2026-10-22' }))];
    const settings = { ...lb.GPP_SETTINGS, numLineups: 3, minProjection: 0, minMinutes: 0 };
    const res = lb.runLineupBacktest(rows, ['perfect', 'noisy'], { fieldSize: 200, settings });
    assert.equal(res.slates.length, 2);
    for (const s of res.slates) {
      assert.equal(s.cash.perfect.actual, s.optimal);
      assert.equal(s.cash.perfect.pctOfOptimal, 100);
      assert.equal(s.cash.perfect.fieldPercentile, 100);
      assert.ok(s.cash.noisy.actual <= s.optimal);
      assert.equal(s.gpp.perfect.lineups.length, 3);
      assert.ok(s.gpp.perfect.best >= s.gpp.perfect.avg);
    }
    assert.equal(res.totals.perfect.cashSlates, 2);
    assert.equal(res.totals.perfect.cashWins, 2);
    // Several seeds: best / avg are means over the seeds' portfolios
    const multi = lb.runLineupBacktest(rows.filter(r => r.slateId === 's1'), ['noisy'], { fieldSize: 200, settings, gppSeeds: 2 });
    const g = multi.slates[0].gpp.noisy;
    assert.equal(g.seeds, 2);
    assert.equal(g.bestBySeed.length, 2);
    assert.ok(Math.abs(g.best - (g.bestBySeed[0] + g.bestBySeed[1]) / 2) < 0.01);
    assert.equal(res.totals.perfect.cashActual, Math.round(res.slates.reduce((t, s) => t + s.optimal, 0) * 100) / 100);
  });

  test('GPP portfolio relaxes the pool filters on a slate too small for them', () => {
    const rows = lb.rosterable(slateRows());
    const g = lb.gppPortfolio(lb.poolFor(rows, 'perfect'), { settings: { ...lb.GPP_SETTINGS, numLineups: 2, minProjection: 60 } });
    assert.equal(g.filtersRelaxed, true);
    assert.equal(g.lineups.length, 2);
  });
});
