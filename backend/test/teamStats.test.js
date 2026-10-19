import { test } from 'vitest';
import assert from 'node:assert/strict';
import { buildTeamStatsMap } from '../src/utils/teamStats.js';

const rows = [
  { team: 'BOS', pace: 98, off_eff: 120, def_eff: 110, updated_at: '2026-10-18 10:00:00' },
  { team: 'PHO', pace: 102, off_eff: 115, def_eff: 114, updated_at: '2026-10-19 09:00:00' },
  { team: 'WSH', pace: null, off_eff: 108, def_eff: 118, updated_at: null },
];

test('keys stats by slate abbreviations, normalizing for the rankings table', () => {
  const { teams } = buildTeamStatsMap(rows, ['BOS', 'PHX', 'WAS', 'XXX']);
  assert.deepEqual(Object.keys(teams), ['BOS', 'PHX', 'WAS']);
  assert.deepEqual(teams.PHX, { pace: 102, offEff: 115, defEff: 114 });
  assert.equal(teams.WAS.pace, null);
});

test('returns all rows when no teams requested, with league pace and latest update', () => {
  const result = buildTeamStatsMap(rows);
  assert.deepEqual(Object.keys(result.teams), ['BOS', 'PHO', 'WSH']);
  assert.equal(result.leagueAvgPace, 100);
  assert.equal(result.updatedAt, '2026-10-19 09:00:00');
});

test('handles an empty table', () => {
  assert.deepEqual(buildTeamStatsMap([], ['BOS']), { teams: {}, leagueAvgPace: null, updatedAt: null });
});
