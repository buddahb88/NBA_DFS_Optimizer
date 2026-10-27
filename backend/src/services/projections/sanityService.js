/**
 * PROJECTION SANITY SERVICE
 *
 * Applies sanityLayer.js to slate players (live or a backtest night). The
 * own rate is O3's (opportunity/metricsService.computeHistory: blended FPPM
 * from games before the slate date only, the slate's Vegas environment and
 * pre-lock teammate outs), so a backtest sees what was known that morning.
 *
 * Computed on read: nothing is written. Each adjusted player keeps the posted
 * value (projection_raw / projected_minutes_raw) and carries
 * projection_adjustment, projection_reasons and projection_sanity = true;
 * value, floor and ceiling scale with the projection. rotowire_projection is
 * left as stored.
 *
 * The history is cached per slate + date + site + player set (as the
 * Opportunity Radar's); clearSanityCache() after new box scores load.
 */

import { easternDate } from '../slateSnapshotService.js';
import { playerKey, canonicalTeam } from '../../utils/playerKey.js';
import { environmentFactor, teammateFactor } from '../opportunity/rateProjection.js';
import { gameEnvironment } from '../opportunity/teamContext.js';
import { SANITY_CONFIG, applySanity } from './sanityLayer.js';
import { projectionSanityConfig } from '../../config/projectionSanity.js';

const CACHE_LIMIT = 50;
const cache = new Map();

const keyOf = (p) => p.player_key ?? playerKey(p.name);
const round = (x, digits = 2) => (Number.isFinite(x) ? Number(x.toFixed(digits)) + 0 : x);
const signature = (players) =>
  players.map(p => `${keyOf(p)}|${p.salary}|${p.injury_status ?? ''}`).sort().join(',');
const cacheKey = (source, now) => `${source.slateId}|${source.slateDate ?? easternDate(now)}|${source.site}`;

/**
 * History for the slate (computeHistory), cached.
 * players: the slate's projected players; all: every slate player (outs).
 */
export async function slateHistory(source, players, { all = players, now = new Date() } = {}) {
  const key = cacheKey(source, now);
  const sig = signature(players);
  const hit = cache.get(key);
  if (hit && hit.signature === sig) return hit.history;
  // Imported late: metricsService reads slates through slateSource, which applies this layer
  const { computeHistory } = await import('../opportunity/metricsService.js');
  const history = await computeHistory(source, players, { now, all });
  cache.delete(key);
  cache.set(key, { signature: sig, history });
  while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
  return history;
}

/** A player's own rate FPPM (O3 blend x environment x teammate) and its L10 minutes sample. */
export function ownRate(player, history) {
  const entry = history?.players.get(keyOf(player));
  if (!entry?.fppm || entry.fppm.fppm === null) return { ownFppm: null, sampleMinutes: 0 };
  const team = history.teams.get(canonicalTeam(player.team)) ?? null;
  const opp = history.teams.get(canonicalTeam(player.opponent)) ?? null;
  const env = gameEnvironment(player, team, opp);
  const envFactor = environmentFactor({ impliedTotal: env.implied_total, paceProxy: env.pace_proxy, leaguePace: history.leaguePace }).factor;
  const mate = teammateFactor(entry.adjusted).factor;
  return { ownFppm: entry.fppm.fppm * envFactor * mate, sampleMinutes: entry.fppm.l10_minutes };
}

const scaled = (v, ratio) => (v === null || v === undefined || !Number.isFinite(Number(v)) ? v : round(Number(v) * ratio));

/** One player with the layer applied (fields above). */
export function adjustPlayer(player, history, config = SANITY_CONFIG) {
  const { ownFppm, sampleMinutes } = ownRate(player, history);
  const r = applySanity({
    projectedPoints: player.projected_points,
    projectedMinutes: player.projected_minutes,
    spread: player.vegas_spread,
    ownFppm,
    sampleMinutes
  }, config);
  const fields = {
    projection_raw: player.projected_points,
    projected_minutes_raw: player.projected_minutes,
    projection_adjustment: round(r.adjustment),
    projection_own_fppm: ownFppm === null ? null : round(ownFppm, 3),
    projection_reasons: r.reasons.map(x => x.text),
    projection_sanity: true
  };
  // Unadjusted: every number exactly as posted
  if (r.reasons.length === 0) return { ...player, ...fields, projection_adjustment: 0 };
  const ratio = r.raw_projection > 0 ? r.projection / r.raw_projection : 1;
  return {
    ...player,
    projected_points: round(r.projection),
    projected_minutes: round(r.minutes, 1),
    value: scaled(player.value, ratio),
    floor: scaled(player.floor, ratio),
    ceiling: scaled(player.ceiling, ratio),
    ...fields
  };
}

/**
 * The layer over `players` (any subset of the slate). projected: the slate's
 * projected players (the cached history's set); all: every slate player.
 * config: defaults to the setting's components (config/projectionSanity.js);
 * the game-log history is only loaded when the FPPM shrink is on.
 */
export async function applyProjectionSanity(source, players, { projected, all, now = new Date(), config = projectionSanityConfig() } = {}) {
  if (!source || players.length === 0) return players;
  const pool = (projected ?? players).filter(p => Number(p.projected_points) > 0);
  if (pool.length === 0) return players;
  const history = config.fppm.enabled === false ? null : await slateHistory(source, pool, { all: all ?? players, now });
  return players.map(p => (Number(p.projected_points) > 0 ? adjustPlayer(p, history, config) : p));
}

/** Drop cached histories (new box scores change every slate on or after them). */
export function clearSanityCache() {
  cache.clear();
}

export default { applyProjectionSanity, adjustPlayer, ownRate, slateHistory, clearSanityCache };
