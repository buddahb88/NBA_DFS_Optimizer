/**
 * CHAT UI BLOCKS (schema version 1)
 *
 * Typed result blocks the chat streams next to the assistant's markdown so the
 * frontend can render cards instead of tables. Tools attach blocks to their
 * result under the UI_BLOCKS symbol: JSON.stringify skips symbol keys, so what
 * the LLM (and the tool_result event) sees is unchanged.
 *
 * Envelope: { version: 1, type, id?, tool?, title?, note?, ...payload }
 * - id/tool are set when streamed (`<toolCallId>:<n>`); markdown may reference a
 *   block as [[block:<id>]]. Without blocks the frontend renders the markdown.
 * - Numbers are null when unknown; rates are fractions (0.31 = 31%).
 *
 * Types: player_list, lineup, matchup_table, team_defense, lineup_score,
 * usage_bumps, streaks, projection_results.
 */

import { z } from 'zod';

export const UI_BLOCK_VERSION = 1;
export const UI_BLOCKS = Symbol.for('nba-dfs.chat.uiBlocks');

const num = z.number().finite().nullable().optional();
const str = z.string().nullable().optional();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional();

const envelope = {
  version: z.literal(UI_BLOCK_VERSION),
  id: z.string().optional(),
  tool: z.string().optional(),
  title: z.string().optional(),
  note: z.string().optional(),
};

const playerRef = z.object({
  name: z.string().min(1),
  player_key: str,
  team: str,
  opponent: str,
  position: str,
  headshot: str,
});

const playerRow = playerRef.extend({
  salary: num,
  projection: num,
  projected_minutes: num,
  last_season_minutes: num,
  archetype: str,
  archetype_label: str,
  matchup_edge: num,
  adjusted_edge: num,
  defense_rank: num,
  defense_teams: num,
  ownership: num,
  injury_status: str,
  flags: z.array(z.string()).default([]),
  // Tool-specific numbers (per-36, rates, averages) keyed snake_case
  stats: z.record(z.string(), num).optional(),
});

// Where the numbers come from (from/to: projection_results window)
const context = z.object({
  slate_id: str,
  site: str,
  season: str,
  date,
  from: date,
  to: date,
  team: str,
}).partial().optional();

const groupRow = z.object({
  team: z.string(),
  group_key: z.string(),
  label: str,
  fp_over_expectation: num,
  pts_delta: num,
  reb_delta: num,
  ast_delta: num,
  fg3m_delta: num,
  stocks_delta: num,
  rank: num,
  teams: num,
  games: num,
  player_games: num,
  low_sample: z.boolean().optional(),
});

const SCHEMAS = {
  player_list: z.object({
    ...envelope,
    type: z.literal('player_list'),
    context,
    players: z.array(playerRow),
  }),

  lineup: z.object({
    ...envelope,
    type: z.literal('lineup'),
    context,
    mode: str,
    slots: z.array(z.object({
      slot: z.string(),
      player: playerRef.extend({ salary: num, projection: num, ownership: num, floor: num, ceiling: num }).nullable(),
    })),
    totals: z.object({ salary: num, projection: num, remaining_salary: num, ownership: num }),
  }),

  matchup_table: z.object({
    ...envelope,
    type: z.literal('matchup_table'),
    context,
    group_by: z.enum(['archetype', 'position']),
    rows: z.array(groupRow),
  }),

  team_defense: z.object({
    ...envelope,
    type: z.literal('team_defense'),
    context,
    team: z.string(),
    groups: z.array(z.object({
      group_by: z.enum(['archetype', 'position']),
      weakest: z.array(groupRow),
      strongest: z.array(groupRow),
    })),
  }),

  lineup_score: z.object({
    ...envelope,
    type: z.literal('lineup_score'),
    context,
    players: z.array(playerRef.extend({
      status: z.string(),
      status_reason: str,
      minutes: num,
      salary: num,
      projected: num,
      actual: num,
      vs_projection: num,
      value_per_1k: num,
    })),
    totals: z.object({ actual: num, projected: num, salary: num, value_per_1k: num }),
    incomplete: z.boolean().optional(),
    not_found: z.array(z.string()).optional(),
  }),

  usage_bumps: z.object({
    ...envelope,
    type: z.literal('usage_bumps'),
    context,
    bumps: z.array(z.object({
      player: playerRef.extend({ salary: num, projection: num, projected_minutes: num, ownership: num }),
      missing_player: z.string(),
      absence_reason: str,
      games_with: num,
      games_without: num,
      avg_with: num,
      avg_without: num,
      minutes_with: num,
      minutes_without: num,
      pct_bump: num,
      bumped_projection: num,
      value: num,
      confidence: str,
    })),
  }),

  streaks: z.object({
    ...envelope,
    type: z.literal('streaks'),
    context,
    kind: z.enum(['hot', 'cold', 'consistency', 'boom_bust']),
    players: z.array(playerRef.extend({
      games: num,
      season_avg: num,
      last3_avg: num,
      diff: num,
      pct: num,
      floor: num,
      ceiling: num,
      std_dev: num,
      consistency_score: num,
      boom_rate: num,
      bust_rate: num,
      last_game: date,
    })),
  }),

  projection_results: z.object({
    ...envelope,
    type: z.literal('projection_results'),
    context,
    overall: z.object({
      players: num,
      played: num,
      mae: num,
      rmse: num,
      bias: num,
      minutes_mae: num,
      hit_rates: z.record(z.string(), num).optional(),
    }),
    misses: z.array(playerRef.extend({
      date,
      salary: num,
      projected: num,
      actual: num,
      error: num,
      minutes: num,
      projected_minutes: num,
    })),
  }),
};

export const UI_BLOCK_TYPES = Object.freeze(Object.keys(SCHEMAS));

/**
 * Validate one block. Returns { success: true, block } (defaults applied) or
 * { success: false, error }.
 */
export function validateUiBlock(block) {
  const schema = SCHEMAS[block?.type];
  if (!schema) return { success: false, error: `Unknown ui block type: ${block?.type}` };
  const parsed = schema.safeParse(block);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { success: false, error: `${block.type}.${issue.path.join('.')}: ${issue.message}` };
  }
  return { success: true, block: parsed.data };
}

/** Build a block with the current version: uiBlock('lineup', { ... }) */
export const uiBlock = (type, payload) => ({ version: UI_BLOCK_VERSION, type, ...payload });

/**
 * Attach validated blocks to a tool result (non-enumerable symbol key, so
 * JSON.stringify(result) is unchanged). Invalid blocks are dropped with a
 * warning rather than failing the tool.
 */
export function attachUiBlocks(result, blocks) {
  if (!result || typeof result !== 'object') return result;
  const valid = [];
  for (const block of [blocks].flat().filter(Boolean)) {
    const check = validateUiBlock(block);
    if (check.success) valid.push(check.block);
    else console.warn(`⚠️ Dropping ui block: ${check.error}`);
  }
  if (valid.length) Object.defineProperty(result, UI_BLOCKS, { value: valid, enumerable: false, configurable: true });
  return result;
}

/** Blocks attached to a tool result ([] when none) */
export const getUiBlocks = (result) => (result && typeof result === 'object' && result[UI_BLOCKS]) || [];
