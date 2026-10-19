/**
 * MINUTES PROJECTION SERVICE
 *
 * Database side of the minutes x FPPM model (the math lives in minutesModel.js):
 *   - loads prior box scores from historical_games and scores them for the site
 *   - reads OUT statuses and manual overrides for the slate
 *   - blends the model into the existing projection results
 */

import db from '../config/database.js';
import projectionOverrideModel from '../models/projectionOverrideModel.js';
import { computeFantasyPoints } from './scoring.js';
import {
  DEFAULT_MINUTES_CONFIG,
  blendProjection,
  isOutStatus,
  projectPlayers,
  resolveConfig
} from './minutesModel.js';

const HISTORY_LOOKBACK_DAYS = 200;

const round1 = (v) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : null);

export const toDateString = (v) => {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
};

const addDays = (dateStr, days) => {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

const localToday = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/**
 * Blend weight from (in order) the request, PROJECTION_MINUTES_WEIGHT, the default.
 */
export function resolveBlendWeight(requested) {
  const candidates = [requested, process.env.PROJECTION_MINUTES_WEIGHT];
  for (const c of candidates) {
    if (c === null || c === undefined || c === '') continue;
    const n = Number(c);
    if (Number.isFinite(n)) return Math.max(0, Math.min(1, n));
  }
  return DEFAULT_MINUTES_CONFIG.blendWeight;
}

/**
 * Turn historical_games rows into model game logs scored for the site.
 */
export function toGameLogs(rows, site) {
  return rows.map(r => ({
    name: r.player_name,
    team: r.team,
    opponent: r.opponent,
    gameId: r.game_id,
    date: toDateString(r.game_date),
    minutes: Number(r.minutes) || 0,
    fp: computeFantasyPoints(r, site),
    isB2B: r.is_back_to_back === 1 || r.is_back_to_back === true
  }));
}

export const HISTORY_COLUMNS = `player_name, team, opponent, game_id, game_date, minutes,
  points, rebounds, assists, steals, blocks, turnovers, fg3_made, is_back_to_back`;

/**
 * Prior box scores (strictly before the slate date) as model game logs.
 */
export async function loadHistory({ beforeDate = null, site = 'draftkings', lookbackDays = HISTORY_LOOKBACK_DAYS } = {}) {
  const before = beforeDate || localToday();
  const rows = await db.all(`
    SELECT ${HISTORY_COLUMNS}
    FROM historical_games
    WHERE game_date < ? AND game_date >= ? AND minutes > 0
  `, before, addDays(before, -lookbackDays));
  return toGameLogs(rows, site);
}

function parseRaw(raw) {
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function loadInjuryStatuses(slateId) {
  const rows = await db.all(`
    SELECT player_id, injury_status, raw_data FROM players WHERE slate_id = ?
  `, String(slateId));
  const statuses = new Map();
  for (const r of rows) {
    statuses.set(String(r.player_id), r.injury_status ?? parseRaw(r.raw_data)?.injuryStatus ?? null);
  }
  return statuses;
}

/**
 * Add the minutes model to projection results (from calculateSlateEnhancedProjections).
 *
 * Each result keeps every existing field. enhanced_projection becomes the
 * final number; legacy_projection holds the pre-blend value and
 * minutes_model the breakdown.
 *
 * @param {Array} results - player rows merged with their projection result
 * @param {Object} options - { slateId, slateDate, site, minutesWeight, config }
 */
export async function applyMinutesModel(results, options = {}) {
  const { slateId = null, slateDate = null, site = 'draftkings', minutesWeight = null } = options;
  const config = resolveConfig(options.config);
  const weight = resolveBlendWeight(minutesWeight);

  const [history, statuses, overrides] = await Promise.all([
    loadHistory({ beforeDate: slateDate, site }),
    slateId ? loadInjuryStatuses(slateId) : Promise.resolve(new Map()),
    slateId ? projectionOverrideModel.getBySlate(slateId) : Promise.resolve([])
  ]);
  const overrideById = new Map(overrides.map(o => [o.player_id, o]));

  const modelInput = results.map(r => {
    const id = String(r.player_id ?? r.id);
    const status = statuses.has(id) ? statuses.get(id) : r.injury_status;
    const override = overrideById.get(id);
    return {
      id,
      name: r.name,
      team: r.team,
      opponent: r.opponent,
      isB2B: r.rest_days === 0,
      spread: r.vegas_spread,
      impliedTotal: r.vegas_implied_total,
      rotowireMinutes: r.projected_minutes,
      out: isOutStatus(status),
      override: override ? { minutes: override.minutes ?? undefined, points: override.points ?? undefined } : null
    };
  });

  const model = projectPlayers(modelInput, history, { config });

  let blended = 0, outCount = 0, overridden = 0, redistributed = 0;
  const output = results.map((r, i) => {
    const id = modelInput[i].id;
    const m = model.get(id);
    const legacy = r.enhanced_projection ?? r.adjusted_projection ?? r.rotowire_projection ?? r.projected_points ?? 0;

    let final = legacy;
    let source = 'legacy';
    if (m.overridePoints !== null) {
      final = m.overridePoints;
      source = 'override_points';
    } else if (m.out) {
      final = 0;
      source = 'out';
    } else if (m.overrideMinutes !== null && m.points !== null) {
      final = m.points;
      source = 'override_minutes';
    } else if (m.points !== null && weight > 0) {
      final = blendProjection(m.points, legacy, weight);
      source = 'blend';
    }

    if (source === 'blend') blended++;
    if (source === 'out') outCount++;
    if (source.startsWith('override')) overridden++;
    if (m.injury) redistributed++;

    return {
      ...r,
      enhanced_projection: round1(final),
      legacy_projection: round1(legacy),
      minutes_model: {
        source,
        weight,
        projection: round1(m.points),
        minutes: round1(m.minutes),
        base_minutes: round1(m.baseMinutes),
        fppm: m.fppm !== null ? Math.round(m.fppm * 1000) / 1000 : null,
        role: m.role,
        out: m.out,
        games: m.games,
        minutes_breakdown: m.minutesBreakdown,
        fppm_breakdown: m.fppmBreakdown,
        injury: m.injury
          ? { added_minutes: round1(m.injury.addedMinutes), fppm_multiplier: Math.round(m.injury.fppmMultiplier * 1000) / 1000, sources: m.injury.sources }
          : null,
        override: overrideById.get(id) || null
      }
    };
  });

  console.log(`⏱️  Minutes model (weight ${weight}): ${blended} blended, ${outCount} OUT, ${redistributed} got injury minutes, ${overridden} overridden`);
  return output;
}

export default { applyMinutesModel, loadHistory, resolveBlendWeight };
