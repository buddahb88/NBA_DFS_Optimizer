import { describe, test } from 'vitest';
import assert from 'node:assert/strict';
import { buildVerdict, verdictFor, MATCHUP_CAP, THRESHOLDS } from '../src/services/playerCard/verdict.js';
import { gameEntry, summarizeForm, trackRecord, rankTeams } from '../src/services/playerCard/cardMath.js';

// The player card's rules engine: fade trusted, injury bumps weighted most,
// "ours higher" never scored, archetype DVP capped as a tiebreaker, OUT
// forced to Fade, confidence capped by sample size.
const base = {
  name: 'Test Guard', salary: 7000, projection: 35, sourceLabel: 'Blend', rotowire: 35, rostership: 15,
  minutesL5: 32, minutesSeason: 32, minutesDelta: 0, games: 20, hit5xRate: 0.45, hit5xGames: 10,
};

describe('buildVerdict', () => {
  test('a neutral player sits near 50 and is not a core play', () => {
    const v = buildVerdict(base);
    assert.ok(Math.abs(v.cash.score - 50) <= 5, `cash ${v.cash.score}`);
    assert.notEqual(v.cash.verdict, 'Core play');
    assert.match(v.blurb, /35\.0/);
  });

  test('fade case: ours 4+ below RotoWire drags both verdicts and cites the hit rate', () => {
    const fade = { points_diff: -6.2, hit_rate: 0.688, n: 77 };
    const v = buildVerdict({ ...base, fade });
    const plain = buildVerdict(base);
    assert.ok(v.cash.score <= plain.cash.score - 10, `cash ${v.cash.score} vs ${plain.cash.score}`);
    assert.ok(v.gpp.score < plain.gpp.score - 7);
    assert.ok(['Pivot', 'Fade'].includes(v.cash.verdict));
    assert.ok(v.reasonsAgainst.some(r => /6\.2 below RotoWire/.test(r) && /69%/.test(r)));
    assert.match(v.blurb, /trust the fade/);
  });

  test('ours higher is noted, never scored', () => {
    const v = buildVerdict({ ...base, oursDiff: 6.5 });
    const plain = buildVerdict(base);
    assert.equal(v.cash.score, plain.cash.score);
    assert.equal(v.gpp.score, plain.gpp.score);
    assert.ok(v.notes.some(n => /no proven edge/.test(n)));
  });

  test('injury bump: teammate out + minutes up lifts it to a core play with the numbers in the blurb', () => {
    const v = buildVerdict({
      ...base, salary: 5200, projection: 31, rostership: 6, minutesL5: 37.2, minutesSeason: 32, minutesDelta: 5.2,
      teammatesOut: ['Tyrese Haliburton'], teammateMinDelta: 6.1, teammateGames: 9, p90: 46,
    });
    assert.equal(v.cash.verdict, 'Core play');
    assert.equal(v.gpp.verdict, 'Core play');
    assert.ok(v.cash.confidence >= 60);
    assert.match(v.blurb, /Haliburton/);
    assert.match(v.blurb, /5\.2/);
    assert.ok(v.reasonsFor.length >= 3);
  });

  test('archetype matchup is a tiebreaker: capped at MATCHUP_CAP', () => {
    const v = buildVerdict({ ...base, matchupDelta: 9, matchupRank: 1, matchupTeams: 30, matchupLabel: 'Primary Creator', opponent: 'WAS' });
    const rule = v.rules.find(r => r.key === 'matchup');
    assert.equal(rule.cash, MATCHUP_CAP);
    assert.match(rule.text, /bottom-5 defense vs Primary Creators/);
    assert.ok(v.cash.score - buildVerdict(base).cash.score <= MATCHUP_CAP);
  });

  test('ruled out: Fade everywhere', () => {
    const v = buildVerdict({ ...base, injuryStatus: 'OUT', minutesDelta: 6, teammatesOut: ['X'], teammateMinDelta: 8 });
    assert.equal(v.cash.verdict, 'Fade');
    assert.equal(v.gpp.verdict, 'Fade');
    assert.match(v.blurb, /will not play/);
  });

  test('rookie / no history: confidence capped, no crash on missing signals', () => {
    const v = buildVerdict({ name: 'New Guy', salary: 3500, projection: 22, rostership: 3, games: 0 });
    assert.ok(v.cash.confidence <= 55);
    assert.ok(v.gpp.confidence <= 55);
    assert.ok(v.blurb.length > 20);
    const empty = buildVerdict({});
    assert.ok(empty.cash.confidence <= 45);
  });

  test('verdict thresholds', () => {
    assert.equal(verdictFor(THRESHOLDS.core), 'Core play');
    assert.equal(verdictFor(THRESHOLDS.playable), 'Playable');
    assert.equal(verdictFor(THRESHOLDS.pivot), 'Pivot');
    assert.equal(verdictFor(THRESHOLDS.pivot - 1), 'Fade');
  });
});

describe('card math', () => {
  const g = (date, fp, minutes, season = '2026-27') => ({
    ...gameEntry({ game_date: date, dk_fantasy_points: fp, minutes, opponent: 'BBB' }, { salary: 6000 }), seasonKey: season,
  });

  test('form: averages, 5x hit rate vs that night salary, minutes trend vs season', () => {
    const entries = [g('2026-10-27', 40, 38), g('2026-10-25', 35, 36), g('2026-10-23', 20, 30), g('2026-10-21', 25, 30),
      g('2026-10-19', 22, 28), g('2026-10-17', 20, 28), g('2026-10-15', 18, 26)];
    const f = summarizeForm(entries, { season: '2026-27', lastSeason: '2025-26' });
    assert.equal(f.log.length, 7);
    assert.equal(f.log.at(-1).date, '2026-10-27', 'log is oldest first');
    assert.equal(f.consistency.hit_games, 2); // 40 and 35 >= 30
    assert.equal(f.l5.minutes, 32.4);
    assert.ok(f.trend.minutes_delta_l5 > 0);
  });

  test('track record: bias, MAE and DNP count', () => {
    const games = new Map([['2026-10-20', { fp: 30, minutes: 30 }], ['2026-10-22', { fp: 20, minutes: 28 }]]);
    const t = trackRecord([
      { game_date: '2026-10-20', projected_points: 25 },
      { game_date: '2026-10-22', projected_points: 26 },
      { game_date: '2026-10-24', projected_points: 24 },
    ], games);
    assert.equal(t.n, 2);
    assert.equal(t.dnp, 1);
    assert.equal(t.bias, -0.5);
    assert.equal(t.mae, 5.5);
  });

  test('team ranks: 1 = softest defense / fastest pace', () => {
    const r = rankTeams([{ team: 'A', defEff: 110, pace: 98 }, { team: 'B', defEff: 118, pace: 101 }]);
    assert.equal(r.get('B').def_rank, 1);
    assert.equal(r.get('B').pace_rank, 1);
    assert.equal(r.get('A').teams, 2);
  });
});
