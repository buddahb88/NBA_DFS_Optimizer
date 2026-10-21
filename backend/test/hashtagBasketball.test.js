/**
 * Tests for the Hashtag Basketball defense-vs-position scraper and the DVP
 * adjustment that consumes it.
 * Fixture: test/fixtures/hashtagDvp.html (trimmed copy of the live page).
 */

import { test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Must be set before database.js is imported so tests never touch real data
process.env.DATABASE_TYPE = 'sqlite';
process.env.DATABASE_PATH = ':memory:';

const fixtureHtml = readFileSync(new URL('./fixtures/hashtagDvp.html', import.meta.url), 'utf8');

vi.mock('node-fetch', () => ({
  default: vi.fn(async () => ({ ok: true, text: async () => fixtureHtml })),
}));

const { default: hashtagBasketballService } = await import('../src/services/hashtagBasketballService.js');
const { default: teamDefenseVsPositionModel } = await import('../src/models/teamDefenseVsPositionModel.js');
const { default: projectionService } = await import('../src/services/projectionService.js');

const parsed = hashtagBasketballService.parsePositionDefense(fixtureHtml);
const find = (team, position) => parsed.find(d => d.team === team && d.position === position);

test('parses rank out of the team cell and maps stat columns in order', () => {
  // Row: C | NY 42 | PTS 19.2 | FG% 52.1 | FT% 77.2 | 3PM 1.4 | REB 13.4 | AST 3.2 | STL 1.1 | BLK 1.8 | TO 2.7
  assert.deepEqual(find('NYK', 'C'), {
    team: 'NYK',
    position: 'C',
    rank: 42,
    ptsAllowed: 19.2,
    fgPctAllowed: 52.1,
    tpmAllowed: 1.4,
    rebAllowed: 13.4,
    astAllowed: 3.2,
    stlAllowed: 1.1,
    blkAllowed: 1.8,
    toAllowed: 2.7,
  });
});

test('rank is the overall 1-150 rank (higher = worse defense)', () => {
  assert.equal(find('UTA', 'PG').rank, 150);
  assert.equal(find('UTA', 'PG').ptsAllowed, 26.3);
  assert.equal(find('OKC', 'PG').rank, 3);
  assert.equal(find('GSW', 'PG').rank, 121);
});

test('de-duplicates rows repeated in the best/worst defense summary tables', () => {
  // OKC PG appears in both the "Best Defense" table and the full table
  assert.equal(parsed.filter(d => d.team === 'OKC' && d.position === 'PG').length, 1);
  assert.equal(parsed.length, 8);
});

test('fetchAndStorePositionDefense awaits the upsert', async () => {
  let resolved = false;
  const spy = vi.spyOn(teamDefenseVsPositionModel, 'bulkUpsert').mockImplementation(async () => {
    await new Promise(r => setTimeout(r, 5));
    resolved = true;
  });
  try {
    const result = await hashtagBasketballService.fetchAndStorePositionDefense();
    assert.equal(result.success, true);
    assert.equal(result.count, 8);
    assert.equal(resolved, true);
  } finally {
    spy.mockRestore();
  }
});

test('fetchAndStorePositionDefense surfaces upsert failures', async () => {
  const spy = vi.spyOn(teamDefenseVsPositionModel, 'bulkUpsert').mockRejectedValue(new Error('db down'));
  try {
    await assert.rejects(hashtagBasketballService.fetchAndStorePositionDefense(), /db down/);
  } finally {
    spy.mockRestore();
  }
});

test('getDvpAdjustment: pre-joined pts_allowed is real points centered near league average', () => {
  const avg = projectionService.getDvpAdjustment('UTA', 'PG', projectionService.LEAGUE_AVG_DVP_PTS);
  assert.equal(avg, 0);
  assert.ok(projectionService.getDvpAdjustment('UTA', 'PG', 26.3) > 0);
  assert.ok(projectionService.getDvpAdjustment('NYK', 'C', 19.2) < 0);
  // Realistic spread stays a modest adjustment
  assert.ok(Math.abs(projectionService.getDvpAdjustment('UTA', 'PG', 26.3)) < 3);
});

test('getDvpAdjustment: ignores implausible pre-joined values and falls back to the 1-150 rank', () => {
  const saved = projectionService.positionDefenseData;
  projectionService.positionDefenseData = {
    UTA_PG: { rank: 150 },
    OKC_PG: { rank: 1 },
  };
  try {
    // 47.0 is a stale FG% value written by the old mis-aligned parser
    const weak = projectionService.getDvpAdjustment('UTA', 'PG', 47.0);
    const elite = projectionService.getDvpAdjustment('OKC', 'PG', null);
    assert.ok(weak > 0);
    assert.ok(elite < 0);
    assert.ok(Math.abs(weak + elite) < 0.1, 'rank scale should be centered on the 1-150 midpoint');
  } finally {
    projectionService.positionDefenseData = saved;
  }
});
