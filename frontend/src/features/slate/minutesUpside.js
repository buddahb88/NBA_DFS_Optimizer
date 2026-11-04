// Minutes upside (backend modelEval/minutesUpside.js, on slate reads through the
// projection source layer): minutes_upside 0-100, rw_minutes_gap (RotoWire's
// posted minutes - ours before any correction), ours_minutes_p10 / _p90 and
// minutes_upside_reasons. Pure helpers for the tables and the player card.

// Score >= 50: on the 14 saved slates 28% of these beat our minutes by 8+ (base 8%)
export const HIGH_UPSIDE = 50

const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v))
const fmt = (v) => (num(v) === null ? '—' : num(v).toFixed(1))

/** Badge / text tone of a score: positive (high), info (some), neutral. */
export function upsideTone(score) {
  const s = num(score)
  if (s === null) return 'neutral'
  return s >= HIGH_UPSIDE ? 'positive' : s >= 25 ? 'info' : 'neutral'
}

/**
 * { score, tone, high, text } for a player with a minutes upside score, else
 * null. text: the score, our minutes and band, RotoWire's minutes and the
 * gap, and the reasons.
 */
export function upsideNote(p = {}) {
  const score = num(p.minutes_upside)
  if (score === null) return null
  const gap = num(p.rw_minutes_gap)
  const p10 = num(p.ours_minutes_p10)
  const p90 = num(p.ours_minutes_p90)
  const parts = [`Minutes upside ${Math.round(score)}/100`]
  const ours = num(p.ours_minutes)
  if (ours !== null) parts.push(`Ours ${fmt(ours)} min${p10 !== null && p90 !== null ? ` (p10–p90 ${fmt(p10)}–${fmt(p90)})` : ''}`)
  if (num(p.projected_minutes) !== null) parts.push(`RotoWire ${fmt(p.projected_minutes)}${gap !== null ? ` (${gap >= 0 ? '+' : ''}${gap.toFixed(1)} vs ours)` : ''}`)
  const reasons = Array.isArray(p.minutes_upside_reasons) ? p.minutes_upside_reasons : []
  if (reasons.length) parts.push(reasons.join(', '))
  return { score, tone: upsideTone(score), high: score >= HIGH_UPSIDE, text: parts.join('. ') }
}
