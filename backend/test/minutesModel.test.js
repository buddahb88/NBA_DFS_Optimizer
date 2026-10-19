/**
 * Tests for the minutes x FPPM model (pure functions, no database).
 * Run: npm test
 */

import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  DEFAULT_MINUTES_CONFIG,
  blendProjection,
  buildOpponentFactors,
  computeWithWithoutSplit,
  isOutStatus,
  playerKey,
  projectBaseMinutes,
  projectFppm,
  projectPlayers,
  recencyWeightedAverage,
  redistributeInjuries,
  resolveConfig
} from '../src/services/minutesModel.js';

// Game logs, most recent first: dates count down from 2025-12-31
const games = (minutesList, { fppm = 1, name = 'P', team = 'AAA', opponent = 'ZZZ', b2b = [] } = {}) =>
  minutesList.map((minutes, i) => ({
    name,
    team,
    opponent,
    gameId: `g${minutesList.length - i}`,
    date: `2025-12-${String(31 - i).padStart(2, '0')}`,
    minutes,
    fp: minutes * fppm,
    isB2B: b2b.includes(i)
  }));

const close = (actual, expected, tol = 0.05) =>
  assert.ok(Math.abs(actual - expected) <= tol, `expected ${expected} ± ${tol}, got ${actual}`);

test('recencyWeightedAverage weights recent games most', () => {
  assert.equal(recencyWeightedAverage([]), 0);
  // weights 3,2,1
  close(recencyWeightedAverage([30, 20, 10]), (90 + 40 + 10) / 6);
});

test('projectBaseMinutes: steady player, too few games, role change', () => {
  assert.equal(projectBaseMinutes(games([30, 30]), {}), null);

  const steady = projectBaseMinutes(games([30, 30, 30, 30, 30, 30]), {});
  close(steady.minutes, 30);
  assert.equal(steady.role, 'starter');
  assert.equal(steady.breakdown.roleChange, false);

  // Moved into the starting lineup 3 games ago: leans on recent games
  const promoted = projectBaseMinutes(games([34, 34, 34, 15, 15, 15, 15, 15, 15, 15]), {});
  assert.equal(promoted.breakdown.roleChange, true);
  assert.ok(promoted.minutes > 27, `promoted minutes ${promoted.minutes}`);
});

test('projectBaseMinutes: RotoWire minutes, B2B and blowout', () => {
  const log = games([30, 30, 30, 30, 30]);
  close(projectBaseMinutes(log, { rotowireMinutes: 20 }).minutes, 0.3 * 20 + 0.7 * 30);

  // No B2B history of his own -> starter default
  close(projectBaseMinutes(log, { isB2B: true }).minutes, 30 + DEFAULT_MINUTES_CONFIG.b2bMinutesByRole.starter);

  // Own B2B history: 3 B2B games at 26 vs 30 rested, shrunk by 3/(3+4)
  const b2bLog = games([30, 26, 30, 26, 30, 26, 30], { b2b: [1, 3, 5] });
  const b2b = projectBaseMinutes(b2bLog, { isB2B: true });
  close(b2b.breakdown.b2b, -4 * (3 / 7), 0.1);

  // 14-point spread: starter loses (14 - 6) * 0.3 = 2.4 minutes, bench gains
  close(projectBaseMinutes(log, { spread: -14 }).breakdown.blowout, -2.4);
  assert.ok(projectBaseMinutes(games([14, 14, 14, 14]), { spread: 14 }).breakdown.blowout > 0);
  assert.equal(projectBaseMinutes(log, { spread: -5 }).breakdown.blowout, 0);
});

test('buildOpponentFactors regresses and caps the ratio', () => {
  const logs = [
    // Opponent SOFT allows 2 FP/min over 2 games, HARD allows 1 FP/min over 2 games
    ...games([30, 30], { fppm: 2, opponent: 'SOFT', name: 'A' }),
    ...games([30, 30], { fppm: 1, opponent: 'HARD', name: 'B' }).map(g => ({ ...g, gameId: `h${g.gameId}` }))
  ];
  const { leagueFppm, opponents } = buildOpponentFactors(logs);
  close(leagueFppm, 1.5);
  // raw 1.333, shrunk by 2/12 -> 1.056, under the 8% cap
  close(opponents.SOFT.ratio, 1 + (2 / 1.5 - 1) * (2 / 12), 0.001);
  const strong = buildOpponentFactors(logs, resolveConfig({ matchupPriorGames: 0 }));
  close(strong.opponents.SOFT.ratio, 1.08, 0.0001);
  close(strong.opponents.HARD.ratio, 0.92, 0.0001);
});

test('projectFppm blends recent and season and applies matchup and Vegas', () => {
  const log = games([30, 30, 30, 30, 30], { fppm: 1.2 });
  const plain = projectFppm(log, {});
  close(plain.fppm, 1.2, 0.001);

  const withMatchup = projectFppm(log, {
    opponent: 'SOFT',
    opponentFactors: { leagueFppm: 1.2, opponents: { SOFT: { ratio: 1.05 } } }
  });
  close(withMatchup.fppm, 1.2 * 1.05, 0.001);

  const vegas = projectFppm(log, { impliedTotal: 123 });
  close(vegas.breakdown.vegas, 1.04, 0.0001);
  assert.equal(projectFppm([], {}), null);
});

test('computeWithWithoutSplit ignores games before the OUT player joined', () => {
  const teamGames = [
    // Star plays g3-g5, misses g6-g7; g1-g2 happened before he joined
    ...['g3', 'g4', 'g5'].map((id, i) => ({ name: 'Star', gameId: id, date: `2025-11-0${3 + i}`, minutes: 34, fp: 50 })),
    ...['g1', 'g2', 'g3', 'g4', 'g5'].map((id, i) => ({ name: 'Backup', gameId: id, date: `2025-11-0${1 + i}`, minutes: 15, fp: 15 })),
    ...['g6', 'g7'].map((id, i) => ({ name: 'Backup', gameId: id, date: `2025-11-0${6 + i}`, minutes: 30, fp: 36 }))
  ];
  const split = computeWithWithoutSplit(teamGames, 'Star', 'Backup');
  assert.equal(split.with.games, 3);
  assert.equal(split.without.games, 2);
  close(split.without.minutes - split.with.minutes, 15);
  close(split.without.fppm, 1.2);
});

test('redistributeInjuries: history picks the backup, scale/presence/budget limit the total', () => {
  const teamGames = [];
  for (let i = 1; i <= 12; i++) {
    const starOut = i > 8; // last 4 games without the star
    const id = `g${i}`;
    const date = `2025-11-${String(i).padStart(2, '0')}`;
    if (!starOut) teamGames.push({ name: 'Star', gameId: id, date, minutes: 34, fp: 50 });
    teamGames.push({ name: 'Backup', gameId: id, date, minutes: starOut ? 32 : 16, fp: starOut ? 36 : 16 });
    teamGames.push({ name: 'Wing', gameId: id, date, minutes: 30, fp: 30 });
  }
  const active = [{ key: 'Backup', minutes: 20 }, { key: 'Wing', minutes: 30 }];
  const full = resolveConfig({ redistributionScale: 1, usageShrinkGames: 0 });

  const r = redistributeInjuries(active, [{ key: 'Star', minutes: 34 }], teamGames, full);
  assert.ok(r.Backup.addedMinutes > r.Wing.addedMinutes, 'backup absorbs more than the steady wing');
  close(r.Backup.addedMinutes, 20, 0.01); // capped at his room: 40 - 20
  assert.ok(r.Backup.addedMinutes + r.Wing.addedMinutes <= 34);
  assert.ok(r.Backup.fppmMultiplier > 1 && r.Backup.fppmMultiplier <= 1 + full.usageBumpCap);

  // Default scale hands out only part of the minutes
  const scaled = redistributeInjuries(active, [{ key: 'Star', minutes: 34 }], teamGames);
  const total = scaled.Backup.addedMinutes + scaled.Wing.addedMinutes;
  assert.ok(total <= 34 * DEFAULT_MINUTES_CONFIG.redistributionScale + 1e-9);

  // Already out for all recent games -> nothing new to hand out
  const stale = redistributeInjuries(active, [{ key: 'Star', minutes: 34, presence: 0 }], teamGames, full);
  assert.equal(stale.Backup.addedMinutes + stale.Wing.addedMinutes, 0);

  // Team budget: rotation already at 235 of 240 minutes
  const crowded = [...active, { key: 'Others', minutes: 185, fixed: true }];
  const capped = redistributeInjuries(crowded, [{ key: 'Star', minutes: 34 }], teamGames, full);
  close(capped.Backup.addedMinutes + capped.Wing.addedMinutes, 5, 0.01);
  assert.equal(capped.Others, undefined, 'fixed players receive nothing');

  // Bench-level OUT player is ignored
  const tiny = redistributeInjuries(active, [{ key: 'Star', minutes: 5 }], teamGames, full);
  assert.equal(tiny.Backup.sources.length, 0);
});

test('projectPlayers: OUT status, overrides and redistribution', () => {
  const history = [];
  for (let i = 1; i <= 10; i++) {
    const date = `2025-11-${String(i).padStart(2, '0')}`;
    const gameId = `g${i}`;
    history.push({ name: 'Star Guard', team: 'AAA', opponent: 'BBB', gameId, date, minutes: 34, fp: 51, isB2B: false });
    history.push({ name: 'Backup Guard', team: 'AAA', opponent: 'BBB', gameId, date, minutes: 18, fp: 18, isB2B: false });
    history.push({ name: 'Big Man', team: 'AAA', opponent: 'BBB', gameId, date, minutes: 30, fp: 36, isB2B: false });
  }
  const base = [
    { id: '1', name: 'Star Guard', team: 'AAA', opponent: 'BBB' },
    { id: '2', name: 'Backup Guard', team: 'AAA', opponent: 'BBB' },
    { id: '3', name: 'Big Man', team: 'AAA', opponent: 'BBB' },
    { id: '4', name: 'Rookie', team: 'AAA', opponent: 'BBB' }
  ];

  const healthy = projectPlayers(base, history);
  close(healthy.get('1').minutes, 34);
  // 1.5 FP/min, regressed slightly toward the league rate (~1.28)
  const starPoints = healthy.get('1').points;
  assert.ok(starPoints < 51 && starPoints > 49, `star points ${starPoints}`);
  assert.equal(healthy.get('4').hasModel, false);
  assert.equal(healthy.get('4').points, null);

  const starOut = projectPlayers(base.map(p => (p.id === '1' ? { ...p, out: true } : p)), history);
  assert.equal(starOut.get('1').points, 0);
  assert.ok(starOut.get('2').minutes > 18, 'backup gains minutes');
  assert.ok(starOut.get('2').injury.sources[0].out === playerKey('Star Guard'));

  // Minutes override 0 = OUT; points override wins over everything
  const overridden = projectPlayers(base.map(p => {
    if (p.id === '1') return { ...p, override: { minutes: 0 } };
    if (p.id === '3') return { ...p, override: { points: 44 } };
    if (p.id === '2') return { ...p, override: { minutes: 30 } };
    return p;
  }), history);
  assert.equal(overridden.get('1').out, true);
  assert.equal(overridden.get('3').points, 44);
  close(overridden.get('2').minutes, 30);
  // 30 minutes x ~1.0 FP/min (regressed a little toward the league rate)
  assert.ok(overridden.get('2').points > 30 && overridden.get('2').points < 33);
  assert.equal(overridden.get('2').injury, null, 'fixed minutes are not topped up');

  const noRedistribution = projectPlayers(base.map(p => (p.id === '1' ? { ...p, out: true } : p)), history, { redistribute: false });
  close(noRedistribution.get('2').minutes, 18);
});

test('blendProjection and isOutStatus', () => {
  close(blendProjection(40, 30, 0.6), 36);
  assert.equal(blendProjection(40, 0, 0.6), 40);
  assert.equal(blendProjection(NaN, 30, 0.6), 30);
  assert.equal(blendProjection(40, 30, 2), 40);

  assert.equal(isOutStatus('OUT'), true);
  assert.equal(isOutStatus('out'), true);
  assert.equal(isOutStatus('OFS'), true);
  assert.equal(isOutStatus('{"status":"Out"}'), true);
  assert.equal(isOutStatus('QUES'), false);
  assert.equal(isOutStatus('GTD'), false);
  assert.equal(isOutStatus(null), false);
});
