import { test, describe } from 'vitest';
import assert from 'node:assert/strict';
import {
  UI_BLOCK_TYPES, UI_BLOCK_VERSION, uiBlock, validateUiBlock, attachUiBlocks, getUiBlocks,
} from '../src/services/chatTools/uiBlocks.js';

// Chat ui blocks: the versioned schema the chat streams next to markdown
const player = { name: 'Tyrese Maxey', player_key: 'tyrese maxey', team: 'PHI', opponent: 'BOS', position: 'PG' };
const row = { team: 'BOS', group_key: 'scoring_guard', label: 'Scoring Guard', fp_over_expectation: 2.5, games: 41 };

const SAMPLES = {
  player_list: uiBlock('player_list', {
    players: [{ ...player, salary: 9000, projection: 45.2, projected_minutes: 36, last_season_minutes: 37.5,
      archetype: 'primary_creator', matchup_edge: 3.1, adjusted_edge: 2.4, ownership: 22, injury_status: null,
      headshot: 'https://cdn/x.png', flags: ['crowded'] }],
  }),
  lineup: uiBlock('lineup', {
    mode: 'cash',
    slots: [{ slot: 'PG', player: { ...player, salary: 9000, projection: 45 } }, { slot: 'UTIL', player: null }],
    totals: { salary: 9000, projection: 45, remaining_salary: 41000 },
  }),
  matchup_table: uiBlock('matchup_table', { group_by: 'archetype', rows: [row] }),
  team_defense: uiBlock('team_defense', { team: 'BOS', groups: [{ group_by: 'position', weakest: [row], strongest: [] }] }),
  lineup_score: uiBlock('lineup_score', {
    context: { date: '2026-01-10', site: 'draftkings' },
    players: [{ ...player, status: 'PLAYED', minutes: 36, salary: 9000, projected: 45, actual: 50, vs_projection: 5, value_per_1k: 5.56 }],
    totals: { actual: 50, projected: 45, salary: 9000, value_per_1k: 5.56 },
  }),
  usage_bumps: uiBlock('usage_bumps', {
    bumps: [{ player: { ...player, salary: 9000 }, missing_player: 'Joel Embiid', avg_with: 30, avg_without: 45, pct_bump: 50 }],
  }),
  streaks: uiBlock('streaks', { kind: 'hot', players: [{ ...player, last3_avg: 45, season_avg: 34, last_game: '2026-01-10' }] }),
  projection_results: uiBlock('projection_results', {
    context: { site: 'draftkings', from: '2026-01-01', to: '2026-01-10' },
    overall: { players: 3, played: 2, mae: 6.4, hit_rates: { '5x': 50 } },
    misses: [{ ...player, projected: 40, actual: 30, error: 10 }],
  }),
};

describe('validateUiBlock', () => {
  test('a valid sample of every type passes, with version and defaults', () => {
    assert.deepEqual(Object.keys(SAMPLES).sort(), [...UI_BLOCK_TYPES].sort());
    for (const [type, block] of Object.entries(SAMPLES)) {
      const r = validateUiBlock(block);
      assert.equal(r.success, true, `${type}: ${r.error}`);
      assert.equal(r.block.version, UI_BLOCK_VERSION);
      assert.equal(r.block.type, type);
    }
    // flags default to []
    const bare = validateUiBlock(uiBlock('player_list', { players: [{ name: 'X' }] }));
    assert.deepEqual(bare.block.players[0].flags, []);
  });

  test('unknown type, wrong version and bad fields are rejected with a path', () => {
    assert.match(validateUiBlock({ version: 1, type: 'pie_chart' }).error, /Unknown ui block type/);
    assert.equal(validateUiBlock(null).success, false);
    assert.equal(validateUiBlock({ ...SAMPLES.lineup, version: 2 }).success, false);

    const noName = validateUiBlock(uiBlock('player_list', { players: [{ salary: 5000 }] }));
    assert.equal(noName.success, false);
    assert.match(noName.error, /player_list\.players\.0\.name/);

    assert.equal(validateUiBlock(uiBlock('streaks', { kind: 'lukewarm', players: [] })).success, false);
    assert.equal(validateUiBlock(uiBlock('matchup_table', { group_by: 'archetype', rows: [{ ...row, games: 'many' }] })).success, false);
    assert.equal(validateUiBlock(uiBlock('lineup_score', { ...SAMPLES.lineup_score, context: { date: 'yesterday' } })).success, false);
  });
});

describe('attachUiBlocks / getUiBlocks', () => {
  test('blocks ride on the result without changing its JSON', () => {
    const result = { success: true, players: [1, 2] };
    const before = JSON.stringify(result);
    attachUiBlocks(result, [SAMPLES.streaks, SAMPLES.matchup_table]);
    assert.equal(JSON.stringify(result), before);
    assert.deepEqual(Object.keys(result), ['success', 'players']);
    assert.deepEqual(getUiBlocks(result).map(b => b.type), ['streaks', 'matchup_table']);
  });

  test('invalid blocks are dropped, a single block is accepted, non-objects pass through', () => {
    const result = attachUiBlocks({ success: true }, [SAMPLES.lineup, { version: 1, type: 'lineup' }]);
    assert.deepEqual(getUiBlocks(result).map(b => b.type), ['lineup']);
    assert.equal(getUiBlocks(attachUiBlocks({}, SAMPLES.streaks)).length, 1);
    assert.deepEqual(getUiBlocks(attachUiBlocks({}, null)), []);
    assert.equal(attachUiBlocks('text', [SAMPLES.lineup]), 'text');
    assert.deepEqual(getUiBlocks(undefined), []);
  });
});
