/**
 * PROJECTION SANITY LAYER
 *
 * Pure math applied on top of the posted (RotoWire) projection; the original
 * stays alongside (raw_projection) with the reasons for any change.
 *
 * 1. FPPM outlier shrink. own = the player's rate FPPM from O3
 *    (opportunity/rateProjection.js: L10 vs season shrunk toward last season,
 *    games before the slate date only, x environment x teammate-out factor).
 *    ratio = posted FPPM / own. Above 1 + overThreshold the projection moves
 *    toward minutes x own by overFraction of the gap, phased in linearly over
 *    `ramp` above the threshold so there is no cliff:
 *      delta = -overFraction x weight x (posted - minutes x own)
 *      weight = clamp((ratio - 1 - overThreshold) / ramp, 0, 1)
 *    Under-projection (ratio below 1 - underThreshold) is the mirror image
 *    with underFraction (0 = off). Needs minSampleMinutes of L10 minutes and
 *    minMinutes projected.
 *
 * 2. Blowout trim. A player projected for minMinutes+ on a team with
 *    |spread| >= threshold loses, per point of |spread| beyond the pivot,
 *      minutesPerPoint[favorite | underdog] minutes   (capped at maxMinutes)
 *      pointsPctPerPoint[favorite | underdog] of his projection (capped at maxPointsPct)
 *    Points are fitted separately from minutes because blowouts move FPPM
 *    too: favorites' starters sit late but score faster while on the floor
 *    (points held), underdogs' lose minutes and rate. Spread is the team's
 *    own: negative = favorite.
 *
 * SANITY_CONFIG values come from scripts/projection-sanity-report.js:
 * blowout coefficients are the expected minutes / DK points lost by a 28+
 * minute player vs a typical game (|spread| 6), from final margins in
 * 2024-25 and 2025-26 (14.7k games) integrated over a normal margin (sd 12)
 * around the spread: favorites 0.15 min and ~0 points per point, underdogs
 * 0.14 min and 0.8% of points per point. The FPPM threshold / fraction were
 * checked on the saved main slates (Oct 20-26 2026) and on the 2025-26
 * replay (18k games: an L3-driven FPPM 30%+ above the own rate kept ~10% of
 * the gap, so most of it is noise).
 */

export const SANITY_CONFIG = Object.freeze({
  fppm: Object.freeze({
    enabled: true,
    overThreshold: 0.3,
    overFraction: 0.75,
    underThreshold: 0.3,
    underFraction: 0,
    ramp: 0.1,
    minSampleMinutes: 150,
    minMinutes: 10
  }),
  blowout: Object.freeze({
    enabled: true,
    threshold: 10,
    pivot: 6,
    minMinutes: 28,
    minutesPerPoint: Object.freeze({ favorite: 0.15, underdog: 0.14 }),
    pointsPctPerPoint: Object.freeze({ favorite: 0, underdog: 0.008 }),
    maxMinutes: 3,
    maxPointsPct: 0.1
  })
});

const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const signed = (x, digits = 1) => `${x >= 0 ? '+' : '-'}${Math.abs(x).toFixed(digits)}`;

const none = { delta: 0, reason: null };

/** FPPM outlier shrink. Returns { delta, reason }; delta 0 when it does not apply. */
export function fppmShrink({ points, minutes, ownFppm, sampleMinutes }, config = SANITY_CONFIG.fppm) {
  const pts = num(points);
  const min = num(minutes);
  const own = num(ownFppm);
  if (config.enabled === false || !(pts > 0) || !(min >= config.minMinutes) || !(own > 0)) return none;
  if (!(num(sampleMinutes) >= config.minSampleMinutes)) return none;

  const posted = pts / min;
  const ratio = posted / own;
  const target = min * own;
  let delta = 0;
  if (ratio > 1 + config.overThreshold && config.overFraction > 0) {
    const weight = clamp((ratio - 1 - config.overThreshold) / config.ramp, 0, 1);
    delta = -config.overFraction * weight * (pts - target);
  } else if (ratio < 1 - config.underThreshold && config.underFraction > 0) {
    const weight = clamp((1 - config.underThreshold - ratio) / config.ramp, 0, 1);
    delta = config.underFraction * weight * (target - pts);
  }
  if (delta === 0) return none;
  return { delta, reason: `FPPM ${posted.toFixed(2)} vs own ${own.toFixed(2)}: ${signed(delta)}` };
}

/**
 * Blowout trim. Returns { minutesDelta, pointsDelta, reason }: minutes and
 * points each lose their side's per-point share beyond the pivot (points as
 * a fraction of the projection), capped.
 */
export function blowoutTrim({ points, minutes, spread }, config = SANITY_CONFIG.blowout) {
  const zero = { minutesDelta: 0, pointsDelta: 0, reason: null };
  const pts = num(points);
  const min = num(minutes);
  const s = num(spread);
  if (config.enabled === false || s === null || !(pts > 0) || !(min >= config.minMinutes)) return zero;
  if (Math.abs(s) < config.threshold) return zero;

  const side = s < 0 ? 'favorite' : 'underdog';
  const excess = Math.abs(s) - config.pivot;
  const trim = clamp((config.minutesPerPoint[side] ?? 0) * excess, 0, config.maxMinutes);
  const pct = clamp((config.pointsPctPerPoint[side] ?? 0) * excess, 0, config.maxPointsPct);
  if (!(trim > 0) && !(pct > 0)) return zero;
  const pointsDelta = -pct * pts;
  return {
    minutesDelta: -trim,
    pointsDelta,
    reason: `blowout ${signed(s)}: -${trim.toFixed(1)} min, ${pct > 0 ? `${signed(pointsDelta)} pts` : 'points held'}`
  };
}

/**
 * Both steps on one player. input: { projectedPoints, projectedMinutes,
 * spread, ownFppm, sampleMinutes }. Returns { projection, minutes,
 * raw_projection, raw_minutes, adjustment, reasons: [{ kind, text, points, minutes }] }
 * (unrounded).
 */
export function applySanity({ projectedPoints, projectedMinutes, spread = null, ownFppm = null, sampleMinutes = null },
  config = SANITY_CONFIG) {
  const raw = num(projectedPoints) ?? 0;
  const rawMinutes = num(projectedMinutes) ?? 0;
  const reasons = [];
  let points = raw;
  let minutes = rawMinutes;

  const shrink = fppmShrink({ points, minutes, ownFppm, sampleMinutes }, config.fppm);
  if (shrink.delta !== 0) {
    points += shrink.delta;
    reasons.push({ kind: 'fppm', text: shrink.reason, points: shrink.delta, minutes: 0 });
  }
  const trim = blowoutTrim({ points, minutes, spread }, config.blowout);
  if (trim.minutesDelta !== 0) {
    points += trim.pointsDelta;
    minutes += trim.minutesDelta;
    reasons.push({ kind: 'blowout', text: trim.reason, points: trim.pointsDelta, minutes: trim.minutesDelta });
  }
  return { projection: points, minutes, raw_projection: raw, raw_minutes: rawMinutes, adjustment: points - raw, reasons };
}

export default { SANITY_CONFIG, fppmShrink, blowoutTrim, applySanity };
