/**
 * PROJECTION SANITY SETTING
 *
 * Whether slate reads (slateSource.loadSlatePlayers) apply the projection
 * sanity layer (services/projections/sanityLayer.js), and which parts.
 * First match wins, for the switch and for each component:
 *   runtime  Lineup Studio toggle / PUT /api/projections/sanity, in memory
 *            until the server restarts
 *   env      PROJECTION_SANITY, PROJECTION_SANITY_FPPM, PROJECTION_SANITY_BLOWOUT
 *            = on|off (also true/false, 1/0)
 *   default  DEFAULTS
 *
 * DEFAULTS come from scripts/projection-sanity-report.js on the saved main
 * slates (Oct 20-26 2026): the blowout trim lowered MAE (7.76 -> 7.72) and
 * did not hurt the optimizer's cash lineups (+1.3 actual points for the
 * 1-lineup, +13.4 for the top-5 average over 7 nights), so it is on. The
 * FPPM shrink lowered MAE too (-> 7.74) but cost the 1-lineup 25.3 points
 * (10/21: Hachimura, Curry, Allen swapped out), so it is off until more
 * slates say otherwise.
 */

import { SANITY_CONFIG } from '../services/projections/sanityLayer.js';

export const DEFAULTS = Object.freeze({ enabled: true, fppm: false, blowout: true });
export const DEFAULT_ENABLED = DEFAULTS.enabled;

const ENV = { enabled: 'PROJECTION_SANITY', fppm: 'PROJECTION_SANITY_FPPM', blowout: 'PROJECTION_SANITY_BLOWOUT' };
const COMPONENTS = ['fppm', 'blowout'];

const runtime = { enabled: null, fppm: null, blowout: null };

const parse = (v) => {
  if (v === undefined || v === null || v === '') return null;
  const s = String(v).trim().toLowerCase();
  if (['on', 'true', '1', 'yes'].includes(s)) return true;
  if (['off', 'false', '0', 'no'].includes(s)) return false;
  return null;
};

const fallback = (name) => parse(process.env[ENV[name]]) ?? DEFAULTS[name];
const resolve = (name) => runtime[name] ?? fallback(name);

/**
 * { enabled, source: 'runtime' | 'env' | 'default', default, components: { fppm, blowout },
 *   componentDefaults: { fppm, blowout } } - default(s) are what a reset returns to.
 */
export function projectionSanityStatus() {
  const source = runtime.enabled !== null ? 'runtime' : parse(process.env[ENV.enabled]) !== null ? 'env' : 'default';
  return {
    enabled: resolve('enabled'),
    source,
    default: fallback('enabled'),
    components: Object.fromEntries(COMPONENTS.map(c => [c, resolve(c)])),
    componentDefaults: Object.fromEntries(COMPONENTS.map(c => [c, fallback(c)]))
  };
}

export const projectionSanityEnabled = () => resolve('enabled');

/** SANITY_CONFIG with each component's enabled flag from the setting. */
export function projectionSanityConfig() {
  return {
    fppm: { ...SANITY_CONFIG.fppm, enabled: resolve('fppm') },
    blowout: { ...SANITY_CONFIG.blowout, enabled: resolve('blowout') }
  };
}

/** true / false: runtime override of the switch; null: back to env / default. */
export function setProjectionSanity(value) {
  runtime.enabled = value === null || value === undefined ? null : Boolean(value);
  return projectionSanityStatus();
}

/** { fppm, blowout } runtime overrides (a missing key is left alone, null resets it); null resets both. */
export function setProjectionSanityComponents(components) {
  for (const c of COMPONENTS) {
    if (components === null || components === undefined) runtime[c] = null;
    else if (c in components) runtime[c] = components[c] === null ? null : Boolean(components[c]);
  }
  return projectionSanityStatus();
}

export default {
  projectionSanityEnabled, projectionSanityStatus, projectionSanityConfig,
  setProjectionSanity, setProjectionSanityComponents, DEFAULTS
};
