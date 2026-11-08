import { test, describe, beforeAll as before } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Services pull in the database module; keep it off the real DB
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nba-dfs-min-upside-'));
let mc;

before(async () => {
  process.env.DATABASE_TYPE = 'sqlite';
  process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');
  mc = await import('../src/services/modelEval/minutesCorrection.js');
});

/** Params with one factor everywhere. */
const flat = (f) => ({
  version: '1', gapEdges: [3, 6], salaryEdge: 5000, global: f,
  buckets: Object.fromEntries(['rw lower 6+', 'rw lower 3-6', 'close', 'rw higher 3-6', 'rw higher 6+']
    .map(b => [b, { n: 10, raw: f, f, bands: { '<5K': { n: 5, raw: f, f }, '5K+': { n: 5, raw: f, f } } }]))
});

describe('live outputs', () => {
  test('playerOutput: minutes band, RotoWire gap, upside, correction', async () => {
    const { playerOutput } = await import('../src/services/modelEval/ownModelService.js');
    const ownPred = {
      dk_points: 22, ours_median: 21, minutes: 26.04, minutes_raw: 20.01, minutes_p10: 18.2, minutes_p90: 33.33, p_play: 0.9,
      rw_minutes_gap: 9.96, minutes_upside: 72, minutes_upside_reasons: ['RotoWire +10.0 min'],
      minutes_correction: { factor: 0.6, bucket: 'rw higher 6+', band: '<5K', applied: true }
    };
    const entry = { id: 1, key: 'x', name: 'X', team: 'AAA', opponent: 'BBB', position: 'PG', teammateOut: 'none out',
      slate: { salary: 4000, adjusted: 20, rotowire: 20, adjustedMinutes: 30, rotowireMinutes: 30, injuryStatus: null } };
    const out = playerOutput(entry, ownPred, null);
    assert.equal(out.ours_minutes, 26);
    assert.equal(out.ours_minutes_raw, 20);
    assert.equal(out.minutes_p10, 18.2);
    assert.equal(out.minutes_p90, 33.3);
    assert.equal(out.rotowire_minutes_posted, 30);
    assert.equal(out.rw_minutes_gap, 10);
    assert.equal(out.minutes_upside, 72);
    assert.deepEqual(out.minutes_upside_reasons, ['RotoWire +10.0 min']);
    assert.deepEqual(out.minutes_correction, { factor: 0.6, bucket: 'rw higher 6+', band: '<5K' });
    // Not corrected: raw = point, no correction block
    const plain = playerOutput(entry, { ...ownPred, minutes_raw: undefined, minutes_correction: { applied: false } }, null);
    assert.equal(plain.ours_minutes_raw, 26);
    assert.equal(plain.minutes_correction, null);
    // No own row
    const none = playerOutput(entry, null, null);
    assert.equal(none.minutes_upside, null);
    assert.deepEqual(none.minutes_upside_reasons, []);
  });

  test('liveCorrection: only a params file marked live', async () => {
    const { liveCorrection } = await import('../src/services/modelEval/ownModelService.js');
    const file = path.join(tmpDir, 'live.json');
    mc.writeCorrectionParams({ ...flat(0.6), live: false }, file);
    assert.equal(liveCorrection(file), null);
    mc.writeCorrectionParams({ ...flat(0.6), live: true }, file);
    assert.equal(liveCorrection(file).global, 0.6);
    assert.equal(liveCorrection(path.join(tmpDir, 'nope.json')), null);
  });

  test('the shipped params file is valid and its factors sit in [0, 1]', () => {
    const p = mc.readCorrectionParams();
    assert.ok(p, 'minutesCorrectionParams.json');
    for (const b of Object.values(p.buckets)) {
      for (const band of Object.values(b.bands)) assert.ok(band.f >= 0 && band.f <= 1);
    }
  });

  test('source layer carries the minutes fields, not the upside score (nulls without an own row)', async () => {
    const layer = await import('../src/services/projections/sourceLayer.js');
    const own = { ours_mean: 22, p10: 10, p90: 35, ours_minutes: 26, minutes_p10: 18, minutes_p90: 33, rw_minutes_gap: 10, minutes_upside: 72,
      minutes_upside_reasons: ['RotoWire +10.0 min'], minutes_correction: { factor: 0.6, bucket: 'rw higher 6+', band: '<5K' }, disagreement: {} };
    const p = layer.applySource({ id: 1, name: 'X', projected_points: 20 }, own, 'ours');
    assert.equal(p.minutes_upside, undefined);
    assert.equal(p.minutes_upside_reasons, undefined);
    assert.equal(p.ours_minutes_p90, 33);
    assert.equal(p.ours_minutes_p10, 18);
    assert.equal(p.rw_minutes_gap, 10);
    assert.deepEqual(p.minutes_correction, own.minutes_correction);
    for (const f of ['ours_minutes_p10', 'ours_minutes_p90', 'rw_minutes_gap', 'minutes_correction']) {
      assert.ok(layer.SOURCE_FIELDS.includes(f), f);
    }
    assert.ok(!layer.SOURCE_FIELDS.includes('minutes_upside'));
    assert.equal(layer.pickSourceFields(p).rw_minutes_gap, 10);
    assert.equal(layer.chatSourceFields(p).minutesUpside, undefined);
    assert.equal(layer.chatSourceFields(p).rwMinutesGap, 10);
    assert.equal(layer.chatSourceFields(p).oursMinutesP90, 33);
    const fallback = layer.applySource({ id: 1, name: 'X', projected_points: 20 }, null, 'ours');
    assert.equal(fallback.rw_minutes_gap, null);
    assert.equal(layer.chatSourceFields(fallback).rwMinutesGap, undefined);
  });

  test('player card block', async () => {
    const { minutesRangeBlock } = await import('../src/services/playerCard/playerCardService.js');
    assert.equal(minutesRangeBlock(null, {}), null);
    const b = minutesRangeBlock({ minutes_upside: 72, minutes_upside_reasons: ['x'], ours_minutes: 26, ours_minutes_raw: 20, minutes_p10: 18, minutes_p90: 33, rotowire_minutes_posted: 30, rw_minutes_gap: 10, minutes_correction: null }, {});
    assert.deepEqual(b, { ours: 26, ours_raw: 20, p10: 18, p90: 33, rotowire: 30, gap: 10, correction: null });
    // From the slate row's source-layer fields
    const s = minutesRangeBlock(null, { ours_minutes: 22, ours_minutes_p10: 15, ours_minutes_p90: 30, projected_minutes: 27, rw_minutes_gap: 5 });
    assert.equal(s.score, undefined);
    assert.equal(s.p10, 15);
    assert.equal(s.p90, 30);
    assert.equal(s.rotowire, 27);
  });
});
