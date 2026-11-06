import { describe, test } from 'vitest';
import assert from 'node:assert/strict';
import { buildVerdict, verdictFor, MATCHUP_CAP, THRESHOLDS } from '../src/services/playerCard/verdict.js';
import { gameEntry, summarizeForm, trackRecord, rankTeams } from '../src/services/playerCard/cardMath.js';
import { buildSlateContext } from '../src/services/playerCard/slateContext.js';

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

describe('buildVerdict: slate size', () => {
  // Slate contexts as buildSlateContext returns them (pool = pivot candidates)
  const slateOf = (bucket, games, avg, extra = {}) => ({
    gameCount: games, sizeBucket: bucket, label: `${games}-game slate`, poolSize: 40,
    ownership: { n: 40, avg, median: avg, p90: avg * 2.5, chalkCount: 0 }, studSalary: null, pool: [], ...extra,
  });
  const large = slateOf('large', 11, 4);
  const medium = slateOf('medium', 6, 8);
  const small = slateOf('small', 2, 17, { studSalary: 8800 });
  // A $10K stud, 42% owned, our model 6 below RotoWire, 11-point spread
  const stud = {
    ...base, id: 's1', name: 'Big Stud', salary: 10000, projection: 45, rotowire: 48, rostership: 42, spread: 11,
    fade: { points_diff: -6, hit_rate: 0.688, n: 77 },
  };

  test('no slate context (or an unknown bucket) = the legacy rules, unchanged', () => {
    for (const s of [base, stud, { ...base, rostership: 3, salary: 5000, projection: 27 }, {}]) {
      assert.deepEqual(buildVerdict(s, null), buildVerdict(s));
      assert.deepEqual(buildVerdict(s, { gameCount: 0, sizeBucket: null }), buildVerdict(s));
    }
    assert.equal(buildVerdict(base).slate, undefined);
  });

  test('same stud: Fade on an 11-game slate, not a Fade on a 2-game slate without a pivot', () => {
    const big = buildVerdict(stud, large);
    assert.equal(big.cash.verdict, 'Fade');
    assert.equal(big.gpp.verdict, 'Fade');
    assert.ok(big.reasonsAgainst.some(r => /Chalky for an 11-game slate: 42\.0% projected owned/.test(r)), big.reasonsAgainst.join(' | '));

    const two = buildVerdict(stud, small);
    assert.equal(two.cash.verdict, 'Pivot');
    assert.equal(two.gpp.verdict, 'Pivot');
    assert.ok(!two.rules.some(r => r.key === 'ownership'), 'no chalk penalty for a stud on a small slate');
    assert.ok(two.rules.some(r => r.key === 'no_pivot'));
    assert.match(two.blurb, /42\.0% owned \(normal for a stud on a 2-game slate\)/);
    assert.match(two.blurb, /no viable pivot within \$500 of his salary on a 2-game slate/);
    assert.equal(two.slate.sizeBucket, 'small');
    assert.ok(two.notes.some(n => /normal for a stud on a 2-game slate/.test(n)));
  });

  test('slate.changed / legacy / note say when slate size changed the call, and the blurb names the slate', () => {
    const two = buildVerdict(stud, small);
    assert.equal(two.slate.changed, true);
    assert.deepEqual(two.slate.legacy, { cash: 'Fade', gpp: 'Fade' });
    assert.match(two.slate.note, /No viable pivot within \$500 on a 2-game slate/);
    assert.match(two.blurb, /in GPPs on a 2-game slate\.$/);

    // Same call either way: no note, no slate wording in the closing sentence
    const big = buildVerdict(stud, large);
    assert.equal(big.slate.changed, false);
    assert.equal(big.slate.note, null);
    assert.match(big.blurb, /in GPPs\.$/);
    assert.doesNotMatch(big.blurb, /in GPPs on an/);

    // Chalk that only exists on a large slate drops a GPP verdict: the note quotes it
    const p = { ...base, salary: 9000, projection: 52, rostership: 25, p90: 70 };
    const v = buildVerdict(p, large);
    assert.notEqual(v.gpp.verdict, buildVerdict(p).gpp.verdict);
    assert.match(v.slate.note, /^Chalky for an 11-game slate: 25\.0% projected owned/);
  });

  test('small slate: a viable pivot at a similar salary keeps the Fade', () => {
    const pool = [{ id: 's1', name: 'Big Stud', salary: 10000, projection: 45 }, { id: 'p2', name: 'Other Stud', salary: 9700, projection: 44 }];
    const v = buildVerdict(stud, { ...small, pool });
    assert.equal(v.gpp.verdict, 'Fade');
    assert.ok(!v.rules.some(r => r.key === 'no_pivot'));
    // A cheaper or much weaker alternative is not a pivot
    const weak = buildVerdict(stud, { ...small, pool: [{ id: 'p3', salary: 9600, projection: 30 }, { id: 'p4', salary: 8000, projection: 46 }] });
    assert.equal(weak.gpp.verdict, 'Pivot');
  });

  test('small slate: studs are top-2-per-game salaries, bigger bump; blowout weighs more; lower value baseline', () => {
    const p = { ...base, salary: 8800, projection: 44, rostership: 20 };
    const two = buildVerdict(p, small);
    const plain = buildVerdict(p);
    assert.deepEqual(two.rules.find(r => r.key === 'stud') && [two.rules.find(r => r.key === 'stud').cash, two.rules.find(r => r.key === 'stud').gpp], [6, 5]);
    assert.ok(!plain.rules.some(r => r.key === 'stud'), '$8.8K is not a stud without slate context');
    assert.ok(two.rules.find(r => r.key === 'stud').text.includes('2-game slate'));

    const blow = buildVerdict({ ...base, spread: -12 }, small).rules.find(r => r.key === 'blowout');
    assert.equal(blow.cash, -8);
    assert.match(blow.text, /weighs more on a 2-game slate/);
    assert.equal(buildVerdict({ ...base, spread: -12 }, large).rules.find(r => r.key === 'blowout').cash, -5);

    // 4.5x: below the legacy 5x baseline (value penalty), at the small-slate baseline (no value rule)
    const fair = { ...base, salary: 6000, projection: 27 };
    assert.ok(buildVerdict(fair).rules.some(r => r.key === 'value' && r.cash < 0));
    assert.ok(!buildVerdict(fair, small).rules.some(r => r.key === 'value'));
  });

  test('small slate: a non-stud at 45% is still chalk, said in slate terms', () => {
    const v = buildVerdict({ ...base, salary: 5000, projection: 25, rostership: 45 }, small);
    const rule = v.rules.find(r => r.key === 'ownership');
    assert.ok(rule && rule.gpp < 0);
    assert.match(rule.text, /Chalky for a 2-game slate: 45\.0% projected owned \(2\.6x the 17\.0% average\)/);
  });

  test('small slate: 30% owned is not chalk (legacy would penalise it)', () => {
    const p = { ...base, rostership: 35 };
    assert.ok(buildVerdict(p).rules.some(r => r.key === 'ownership' && r.gpp < 0));
    assert.ok(!buildVerdict(p, small).rules.some(r => r.key === 'ownership'));
  });

  test('large slate: chalk at 16% (never under the legacy 30% line); leverage needs a lower relative ownership', () => {
    const chalk = buildVerdict({ ...base, rostership: 16 }, large).rules.find(r => r.key === 'ownership');
    assert.ok(chalk && chalk.gpp < 0);
    assert.match(chalk.text, /Chalky for an 11-game slate/);
    assert.ok(!buildVerdict({ ...base, rostership: 16 }).rules.some(r => r.key === 'ownership'));

    const cheap = { ...base, salary: 5000, projection: 26 };
    assert.ok(buildVerdict({ ...cheap, rostership: 3 }).rules.some(r => r.key === 'ownership' && r.gpp > 0), 'legacy: 3% is leverage');
    assert.ok(!buildVerdict({ ...cheap, rostership: 3 }, large).rules.some(r => r.key === 'ownership'), '3% is ordinary on an 11-game slate');
    const lev = buildVerdict({ ...cheap, rostership: 1.2 }, large).rules.find(r => r.key === 'ownership');
    assert.ok(lev && lev.gpp > 0);
    assert.match(lev.text, /Only 1\.2% projected owned on an 11-game slate \(0\.3x the 4\.0% average\) - leverage/);
  });

  test('medium slate at an 8% average scores ownership like the legacy rules', () => {
    for (const own of [2, 5, 40, 50]) {
      const p = { ...base, salary: 5000, projection: 26, rostership: own };
      const legacy = buildVerdict(p).rules.find(r => r.key === 'ownership')?.gpp ?? 0;
      const sized = buildVerdict(p, medium).rules.find(r => r.key === 'ownership')?.gpp ?? 0;
      assert.ok(Math.abs(legacy - sized) <= 0.1, `own ${own}: legacy ${legacy} vs medium ${sized}`);
    }
  });

  test('slate without ownership: absolute ownership rules, other slate rules still apply', () => {
    const noOwn = { ...small, ownership: null };
    const v = buildVerdict({ ...base, rostership: 35 }, noOwn);
    assert.ok(v.rules.some(r => r.key === 'ownership' && r.text === 'Chalky at 35.0% projected owned'));
  });

  test('OUT is still a forced Fade with slate context', () => {
    const v = buildVerdict({ ...stud, injuryStatus: 'OUT' }, small);
    assert.equal(v.cash.verdict, 'Fade');
    assert.equal(v.gpp.verdict, 'Fade');
  });
});

describe('buildSlateContext', () => {
  const row = (id, team, opponent, salary, proj, own, status = null) => ({
    id, name: `P${id}`, team, opponent, salary, projected_points: proj, rostership: own, injury_status: status,
  });

  test('games, bucket, pool, ownership distribution and small-slate stud line', () => {
    const rows = [
      row(1, 'BOS', 'NYK', 10000, 50, 40), row(2, 'NYK', 'BOS', 9000, 44, 30), row(3, 'LAL', 'GSW', 8800, 42, 25),
      row(4, 'GSW', 'LAL', 8000, 38, 20), row(5, 'BOS', 'NYK', 4000, 18, 10), row(6, 'LAL', 'GSW', 3500, 0, 0),
      row(7, 'NYK', 'BOS', 7000, 30, 15, 'OUT'), row(8, 'GSW', 'LAL', 5000, 22, 5, 'GTD'),
    ];
    const c = buildSlateContext(rows);
    assert.equal(c.gameCount, 2);
    assert.equal(c.sizeBucket, 'small');
    assert.equal(c.label, '2-game slate');
    assert.equal(c.poolSize, 6); // no zero projection, no OUT
    assert.equal(c.ownership.n, 6);
    assert.equal(c.ownership.avg, 21.67);
    assert.equal(c.ownership.chalkCount, 2);
    assert.equal(c.studSalary, 8000); // 4th-highest salary = top 2 per game
    assert.deepEqual(c.pool.map(p => p.id), [1, 2, 3, 4, 5]); // GTD is not a pivot
  });

  test('buckets by game count; null without games', () => {
    const games = (n) => Array.from({ length: n }, (_, i) => row(i, `T${i}a`, `T${i}b`, 5000, 20, 5));
    assert.equal(buildSlateContext(games(5)).sizeBucket, 'medium');
    assert.equal(buildSlateContext(games(8)).sizeBucket, 'large');
    assert.equal(buildSlateContext(games(8)).studSalary, null);
    assert.equal(buildSlateContext([]), null);
    assert.equal(buildSlateContext(games(3), { gameCount: 9 }).sizeBucket, 'large');
    assert.equal(buildSlateContext([row(1, 'BOS', 'NYK', 5000, 20, null)]).ownership, null);
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
