import { test, describe } from 'vitest';
import assert from 'node:assert/strict';
import { correlation, bucketStats, joinRows, buildReport } from '../src/services/playerCard/verdictBacktest.js';

const v = (verdict, score) => ({ verdict, score, confidence: 50 });

describe('verdict backtest math', () => {
  test('correlation: perfect, inverse, too small / flat -> null', () => {
    assert.equal(correlation([1, 2, 3], [2, 4, 6]), 1);
    assert.equal(correlation([1, 2, 3], [6, 4, 2]), -1);
    assert.equal(correlation([1, 2], [1, 2]), null);
    assert.equal(correlation([1, 1, 1], [1, 2, 3]), null);
  });

  test('bucketStats: actual, vs projection, value, 5x and 6x rates', () => {
    const rows = [
      { salary: 5000, projection: 25, actual: 30 }, // 6x
      { salary: 5000, projection: 25, actual: 25 }, // 5x
      { salary: 10000, projection: 50, actual: 20 }, // miss
      { salary: 4000, projection: 20, actual: 0 }, // DNP
    ];
    const b = bucketStats(rows);
    assert.equal(b.n, 4);
    assert.equal(b.avg_actual, 18.75);
    assert.equal(b.avg_vs_projection, -11.25);
    assert.equal(b.avg_value, 3.25);
    assert.equal(b.hit5x, 0.5);
    assert.equal(b.hit6x, 0.25);
    assert.equal(bucketStats([]).n, 0);
  });

  test('joinRows: no box score scores 0, OUT and unprojected players are excluded', () => {
    const verdicts = {
      players: {
        1: { id: 1, name: 'A', salary: 6000, projection: { active: 30, blend: 31 }, cash: v('Playable', 60), gpp: v('Pivot', 50) },
        2: { id: 2, name: 'B', salary: 5000, injury_status: 'OUT', projection: { active: 0, blend: 0 }, cash: v('Fade', 0), gpp: v('Fade', 0) },
        3: { id: 3, name: 'C', salary: 4000, projection: { active: 0, blend: null }, cash: v('Fade', 30), gpp: v('Fade', 30) },
        4: { id: 4, name: 'D', salary: 4000, projection: { active: 20, blend: 19 }, cash: v('Pivot', 45), gpp: v('Pivot', 45) },
      },
    };
    const actuals = new Map([[1, { actualPoints: 40, resultStatus: 'PLAYED' }]]);
    const rows = joinRows({ date: '2026-10-28', slateId: 's', verdicts, actuals });
    const byName = Object.fromEntries(rows.map(r => [r.name, r]));
    assert.equal(byName.A.actual, 40);
    assert.equal(byName.A.projection, 31, 'blend projection is the baseline');
    assert.equal(byName.D.actual, 0);
    assert.equal(byName.D.status, 'NO_BOX_SCORE');
    assert.equal(byName.B.excluded, 'out');
    assert.equal(byName.C.excluded, 'no_projection');

    const report = buildReport(rows);
    assert.equal(report.players, 2);
    assert.deepEqual(report.excluded, { out: 1, no_projection: 1 });
    assert.equal(report.dnp, 1);
    assert.equal(report.overall.cash.buckets.Playable.n, 1);
    assert.equal(report.overall.cash.buckets.Pivot.n, 1);
    assert.equal(report.tiers.under_5k.cash.all.n, 1);
    assert.equal(report.studs.cash.all.n, 0);
  });
});
