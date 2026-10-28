/**
 * PROJECTION SOURCE LAYER
 *
 * Pure: puts the chosen source's numbers on a slate player (after the sanity
 * layer) from that player's own-model row (ownModelService.playerOutput).
 *
 *   rotowire  nothing changes (sourceService never calls this)
 *   ours      projected_points = ours_mean (DK mean incl. DNP)
 *             floor / ceiling  = our p10 / p90
 *             boom_probability = p_boom (P(DK >= 6x salary)), in percent
 *   blend     projected_points = blend_point; floor / ceiling / boom from our
 *             distribution re-centered on the blend point (blend_p10 /
 *             blend_p90 / blend_p_boom, as the M4 backtest scored it)
 * std_dev follows the p10-p90 width (normal: 2 x 1.2816 sd), volatility is
 * std_dev / projection, value scales with the projection (as the sanity
 * layer's). projected_minutes, bust_probability and ownership stay RotoWire's.
 *
 * Every player the layer sees carries the comparison fields:
 *   projection_source     the source its numbers come from ('rotowire' on fallback)
 *   projection_requested  the source asked for
 *   projection_fallback   true when the own model had no usable row (reason in
 *                         projection_fallback_reason): RotoWire is kept
 *   projection_rotowire   RotoWire after the sanity layer (as read)
 *   projection_ours, projection_blend, ours_minutes, p_play
 *   projection_fade       FADE call or null (fadeCall)
 * Players RotoWire projects at 0 (ruled out) keep their row: the pool is
 * RotoWire's, as with the sanity layer.
 */

export const FADE_THRESHOLD = 4;
const Z90 = 1.2816;

const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const round = (x, d = 2) => (finite(x) ? Number(x.toFixed(d)) + 0 : x);

/**
 * FADE: ours below RotoWire (sanity-adjusted, the own model's comparison) by
 * threshold+ DK points. Returns { points_diff, ours, rotowire, bucket, hit_rate,
 * n, text } or null. hit_rate / n: how often that bucket's calls ended below
 * RotoWire on the saved slates (ownModelWeights.json disagreement). "Ours
 * higher" never flags: those calls had no edge (M4).
 */
export function fadeCall(own, { threshold = FADE_THRESHOLD } = {}) {
  const diff = num(own?.disagreement?.points_diff);
  if (diff === null || diff > -threshold || !finite(own.ours_mean) || !finite(own.rotowire_points)) return null;
  const history = own.disagreement.history ?? null;
  const bucket = own.disagreement.lean ?? null;
  const hitRate = finite(history?.hitRate) ? history.hitRate : null;
  const record = hitRate !== null
    ? ` Ours ${bucket}: actual below RotoWire ${Math.round(hitRate * 100)}% of ${history.n} saved-slate calls.`
    : '';
  return {
    points_diff: round(diff),
    ours: own.ours_mean,
    rotowire: own.rotowire_points,
    bucket,
    hit_rate: hitRate,
    n: history?.n ?? null,
    text: `Fade: ours ${own.ours_mean.toFixed(1)} vs RotoWire ${own.rotowire_points.toFixed(1)} (${diff.toFixed(1)}).${record}`
  };
}

const scaled = (v, ratio) => (v === null || v === undefined || !Number.isFinite(Number(v)) ? v : round(Number(v) * ratio));

/** The source's { point, p10, p90, pBoom } from an own-model row, or null when it has none. */
export function sourceNumbers(own, source) {
  if (!own) return null;
  const pick = source === 'blend'
    ? { point: own.blend_point, p10: own.blend_p10, p90: own.blend_p90, pBoom: own.blend_p_boom }
    : { point: own.ours_mean, p10: own.p10, p90: own.p90, pBoom: own.p_boom };
  return finite(pick.point) ? pick : null;
}

/**
 * One player under `source` ('ours' | 'blend'). own: the player's own-model row
 * or null; reason: why it is missing (the fallback reason).
 */
export function applySource(player, own, source, { reason = null, threshold = FADE_THRESHOLD } = {}) {
  const rotowire = num(player.projected_points);
  const picked = sourceNumbers(own, source);
  const fields = {
    projection_requested: source,
    projection_rotowire: rotowire,
    projection_ours: own?.ours_mean ?? null,
    projection_blend: own?.blend_point ?? null,
    ours_minutes: own?.ours_minutes ?? null,
    p_play: own?.p_play ?? null,
    projection_fade: own ? fadeCall(own, { threshold }) : null
  };
  // The pool is RotoWire's: a ruled-out player keeps his 0
  if (!(rotowire > 0)) return { ...player, ...fields, projection_source: 'rotowire', projection_fallback: false };
  if (!picked) {
    const why = reason ?? (own ? `no ${source} projection` : 'not in the own model');
    return { ...player, ...fields, projection_source: 'rotowire', projection_fallback: true, projection_fallback_reason: why };
  }
  const point = picked.point;
  const ratio = point / rotowire;
  const hasRange = finite(picked.p10) && finite(picked.p90);
  const stdDev = hasRange ? Math.max(0, picked.p90 - picked.p10) / (2 * Z90) : null;
  return {
    ...player,
    projected_points: round(point),
    value: scaled(player.value, ratio),
    floor: hasRange ? round(picked.p10) : scaled(player.floor, ratio),
    ceiling: hasRange ? round(picked.p90) : scaled(player.ceiling, ratio),
    std_dev: stdDev !== null ? round(stdDev) : scaled(player.std_dev, ratio),
    volatility: stdDev !== null && point > 0 ? round(stdDev / point, 4) : player.volatility,
    boom_probability: finite(picked.pBoom) ? round(picked.pBoom * 100) : player.boom_probability,
    ...fields,
    projection_source: source,
    projection_fallback: false
  };
}

export default { FADE_THRESHOLD, fadeCall, sourceNumbers, applySource };
