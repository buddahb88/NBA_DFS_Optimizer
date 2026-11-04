/**
 * MINUTES UPSIDE SIGNAL (Q2). Pure.
 *
 * A 0-100 score for "this player can play well above our minutes tonight", the
 * nights that win slates (14 saved DK main slates: cheap players beating our
 * minutes by 8+ hit 6x value 54% of the time vs 18% of all cheap players).
 * Weighted components, each 0..1:
 *
 *   gap         RotoWire minutes above our conditional minutes (UNcorrected),
 *               full at GAP_FULL minutes                         weight 60
 *   volatility  our minutes sd above VOL_FLOOR, full at VOL_FLOOR + VOL_SPAN  15
 *   teammate    a teammate projected TEAMMATE_MINUTES+ is OUT          10
 *   role        recent starts above earlier ones (rates_v1 role_shift),
 *               full at ROLE_FULL                                   15
 *
 * The gap carries the signal: on the 14 slates it alone separated minutes
 * spikes (actual >= ours + 8) with AUC ~0.65; the other three are near 0.5 on
 * their own and stay as small, explainable nudges (npm run
 * backtest:minutes-correction reports the score vs the gap alone).
 */

export const WEIGHTS = Object.freeze({ gap: 60, volatility: 15, teammate: 10, role: 15 });
export const GAP_FULL = 8;
export const VOL_FLOOR = 4;
export const VOL_SPAN = 6;
export const ROLE_FULL = 0.67;
export const TEAMMATE_MINUTES = 20;
export const SPIKE_MINUTES = 8;
export const HIGH_UPSIDE = 50;

const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const unit = (v) => (finite(v) ? Math.max(0, Math.min(1, v)) : 0);

/**
 * Score of one player. x: { gap (RotoWire - our conditional minutes, null
 * without RotoWire), sigma (our conditional minutes sd), teammateOut (bool),
 * roleShift, out (bool) }. Returns { score (0-100 integer), components:
 * { gap, volatility, teammate, role } (0..1), reasons: [short strings] }.
 */
export function minutesUpside({ gap = null, sigma = null, teammateOut = false, roleShift = 0, out = false } = {}) {
  if (out) return { score: 0, components: { gap: 0, volatility: 0, teammate: 0, role: 0 }, reasons: [] };
  const components = {
    gap: unit(gap / GAP_FULL),
    volatility: unit((sigma - VOL_FLOOR) / VOL_SPAN),
    teammate: teammateOut ? 1 : 0,
    role: unit(roleShift / ROLE_FULL)
  };
  const score = Math.round(Object.entries(WEIGHTS).reduce((s, [k, w]) => s + w * components[k], 0));
  const reasons = [];
  if (components.gap > 0 && gap >= 1) reasons.push(`RotoWire +${gap.toFixed(1)} min`);
  if (components.volatility >= 0.5) reasons.push('volatile minutes');
  if (teammateOut) reasons.push('teammate out');
  if (components.role >= 0.5) reasons.push('moving into the starting five');
  return { score, components, reasons };
}

export default { minutesUpside, WEIGHTS, GAP_FULL, VOL_FLOOR, VOL_SPAN, ROLE_FULL, TEAMMATE_MINUTES, SPIKE_MINUTES, HIGH_UPSIDE };
