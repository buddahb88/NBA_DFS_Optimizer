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
 *
 * No outcome enters: everything comes from featureStore.asOf (rows before the
 * date) and the slate's pre-lock fields.
 */

import { getSiteConfig } from '../../config/sites.js';
import { conditionalMean, createRatesV1Projector, predictPlayer, projectRates, seedOf } from './ratesV1.js';
import { projectDate as projectMinutes } from './minutesV2.js';

export const QUANTILE_LEVELS = Object.freeze(Array.from({ length: 101 }, (_, i) => i / 100));
export const MINUTES_BLEND_GRID = Object.freeze(Array.from({ length: 11 }, (_, i) => i / 10));

const finite = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * Prediction of one player from the date's rates / minutes maps.
 * ctx: harness ctx ({ mode, date, site, player, slate }); maps: { rates, minutes };
 * models: { rates, minutes } (fitted). Returns null when either model has no row.
 */
export function ownPrediction(ctx, maps, models, { minutesGrid = MINUTES_BLEND_GRID } = {}) {
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
      ...(rwMinutes !== null ? { minutes_blend_means: minutesGrid.map(() => 0) } : {})
    };
  }
  const k = `${player.key}|${player.team}`;
  const r = maps.rates.get(k);
  const m = maps.minutes.get(k);
  if (!r || !m) return null;
  const seed = seedOf(`${date}|${player.key}`);
  const minutes = { kind: 'mixture', pPlay: m.p_play, cond: m.conditional_minutes, sigma: m.sigma, zMinutes: models.minutes?.zMinutes ?? null, point: m.minutes };
  const pred = predictPlayer(r.rates, models.rates, minutes, { seed, scoring, boomAt, typical: r.typical, quantiles: QUANTILE_LEVELS });
  const out = {
    dk_points: pred.dk_mean,
    ours_median: pred.dk_points,
    minutes: m.minutes,
    expected_minutes: m.expected_minutes,
    conditional_minutes: m.conditional_minutes,
    p_play: m.p_play,
    minutes_p10: m.minutes_p10,
    minutes_p90: m.minutes_p90,
    p10: pred.p10,
    p90: pred.p90,
    p_boom: pred.p_boom,
    boom_at: boomAt,
    p_dd: pred.p_dd,
    p_td: pred.p_td,
    dk_quantiles: pred.dk_quantiles,
    role_shift: r.features.roleShift ?? 0
  };
  if (rwMinutes !== null) {
    out.minutes_blend_means = minutesGrid.map(w => {
      if (w === 0) return pred.dk_mean;
      if (!(rwMinutes > 0)) return (1 - w) * pred.dk_mean;
      const cond = w * rwMinutes + (1 - w) * m.conditional_minutes;
      return m.p_play * conditionalMean(r.rates, models.rates, { cond, sigma: m.sigma, zMinutes: minutes.zMinutes }, { seed, scoring, typical: r.typical });
    });
  }
  return out;
}

/** The date's rates and minutes maps (rates_v1.projectRates, minutes_v2.projectDate). */
export function prepareOwnMaps(dateCtx, models) {
  return { rates: projectRates(dateCtx, models.rates), minutes: projectMinutes(dateCtx, models.minutes) };
}

/**
 * Harness projector. Options as createRatesV1Projector (params, minutesParams,
 * model, minutesModel); fit() fits both on the training window.
 */
export function createOwnModelProjector(options = {}) {
  const inner = createRatesV1Projector({ ...options, minutesSource: 'minutes_v2' });
  const models = () => ({ rates: inner.model(), minutes: inner.minutesModel() });
  const memoKey = `own_model|${JSON.stringify(options.params ?? {})}|${JSON.stringify(options.minutesParams ?? {})}`;
  return {
    fit: (args) => inner.fit(args),
    prepareDate(dateCtx) {
      if (!dateCtx.shared.has(memoKey)) dateCtx.shared.set(memoKey, prepareOwnMaps(dateCtx, models()));
    },
    project(ctx) {
      const maps = ctx.shared.get(memoKey);
      return maps ? ownPrediction(ctx, maps, models()) : null;
    },
    model: inner.model,
    minutesModel: inner.minutesModel
  };
}

export default { createOwnModelProjector, ownPrediction, prepareOwnMaps, QUANTILE_LEVELS, MINUTES_BLEND_GRID };
