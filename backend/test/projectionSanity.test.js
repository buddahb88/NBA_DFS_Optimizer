import { test, describe } from 'vitest';
import assert from 'node:assert/strict';

// Projection sanity layer on top of RotoWire: FPPM outlier shrink toward the
// player's own rate (O3), and blowout minutes trim from the spread.
const { SANITY_CONFIG, fppmShrink, blowoutTrim, applySanity } =
  await import('../src/services/projections/sanityLayer.js');

const close = (actual, expected, eps = 0.01) =>
  assert.ok(Math.abs(actual - expected) <= eps, `expected ${expected}, got ${actual}`);

const fppmConfig = { overThreshold: 0.3, overFraction: 0.5, underThreshold: 0.3, underFraction: 0, ramp: 0.1, minSampleMinutes: 150, minMinutes: 10 };
const blowoutConfig = { threshold: 10, pivot: 6, minMinutes: 28, minutesPerPoint: { favorite: 0.1, underdog: 0.2 }, maxMinutes: 3 };

describe('fppmShrink', () => {
  test('posted FPPM far above own rate: shrinks a fraction of the gap to minutes x own rate', () => {
    // Rui 10/25: 35.44 on 33 min (1.07) vs own 0.77
    const r = fppmShrink({ points: 35.44, minutes: 33, ownFppm: 0.77, sampleMinutes: 300 }, fppmConfig);
    const weight = (35.44 / 33 / 0.77 - 1.3) / 0.1; // ratio 1.395: 95% up the ramp
    close(r.delta, -0.5 * weight * (35.44 - 33 * 0.77));
    assert.match(r.reason, /^FPPM 1\.07 vs own 0\.77: -4\.\d$/);
  });

  test('within the threshold: nothing; ramps in over `ramp` above it (no cliff)', () => {
    assert.equal(fppmShrink({ points: 25, minutes: 25, ownFppm: 0.8, sampleMinutes: 300 }, fppmConfig).delta, 0);
    // ratio 1.35: halfway up the ramp
    const r = fppmShrink({ points: 1.35 * 25, minutes: 25, ownFppm: 1, sampleMinutes: 300 }, fppmConfig);
    close(r.delta, -0.5 * 0.5 * (1.35 * 25 - 25));
  });

  test('under-projection: symmetric, off with underFraction 0', () => {
    const low = { points: 15, minutes: 30, ownFppm: 1, sampleMinutes: 300 };
    assert.equal(fppmShrink(low, fppmConfig).delta, 0);
    const r = fppmShrink(low, { ...fppmConfig, underFraction: 0.4 });
    close(r.delta, 0.4 * (30 - 15));
    assert.match(r.reason, /^FPPM 0\.50 vs own 1\.00: \+6\.0$/);
  });

  test('no adjustment without a sample, an own rate or minutes', () => {
    assert.equal(fppmShrink({ points: 40, minutes: 30, ownFppm: 0.7, sampleMinutes: 60 }, fppmConfig).delta, 0);
    assert.equal(fppmShrink({ points: 40, minutes: 30, ownFppm: null, sampleMinutes: 300 }, fppmConfig).delta, 0);
    assert.equal(fppmShrink({ points: 8, minutes: 6, ownFppm: 0.7, sampleMinutes: 300 }, fppmConfig).delta, 0);
  });
});

describe('blowoutTrim', () => {
  test('a starter on a big underdog loses minutes beyond the pivot; points follow at his FPPM', () => {
    const r = blowoutTrim({ points: 35.44, minutes: 33, spread: 16.5 }, blowoutConfig);
    close(r.minutesDelta, -0.2 * 10.5);
    close(r.pointsDelta, -0.2 * 10.5 * 35.44 / 33);
    assert.equal(r.reason, 'blowout +16.5: -2.1 min');
  });

  test('favorites use their own coefficient (negative spread)', () => {
    const r = blowoutTrim({ points: 40, minutes: 34, spread: -12 }, blowoutConfig);
    close(r.minutesDelta, -0.1 * 6);
    assert.equal(r.reason, 'blowout -12.0: -0.6 min');
  });

  test('only from the threshold, only high-minute players, capped', () => {
    assert.equal(blowoutTrim({ points: 30, minutes: 34, spread: 9.5 }, blowoutConfig).minutesDelta, 0);
    assert.equal(blowoutTrim({ points: 12, minutes: 20, spread: 18 }, blowoutConfig).minutesDelta, 0);
    close(blowoutTrim({ points: 40, minutes: 36, spread: 25 }, blowoutConfig).minutesDelta, -3);
    assert.equal(blowoutTrim({ points: 40, minutes: 36, spread: null }, blowoutConfig).minutesDelta, 0);
  });
});

describe('applySanity', () => {
  const config = { fppm: fppmConfig, blowout: blowoutConfig };

  test('FPPM shrink then blowout trim at the shrunk FPPM; keeps raw values and reasons', () => {
    const r = applySanity({ projectedPoints: 35.44, projectedMinutes: 33, spread: 16.5, ownFppm: 0.77, sampleMinutes: 300 }, config);
    const shrunk = 35.44 - 0.5 * ((35.44 / 33 / 0.77 - 1.3) / 0.1) * (35.44 - 33 * 0.77);
    const trimmed = shrunk * (33 - 2.1) / 33;
    close(r.projection, trimmed);
    close(r.minutes, 30.9);
    assert.equal(r.raw_projection, 35.44);
    assert.equal(r.raw_minutes, 33);
    close(r.adjustment, trimmed - 35.44);
    assert.equal(r.reasons.length, 2);
    assert.deepEqual(r.reasons.map(x => x.kind), ['fppm', 'blowout']);
  });

  test('no reasons: the posted projection unchanged', () => {
    const r = applySanity({ projectedPoints: 30, projectedMinutes: 30, spread: -3, ownFppm: 1, sampleMinutes: 300 }, config);
    assert.equal(r.projection, 30);
    assert.equal(r.minutes, 30);
    assert.equal(r.adjustment, 0);
    assert.deepEqual(r.reasons, []);
  });

  test('a section can be switched off; defaults are conservative and bounded', () => {
    const off = { ...config, blowout: { ...blowoutConfig, enabled: false } };
    assert.equal(applySanity({ projectedPoints: 30, projectedMinutes: 34, spread: 20, ownFppm: 0.9, sampleMinutes: 300 }, off).adjustment, 0);
    assert.ok(SANITY_CONFIG.fppm.overThreshold >= 0.2);
    assert.ok(SANITY_CONFIG.fppm.overFraction <= 0.75);
    assert.ok(SANITY_CONFIG.blowout.maxMinutes <= 4);
  });

  test('zero / missing projection passes through', () => {
    const r = applySanity({ projectedPoints: 0, projectedMinutes: 0, spread: 15, ownFppm: 1, sampleMinutes: 300 }, config);
    assert.equal(r.projection, 0);
    assert.deepEqual(r.reasons, []);
  });
});
