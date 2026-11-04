import { test, describe, beforeEach, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import {
  calibrateInjuryRisk, fallbackTable, normalizeTag, riskLevel, salaryBand, tagPlayProbability, FALLBACK_P_PLAY, PSEUDO
} from '../src/services/projections/injuryRisk.js';
import { applyInjuryRisk, chatInjuryFields, chatSourceFields } from '../src/services/projections/sourceLayer.js';
import {
  injuryRiskEnabled, injuryRiskStatus, injuryRiskTable, parseEnabled, setInjuryRiskEnabled
} from '../src/config/injuryRisk.js';
import { filterPlayers, skipQuestionableDefault, skipQuestionableFor } from '../src/services/optimizer/constraints/filters.js';
import { generateLineupBatch } from '../src/services/optimizer/constraints/exposure.js';
import optimizerService from '../src/services/optimizerService.js';
import { buildRequestContext, buildSolveContext } from '../src/services/optimizer/context.js';
import { buildVerdict } from '../src/services/playerCard/verdict.js';
import { questionableNote } from '../src/services/chatTools/questionableNote.js';
import { buildPlayerPool } from './fixtures/playerPool.js';

// Injury-tag risk: calibration math (shrinkage, bands, GTD = QUES), the
// source-layer discount on every source (min with our p_play), the setting,
// the optimizer's skipQuestionable default per mode + lock override, and the
// verdict engine reading the risk-adjusted projection.

const rows = (tag, salary, played, dnp) => [
  ...Array.from({ length: played }, () => ({ tag, salary, played: true })),
  ...Array.from({ length: dnp }, () => ({ tag, salary, played: false }))
];

describe('normalizeTag / bands / risk levels', () => {
  test('maps every spelling to one tag', () => {
    assert.equal(normalizeTag('QUES'), 'QUES');
    assert.equal(normalizeTag('Questionable'), 'QUES');
    assert.equal(normalizeTag('q'), 'QUES');
    assert.equal(normalizeTag('GTD'), 'GTD');
    assert.equal(normalizeTag('Game Time Decision'), 'GTD');
    assert.equal(normalizeTag('DOUBT'), 'DOUBT');
    assert.equal(normalizeTag('Probable'), 'PROB');
    assert.equal(normalizeTag('OUT'), 'OUT');
    assert.equal(normalizeTag('{"status":"QUES"}'), 'QUES');
    assert.equal(normalizeTag(null), null);
    assert.equal(normalizeTag(''), null);
    assert.equal(normalizeTag('Healthy'), null);
  });

  test('salary bands split at $5K', () => {
    assert.equal(salaryBand(4900), 'lt5k');
    assert.equal(salaryBand(5000), '5k+');
    assert.equal(salaryBand(null), '5k+');
  });

  test('risk levels', () => {
    assert.equal(riskLevel(null), 'none');
    assert.equal(riskLevel(0.95), 'low');
    assert.equal(riskLevel(0.68), 'medium');
    assert.equal(riskLevel(0.25), 'high');
  });
});

describe('calibrateInjuryRisk', () => {
  test('no history: every tag and band is its fallback', () => {
    const t = fallbackTable();
    for (const [tag, p] of Object.entries(FALLBACK_P_PLAY)) {
      assert.equal(t.tags[tag].p_play, p);
      assert.equal(t.tags[tag].bands.lt5k.p_play, p);
      assert.equal(t.tags[tag].bands['5k+'].p_play, p);
    }
  });

  test('tag rate shrinks toward the fallback, band rate toward the tag rate', () => {
    // QUES: 20 cheap (10 played), 10 pricey (9 played)
    const t = calibrateInjuryRisk([...rows('QUES', 4000, 10, 10), ...rows('QUES', 8000, 9, 1), ...rows(null, 6000, 50, 2)]);
    const tagRate = (19 + PSEUDO.tag * 0.68) / (30 + PSEUDO.tag);
    assert.equal(t.tags.QUES.n, 30);
    assert.equal(t.tags.QUES.played, 19);
    assert.ok(Math.abs(t.tags.QUES.p_play - tagRate) < 1e-3);
    const cheap = (10 + PSEUDO.band * tagRate) / (20 + PSEUDO.band);
    const pricey = (9 + PSEUDO.band * tagRate) / (10 + PSEUDO.band);
    assert.ok(Math.abs(t.tags.QUES.bands.lt5k.p_play - cheap) < 1e-3);
    assert.ok(Math.abs(t.tags.QUES.bands['5k+'].p_play - pricey) < 1e-3);
    assert.ok(t.tags.QUES.bands.lt5k.p_play < t.tags.QUES.bands['5k+'].p_play);
    assert.equal(t.untagged.n, 52);
    // GTD has no rows: QUES's numbers
    assert.equal(t.tags.GTD.p_play, t.tags.QUES.p_play);
    assert.match(t.tags.GTD.source, /QUES/);
    // PROB untouched: fallback
    assert.equal(t.tags.PROB.p_play, FALLBACK_P_PLAY.PROB);
  });

  test('OUT rows are ignored; rates are clamped', () => {
    const t = calibrateInjuryRisk([...rows('OUT', 6000, 0, 30), ...rows('DOUBT', 6000, 0, 500)]);
    assert.equal(t.rows, 500);
    assert.ok(t.tags.DOUBT.p_play >= 0.05);
  });

  test('tagPlayProbability reads the band; untagged / OUT are null', () => {
    const t = calibrateInjuryRisk(rows('QUES', 4000, 5, 15));
    assert.equal(tagPlayProbability(t, 'QUES', 4000).p, t.tags.QUES.bands.lt5k.p_play);
    assert.equal(tagPlayProbability(t, 'Questionable', 9000).p, t.tags.QUES.bands['5k+'].p_play);
    assert.equal(tagPlayProbability(t, null, 4000), null);
    assert.equal(tagPlayProbability(t, 'OUT', 4000), null);
  });
});

describe('applyInjuryRisk (source layer)', () => {
  const table = fallbackTable(); // QUES 0.68, PROB 0.92, DOUBT 0.25
  const base = { id: 1, name: 'Q Guy', salary: 6000, projected_points: 30, floor: 20, ceiling: 45, value: 5, boom_probability: 20, std_dev: 8, volatility: 0.27 };

  test('RotoWire (no model p_play): expected = P(play) x full projection, ceiling kept', () => {
    const p = applyInjuryRisk({ ...base, injury_status: 'QUES' }, table);
    assert.equal(p.projected_points, 20.4);
    assert.equal(p.projection_if_plays, 30);
    assert.equal(p.projection_pre_injury, 30);
    assert.equal(p.injury_play_prob, 0.68);
    assert.equal(p.injury_discount, 0.68);
    assert.equal(p.injury_risk, 'medium');
    assert.equal(p.injury_tag, 'QUES');
    assert.equal(p.floor, 13.6);
    assert.equal(p.ceiling, 45);
    assert.equal(p.value, 3.4);
    assert.equal(p.boom_probability, 13.6);
    assert.equal(p.std_dev, 8);
  });

  test('blend / ours: MIN with our p_play (the mean already includes it)', () => {
    const p = applyInjuryRisk({ ...base, injury_status: 'QUES', projection_source: 'blend', p_play: 0.96 }, table);
    assert.equal(p.injury_play_prob, 0.68);
    assert.equal(p.projection_if_plays, 31.25);
    assert.equal(p.injury_discount, Number((0.68 / 0.96).toFixed(3)));
    assert.ok(Math.abs(p.projected_points - 30 * 0.68 / 0.96) < 0.01);
    // our model already lower than the tag rate: no further discount
    const low = applyInjuryRisk({ ...base, injury_status: 'QUES', projection_source: 'ours', p_play: 0.5 }, table);
    assert.equal(low.projected_points, 30);
    assert.equal(low.injury_play_prob, 0.5);
    assert.equal(low.injury_discount, 1);
    assert.equal(low.projection_if_plays, 60);
  });

  test('a fallback row (RotoWire numbers) ignores the model p_play', () => {
    const p = applyInjuryRisk({ ...base, injury_status: 'DOUBT', projection_source: 'rotowire', p_play: 0.9 }, table);
    assert.equal(p.injury_play_prob, 0.25);
    assert.equal(p.projected_points, 7.5);
    assert.equal(p.injury_risk, 'high');
  });

  test('untagged / OUT / projected-0 players keep their numbers', () => {
    const clean = applyInjuryRisk({ ...base, injury_status: null }, table);
    assert.equal(clean.projected_points, 30);
    assert.equal(clean.injury_risk, 'none');
    assert.equal(clean.injury_play_prob, null);
    const out = applyInjuryRisk({ ...base, injury_status: 'OUT', projected_points: 0 }, table);
    assert.equal(out.projected_points, 0);
    assert.equal(out.injury_tag, null);
    const zero = applyInjuryRisk({ ...base, injury_status: 'QUES', projected_points: 0 }, table);
    assert.equal(zero.projected_points, 0);
    assert.equal(zero.injury_tag, 'QUES');
    assert.equal(zero.injury_risk, 'none');
  });

  test('chat payloads carry the risk for tagged players on any source', () => {
    const p = applyInjuryRisk({ ...base, injury_status: 'QUES' }, table);
    const fields = chatInjuryFields(p);
    assert.equal(fields.playProbability, 0.68);
    assert.match(fields.injuryNote, /Questionable: plays ~68%/);
    assert.deepEqual(chatSourceFields(p), fields);
    assert.deepEqual(chatInjuryFields(applyInjuryRisk(base, table)), {});
  });
});

describe('setting', () => {
  const saved = process.env.INJURY_RISK_DISCOUNT;
  afterEach(() => {
    setInjuryRiskEnabled(null);
    if (saved === undefined) delete process.env.INJURY_RISK_DISCOUNT;
    else process.env.INJURY_RISK_DISCOUNT = saved;
  });

  test('default on, env off, runtime wins, null resets', () => {
    delete process.env.INJURY_RISK_DISCOUNT;
    assert.equal(injuryRiskEnabled(), true);
    assert.equal(injuryRiskStatus().origin, 'default');
    process.env.INJURY_RISK_DISCOUNT = 'off';
    assert.equal(injuryRiskEnabled(), false);
    assert.equal(injuryRiskStatus().origin, 'env');
    assert.equal(setInjuryRiskEnabled(true).enabled, true);
    assert.equal(injuryRiskStatus().origin, 'runtime');
    assert.equal(setInjuryRiskEnabled(null).enabled, false);
    assert.throws(() => setInjuryRiskEnabled('maybe'));
    assert.equal(parseEnabled('1'), true);
    assert.equal(parseEnabled('no'), false);
  });

  test('the committed table has every tag', () => {
    const t = injuryRiskTable({ reload: true });
    for (const tag of ['QUES', 'PROB', 'DOUBT', 'GTD']) {
      assert.ok(t.tags[tag].p_play > 0 && t.tags[tag].p_play < 1, tag);
    }
  });
});

describe('optimizer skipQuestionable', () => {
  let pool;
  // Two strong questionable players the optimizer would otherwise take
  beforeEach(() => {
    pool = buildPlayerPool().map(p => ({ ...p }));
    pool[0].injury_status = 'QUES'; // AAA PG
    pool[8].injury_status = 'GTD';  // BBB PG
    pool[1].injury_status = 'PROB'; // stays in
  });
  const ids = (lineup) => lineup.players.map(s => s.player.id);

  test('defaults: on for cash, off for GPP; explicit wins', () => {
    assert.equal(skipQuestionableDefault('cash'), true);
    assert.equal(skipQuestionableDefault('gpp'), false);
    assert.equal(skipQuestionableDefault(undefined), true);
    assert.equal(skipQuestionableFor({ mode: 'gpp', skipQuestionable: true }), true);
    assert.equal(skipQuestionableFor({ mode: 'cash', skipQuestionable: false }), false);
  });

  test('filterPlayers drops QUES / GTD (not PROB) and records them; locked stay', () => {
    const ctx = buildSolveContext(buildRequestContext({ mode: 'cash' }), pool, { skippedQuestionable: [] });
    const kept = filterPlayers(pool, ctx);
    assert.equal(kept.length, pool.length - 2);
    assert.deepEqual(ctx.skippedQuestionable.map(p => p.id).sort(), [pool[0].id, pool[8].id].sort());
    const locked = buildSolveContext(buildRequestContext({ mode: 'cash', lockedPlayers: [pool[0].id] }), pool, { skippedQuestionable: [] });
    assert.ok(filterPlayers(pool, locked).some(p => p.id === pool[0].id));
    assert.equal(locked.skippedQuestionable.length, 1);
  });

  test('generateLineupBatch: cash skips, GPP keeps, lock overrides', () => {
    const cash = generateLineupBatch(pool, { mode: 'cash', numLineups: 1 });
    assert.equal(cash.skippedQuestionable.enabled, true);
    assert.equal(cash.skippedQuestionable.count, 2);
    assert.equal(cash.settings.skipQuestionable, true);
    assert.ok(!ids(cash.lineups[0]).includes(pool[0].id));

    const gpp = generateLineupBatch(pool, { mode: 'gpp', numLineups: 1 });
    assert.equal(gpp.skippedQuestionable.enabled, false);
    assert.equal(gpp.skippedQuestionable.count, 0);

    const lockedRun = generateLineupBatch(pool, { mode: 'cash', numLineups: 1, lockedPlayers: [pool[0].id] });
    assert.ok(ids(lockedRun.lineups[0]).includes(pool[0].id));
    assert.equal(lockedRun.skippedQuestionable.count, 1);

    const off = generateLineupBatch(pool, { mode: 'cash', numLineups: 1, skipQuestionable: false });
    assert.equal(off.skippedQuestionable.count, 0);
  });

  test('optimizerService.optimize (chat build_lineup) reports the skip', () => {
    const r = optimizerService.optimize(pool, { mode: 'cash', numLineups: 1 });
    assert.equal(r.skippedQuestionable.count, 2);
    assert.ok(!ids(r.lineups[0]).includes(pool[0].id));
    const g = optimizerService.optimize(pool, { mode: 'gpp', numLineups: 1 });
    assert.equal(g.skippedQuestionable.enabled, false);
    const note = questionableNote(r.skippedQuestionable);
    assert.match(note.questionableNote, /Skipped 2 questionable/);
    assert.equal(questionableNote(g.skippedQuestionable).skippedQuestionable.enabled, false);
  });
});

describe('verdict with the risk-adjusted projection', () => {
  const signals = {
    name: 'Cheap Guard', salary: 4500, injuryStatus: 'QUES', projection: 15.3, sourceLabel: 'Blend', rostership: 10
  };

  test('the injury rule uses P(play) and the blurb says the projection is risk-adjusted', () => {
    const v = buildVerdict({ ...signals, injuryTag: 'QUES', injuryPlayProb: 0.68, injuryDiscount: 0.68, projectionIfPlays: 22.5 });
    const rule = v.rules.find(r => r.key === 'injury_risk');
    assert.ok(rule.cash <= -10);
    assert.match(rule.text, /Questionable: plays ~68% of the time; projection shown x0.68 \(if he plays: 22.5\)/);
    assert.match(v.blurb, /Blend 15.3 \(risk-adjusted x0.68 for the QUES tag; 22.5 if he plays\)/);
  });

  test('a lower P(play) costs more in cash; PROB barely registers', () => {
    const doubt = buildVerdict({ ...signals, injuryTag: 'DOUBT', injuryPlayProb: 0.3, injuryDiscount: 0.3, projectionIfPlays: 50 });
    const prob = buildVerdict({ ...signals, injuryTag: 'PROB', injuryPlayProb: 0.95, injuryDiscount: 0.95, projectionIfPlays: 16 });
    const ques = buildVerdict({ ...signals, injuryTag: 'QUES', injuryPlayProb: 0.68, injuryDiscount: 0.68, projectionIfPlays: 22.5 });
    const cash = (v) => v.rules.find(r => r.key === 'injury_risk').cash;
    assert.ok(cash(doubt) < cash(ques));
    assert.ok(cash(ques) < cash(prob));
    assert.ok(cash(prob) >= -2);
  });

  test('RotoWire QUES without the layer still counts as risky', () => {
    const v = buildVerdict(signals);
    assert.ok(v.rules.some(r => r.key === 'injury_risk'));
  });
});
