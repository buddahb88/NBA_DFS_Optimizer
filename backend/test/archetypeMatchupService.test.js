import { test, describe } from 'vitest';
import assert from 'node:assert/strict';
import { MATCHUP_EDGE_CONFIG, scoreMatchupEdges } from '../src/services/archetypeMatchupService.js';

const player = (id, extra = {}) => ({
  player_id: id, player_key: `p${id}`, name: `Player ${id}`, team: 'MIL', opponent: 'WAS',
  archetype: 'scoring_guard', projected_minutes: 34, injury_status: null, matchup_edge: 2, ...extra,
});
const profile = (minutes_pg, team = 'MIL', games = 70) => ({ minutes_pg, team, games });
const score = (players, lastSeason = {}, current = {}) => scoreMatchupEdges(players, {
  lastSeason: new Map(Object.entries(lastSeason)),
  current: new Map(Object.entries(current)),
});

describe('scoreMatchupEdges', () => {
  test('constants live in one config', () => {
    assert.equal(MATCHUP_EDGE_CONFIG.fullMinutes, 32);
    assert.equal(MATCHUP_EDGE_CONFIG.roleChangeMinutes, 4);
    assert.equal(MATCHUP_EDGE_CONFIG.crowdingPenalty, 0.25);
  });

  test('a steady starter keeps the full matchup edge', () => {
    const s = score([player('1')], { p1: profile(33) }).get('1');
    assert.equal(s.matchup_edge, 2);
    assert.equal(s.adjusted_edge, 2);
    assert.equal(s.minutes.projected, 34);
    assert.equal(s.minutes.last_season, 33);
    assert.equal(s.minutes.change, 1);
    assert.equal(s.role, null);
    assert.equal(s.new_team, false);
    assert.deepEqual(s.flags, []);
    assert.deepEqual(s.components, { volume: 1, role_factor: 1, minutes_confidence: 1, crowding_factor: 1 });
  });

  test('minutes scaling: volume is projected / fullMinutes, capped at 1', () => {
    const s = score([player('1', { projected_minutes: 24 })], { p1: profile(25) }).get('1');
    assert.equal(s.components.volume, 0.75);
    assert.equal(s.components.minutes_confidence, 0.75);
    assert.equal(s.adjusted_edge, 1.5);
  });

  test('role_down when projected minutes drop 4+ below last season', () => {
    const s = score([player('1', { projected_minutes: 24 })], { p1: profile(32.1) }).get('1');
    assert.equal(s.role, 'role_down');
    assert.equal(s.minutes.change, -8.1);
    assert.deepEqual(s.flags, ['role_down']);
    assert.equal(s.components.role_factor, MATCHUP_EDGE_CONFIG.penalties.role_down);
    assert.equal(s.components.minutes_confidence, 0.6); // 0.75 volume x 0.8
    assert.equal(s.adjusted_edge, 1.2);
  });

  test('role_up when projected minutes rise 4+ above last season', () => {
    const s = score([player('1', { projected_minutes: 32 })], { p1: profile(22.2) }).get('1');
    assert.equal(s.role, 'role_up');
    assert.equal(s.components.role_factor, MATCHUP_EDGE_CONFIG.penalties.role_up);
    assert.equal(s.adjusted_edge, 1.8);
  });

  test('current-season minutes so far can flag role_down, and stand in for a missing projection', () => {
    const s = score([player('1', { projected_minutes: null })], { p1: profile(30) }, { p1: { games: 3, minutes_pg: 20 } }).get('1');
    assert.equal(s.minutes.current, 20);
    assert.equal(s.minutes.current_games, 3);
    assert.equal(s.minutes.basis, 'current');
    assert.equal(s.role, 'role_down');
    assert.equal(s.components.volume, 0.625);

    // One game is not enough to override a steady projection
    const one = score([player('2')], { p2: profile(33) }, { p2: { games: 1, minutes_pg: 20 } }).get('2');
    assert.equal(one.role, null);
    const two = score([player('3')], { p3: profile(33) }, { p3: { games: 2, minutes_pg: 22 } }).get('3');
    assert.equal(two.role, 'role_down');
  });

  test('new team when the slate team differs from the profile season team', () => {
    const s = score([player('1', { team: 'MIL' })], { p1: profile(31.2, 'MIA') }).get('1');
    assert.equal(s.new_team, true);
    assert.equal(s.last_team, 'MIA');
    assert.deepEqual(s.flags, ['new_team']);
    assert.equal(s.components.role_factor, MATCHUP_EDGE_CONFIG.penalties.new_team);
    // Team codes are canonicalized (PHO = PHX)
    assert.equal(score([player('2', { team: 'PHO' })], { p2: profile(33, 'PHX') }).get('2').new_team, false);
  });

  test('no last-season profile is flagged and discounted', () => {
    const s = score([player('1')]).get('1');
    assert.equal(s.minutes.last_season, null);
    assert.equal(s.minutes.change, null);
    assert.deepEqual(s.flags, ['no_history']);
    assert.equal(s.adjusted_edge, 2 * MATCHUP_EDGE_CONFIG.penalties.no_history);
  });

  test('flags combine multiplicatively', () => {
    const s = score([player('1', { projected_minutes: 25 })], { p1: profile(22.2, 'MIA') }).get('1');
    assert.deepEqual(s.flags, ['new_team']);
    const t = score([player('2', { projected_minutes: 30 })], { p2: profile(22.2, 'MIA') }).get('2');
    assert.deepEqual(t.flags, ['new_team', 'role_up']);
    assert.equal(t.components.role_factor, 0.765); // 0.85 x 0.9
  });

  test('crowding: same team, archetype and opponent teammates share the edge', () => {
    const players = [
      player('1', { archetype: 'stretch_big' }),
      player('2', { archetype: 'stretch_big', name: 'Big Two' }),
      player('3', { archetype: 'stretch_big', projected_minutes: 8 }), // too few minutes to count
      player('4', { archetype: 'stretch_big', team: 'BOS', opponent: 'NYK' }), // other team
      player('5', { archetype: 'scoring_guard' }),
      player('6', { archetype: 'stretch_big', injury_status: 'OUT' }), // out: does not count
    ];
    const lastSeason = Object.fromEntries(players.map(p => [p.player_key, profile(33, p.team)]));
    const s = score(players, lastSeason);
    assert.equal(s.get('1').crowding.count, 1);
    assert.deepEqual(s.get('1').crowding.teammates, ['Big Two']);
    assert.ok(s.get('1').flags.includes('crowded'));
    assert.equal(s.get('1').components.crowding_factor, 0.8);
    assert.equal(s.get('1').adjusted_edge, 1.6);
    assert.equal(s.get('2').crowding.count, 1);
    assert.equal(s.get('4').crowding.count, 0);
    assert.equal(s.get('5').crowding.count, 0);
    // A low-minute player is still told who crowds him
    assert.equal(s.get('3').crowding.count, 2);
    assert.equal(s.get('3').components.crowding_factor, round(1 / 1.5));
  });

  test('players without a matchup edge get null adjusted edge but full context', () => {
    const s = score([player('1', { matchup_edge: null })], { p1: profile(33) }).get('1');
    assert.equal(s.adjusted_edge, null);
    assert.equal(s.minutes.last_season, 33);
  });

  test('unknown minutes use a neutral volume', () => {
    const s = score([player('1', { projected_minutes: null })]).get('1');
    assert.equal(s.minutes.basis, null);
    assert.equal(s.components.volume, MATCHUP_EDGE_CONFIG.unknownVolume);
  });
});

function round(x) {
  return Math.round(x * 1000) / 1000;
}
