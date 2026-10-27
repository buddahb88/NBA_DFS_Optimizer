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
 * 2. Blowout minutes trim. A player projected for minMinutes+ on a team with
 *    |spread| >= threshold loses
 *      minutesPerPoint[favorite | underdog] x (|spread| - pivot)
 *    minutes (capped at maxMinutes); points follow at his (shrunk) FPPM.
 *    Spread is the team's own: negative = favorite.
 *
 * SANITY_CONFIG values come from scripts/projection-sanity-report.js (see the
 * numbers there): blowout coefficients are the expected minutes lost by a
 * 28+ minute player vs a typical game, from final margins in 2024-25 and
 * 2025-26 integrated over a normal margin around the spread; the FPPM
 * threshold / fraction were checked on the saved main slates and on the
 * 2025-26 rate replay.
 */

export const SANITY_CONFIG = Object.freeze({
  fppm: Object.freeze({
    enabled: true,
    overThreshold: 0.3,
    overFraction: 0.5,
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
    minutesPerPoint: Object.freeze({ favorite: 0.15, underdog: 0.15 }),
    maxMinutes: 3
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

/** Blowout minutes trim. Returns { minutesDelta, pointsDelta, reason }. */
export function blowoutTrim({ points, minutes, spread }, config = SANITY_CONFIG.blowout) {
  const zero = { minutesDelta: 0, pointsDelta: 0, reason: null };
  const pts = num(points);
  const min = num(minutes);
  const s = num(spread);
  if (config.enabled === false || s === null || !(pts > 0) || !(min >= config.minMinutes)) return zero;
  if (Math.abs(s) < config.threshold) return zero;

  const perPoint = s < 0 ? config.minutesPerPoint.favorite : config.minutesPerPoint.underdog;
  const trim = clamp(perPoint * (Math.abs(s) - config.pivot), 0, config.maxMinutes);
  if (!(trim > 0)) return zero;
  return {
    minutesDelta: -trim,
    pointsDelta: -trim * pts / min,
    reason: `blowout ${signed(s)}: -${trim.toFixed(1)} min`
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
