/**
 * OWN MODEL (model evaluation harness projector "own_mean", and the per-player
 * output of the live service ownModelService.projectSlateOwnModel)
 *
 * rates_v1's per-minute production x minutes_v2's minutes distribution (same
 * fits: 2024-25), with the point estimate an optimizer can sum: the DK MEAN of
 * the full mixture (DNP with probability 1 - p_play, else the conditional
 * minutes distribution), where rates_v1's own point is the median at the point
 * minutes (fine for MAE, biased low for lineup totals). Per player:
 *
 *   dk_points        mean incl. DNP (p_play x conditional mean)
 *   ours_median      rates_v1's point (DK median at minutes_v2's point minutes)
 *   minutes          minutes_v2's point minutes; expected / conditional minutes, p_play
 *   p10 / p90, p_boom (boom_at), p_dd, p_td   from the mixture
 *   dk_quantiles     the mixture at QUANTILE_LEVELS (blends re-center them)
 *   role_shift       recent starts vs earlier (rates_v1 feature: role changes)
 *   minutes_blend_means  slates with RotoWire minutes: the mean incl. DNP with the
 *                    conditional minutes blended toward RotoWire's,
 *                    w x RotoWire + (1 - w) x ours for w in MINUTES_BLEND_GRID
 *                    (RotoWire at 0 minutes: (1 - w) x our mean). blend.js
 *                    picks w by cross-validation.
 *   minutes_sigma, rw_minutes (posted), rw_minutes_gap (RotoWire - our UNcorrected
 *                    conditional minutes), minutes_upside (+ components, reasons;
 *                    minutesUpside.js)
 *
 * options.correction (minutesCorrection.js params, or { bySlate: { slateId:
 * params } } for leave-one-slate-out runs): our conditional minutes move toward
 * RotoWire's before the simulation, so the mean, quantiles, p_boom and the
 * minutes fields follow (minutes_raw / conditional_minutes_raw keep ours, and
 * minutes_correction the factor / bucket). Without it the output is own_mean's.
 *
 * options.tagPlay (P(play | injury tag, salary band), projections/injuryRisk.js;
 * null for untagged players): minutes_v2's p_play never sees the tag (its
 * logistic is history only), so a QUES player came out at ~0.98. When the tag's
 * rate is lower, the mixture is re-run at it: dk_points, quantiles, p10 / p90,
 * p_boom, p_dd, expected minutes and the minutes band follow (the minutes point
 * and ours_median, both conditional-ish, stay). The output then carries
 * p_play_model (minutes_v2's), p_play_tag, tag_applied and untagged (the
 * prediction at p_play_model, which the blend weights were fit on).
 *
 * No outcome enters: everything comes from featureStore.asOf (rows before the
 * date) and the slate's pre-lock fields.
 */

import { getSiteConfig } from '../../config/sites.js';
import { conditionalMean, createRatesV1Projector, predictPlayer, projectRates, seedOf } from './ratesV1.js';
import { mixtureQuantile, projectDate as projectMinutes } from './minutesV2.js';
import { correctConditional } from './minutesCorrection.js';
import { minutesUpside, TEAMMATE_MINUTES } from './minutesUpside.js';

export const QUANTILE_LEVELS = Object.freeze(Array.from({ length: 101 }, (_, i) => i / 100));
export const MINUTES_BLEND_GRID = Object.freeze(Array.from({ length: 11 }, (_, i) => i / 10));

const finite = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * Prediction of one player from the date's rates / minutes maps.
 * ctx: harness ctx ({ mode, date, site, player, slate }); maps: { rates, minutes };
 * models: { rates, minutes } (fitted). Returns null when either model has no row.
 */
/** The correction params for a ctx: options.correction is params or { bySlate }. */
export function correctionFor(correction, ctx) {
  if (!correction) return null;
  if (correction.bySlate) return correction.bySlate[String(ctx.slate?.slateId)] ?? null;
  return correction;
}

export function ownPrediction(ctx, maps, models, { minutesGrid = MINUTES_BLEND_GRID, correction = null, tagPlay = null } = {}) {
  const { mode, date, site, player, slate } = ctx;
  const scoring = getSiteConfig(site).scoring;
  const params = models.rates.params;
  const boomAt = mode === 'slate' ? (slate?.salary > 0 ? params.boomMultiple * slate.salary / 1000 : null) : params.boomPoints;
  const rwMinutes = mode === 'slate' && finite(slate?.rotowireMinutes) ? slate.rotowireMinutes : null;
  if (player.out) {
    return {
      dk_points: 0, ours_median: 0, minutes: 0, expected_minutes: 0, conditional_minutes: 0, p_play: 0,
      minutes_p10: 0, minutes_p90: 0, p10: 0, p90: 0, p_boom: boomAt === null ? null : 0, boom_at: boomAt, p_dd: 0, p_td: 0,
      dk_quantiles: QUANTILE_LEVELS.map(() => 0), role_shift: 0,
      minutes_sigma: 0, rw_minutes: rwMinutes, rw_minutes_gap: null, minutes_upside: 0, minutes_upside_components: null, minutes_upside_reasons: [],
      ...(rwMinutes !== null ? { minutes_blend_means: minutesGrid.map(() => 0) } : {})
    };
  }
  const k = `${player.key}|${player.team}`;
  const r = maps.rates.get(k);
  const m = maps.minutes.get(k);
  if (!r || !m) return null;
  const seed = seedOf(`${date}|${player.key}`);
  const corrParams = correctionFor(correction, ctx);
  const corr = corrParams ? correctConditional({ cond: m.conditional_minutes, rotowire: rwMinutes, salary: slate?.salary ?? null }, corrParams) : null;
  const delta = corr?.applied ? corr.cond - m.conditional_minutes : 0;
  const shift = (v) => (v > 0 ? Math.max(0, v + delta) : v);
  const cond = m.conditional_minutes + delta;
  const zMinutes = models.minutes?.zMinutes ?? null;
  const rwGap = rwMinutes !== null ? rwMinutes - m.conditional_minutes : null;
  const teammateOut = (player.teamOut ?? []).some(o => o.expectedMinutes >= TEAMMATE_MINUTES);
  const upside = minutesUpside({ gap: rwMinutes > 0 ? rwGap : null, sigma: m.sigma, teammateOut, roleShift: r.features.roleShift ?? 0 });

  // The full output at a play probability (minutes_v2's, or the injury tag's when lower)
  const build = (pPlay) => {
    const tagged = pPlay !== m.p_play;
    const minutes = { kind: 'mixture', pPlay, cond, sigma: m.sigma, zMinutes, point: shift(m.minutes) };
    const pred = predictPlayer(r.rates, models.rates, minutes, { seed, scoring, boomAt, typical: r.typical, quantiles: QUANTILE_LEVELS });
    const out = {
      dk_points: pred.dk_mean,
      ours_median: pred.dk_points,
      minutes: shift(m.minutes),
      expected_minutes: delta || tagged ? pPlay * cond : m.expected_minutes,
      conditional_minutes: cond,
      p_play: pPlay,
      // minutes_v2's mixture quantiles; re-derived at the tag's DNP mass
      minutes_p10: tagged ? mixtureQuantile(0.1, pPlay, cond, m.sigma, zMinutes) : shift(m.minutes_p10),
      minutes_p90: tagged ? mixtureQuantile(0.9, pPlay, cond, m.sigma, zMinutes) : shift(m.minutes_p90),
      p10: pred.p10,
      p90: pred.p90,
      p_boom: pred.p_boom,
      boom_at: boomAt,
      p_dd: pred.p_dd,
      p_td: pred.p_td,
      dk_quantiles: pred.dk_quantiles,
      role_shift: r.features.roleShift ?? 0,
      minutes_sigma: m.sigma,
      rw_minutes: rwMinutes,
      rw_minutes_gap: rwGap,
      minutes_upside: upside.score,
      minutes_upside_components: upside.components,
      minutes_upside_reasons: upside.reasons
    };
    if (corrParams) {
      out.minutes_raw = m.minutes;
      out.conditional_minutes_raw = m.conditional_minutes;
      out.minutes_correction = { factor: corr.factor, bucket: corr.bucket, band: corr.band, applied: corr.applied };
    }
    if (rwMinutes !== null) {
      out.minutes_blend_means = minutesGrid.map(w => {
        if (w === 0) return pred.dk_mean;
        if (!(rwMinutes > 0)) return (1 - w) * pred.dk_mean;
        const c = w * rwMinutes + (1 - w) * cond;
        return pPlay * conditionalMean(r.rates, models.rates, { cond: c, sigma: m.sigma, zMinutes }, { seed, scoring, typical: r.typical });
      });
    }
    return out;
  };

  const base = build(m.p_play);
  const tag = playProbabilityWithTag(m.p_play, tagPlay);
  if (!tag.applied) return tag.p_play_tag === null ? base : { ...base, p_play_model: m.p_play, p_play_tag: tag.p_play_tag, tag_applied: false };
  // A tag that is the stronger signal: the mixture at the tag's play probability.
  // untagged: the prediction at minutes_v2's p_play (the blend's weights were fit on it)
  return { ...build(tag.p_play), p_play_model: m.p_play, p_play_tag: tag.p_play_tag, tag_applied: true, untagged: base };
}

/**
 * Play probability with an injury tag: min(model, P(play | tag, salary band)).
 * The model's p_play already prices the base DNP rate every player has; the
 * tag rate is tagged players' play rate overall, so the min (not the product)
 * - the same rule as the source layer's applyInjuryRisk. Returns { p_play,
 * p_play_tag, applied }.
 */
export function playProbabilityWithTag(modelP, tagP) {
  if (!finite(tagP)) return { p_play: modelP, p_play_tag: null, applied: false };
  const applied = finite(modelP) && tagP < modelP;
  return { p_play: applied ? tagP : modelP, p_play_tag: tagP, applied };
}

/** The date's rates and minutes maps (rates_v1.projectRates, minutes_v2.projectDate). */
export function prepareOwnMaps(dateCtx, models) {
  return { rates: projectRates(dateCtx, models.rates), minutes: projectMinutes(dateCtx, models.minutes) };
}

// Fitted models per training store + options: own_mean and own_mean_mincorr fit once per run
const FITS = new WeakMap();

/**
 * Harness projector. Options as createRatesV1Projector (params, minutesParams,
 * model, minutesModel); fit() fits both on the training window, shared with the
 * run's other own-model projectors on the same store. correction: as
 * ownPrediction (own_mean_mincorr). tagPlay: (ctx) => P(play | tag) or null
 * (ownPrediction's tagPlay per player; none by default).
 */
export function createOwnModelProjector(options = {}) {
  const { correction = null, tagPlay = null, ...rest } = options;
  const config = `${JSON.stringify(rest.params ?? {})}|${JSON.stringify(rest.minutesParams ?? {})}`;
  let inner = createRatesV1Projector({ ...rest, minutesSource: 'minutes_v2' });
  const models = () => ({ rates: inner.model(), minutes: inner.minutesModel() });
  const memoKey = `own_model|${config}`;
  return {
    async fit(args) {
      if (rest.model && rest.minutesModel) return;
      if (!FITS.has(args.store)) FITS.set(args.store, new Map());
      const byKey = FITS.get(args.store);
      const key = `${config}|${args.until}|${(args.seasons ?? []).join(',')}`;
      if (!byKey.has(key)) byKey.set(key, inner.fit(args).then(models));
      const fitted = await byKey.get(key);
      inner = createRatesV1Projector({ ...rest, minutesSource: 'minutes_v2', model: fitted.rates, minutesModel: fitted.minutes });
    },
    prepareDate(dateCtx) {
      if (!dateCtx.shared.has(memoKey)) dateCtx.shared.set(memoKey, prepareOwnMaps(dateCtx, models()));
    },
    project(ctx) {
      const maps = ctx.shared.get(memoKey);
      return maps ? ownPrediction(ctx, maps, models(), { correction, tagPlay: typeof tagPlay === 'function' ? tagPlay(ctx) : null }) : null;
    },
    model: () => inner.model(),
    minutesModel: () => inner.minutesModel()
  };
}

export default { createOwnModelProjector, ownPrediction, playProbabilityWithTag, correctionFor, prepareOwnMaps, QUANTILE_LEVELS, MINUTES_BLEND_GRID };
