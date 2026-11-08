import { test, describe, beforeAll as before } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { buildData, scheduleDates } from './helpers/modelEvalData.js';

// Own model x injury tag: minutes_v2's p_play is history only, so the tag's
// P(play | tag, salary band) has to enter the own model (and the blend) itself.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nba-dfs-own-tag-'));
let featureStore;
let evaluate;
let own;
let blend;
let service;
let layer;
let risk;

before(async () => {
  process.env.DATABASE_TYPE = 'sqlite';
  process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');
  featureStore = await import('../src/services/modelEval/featureStore.js');
  evaluate = await import('../src/services/modelEval/evaluate.js');
  own = await import('../src/services/modelEval/ownModel.js');
  blend = await import('../src/services/modelEval/blend.js');
  service = await import('../src/services/modelEval/ownModelService.js');
  layer = await import('../src/services/projections/sourceLayer.js');
  risk = await import('../src/services/projections/injuryRisk.js');
});

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);
const D = scheduleDates('2025-11-01', 20)[12];
const OPTIONS = { params: { sims: 200 }, minutesParams: { teamMinutes: 130 } };

function slateFor(store, date) {
  return {
    date, slateId: 'main',
    players: store.gameDay(date).players.map(p => ({
      key: p.key, name: p.name, team: p.team, opponent: p.opponent, position: p.position, isHome: p.isHome, out: false,
      slate: { salary: 5000, rotowire: 20, rotowireMinutes: 30, adjusted: 20, adjustedMinutes: 30, spread: -3, impliedTotal: 112, injuryStatus: null },
      outcome: { played: p.played, status: p.status, actual: p.actual, isStarter: p.isStarter }
    }))
  };
}

/** own_mean with and without a tag play probability for every player. */
async function runWithTag(tagPlay) {
  const store = featureStore.createFeatureStore(buildData());
  const slate = slateFor(store, D);
  const plain = { ...own.createOwnModelProjector(OPTIONS), name: 'plain' };
  const tagged = { ...own.createOwnModelProjector({ ...OPTIONS, tagPlay: () => tagPlay }), name: 'tagged' };
  const { rows } = await evaluate.runSlates(store, [plain, tagged], [slate]);
  return rows.filter(r => r.preds.plain && r.preds.plain.p_play > 0);
}

describe('ownPrediction with an injury tag', () => {
  test('a lower tag rate re-runs the mixture: mean, ranges, boom and double-double scale; minutes band follows', async () => {
    const rows = await runWithTag(0.4);
    assert.ok(rows.length >= 10);
    for (const r of rows) {
      const base = r.preds.plain;
      const p = r.preds.tagged;
      assert.equal(p.tag_applied, true);
      assert.equal(p.p_play, 0.4);
      close(p.p_play_model, base.p_play, 1e-12);
      assert.equal(p.p_play_tag, 0.4);
      // untagged: exactly the prediction without the tag (the blend weights' input)
      assert.deepEqual(p.untagged, base);
      const f = 0.4 / base.p_play;
      close(p.dk_points, base.dk_points * f, 1e-9);
      close(p.dk_points / p.p_play, base.dk_points / base.p_play, 1e-9); // same projection if he plays
      if (base.p_boom !== null) close(p.p_boom, base.p_boom * f, 1e-9);
      close(p.p_dd, base.p_dd * f, 1e-9);
      close(p.expected_minutes, 0.4 * base.conditional_minutes, 1e-9);
      p.minutes_blend_means.forEach((v, i) => close(v, base.minutes_blend_means[i] * f, 1e-6));
      // DNP mass 0.6: the bottom 60% of the distribution is 0; p90 sits lower in the conditional
      assert.equal(p.p10, 0);
      assert.equal(p.minutes_p10, 0);
      assert.ok(p.p90 <= base.p90 + 1e-9);
      assert.equal(p.dk_quantiles[60], 0);
      for (let i = 1; i < p.dk_quantiles.length; i++) assert.ok(p.dk_quantiles[i] >= p.dk_quantiles[i - 1]);
      close(p.dk_quantiles[90], p.p90, 1e-9);
      // The conditional point estimates stay
      close(p.minutes, base.minutes, 1e-12);
      close(p.ours_median, base.ours_median, 1e-12);
    }
  });

  test('a tag rate above the model\'s, or no tag, leaves the prediction alone', async () => {
    const rows = await runWithTag(0.999);
    for (const r of rows) {
      const { p_play_model: pm, p_play_tag: pt, tag_applied: applied, ...rest } = r.preds.tagged;
      assert.equal(applied, false);
      assert.equal(pt, 0.999);
      close(pm, r.preds.plain.p_play, 1e-12);
      assert.deepEqual(rest, r.preds.plain);
    }
    const none = await runWithTag(null);
    for (const r of none) assert.deepEqual(r.preds.tagged, r.preds.plain);
  });

  test('playProbabilityWithTag: min of model and tag (not the product)', () => {
    assert.deepEqual(own.playProbabilityWithTag(0.97, 0.68), { p_play: 0.68, p_play_tag: 0.68, applied: true });
    assert.deepEqual(own.playProbabilityWithTag(0.5, 0.68), { p_play: 0.5, p_play_tag: 0.68, applied: false });
    assert.deepEqual(own.playProbabilityWithTag(0.97, null), { p_play: 0.97, p_play_tag: null, applied: false });
  });
});

/** A tagged own prediction built the way ownPrediction does (p_play_model 0.98 -> tag 0.49). */
function taggedPred() {
  const qs = (scale, dnp) => own.QUANTILE_LEVELS.map(t => (t <= dnp ? 0 : scale * (t - dnp) / (1 - dnp)));
  const untagged = { dk_points: 39.2, minutes: 32, p_play: 0.98, role_shift: 0, boom_at: 54, p_dd: 0.2, dk_quantiles: qs(80, 0.02), minutes_blend_means: own.MINUTES_BLEND_GRID.map(() => 39.2) };
  return {
    ...untagged, dk_points: 19.6, p_play: 0.49, p_dd: 0.1, dk_quantiles: qs(80, 0.51), minutes_blend_means: own.MINUTES_BLEND_GRID.map(() => 19.6),
    p_play_model: 0.98, p_play_tag: 0.49, tag_applied: true, untagged
  };
}

describe('own model service output with a tag', () => {
  const weights = { blend: { kind: 'points', scheme: 'global', global: 0.45, segments: {} }, disagreement: { points: {}, minutes: {} } };
  const entry = { id: 7, key: 'q', name: 'Q', team: 'AAA', opponent: 'BBB', position: 'SF', teammateOut: 'none out',
    slate: { salary: 9000, adjusted: 44, rotowire: 44, adjustedMinutes: 33, injuryStatus: 'QUES' } };

  test('blend: the untagged blend x p_play / p_play_model, ranges from our tagged mixture; if-plays kept', () => {
    const pred = taggedPred();
    const out = service.playerOutput(entry, pred, weights);
    const untaggedBlend = 0.45 * 44 + 0.55 * 39.2;
    close(out.blend_point_model, untaggedBlend, 0.01);
    close(out.blend_point, untaggedBlend * 0.5, 0.01);
    close(out.blend_point_if_plays, untaggedBlend / 0.98, 0.01);
    const r = blend.recenter(pred, untaggedBlend * 0.5);
    close(out.blend_p10, r.p10, 0.01);
    close(out.blend_p90, r.p90, 0.01);
    assert.equal(out.blend_p10, 0); // 51% DNP mass
    assert.equal(out.p_play, 0.49);
    assert.equal(out.p_play_model, 0.98);
    assert.equal(out.p_play_tag, 0.49);
    assert.equal(out.tag_applied, true);
    assert.equal(out.ours_mean, 19.6);
    assert.equal(out.ours_mean_model, 39.2);
    close(out.ours_mean_if_plays, 40, 0.01);
    // Disagreement stays on the untagged mean (its saved-slate history scored that)
    close(out.disagreement.points_diff, 39.2 - 44, 0.01);
  });

  test('untagged players: blend and fields as before, the *_model fields equal the outputs', () => {
    const plain = taggedPred().untagged;
    const out = service.playerOutput({ ...entry, slate: { ...entry.slate, injuryStatus: null } }, plain, weights);
    close(out.blend_point, 0.45 * 44 + 0.55 * 39.2, 0.01);
    assert.equal(out.blend_point_model, out.blend_point);
    assert.equal(out.ours_mean_model, out.ours_mean);
    assert.equal(out.p_play_model, out.p_play);
    assert.equal(out.p_play_tag, null);
    assert.equal(out.tag_applied, false);
    assert.deepEqual(blend.blendPrediction({ own: plain, rw: { dk_points: 44, minutes: 33 }, salary: 9000, teammateOut: 'none out' }, weights.blend).p10,
      service.blendWithTag({ own: plain, rw: { dk_points: 44, minutes: 33 }, salary: 9000, teammateOut: 'none out' }, weights.blend).p10);
  });
});

describe('source layer after a tagged own model', () => {
  const table = () => risk.calibrateInjuryRisk([]); // fallback rates: QUES 0.68

  test('no second discount: the own model already priced the tag (even under the 0.2 model floor)', () => {
    const own = { ours_mean: 13.6, p10: 0, p90: 40, blend_point: 15, blend_p10: 0, blend_p90: 42, p_play: 0.68, tag_applied: true, disagreement: {} };
    const p = layer.applyInjuryRisk(layer.applySource({ id: 1, projected_points: 30, salary: 6000, injury_status: 'QUES' }, own, 'blend'), table());
    assert.equal(p.tag_applied, true);
    assert.equal(p.projected_points, 15);
    assert.equal(p.injury_discount, 1);
    close(p.projection_if_plays, 15 / 0.68, 0.01);
    assert.equal(p.injury_play_prob, 0.68);
    // DOUBT at a very low rate: the 0.2 floor would have discounted again
    const low = { ...own, blend_point: 3, p_play: 0.1 };
    const lowTable = risk.calibrateInjuryRisk([], { fallback: { ...risk.FALLBACK_P_PLAY, DOUBT: 0.1 } });
    const q = layer.applyInjuryRisk(layer.applySource({ id: 2, projected_points: 30, salary: 6000, injury_status: 'DOUBT' }, low, 'blend'), lowTable);
    assert.equal(q.projected_points, 3);
    assert.equal(q.injury_discount, 1);
    assert.ok(layer.SOURCE_FIELDS.includes('tag_applied'));
  });

  test('an own row without the tag (older cache) is still discounted by the layer', () => {
    const own = { ours_mean: 29.4, p10: 10, p90: 50, blend_point: 30, blend_p10: 10, blend_p90: 50, p_play: 0.98, disagreement: {} };
    const p = layer.applyInjuryRisk(layer.applySource({ id: 1, projected_points: 30, salary: 6000, injury_status: 'QUES' }, own, 'blend'), table());
    assert.equal(p.tag_applied, false);
    close(p.projected_points, 30 * 0.68 / 0.98, 0.01);
  });
});
