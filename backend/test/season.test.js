import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  getCurrentSeason,
  seasonForDate,
  seasonStartDate,
  seasonEndYear,
  previousSeason,
  listSeasons,
  getSeasonsInfo,
} from '../src/utils/season.js';

test('seasonForDate rolls over on October 1st', () => {
  assert.equal(seasonForDate('2026-09-30'), '2025-26');
  assert.equal(seasonForDate('2026-10-01'), '2026-27');
  assert.equal(seasonForDate('2026-10-21'), '2026-27');
  assert.equal(seasonForDate('2027-06-15'), '2026-27');
  assert.equal(seasonForDate('2025-01-01'), '2024-25');
  assert.equal(seasonForDate('2024-12-31'), '2024-25');
});

test('seasonForDate accepts Date objects and datetime strings', () => {
  assert.equal(seasonForDate(new Date(2026, 8, 30)), '2025-26');
  assert.equal(seasonForDate(new Date(2026, 9, 1)), '2026-27');
  assert.equal(seasonForDate('2026-10-01T02:00:00Z'), '2026-27');
  assert.equal(seasonForDate('2026-09-30 23:59:59'), '2025-26');
});

test('seasonForDate pads the end year across centuries', () => {
  assert.equal(seasonForDate('2099-11-01'), '2099-00');
});

test('seasonForDate rejects invalid input', () => {
  assert.throws(() => seasonForDate('not-a-date'));
  assert.throws(() => seasonForDate(null));
});

test('getCurrentSeason derives from the given date (defaults to now)', () => {
  assert.equal(getCurrentSeason(new Date(2026, 9, 21)), '2026-27');
  assert.equal(getCurrentSeason(new Date(2026, 8, 1)), '2025-26');
  assert.equal(getCurrentSeason(), seasonForDate(new Date()));
});

test('seasonStartDate uses known opening nights, else October 1st', () => {
  assert.equal(seasonStartDate('2024-25'), '2024-10-22');
  assert.equal(seasonStartDate('2025-26'), '2025-10-21');
  assert.equal(seasonStartDate('2026-27'), '2026-10-20');
  assert.equal(seasonStartDate('2030-31'), '2030-10-01');
  assert.throws(() => seasonStartDate('2024'));
});

test('seasonEndYear returns the calendar year the season ends in', () => {
  assert.equal(seasonEndYear('2024-25'), 2025);
  assert.equal(seasonEndYear('2026-27'), 2027);
});

test('previousSeason steps back one season, across centuries', () => {
  assert.equal(previousSeason('2026-27'), '2025-26');
  assert.equal(previousSeason('2000-01'), '1999-00');
  assert.throws(() => previousSeason('2026'), /Invalid season/);
});

test('listSeasons returns newest first, from 2024-25 to current by default', () => {
  assert.deepEqual(listSeasons('2024-25', new Date(2026, 9, 21)), ['2026-27', '2025-26', '2024-25']);
  assert.deepEqual(listSeasons(undefined, new Date(2026, 8, 30)), ['2025-26', '2024-25']);
  assert.deepEqual(listSeasons('2022-23', new Date(2024, 0, 5)), ['2023-24', '2022-23']);
  assert.deepEqual(listSeasons('2027-28', new Date(2026, 9, 21)), []);
});

test('getSeasonsInfo returns the payload for GET /api/historical/seasons', () => {
  assert.deepEqual(getSeasonsInfo(new Date(2026, 9, 21)), {
    current: '2026-27',
    currentStartDate: '2026-10-20',
    seasons: [
      { value: '2026-27', startDate: '2026-10-20', current: true },
      { value: '2025-26', startDate: '2025-10-21', current: false },
      { value: '2024-25', startDate: '2024-10-22', current: false },
    ],
  });
});
