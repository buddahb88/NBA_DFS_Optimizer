// Projection sanity layer (backend services/projections): slate players carry
// projection_raw (RotoWire as synced), projection_adjustment and
// projection_reasons when the layer is on. Pure helpers for the tables.
// Under the ours / blend projection source projected_points is that source's
// number; the adjusted RotoWire value is projection_rotowire.

const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v))
const signed = (x) => `${x >= 0 ? '+' : '-'}${Math.abs(x).toFixed(1)}`

/**
 * { raw, adjusted, delta, reasons, text } for a player the layer touched
 * (moved the projection, or gave a reason), else null.
 */
export function sanityNote(p = {}) {
  if (!p.projection_sanity) return null
  const reasons = Array.isArray(p.projection_reasons) ? p.projection_reasons : []
  const raw = num(p.projection_raw)
  const adjusted = num(p.projection_rotowire ?? p.projected_points)
  const delta = num(p.projection_adjustment) ?? 0
  if (raw === null || adjusted === null || (!reasons.length && delta === 0)) return null
  const head = delta === 0
    ? `RotoWire ${raw.toFixed(1)} (unchanged)`
    : `RotoWire ${raw.toFixed(1)} -> adjusted ${adjusted.toFixed(1)} (${signed(delta)})`
  return { raw, adjusted, delta, reasons, text: reasons.length ? `${head}: ${reasons.join('; ')}` : head }
}
