/**
 * PROJECTION SANITY SETTING
 *
 * Whether slate reads (slateSource.loadSlatePlayers) apply the projection
 * sanity layer (services/projections/sanityLayer.js), first match wins:
 *   runtime  Lineup Studio toggle (PUT /api/projections/sanity), in memory
 *            until the server restarts
 *   env      PROJECTION_SANITY=on|off (also true/false, 1/0)
 *   default  DEFAULT_ENABLED, set from scripts/projection-sanity-report.js
 */

export const DEFAULT_ENABLED = false;

let runtime = null;

const parse = (v) => {
  if (v === undefined || v === null || v === '') return null;
  const s = String(v).trim().toLowerCase();
  if (['on', 'true', '1', 'yes'].includes(s)) return true;
  if (['off', 'false', '0', 'no'].includes(s)) return false;
  return null;
};

/** { enabled, source: 'runtime' | 'env' | 'default', default } */
export function projectionSanityStatus() {
  const fallback = parse(process.env.PROJECTION_SANITY) ?? DEFAULT_ENABLED;
  if (runtime !== null) return { enabled: runtime, source: 'runtime', default: fallback };
  const env = parse(process.env.PROJECTION_SANITY);
  if (env !== null) return { enabled: env, source: 'env', default: fallback };
  return { enabled: DEFAULT_ENABLED, source: 'default', default: fallback };
}

export const projectionSanityEnabled = () => projectionSanityStatus().enabled;

/** true / false: runtime override; null: back to env / default. */
export function setProjectionSanity(value) {
  runtime = value === null || value === undefined ? null : Boolean(value);
  return projectionSanityStatus();
}

export default { projectionSanityEnabled, projectionSanityStatus, setProjectionSanity, DEFAULT_ENABLED };
