// Run with: npm test (vitest)
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { toInsightsPlayers } from './slatePayload.js';

test('keeps only the fields the insights endpoints use', () => {
  const full = {
    id: 7, player_id: '123', name: 'Luka Dončić', team: 'LAL', opponent: 'BOS', position: 'PG/SG',
    salary: 11000, projected_points: 55.2, projected_minutes: 36, rostership: 30, ceiling: 70, notes: 'x'
  };
  assert.deepEqual(toInsightsPlayers([full]), [{
    name: 'Luka Dončić', team: 'LAL', opponent: 'BOS', position: 'PG/SG',
    salary: 11000, projected_points: 55.2, projected_minutes: 36
  }]);
});

test('handles a missing list', () => {
  assert.deepEqual(toInsightsPlayers(undefined), []);
});
