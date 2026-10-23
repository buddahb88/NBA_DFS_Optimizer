/**
 * Tests for the per-player outcome distribution (pure functions, no database).
 * Run: npx vitest run test/outcomeDistribution.test.js
 */

import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  FLOOR_PCTL,
  CEILING_PCTL,
  PRIOR_GAMES,
  CALIBRATION,
  normalCdf,
  normalQuantile,
  positionGroup,
  priorFor,
  summarizeGameLog,
  shrinkProfile,
  outcomeDistribution,
  computeOutcomeRange,
  boomBustThresholds
} from '../src/services/variance/outcomeDistribution.js';
import { replayCases, coverage, legacyRange } from '../src/services/variance/replay.js';

const close = (actual, expected, tol, label = '') =>
  assert.ok(Math.abs(actual - expected) <= tol, `${label} expected ${expected} ± ${tol}, got ${actual}`);

// Most recent first, like the repository returns them
const log = (pairs) => pairs.map(([minutes, fp]) => ({ minutes, fp }));

test('floor and ceiling are the 15th and 85th percentiles', () => {
  assert.equal(FLOOR_PCTL, 0.15);
  assert.equal(CEILING_PCTL, 0.85);
});

test('normalCdf / normalQuantile are accurate inverses', () => {
  close(normalCdf(0), 0.5, 1e-7);
  close(normalCdf(1.959964), 0.975, 1e-5);
  close(normalCdf(-1), 0.158655, 1e-5);
  for (const p of [0.001, 0.05, 0.15, 0.5, 0.85, 0.99]) close(normalCdf(normalQuantile(p)), p, 1e-6, `p=${p}`);
});

test('positionGroup maps DK/ESPN positions to G/F/C', () => {
  assert.equal(positionGroup('PG'), 'G');
  assert.equal(positionGroup('SG,SF'), 'G');
  assert.equal(positionGroup('SF/PF'), 'F');
  assert.equal(positionGroup('PF,C'), 'F');
  assert.equal(positionGroup('C'), 'C');
  assert.equal(positionGroup('F'), 'F');
  assert.equal(positionGroup(null), 'F');
});

test('summarizeGameLog: minutes-weighted rate, rate CV and minutes spread', () => {
  // Rates 1.0 and 1.5 at 30 min, a 4-minute cameo is excluded from the rate stats
  const s = summarizeGameLog(log([[30, 30], [30, 45], [4, 20]]));
  assert.equal(s.games, 3);
  assert.equal(s.rateGames, 2);
  close(s.fppm, 75 / 60, 1e-9);
  // sample sd of [1, 1.5] = 0.35355; kappa = cv * sqrt(mean rate-game minutes)
  close(s.kappa, (0.353553 / 1.25) * Math.sqrt(30), 1e-4);
  close(s.minutesMean, 64 / 3, 1e-9);
  assert.ok(s.minutesSd > 14);

  const empty = summarizeGameLog([]);
  assert.equal(empty.games, 0);
  assert.equal(empty.kappa, null);
  assert.equal(empty.minutesSd, null);
});

test('shrinkProfile: no history falls back to the prior entirely', () => {
  const prior = priorFor('G', 30);
  const p = shrinkProfile(summarizeGameLog([]), prior);
  assert.equal(p.kappa, prior.kappa);
  assert.equal(p.minutesSd, prior.minutesSd);
  assert.equal(p.weight, 0);
});

test('shrinkProfile: small samples stay near the prior, large samples follow the player', () => {
  const prior = priorFor('F', 30);
  // A very steady player: identical rate every game, identical minutes
  const steady = (n) => summarizeGameLog(log(Array.from({ length: n }, () => [30, 30])));

  const few = shrinkProfile(steady(3), prior);
  const many = shrinkProfile(steady(30), prior);
  assert.ok(few.weight < 0.3, `3 games weight ${few.weight}`);
  assert.ok(many.weight > 0.75, `30 games weight ${many.weight}`);
  close(few.weight, 3 / (3 + PRIOR_GAMES), 1e-9);
  // Shrinkage pulls the zero-variance sample up toward the prior
  assert.ok(few.kappa > 0.7 * prior.kappa);
  assert.ok(many.kappa < few.kappa);
  assert.ok(many.minutesSd < few.minutesSd);
});

test('priorFor: low-minute roles get more minutes uncertainty', () => {
  assert.ok(priorFor('G', 14).minutesSd > priorFor('G', 34).minutesSd);
  assert.ok(priorFor('C', 25).kappa > 0);
});

test('outcomeDistribution: mean is pinned to the projection, quantiles are ordered', () => {
  const d = outcomeDistribution({ mean: 36.3, minutes: 34, kappa: 1.6, minutesSd: 5 });
  close(d.mean, 36.3, 0.05);
  const q15 = d.quantile(0.15);
  const q50 = d.quantile(0.5);
  const q85 = d.quantile(0.85);
  assert.ok(q15 < q50 && q50 < q85);
  close(d.cdf(q15), 0.15, 1e-3);
  close(d.cdf(q85), 0.85, 1e-3);
  // Right skew: median below mean
  assert.ok(q50 < 36.3);
  // sd consistent with a ~30% CV fantasy outcome
  assert.ok(d.sd > 0.22 * 36.3 && d.sd < 0.45 * 36.3, `sd ${d.sd}`);
});

test('outcomeDistribution: more minutes uncertainty widens the range', () => {
  const tight = outcomeDistribution({ mean: 30, minutes: 30, kappa: 1.5, minutesSd: 2 });
  const loose = outcomeDistribution({ mean: 30, minutes: 30, kappa: 1.5, minutesSd: 9 });
  assert.ok(loose.quantile(0.15) < tight.quantile(0.15));
  assert.ok(loose.sd > tight.sd);
});

test('boomBustThresholds keep the existing definition (value = 5x, boom = value + 10)', () => {
  assert.deepEqual(boomBustThresholds(6000), { value: 30, boom: 40 });
});

test('computeOutcomeRange returns consistent floor/ceiling/sd/volatility/boom/bust', () => {
  const profile = shrinkProfile(summarizeGameLog([]), priorFor('G', 34));
  const r = computeOutcomeRange({ projection: 36.3, minutes: 34, salary: 6000, profile });
  assert.ok(r.floor < 36.3 && r.ceiling > 36.3);
  close(r.volatility, r.stdDev / 36.3, 1e-9);
  // Bust = P(score < 30), boom = P(score >= 40), both from the same distribution
  const d = outcomeDistribution({
    mean: 36.3, minutes: 34,
    kappa: profile.kappa * CALIBRATION.kappaScale,
    minutesSd: profile.minutesSd * CALIBRATION.minutesScale
  });
  close(r.bustProbability, 100 * d.cdf(30), 1e-6);
  close(r.boomProbability, 100 * (1 - d.cdf(40)), 1e-6);
  close(r.floor, d.quantile(FLOOR_PCTL), 1e-6);
  close(r.ceiling, d.quantile(CEILING_PCTL), 1e-6);
});

test('computeOutcomeRange: blowout risk widens the distribution instead of shifting points', () => {
  const profile = shrinkProfile(summarizeGameLog([]), priorFor('F', 30));
  const base = computeOutcomeRange({ projection: 28, minutes: 30, salary: 5000, profile });
  const blowout = computeOutcomeRange({ projection: 28, minutes: 30, salary: 5000, profile, blowoutRisk: 0.5 });
  assert.ok(blowout.floor < base.floor);
  assert.ok(blowout.ceiling > base.ceiling);
  assert.ok(blowout.stdDev > base.stdDev);
});

test('computeOutcomeRange: no projection means a zero range', () => {
  const profile = shrinkProfile(summarizeGameLog([]), priorFor('G', 0));
  const r = computeOutcomeRange({ projection: 0, minutes: 0, salary: 3000, profile });
  assert.deepEqual(r, { floor: 0, ceiling: 0, stdDev: 0, volatility: 0, boomProbability: 0, bustProbability: 0 });
});

// Regression: 2026-10-21 DK slate. The old method produced floor 34.25 / ceiling 38.35
// for Coward (actual 21.25) and 26.35 / 29.17 for Oubre (actual 14.5).
test('regression: Coward/Oubre-type players get ranges wide enough to cover real misses', () => {
  // Typical wing log: ~30 min, rate swinging 0.6-1.3 FP/min
  const wing = log([
    [33, 30], [31, 22], [35, 41], [28, 19], [34, 36], [30, 25], [36, 44], [29, 18], [32, 33], [34, 27],
    [31, 35], [27, 16], [33, 39], [35, 30], [30, 21], [32, 38], [29, 24], [34, 31], [31, 28], [33, 42]
  ]);
  const profile = shrinkProfile(summarizeGameLog(wing), priorFor('G', 34));
  const coward = computeOutcomeRange({ projection: 36.3, minutes: 34, salary: 6000, profile });
  const oubre = computeOutcomeRange({ projection: 27.76, minutes: 32, salary: 4700, profile });

  // Ranges should be roughly +/- 25-35% of projection, not +/- 5%
  assert.ok(coward.ceiling - coward.floor > 0.45 * 36.3, `Coward range ${coward.floor}-${coward.ceiling}`);
  assert.ok(oubre.ceiling - oubre.floor > 0.45 * 27.76, `Oubre range ${oubre.floor}-${oubre.ceiling}`);
  assert.ok(coward.floor < 29 && coward.ceiling > 43);
  // A 21-point Coward night is unlikely but not ~impossible (old model: z = -7.4)
  assert.ok(coward.bustProbability > 25);
  assert.ok(oubre.floor < 22);

  // The legacy calculation on the rolling averages it was fed is the bug
  const legacy = legacyRange(36.3, [31.1, 25.4, 28, 27.5]);
  assert.ok(legacy.ceiling - legacy.floor < 5);
});

test('replayCases: uses only games strictly before each game date (no lookahead)', () => {
  const games = [
    { player_key: 'a', game_date: '2025-11-01', minutes: 30, fp: 30, season: '2025-26' },
    { player_key: 'a', game_date: '2025-11-03', minutes: 30, fp: 36, season: '2025-26' },
    { player_key: 'a', game_date: '2025-11-05', minutes: 30, fp: 42, season: '2025-26' },
    { player_key: 'a', game_date: '2025-11-07', minutes: 30, fp: 99, season: '2025-26' }
  ];
  const cases = replayCases(games, { minPriorGames: 3, window: 30 });
  assert.equal(cases.length, 1);
  const c = cases[0];
  assert.equal(c.game_date, '2025-11-07');
  assert.equal(c.actual, 99);
  assert.equal(c.priorGames.length, 3);
  assert.ok(c.priorGames.every((g) => g.game_date < '2025-11-07'));
  // Naive projection = recent minutes x prior FPPM, never the actual
  close(c.projection, 30 * (108 / 90), 1e-9);
  close(c.minutes, 30, 1e-9);
  // Prior games are returned most recent first
  assert.equal(c.priorGames[0].game_date, '2025-11-05');
});

test('replayCases: respects window and the from/to range', () => {
  const games = Array.from({ length: 12 }, (_, i) => ({
    player_key: 'b', game_date: `2025-12-${String(i + 1).padStart(2, '0')}`, minutes: 20, fp: 20 + i, season: '2025-26'
  }));
  const cases = replayCases(games, { minPriorGames: 5, window: 4, from: '2025-12-10' });
  assert.deepEqual(cases.map((c) => c.game_date), ['2025-12-10', '2025-12-11', '2025-12-12']);
  assert.ok(cases.every((c) => c.priorGames.length === 4));
});

test('coverage counts actuals below floor and above ceiling', () => {
  const c = coverage([
    { actual: 10, floor: 15, ceiling: 30 },
    { actual: 20, floor: 15, ceiling: 30 },
    { actual: 35, floor: 15, ceiling: 30 },
    { actual: 25, floor: 15, ceiling: 30 }
  ]);
  assert.deepEqual(c, { n: 4, below: 1, above: 1, belowPct: 25, abovePct: 25 });
});
