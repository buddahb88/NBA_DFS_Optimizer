import { test, describe } from 'vitest';
import assert from 'node:assert/strict';
import { componentScores, opportunityScore, reasonLine, decileValidation } from '../src/services/opportunity/radarScore.js';
import { RADAR_WEIGHTS, RADAR_SCALES } from '../src/services/opportunity/radarConfig.js';

// Opportunity Radar score: O1-O3 metrics -> 0..1 components -> weighted 0..100.

const close = (actual, expected, eps = 0.002) =>
  assert.ok(Math.abs(actual - expected) <= eps, `expected ${expected}, got ${actual}`);

// A neutral player: every metric at its ramp midpoint
const NEUTRAL = {
  salary: 6000, projected_minutes: 20,
  min_delta_l3: 0, min_delta_l5: 0, games_l3: 3, games_l5: 5, games_l10: 10, starter_change: null,
  usg_delta: 0,
  teammate_sample: null, teammate_play_share_delta: null,
  rate_gap_pct: 0,
  value_games_l10: 10, hit5x_l10: 0.5, hit6x_l10: 0.5,
  min_sd_l10: 5, under20_l10: 5, starts_l5: 2.5,
  floor: 25.5, ceiling: 42,
  implied_total: 116, blowout: false, back_to_back: false,
  rate_value: 5, projected_points: 30, rostership: 17.5
};

describe('componentScores', () => {
  test('every component sits at 0.5 for a neutral player', () => {
    for (const mode of ['cash', 'gpp']) {
      const c = componentScores(NEUTRAL, mode);
      // vacated is null without teammates out
      assert.equal(c.vacated, null);
      for (const [name, value] of Object.entries(c)) if (name !== 'vacated') close(value, 0.5, 0.001);
    }
  });

  test('minutes: L3 / L5 deltas on a -6..+6 ramp, plus a bonus for moving into the lineup', () => {
    // 0.6 x 6 + 0.4 x 3 = 4.8 -> 0.5 + 4.8 / 12
    close(componentScores({ ...NEUTRAL, min_delta_l3: 6, min_delta_l5: 3 }, 'cash').minutes, 0.9);
    close(componentScores({ ...NEUTRAL, min_delta_l3: -12, min_delta_l5: -12 }, 'cash').minutes, 0);
    close(componentScores({ ...NEUTRAL, starter_change: 'into' }, 'cash').minutes, 0.5 + RADAR_SCALES.minutes.intoLineupBonus);
    // One game in the L3 window: shrunk to a third of the way from neutral
    close(componentScores({ ...NEUTRAL, min_delta_l3: 6, min_delta_l5: 6, games_l3: 1, games_l5: 1 }, 'cash').minutes, 0.5 + 0.5 / 3);
  });

  test('vacated: play-share rise without tonight\'s outs; a thin sample counts half; no outs is neutral', () => {
    close(componentScores({ ...NEUTRAL, teammate_sample: 'confirmed', teammate_play_share_delta: 0.03 }, 'gpp').vacated, 0.75);
    close(componentScores({ ...NEUTRAL, teammate_sample: 'thin', teammate_play_share_delta: 0.03 }, 'gpp').vacated, 0.625);
    assert.equal(componentScores({ ...NEUTRAL, teammate_sample: 'none', teammate_play_share_delta: 0.03 }, 'gpp').vacated, null);
    assert.equal(componentScores(NEUTRAL, 'gpp').vacated, null);
  });

  test('hit rate: 5x for cash, 6x for GPP, shrunk toward neutral on a short L10', () => {
    const p = { ...NEUTRAL, hit5x_l10: 0.8, hit6x_l10: 0.2 };
    close(componentScores(p, 'cash').hitRate, 0.8);
    close(componentScores(p, 'gpp').hitRate, 0.2);
    close(componentScores({ ...p, value_games_l10: 5 }, 'cash').hitRate, 0.65);
  });

  test('stability: low minutes SD, few sub-20 games and starts', () => {
    close(componentScores({ ...NEUTRAL, min_sd_l10: 2, under20_l10: 0, starts_l5: 5, games_l5: 5 }, 'cash').stability, 1);
    close(componentScores({ ...NEUTRAL, min_sd_l10: 10, under20_l10: 10, starts_l5: 0 }, 'cash').stability, 0);
  });

  test('environment: implied total ramp less blowout and back-to-back penalties', () => {
    close(componentScores({ ...NEUTRAL, implied_total: 124 }, 'cash').environment, 1);
    close(componentScores({ ...NEUTRAL, blowout: true, back_to_back: true }, 'cash').environment, 0.5 - 0.2 - 0.1);
  });

  test('floor / upside per $1K, leverage = value nobody is on', () => {
    close(componentScores({ ...NEUTRAL, floor: 33 }, 'cash').floor, 1); // 5.5x
    close(componentScores({ ...NEUTRAL, ceiling: 54 }, 'gpp').upside, 1); // 9x
    close(componentScores({ ...NEUTRAL, rate_value: 6.5, rostership: 0 }, 'gpp').leverage, 1);
    close(componentScores({ ...NEUTRAL, rate_value: 6.5, rostership: 35 }, 'gpp').leverage, 0);
    // Falls back to the posted projection's value without a rate projection
    close(componentScores({ ...NEUTRAL, rate_value: null, projected_points: 39, rostership: 0 }, 'gpp').leverage, 1);
  });

  test('missing metrics are null', () => {
    const c = componentScores({ salary: 5000 }, 'cash');
    assert.equal(c.minutes, null);
    assert.equal(c.gap, null);
    assert.equal(c.floor, null);
    assert.equal(c.projMinutes, null);
  });

  test('projected minutes: 10..30 ramp on the slate minutes', () => {
    close(componentScores({ ...NEUTRAL, projected_minutes: 30 }, 'cash').projMinutes, 1);
    close(componentScores({ ...NEUTRAL, projected_minutes: 8 }, 'cash').projMinutes, 0);
  });
});

describe('opportunityScore', () => {
  test('a neutral player scores 50 in both modes', () => {
    assert.equal(opportunityScore(NEUTRAL, 'cash').score, 50);
    assert.equal(opportunityScore(NEUTRAL, 'gpp').score, 50);
  });

  test('100 x weighted mean of components, missing ones at 0.5; coverage = weight with data', () => {
    const p = { ...NEUTRAL, min_delta_l3: 6, min_delta_l5: 6 }; // minutes -> 1
    const { score, components, coverage } = opportunityScore(p, 'cash');
    const w = RADAR_WEIGHTS.cash;
    const total = Object.values(w).reduce((a, b) => a + b, 0);
    close(score, 100 * (0.5 * total + 0.5 * w.minutes) / total, 0.05);
    assert.equal(components.minutes, 1);
    // vacated (no outs) and leverage (weight 0 in cash) aside, everything has data
    close(coverage, (total - w.vacated) / total, 0.001);
  });

  test('cash rewards stability and floor, GPP rewards upside and leverage', () => {
    const steady = { ...NEUTRAL, min_sd_l10: 2, under20_l10: 0, starts_l5: 5, floor: 33, ceiling: 36, rostership: 35 };
    const volatile = { ...NEUTRAL, min_sd_l10: 9, under20_l10: 6, starts_l5: 0, floor: 15, ceiling: 60, rostership: 2, rate_value: 6.5 };
    assert.ok(opportunityScore(steady, 'cash').score > opportunityScore(volatile, 'cash').score);
    assert.ok(opportunityScore(volatile, 'gpp').score > opportunityScore(steady, 'gpp').score);
  });

  test('custom weights come from the config argument', () => {
    const p = { ...NEUTRAL, min_delta_l3: 6, min_delta_l5: 6 };
    const config = { weights: { cash: { minutes: 1 } } };
    assert.equal(opportunityScore(p, 'cash', config).score, 100);
  });
});

describe('reasonLine', () => {
  test('minutes, starter date, absorbed usage of the outs', () => {
    const line = reasonLine({
      ...NEUTRAL, min_delta_l3: 6.24, starter_since: '2026-10-21', starter_streak: 3,
      teammate_sample: 'confirmed', teammate_absorbed_pct: 0.31, teammate_out_names: ['Tobias Harris']
    });
    assert.equal(line, '+6.2 min L3, starter since 10/21, absorbs ~31% of Harris usage (OUT)');
  });

  test('cautions (blowout, back-to-back) and caps at four parts', () => {
    const line = reasonLine({
      ...NEUTRAL, min_delta_l3: -4, usg_delta: 0.05, rate_gap: 4.3, hit5x_l10: 0.7,
      implied_total: 121.5, blowout: true, spread: -12, back_to_back: true
    });
    assert.equal(line, '-4.0 min L3, usage +5.0 pts L5, rate proj +4.3 vs posted, hit 5x in 7/10');
    assert.equal(reasonLine({ ...NEUTRAL, hit5x_l10: 0, blowout: true, spread: 12.5, back_to_back: true }),
      'blowout risk (spread +12.5), back-to-back');
  });

  test('several outs, shooting bounce-back and salary lag', () => {
    assert.equal(reasonLine({
      ...NEUTRAL, teammate_sample: 'thin', teammate_absorbed_pct: 0.2, teammate_out_names: ['Joel Embiid', 'Paul George'],
      shooting_flag: 'bounce_back', salary_lag: true
    }), 'absorbs ~20% of Embiid + George usage (OUT, thin sample), TS% bounce-back due, salary lagging production');
  });

  test('a starter streak carried over from last season (season fallback) is left out', () => {
    assert.equal(reasonLine({ ...NEUTRAL, hit5x_l10: 0, starter_since: '2026-04-12', starter_streak: 2, season_fallback: true }), '');
  });

  test('nothing notable: empty string', () => {
    assert.equal(reasonLine({ ...NEUTRAL, hit5x_l10: 0.2 }), '');
  });
});

describe('decileValidation', () => {
  const row = (score, salary, actual, status = 'PLAYED') => ({ score, salary, actualPoints: actual, resultStatus: status });

  test('top-decile 5x hit rate vs the slate; DNP counts as a miss, pending is left out', () => {
    const rows = [
      row(90, 5000, 30), row(80, 5000, 10), // top 2 of 20: one hit
      ...Array.from({ length: 16 }, (_, i) => row(50 - i, 5000, i < 2 ? 26 : 5)),
      row(10, 5000, 0, 'DNP'),
      row(5, 5000, null, 'PENDING')
    ];
    const v = decileValidation(rows, { multiple: 5 });
    assert.equal(v.players, 19);
    assert.equal(v.top.players, 2);
    assert.equal(v.top.hits, 1);
    close(v.top.hitRate, 0.5);
    assert.equal(v.slate.hits, 3);
    close(v.slate.hitRate, 3 / 19);
    close(v.lift, 0.5 / (3 / 19), 0.01);
  });
});
