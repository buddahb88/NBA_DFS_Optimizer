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
 *   minutes (Q2): ours_minutes_p10 / ours_minutes_p90 (our minutes band),
 *   rw_minutes_gap (RotoWire's posted minutes - ours, before any correction),
 *   minutes_correction
 *   ({ factor, bucket, band } when the live correction moved ours, else null)
 * Players RotoWire projects at 0 (ruled out) keep their row: the pool is
 * RotoWire's, as with the sanity layer.
 */

import { normalizeTag, riskLevel, tagLabel, tagPlayProbability } from './injuryRisk.js';

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

/**
 * The minutes fields of an own-model row (nulls without one). The own model's
 * 0-100 minutes_upside score stays on its endpoint only: it showed no signal
 * for minutes spikes once the minutes correction went live (blend calibration
 * backtest, 18 DK main slates 10/20-11/7: AUC 0.51 vs our minutes, 0.45 vs
 * RotoWire's).
 */
export function minutesRangeFields(own) {
  return {
    ours_minutes_p10: own?.minutes_p10 ?? null,
    ours_minutes_p90: own?.minutes_p90 ?? null,
    rw_minutes_gap: own?.rw_minutes_gap ?? null,
    minutes_correction: own?.minutes_correction ?? null
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
    tag_applied: Boolean(own?.tag_applied),
    p_play_model: own ? own.p_play_model ?? own.p_play ?? null : null,
    projection_fade: own ? fadeCall(own, { threshold }) : null,
    ...minutesRangeFields(own)
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

/**
 * INJURY-TAG RISK (after the source is chosen, every source). A tagged player
 * (QUES / PROB / DOUBT / GTD; injuryRisk.js) gets
 *   injury_play_prob     P(play) used: min(P(play | tag, salary band), model p_play)
 *   projection_if_plays  the source projection / model p_play (the model's mean
 *                        already includes its own DNP chance; RotoWire's and a
 *                        fallback's do not: model p_play = 1 there)
 *   projected_points     injury_play_prob x projection_if_plays
 * The own model now prices the tag itself (ownModel tagPlay: its p_play is
 * already min(minutes_v2, tag) with the same table), so for ours / blend the
 * factor here is 1 and only projection_if_plays / the risk fields are added.
 * Combining with our model: MIN, not product. The model's p_play already
 * prices the base DNP rate every player has; the tag rate is the play rate of
 * tagged players overall, so multiplying would count the base rate twice.
 * With the min, a tag only lowers the projection when it is the stronger
 * signal (p_play 0.97, QUES 0.68 -> x0.70; p_play 0.5 -> unchanged).
 * The discount factor (injury_play_prob / model p_play) also scales floor,
 * value and boom_probability (a boom needs him to play); ceiling and std_dev
 * stay (GPP upside if he plays). injury_risk: 'none' | 'low' | 'medium' | 'high'.
 * Untagged players get injury_risk 'none' and null fields; OUT / projected-0
 * players are left alone.
 */
export const INJURY_FIELDS = Object.freeze([
  'injury_tag', 'injury_risk', 'injury_play_prob', 'injury_tag_play_prob', 'projection_if_plays',
  'projection_pre_injury', 'injury_discount'
]);

const MODEL_SOURCES = new Set(['ours', 'blend']);
const MIN_MODEL_P = 0.2;

export function applyInjuryRisk(player, table) {
  const untouched = { injury_tag: null, injury_risk: 'none', injury_play_prob: null, injury_tag_play_prob: null,
    projection_if_plays: null, projection_pre_injury: null, injury_discount: null };
  const projection = num(player.projected_points);
  const tagged = tagPlayProbability(table, player.injury_status, player.salary);
  if (!tagged || !(projection > 0)) {
    const tag = normalizeTag(player.injury_status);
    return { ...player, ...untouched, injury_tag: tag && tag !== 'OUT' ? tag : null };
  }
  const fromModel = MODEL_SOURCES.has(player.projection_source) && finite(num(player.p_play)) && num(player.p_play) > 0;
  // The own model already priced the tag (p_play = the tag's rate): no floor, so no second discount
  const modelP = fromModel ? (player.tag_applied ? num(player.p_play) : Math.max(MIN_MODEL_P, num(player.p_play))) : 1;
  const pPlay = Math.min(modelP, tagged.p);
  const factor = pPlay / modelP;
  const ifPlays = projection / modelP;
  const point = projection * factor;
  const stdDev = num(player.std_dev);
  return {
    ...player,
    projected_points: round(point),
    value: scaled(player.value, factor),
    floor: scaled(player.floor, factor),
    boom_probability: scaled(player.boom_probability, factor),
    volatility: stdDev !== null && point > 0 && player.volatility !== null && player.volatility !== undefined
      ? round(stdDev / point, 4) : player.volatility,
    injury_tag: tagged.tag,
    injury_risk: riskLevel(pPlay),
    injury_play_prob: round(pPlay, 3),
    injury_tag_play_prob: round(tagged.p, 3),
    projection_if_plays: round(ifPlays),
    projection_pre_injury: round(projection),
    injury_discount: round(factor, 3)
  };
}

/** The injury fields of a row ({} when the layer did not run). */
export const pickInjuryFields = (p) => (p && 'injury_risk' in p
  ? Object.fromEntries(INJURY_FIELDS.filter(f => f in p).map(f => [f, p[f]]))
  : {});

/** Compact injury fields for chat / agent payloads ({} for untagged players). */
export function chatInjuryFields(p) {
  if (!p?.injury_tag || !finite(p.injury_play_prob)) return {};
  return {
    injuryRisk: p.injury_risk,
    playProbability: p.injury_play_prob,
    projectionIfPlays: p.projection_if_plays,
    injuryNote: `${tagLabel(p.injury_tag)}: plays ~${Math.round(p.injury_tag_play_prob * 100)}% of the time; projection is x${p.injury_discount} of ${p.projection_if_plays} if he plays`
  };
}

export const SOURCE_FIELDS = Object.freeze([
  'projection_source', 'projection_requested', 'projection_fallback', 'projection_fallback_reason',
  'projection_rotowire', 'projection_ours', 'projection_blend', 'ours_minutes', 'p_play', 'p_play_model', 'tag_applied', 'projection_fade',
  'ours_minutes_p10', 'ours_minutes_p90', 'rw_minutes_gap', 'minutes_correction'
]);

/** The layer's fields of a row ({} for a RotoWire read), for rows rebuilt field by field. */
export const pickSourceFields = (p) => (p?.projection_source
  ? Object.fromEntries(SOURCE_FIELDS.filter(f => f in p).map(f => [f, p[f]]))
  : {});

/**
 * Compact source fields for chat / agent tool payloads ({} for a RotoWire
 * read): which source the projection is, the three numbers, our minutes /
 * p_play and the fade call; plus the injury-tag risk fields (chatInjuryFields)
 * for a tagged player on any source.
 */
export function chatSourceFields(p) {
  if (!p?.projection_source) return chatInjuryFields(p);
  const fade = p.projection_fade;
  return {
    projectionSource: p.projection_source,
    ...(p.projection_fallback ? { projectionFallback: p.projection_fallback_reason ?? true } : {}),
    rotowireProjection: p.projection_rotowire,
    oursProjection: p.projection_ours,
    blendProjection: p.projection_blend,
    oursMinutes: p.ours_minutes,
    pPlay: p.p_play,
    ...(Number.isFinite(p.rw_minutes_gap) ? { rwMinutesGap: p.rw_minutes_gap, oursMinutesP90: p.ours_minutes_p90 } : {}),
    ...(fade ? { fade: { pointsDiff: fade.points_diff, hitRate: fade.hit_rate, calls: fade.n, note: fade.text } } : {}),
    ...chatInjuryFields(p)
  };
}

export default {
  FADE_THRESHOLD, SOURCE_FIELDS, INJURY_FIELDS, fadeCall, sourceNumbers, applySource, applyInjuryRisk,
  pickSourceFields, pickInjuryFields, chatSourceFields, chatInjuryFields, minutesRangeFields
};
