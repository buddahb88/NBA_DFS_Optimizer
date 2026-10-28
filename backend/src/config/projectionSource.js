/**
 * PROJECTION SOURCE SETTING
 *
 * Which projection slate reads (slateSource.loadSlatePlayers) hand to every
 * consumer - optimizer, portfolio, chat / agent tools, radar, player tables:
 *   rotowire  RotoWire after the sanity layer (the app before M5, unchanged)
 *   ours      our model's DK mean incl. DNP (ownModelService, ours_mean)
 *   blend     the M4 blend of the two (blend_point; ownModelWeights.json)
 * First match wins:
 *   runtime  Lineup Studio control / PUT /api/projections/source, in memory
 *            until the server restarts
 *   env      PROJECTION_SOURCE = rotowire | ours | blend
 *   default  DEFAULT_SOURCE
 *
 * DEFAULT_SOURCE is the blend: on the 8 saved main slates (M4, leave-one-
 * slate-out) blend_points_salaryTier had MAE 7.61 incl. DNP vs RotoWire
 * adjusted 7.71 (CI excludes 0), best on 6 of 8 slates, and the best average
 * GPP portfolio; RotoWire kept the best cash lineup (2075.8 vs 2043.3), so it
 * stays one click away.
 */

export const SOURCES = Object.freeze(['rotowire', 'ours', 'blend']);
export const DEFAULT_SOURCE = 'blend';
const ENV = 'PROJECTION_SOURCE';

let runtime = null;

/** A valid source name (case-insensitive) or null. */
export const parseSource = (v) => {
  if (v === undefined || v === null || v === '') return null;
  const s = String(v).trim().toLowerCase();
  return SOURCES.includes(s) ? s : null;
};

const fallback = () => parseSource(process.env[ENV]) ?? DEFAULT_SOURCE;

/** The active source. */
export const projectionSource = () => runtime ?? fallback();

/** { source, origin: 'runtime' | 'env' | 'default', default, options } - default is what a reset returns to. */
export function projectionSourceStatus() {
  const origin = runtime !== null ? 'runtime' : parseSource(process.env[ENV]) !== null ? 'env' : 'default';
  return { source: projectionSource(), origin, default: fallback(), options: [...SOURCES] };
}

/** A source name: runtime override; null: back to env / default. Throws on an unknown name. */
export function setProjectionSource(value) {
  if (value === null || value === undefined) {
    runtime = null;
  } else {
    const s = parseSource(value);
    if (!s) throw new Error(`source must be one of: ${SOURCES.join(', ')}`);
    runtime = s;
  }
  return projectionSourceStatus();
}

export default { SOURCES, DEFAULT_SOURCE, parseSource, projectionSource, projectionSourceStatus, setProjectionSource };
