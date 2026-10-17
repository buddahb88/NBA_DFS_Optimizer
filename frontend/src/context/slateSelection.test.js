import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  SLATE_STORAGE_KEY,
  describeTeamRules,
  formatRosterSlots,
  formatSalaryCap,
  readStoredSelection,
  resolveSite,
  resolveSlateId,
  writeStoredSelection,
} from './slateSelection.js';

function memoryStorage(initial = {}) {
  const data = { ...initial };
  return {
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => {
      data[k] = String(v);
    },
    data,
  };
}

const SITES = {
  draftkings: { key: 'draftkings', name: 'DraftKings' },
  fanduel: { key: 'fanduel', name: 'FanDuel' },
  yahoo: { key: 'yahoo', name: 'Yahoo' },
};

test('selection round-trips through storage', () => {
  const storage = memoryStorage();
  writeStoredSelection({ site: 'fanduel', slateId: '123' }, storage);
  assert.deepEqual(readStoredSelection(storage), { site: 'fanduel', slateId: '123' });
});

test('bad or missing storage yields an empty selection', () => {
  assert.deepEqual(readStoredSelection(memoryStorage()), { site: null, slateId: null });
  assert.deepEqual(readStoredSelection(memoryStorage({ [SLATE_STORAGE_KEY]: '{not json' })), { site: null, slateId: null });
  const throwing = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
  assert.deepEqual(readStoredSelection(throwing), { site: null, slateId: null });
  assert.doesNotThrow(() => writeStoredSelection({ site: 'yahoo', slateId: null }, throwing));
});

test('numeric slate ids are stored as strings', () => {
  const storage = memoryStorage({ [SLATE_STORAGE_KEY]: JSON.stringify({ site: 'draftkings', slateId: 42 }) });
  assert.equal(readStoredSelection(storage).slateId, '42');
});

test('resolveSite keeps a known site and falls back to DraftKings', () => {
  assert.equal(resolveSite(SITES, 'yahoo'), 'yahoo');
  assert.equal(resolveSite(SITES, 'superdraft'), 'draftkings');
  assert.equal(resolveSite(SITES, null), 'draftkings');
  assert.equal(resolveSite(null, 'fanduel'), 'draftkings');
  assert.equal(resolveSite({ fanduel: SITES.fanduel }, 'nope'), 'fanduel');
});

test('resolveSlateId keeps the wanted slate or falls back to the newest', () => {
  const slates = [{ slate_id: '300' }, { slate_id: 200 }];
  assert.equal(resolveSlateId(slates, '200'), '200');
  assert.equal(resolveSlateId(slates, 200), '200');
  assert.equal(resolveSlateId(slates, '999'), '300');
  assert.equal(resolveSlateId(slates, null), '300');
  assert.equal(resolveSlateId([], '300'), null);
});

test('salary cap formatting', () => {
  assert.equal(formatSalaryCap(50000), '$50K');
  assert.equal(formatSalaryCap(60000), '$60K');
  assert.equal(formatSalaryCap(200), '$200');
  assert.equal(formatSalaryCap(undefined), '');
});

test('roster formatting groups repeated slots', () => {
  const slots = (names) => names.map((slot) => ({ slot }));
  assert.equal(formatRosterSlots(slots(['PG', 'SG', 'SF', 'PF', 'C', 'G', 'F', 'UTIL'])), 'PG SG SF PF C G F UTIL');
  assert.equal(formatRosterSlots(slots(['PG', 'PG', 'SG', 'SG', 'SF', 'SF', 'PF', 'PF', 'C'])), '2PG 2SG 2SF 2PF C');
});

test('team rules list only the limits a site has', () => {
  assert.deepEqual(describeTeamRules({ maxPlayersPerTeam: null, minTeams: 2, minGames: 2 }), ['Min 2 teams', 'Min 2 games']);
  assert.deepEqual(describeTeamRules({ maxPlayersPerTeam: 4, minTeams: 3, minGames: null }), ['Max 4 per team', 'Min 3 teams']);
  assert.deepEqual(describeTeamRules(null), []);
});
