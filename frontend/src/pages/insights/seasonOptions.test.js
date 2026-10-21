// Run with: npm test (vitest)
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { toSeasonOptions } from './seasonOptions.js';

const info = {
  current: '2026-27',
  currentStartDate: '2026-10-01',
  seasons: [
    { value: '2026-27', startDate: '2026-10-01', current: true },
    { value: '2025-26', startDate: '2025-10-21', current: false },
  ],
};

test('labels the current season and keeps server order', () => {
  assert.deepEqual(toSeasonOptions(info), [
    { value: '2026-27', label: '2026-27 (Current)' },
    { value: '2025-26', label: '2025-26' },
  ]);
});

test('handles a missing or empty payload', () => {
  assert.deepEqual(toSeasonOptions(undefined), []);
  assert.deepEqual(toSeasonOptions({}), []);
});
