/**
 * PLAYER ARCHETYPE RULES
 *
 * Single source of truth for classifying player_season_profiles rows into
 * archetypes (services/archetypeService.js). Labels and descriptions are
 * served by GET /api/archetypes/players for the UI.
 *
 * How classification works:
 *   1. A profile below MIN_SAMPLE (games AND minutes) is Unclassified.
 *   2. ARCHETYPES are checked in order; every rule must pass. The first match
 *      is the primary archetype, the next match the secondary.
 *   3. No match -> DEFAULT_ARCHETYPE (Role Player), with no secondary.
 *
 * Rule shape: { stat, op, value } where stat is a player_season_profiles
 * column and op is one of >=, >, <=, <, in, not_in. { any: [rules] } passes
 * when at least one inner rule passes. A null stat fails its rule.
 *
 * Rates are fractions (0.26 = 26%), matching player_season_profiles.
 * Thresholds were tuned against the 2024-25 / 2025-26 profiles of players
 * with 20+ games and 400+ minutes (n = 801), where the medians / 90th
 * percentiles are roughly: usg 18% / 27%, ast 13% / 27%, reb 9% / 17%,
 * 3PA rate 44% / 67%, 3PM per 36 2.0 / 3.3, stl 1.6% / 2.4%, blk 1.4% / 4.2%.
 * ESPN positions are mostly G / F / C, so guard vs. wing vs. big is read from
 * the stats wherever possible.
 */

const GUARDS = ['G', 'PG', 'SG'];
const FRONTCOURT = ['F', 'SF', 'PF', 'C'];

// Plays like a big: a non-guard listed at center or rebounding at a big's rate
const BIG_RULES = [
  { stat: 'position', op: 'not_in', value: GUARDS },
  { any: [{ stat: 'position', op: 'in', value: ['C'] }, { stat: 'reb_pct', op: '>=', value: 0.13 }] },
];

export const MIN_SAMPLE = { games: 10, minutes: 200 };

export const ARCHETYPES = [
  {
    key: 'primary_creator',
    label: 'Primary Creator',
    description: 'High-usage starter who also runs the offense (26%+ usage, 25%+ assist rate, 24+ mpg).',
    rules: [
      { stat: 'usg_pct', op: '>=', value: 0.26 },
      { stat: 'ast_pct', op: '>=', value: 0.25 },
      { stat: 'minutes_pg', op: '>=', value: 24 },
    ],
  },
  {
    key: 'point_forward',
    label: 'Point Forward',
    description: 'Frontcourt player who creates for others (20%+ assist rate) while rebounding like a forward (10%+ rebound rate).',
    rules: [
      { stat: 'position', op: 'in', value: FRONTCOURT },
      { stat: 'ast_pct', op: '>=', value: 0.20 },
      { stat: 'reb_pct', op: '>=', value: 0.10 },
      { stat: 'minutes_pg', op: '>=', value: 20 },
    ],
  },
  {
    key: 'scoring_guard',
    label: 'Scoring Guard / Wing',
    description: 'Non-center whose role is to score: 24%+ usage in 24+ mpg without the assist rate of a primary creator.',
    rules: [
      { stat: 'position', op: 'not_in', value: ['C'] },
      { stat: 'usg_pct', op: '>=', value: 0.24 },
      { stat: 'minutes_pg', op: '>=', value: 24 },
    ],
  },
  {
    key: 'bench_scorer',
    label: 'Bench Scorer',
    description: 'Under 22 mpg but takes a starter-level share of possessions (24%+ usage, 18+ points per 36).',
    rules: [
      { stat: 'minutes_pg', op: '<', value: 22 },
      { stat: 'usg_pct', op: '>=', value: 0.24 },
      { stat: 'pts_per36', op: '>=', value: 18 },
    ],
  },
  {
    key: 'stretch_big',
    label: 'Stretch Big',
    description: 'Center or big-rebounding forward (13%+ rebound rate) who takes 28%+ of their shots from three.',
    rules: [
      ...BIG_RULES,
      { stat: 'three_pa_rate', op: '>=', value: 0.28 },
    ],
  },
  {
    key: 'rim_running_big',
    label: 'Rim-Running / Rebounding Big',
    description: 'Center or big-rebounding forward (13%+ rebound rate) who lives inside the arc (under 28% of shots from three).',
    rules: [
      ...BIG_RULES,
      { stat: 'three_pa_rate', op: '<', value: 0.28 },
    ],
  },
  {
    key: 'three_and_d_wing',
    label: '3-and-D Wing',
    description: 'Non-center, low-usage (under 22%), non-playmaking (under 20% assist rate) shooter (40%+ of shots from three) with defensive event rates (1.7%+ steal or 2%+ block rate).',
    rules: [
      { stat: 'position', op: 'not_in', value: ['C'] },
      { stat: 'three_pa_rate', op: '>=', value: 0.40 },
      { stat: 'usg_pct', op: '<', value: 0.22 },
      { stat: 'ast_pct', op: '<', value: 0.20 },
      { any: [{ stat: 'stl_pct', op: '>=', value: 0.017 }, { stat: 'blk_pct', op: '>=', value: 0.02 }] },
    ],
  },
  {
    key: 'spot_up_shooter',
    label: 'Movement / Spot-up Shooter',
    description: 'Off-ball shooter: half or more of shots from three and 2.2+ threes made per 36, under 24% usage.',
    rules: [
      { stat: 'three_pa_rate', op: '>=', value: 0.50 },
      { stat: 'fg3m_per36', op: '>=', value: 2.2 },
      { stat: 'usg_pct', op: '<', value: 0.24 },
    ],
  },
];

export const DEFAULT_ARCHETYPE = {
  key: 'role_player',
  label: 'Role Player',
  description: 'Met the minimum sample but matched no specialized archetype.',
};

export const UNCLASSIFIED_ARCHETYPE = {
  key: 'unclassified',
  label: 'Unclassified',
  description: `Below the minimum sample (${MIN_SAMPLE.games} games and ${MIN_SAMPLE.minutes} minutes) for the season.`,
};

/** Every archetype (rule-based, default, unclassified) in display order. */
export const ALL_ARCHETYPES = [...ARCHETYPES, DEFAULT_ARCHETYPE, UNCLASSIFIED_ARCHETYPE];
