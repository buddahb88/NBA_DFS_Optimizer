/**
 * DVP ADJUSTMENT (archetype defense)
 *
 * The projection's defense-vs-position term, from team_archetype_defense
 * (archetypeDefenseService): how players of this archetype scored against the
 * opponent relative to their own baseline, already shrunk toward 0 by sample
 * size. Lookup order:
 *   1. opponent x archetype (this season's archetype, else last season's)
 *   2. opponent x G/F/C position
 *   3. 0
 * adjustment = clamp(weight x fp_over_expectation, -cap, +cap)
 *
 * mode 'legacy' keeps the old Hashtag Basketball points-allowed formula
 * (projectionService.getLegacyDvpAdjustment); 'off' disables the term.
 * Configure with DVP_ADJUSTMENT_MODE / DVP_ARCHETYPE_WEIGHT / DVP_ARCHETYPE_CAP.
 */

import db from '../config/database.js';
import { dvpPosition, previousSeason } from './archetypeDefenseService.js';
import { getSiteConfig } from '../config/sites.js';
import { canonicalTeam, playerKey } from '../utils/playerKey.js';
import { getCurrentSeason, seasonForDate } from '../utils/season.js';

export const DVP_MODES = ['archetype', 'legacy', 'off'];

export const DEFAULT_DVP_CONFIG = Object.freeze({
  mode: 'archetype',
  weight: 0.75, // best of 0.25-1.5 in the replay backtest (MAE 7.969 vs 7.981 legacy DVP)
  cap: 2,
});

const ENV_KEYS = { mode: 'DVP_ADJUSTMENT_MODE', weight: 'DVP_ARCHETYPE_WEIGHT', cap: 'DVP_ARCHETYPE_CAP' };

/** Defaults < env < overrides. Throws on an unknown mode or a negative / non-numeric weight or cap. */
export function resolveDvpConfig(overrides = {}, env = process.env) {
  const pick = (key) => overrides[key] ?? (env[ENV_KEYS[key]] || undefined) ?? DEFAULT_DVP_CONFIG[key];
  const mode = String(pick('mode'));
  if (!DVP_MODES.includes(mode)) throw new Error(`DVP mode must be one of: ${DVP_MODES.join(', ')}`);
  const number = (key) => {
    const v = Number(pick(key));
    if (!Number.isFinite(v) || v < 0) throw new Error(`DVP ${key} must be a non-negative number`);
    return v;
  };
  return { mode, weight: number('weight'), cap: number('cap') };
}

/**
 * Lookup context from team_archetype_defense rows (one season, one site) and
 * player_key -> archetype maps for that season and the one before.
 */
export function buildDvpContext({ defenseRows = [], archetypes = new Map(), priorArchetypes = new Map(), season = null, site = null } = {}) {
  const cells = new Map();
  for (const r of defenseRows) {
    const value = Number(r.fp_over_expectation);
    if (Number.isFinite(value)) cells.set(`${r.group_by}|${r.team}|${r.group_key}`, value);
  }
  return { season, site, cells, archetypes, priorArchetypes };
}

/** This season's archetype, else last season's (as archetypeDefenseService does). */
function archetypeFor(key, context) {
  const current = context.archetypes.get(key);
  if (current && current !== 'unclassified') return current;
  const prior = context.priorArchetypes.get(key);
  return prior && prior !== 'unclassified' ? prior : null;
}

/**
 * Archetype DVP adjustment for one player. Pure.
 * @param {Object} player - { name, opponent, position }
 * @returns {{ value: number, raw: number|null, source: 'archetype'|'position'|'none', group: string|null }}
 */
export function archetypeDvpAdjustment(player, context, config = DEFAULT_DVP_CONFIG) {
  const none = { value: 0, raw: null, source: 'none', group: null };
  const opponent = canonicalTeam(player?.opponent);
  if (!context || !opponent) return none;

  const candidates = [
    ['archetype', player.name ? archetypeFor(playerKey(player.name), context) : null],
    ['position', dvpPosition(player.position)],
  ];
  for (const [groupBy, group] of candidates) {
    if (!group) continue;
    const raw = context.cells.get(`${groupBy}|${opponent}|${group}`);
    if (raw === undefined) continue;
    const value = Math.max(-config.cap, Math.min(config.cap, raw * config.weight));
    return { value: value === 0 ? 0 : value, raw, source: groupBy, group };
  }
  return none;
}

const DEFENSE_SQL = `SELECT group_by, team, group_key, fp_over_expectation FROM team_archetype_defense
  WHERE season = ? AND site = ?`;
const ARCHETYPES_SQL = 'SELECT player_key, archetype FROM player_archetypes WHERE season = ?';

/**
 * Load the context for a slate: the slate date's season (today's when no date),
 * or the season before it while the slate season has no rows yet.
 */
export async function loadDvpContext({ slateDate = null, site = 'draftkings' } = {}) {
  const siteKey = getSiteConfig(site).key;
  const slateSeason = slateDate ? seasonForDate(slateDate) : getCurrentSeason();
  const prior = previousSeason(slateSeason);

  let season = slateSeason;
  let defenseRows = await db.all(DEFENSE_SQL, slateSeason, siteKey);
  if (defenseRows.length === 0) {
    season = prior;
    defenseRows = await db.all(DEFENSE_SQL, prior, siteKey);
  }
  const [current, previous] = await Promise.all([
    db.all(ARCHETYPES_SQL, slateSeason),
    db.all(ARCHETYPES_SQL, prior),
  ]);
  return buildDvpContext({
    defenseRows,
    archetypes: new Map(current.map(r => [r.player_key, r.archetype])),
    priorArchetypes: new Map(previous.map(r => [r.player_key, r.archetype])),
    season,
    site: siteKey,
  });
}
