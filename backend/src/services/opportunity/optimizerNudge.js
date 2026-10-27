/**
 * OPPORTUNITY OPTIMIZER NUDGE
 *
 * The optional "opportunity" factor of the optimizer (Lineup Studio settings,
 * POST /api/optimizer/generate and the chat's build_lineup): each player's
 * projection, floor and ceiling are scaled by his Opportunity Score for the
 * optimizer mode (cash_score in cash, gpp_score in GPP):
 *
 *   factor = 1 + weight x maxPct x clamp((score - 50) / 50, -1, 1)
 *
 * so weight 1 moves a 100 score up maxPct and a 0 score down maxPct, and
 * weight 0 (the default) returns the players untouched. Players without a
 * radar row keep their numbers. Scores come from the radar for the same
 * slate source, so a backtest uses only games before its date.
 */

import { getOpportunityRadar } from './radarService.js';

export const OPPORTUNITY_NUDGE = Object.freeze({ maxPct: 0.1, neutral: 50 });

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const round2 = (x) => Math.round(x * 100) / 100;
const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

/** 'opportunityWeight must be ...' for a value outside 0-1, null when fine (empty counts as 0). */
export function validateOpportunityWeight(weight) {
  if (weight === undefined || weight === null || weight === '') return null;
  const w = num(weight);
  return w === null || w < 0 || w > 1 ? 'opportunityWeight must be a number from 0 to 1' : null;
}

const weightOf = (weight) => clamp(num(weight) ?? 0, 0, 1);

/** Projection multiplier for a 0-100 score at a 0-1 weight (1 when either is missing). */
export function opportunityFactor(score, weight, config = OPPORTUNITY_NUDGE) {
  const s = num(score);
  const w = weightOf(weight);
  if (s === null || w === 0) return 1;
  return 1 + w * config.maxPct * clamp((s - config.neutral) / config.neutral, -1, 1);
}

const scale = (v, factor) => (num(v) === null ? v : round2(Number(v) * factor));

/**
 * Players with projected_points / floor / ceiling nudged by their radar
 * row's score for `mode`; rows match by id, else player_key. Each nudged
 * player carries opportunity_score, opportunity_factor and
 * base_projected_points. Weight 0 returns `players` itself.
 */
export function applyOpportunity(players, rows, { weight = 0, mode = 'cash', config = OPPORTUNITY_NUDGE } = {}) {
  const w = weightOf(weight);
  if (w === 0) return players;
  const scoreKey = mode === 'gpp' ? 'gpp_score' : 'cash_score';
  const byId = new Map(rows.map(r => [String(r.id), r]));
  const byKey = new Map(rows.filter(r => r.player_key).map(r => [r.player_key, r]));
  return players.map(p => {
    const row = byId.get(String(p.id)) ?? (p.player_key ? byKey.get(p.player_key) : undefined);
    const score = num(row?.[scoreKey]);
    if (score === null) return p;
    const factor = opportunityFactor(score, w, config);
    return {
      ...p,
      projected_points: scale(p.projected_points, factor),
      floor: scale(p.floor, factor),
      ceiling: scale(p.ceiling, factor),
      base_projected_points: p.projected_points,
      opportunity_score: score,
      opportunity_factor: Number(factor.toFixed(4))
    };
  });
}

/**
 * applyOpportunity with the radar of a slateSource source. Returns
 * { players, opportunity } where opportunity is null at weight 0, else
 * { weight, mode, scored } (scored = players with a score).
 */
export async function withOpportunity(source, players, { weight = 0, mode = 'cash', site = null } = {}) {
  const w = weightOf(weight);
  if (w === 0 || !source) return { players, opportunity: null };
  const m = mode === 'gpp' ? 'gpp' : 'cash';
  const radar = await getOpportunityRadar({
    slateId: source.slateId, slateDate: source.isBacktest ? source.slateDate : null, site: site || source.site, mode: m
  });
  const nudged = applyOpportunity(players, radar.players, { weight: w, mode: m });
  return {
    players: nudged,
    opportunity: { weight: w, mode: m, scored: nudged.filter(p => p.opportunity_score !== undefined).length }
  };
}

export default { applyOpportunity, withOpportunity, opportunityFactor, validateOpportunityWeight, OPPORTUNITY_NUDGE };
