// Projection source layer (backend services/projections/sourceLayer.js): with
// source ours / blend, slate players carry projection_source,
// projection_rotowire (after the sanity layer), projection_ours,
// projection_blend, ours_minutes, p_play and projection_fade. Pure helpers
// for the tables and controls.

export const SOURCE_LABELS = { rotowire: 'RotoWire', ours: 'Ours', blend: 'Blend' }

export const SOURCE_HINTS = {
  rotowire: 'RotoWire projections (after the sanity layer), exactly as before.',
  ours: 'Our model: rates x minutes, DK mean incl. DNP risk; floor / ceiling = our p10 / p90.',
  blend: 'RotoWire x ours, weighted by salary tier (M4 backtest: MAE 7.61 vs RotoWire 7.71 on 8 slates).',
}

const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v))
const fmt = (v) => (num(v) === null ? '—' : num(v).toFixed(1))

/**
 * { source, requested, fallback, text } for a player read with ours / blend,
 * else null. text: which source is shown, the three projections, our minutes
 * and p_play, and why RotoWire was kept on a fallback.
 */
export function sourceNote(p = {}) {
  if (!p.projection_source) return null
  const requested = p.projection_requested ?? p.projection_source
  const fallback = Boolean(p.projection_fallback)
  const parts = [
    `${SOURCE_LABELS[p.projection_source] ?? p.projection_source} projection`,
    `RotoWire ${fmt(p.projection_rotowire)} · Ours ${fmt(p.projection_ours)} · Blend ${fmt(p.projection_blend)}`,
  ]
  const minutes = num(p.ours_minutes)
  const pPlay = num(p.p_play)
  if (minutes !== null || pPlay !== null) {
    parts.push(`Our minutes ${fmt(minutes)}${pPlay !== null ? ` · plays ${Math.round(pPlay * 100)}%` : ''}`)
  }
  if (fallback) parts.push(`${SOURCE_LABELS[requested] ?? requested} unavailable, RotoWire kept${p.projection_fallback_reason ? `: ${p.projection_fallback_reason}` : ''}`)
  return { source: p.projection_source, requested, fallback, text: parts.join('. ') }
}

/** { label, text, hitRate, pointsDiff } for a player with a fade call, else null. */
export function fadeNote(p = {}) {
  const f = p.projection_fade
  if (!f) return null
  const hitRate = num(f.hit_rate)
  return {
    label: hitRate !== null ? `Fade ${Math.round(hitRate * 100)}%` : 'Fade',
    text: f.text ?? `Fade: ours ${fmt(f.ours)} vs RotoWire ${fmt(f.rotowire)}`,
    hitRate,
    pointsDiff: num(f.points_diff),
  }
}
