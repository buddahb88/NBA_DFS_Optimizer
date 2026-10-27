/**
 * OPPORTUNITY RADAR CONFIG
 *
 * Every knob of the Opportunity Score (radarScore.js) in one place.
 *
 * Each component maps one O1-O3 metric onto 0..1 (0.5 = neutral) with a
 * linear ramp: `from` maps to 0, `to` maps to 1, clamped (from > to inverts
 * the ramp, e.g. lower ownership is better). The score is
 * 100 x Σ weight x component / Σ weight, with a missing metric at 0.5.
 *
 * Cash leans on projected minutes, stability, floor and hit rates at tonight's salary; GPP on
 * upside (ceiling), leverage vs ownership, vacated usage and environment.
 */

export const RADAR_MODES = ['cash', 'gpp'];

export const RADAR_WEIGHTS = Object.freeze({
  cash: Object.freeze({
    projMinutes: 0.12, minutes: 0.12, usage: 0.06, vacated: 0.09, gap: 0.11, hitRate: 0.15,
    stability: 0.15, floor: 0.10, environment: 0.07, upside: 0.03, leverage: 0
  }),
  gpp: Object.freeze({
    projMinutes: 0.08, minutes: 0.12, usage: 0.09, vacated: 0.11, gap: 0.09, hitRate: 0.08,
    stability: 0.03, floor: 0, environment: 0.08, upside: 0.16, leverage: 0.16
  })
});

export const RADAR_SCALES = Object.freeze({
  // Tonight's projected minutes (slate): the role the projection already sees
  projMinutes: { from: 10, to: 30 },
  // Minutes trend: 0.6 x (L3 - season) + 0.4 x (L5 - season), minutes
  minutes: { from: -6, to: 6, l3Weight: 0.6, intoLineupBonus: 0.1 },
  // Usage L5 - season (fraction of plays)
  usage: { from: -0.05, to: 0.05 },
  // O2: rise in the player's share of team plays with tonight's outs off the floor
  vacated: { from: -0.06, to: 0.06, thinWeight: 0.5 },
  // O3: (rate projection - posted) / posted
  gap: { from: -0.25, to: 0.25 },
  // Hit rate at tonight's salary over L10: 5x (cash) / 6x (gpp)
  hitRate: { cashMultiple: 5, gppMultiple: 6, fullGames: 10 },
  // Minutes SD over L10 (inverted), games under 20 min, starts in L5
  stability: { sdFrom: 8, sdTo: 2, sdWeight: 0.5, under20Weight: 0.25, startsWeight: 0.25 },
  // Slate floor / ceiling per $1K salary
  floor: { from: 3, to: 5.5 },
  upside: { from: 5, to: 9 },
  // Team implied total, less blowout / back-to-back penalties
  environment: { from: 108, to: 124, blowoutPenalty: 0.2, backToBackPenalty: 0.1 },
  // sqrt(value ramp x ownership ramp): good value nobody is on
  leverage: { valueFrom: 3.5, valueTo: 6.5, ownFrom: 35, ownTo: 0 },
  // Sample shrink: L3 / L5 windows shrink toward neutral under these games
  sampleGames: 3
});

/** Thresholds for the reason line (radarScore.reasonLine). */
export const RADAR_REASONS = Object.freeze({
  maxParts: 4,
  minutesDelta: 3,
  usageDelta: 0.03,
  absorbedPct: 0.1,
  rateGap: 3,
  hitRate: 0.6,
  impliedTotal: 118,
  starterStreakMax: 10
});

export const RADAR_CONFIG = Object.freeze({ weights: RADAR_WEIGHTS, scales: RADAR_SCALES, reasons: RADAR_REASONS });

export default RADAR_CONFIG;
