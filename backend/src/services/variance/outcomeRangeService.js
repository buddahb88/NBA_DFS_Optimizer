/**
 * Floor / ceiling / std_dev / volatility / boom / bust for slate players, from
 * historical_games game logs (see outcomeDistribution.js for the model).
 *
 * Used by the RotoWire sync, the projection recalculation routes and salary
 * imports, so every writer of these columns shares one definition. Only box
 * scores from before each player's game date are read (no lookahead when a
 * slate is recomputed after its games were played).
 */

import db from '../../config/database.js';
import { fantasyPointsColumn } from '../scoring.js';
import { playerKey } from '../../utils/playerKey.js';
import { DEFAULT_SITE } from '../../config/sites.js';
import { playerGameDate, rotowireGameDate, slateGameDate } from '../slateSnapshotService.js';
import {
  GAME_WINDOW,
  computeOutcomeRange,
  positionGroup,
  priorFor,
  shrinkProfile,
  summarizeGameLog
} from './outcomeDistribution.js';

const DATABASE_TYPE = process.env.DATABASE_TYPE || 'sqlite';
// Azure SQL caps parameters at 2100
const CHUNK = 500;

/**
 * GPP leverage: boom% / (ownership% + 1), so 30% boom at 5% owned = 5.
 * (The old sync multiplied the already-percent boom by 100 again; that only
 * looked sane while boom was ~0 for everyone.)
 */
export function leverageScore(boomProbability, ownership) {
  return (Number(boomProbability) || 0) / ((Number(ownership) || 0) + 1);
}

/**
 * Recent regular-season games (minutes > 0) before `beforeDate`, most recent first.
 * @returns {Promise<Map<string, {game_date:string, minutes:number, fp:number}[]>>}
 */
export async function loadGameLogs(keys, { site = DEFAULT_SITE, beforeDate, window = GAME_WINDOW } = {}) {
  const col = fantasyPointsColumn(site);
  const wanted = [...new Set(keys.filter(Boolean))];
  const logs = new Map();
  for (let i = 0; i < wanted.length; i += CHUNK) {
    const chunk = wanted.slice(i, i + CHUNK);
    const rows = await db.all(
      `SELECT player_key, game_date, minutes, ${col} AS fp
       FROM historical_games
       WHERE player_key IN (${chunk.map(() => '?').join(', ')})
         AND season_type = 'regular' AND minutes > 0 AND ${col} IS NOT NULL
         AND game_date < ?
       ORDER BY game_date DESC`,
      ...chunk, beforeDate
    );
    for (const r of rows) {
      let list = logs.get(r.player_key);
      if (!list) logs.set(r.player_key, (list = []));
      // Window per player (beforeDate is the latest game date among the players asked for)
      list.push({ game_date: r.game_date, minutes: Number(r.minutes), fp: Number(r.fp) });
    }
  }
  return logs;
}

/**
 * Range metrics for one player.
 * @param {{ name, position, salary, projection, minutes, blowoutRisk, gameDate }} p
 */
export function rangeForPlayer(p, logs, { window = GAME_WINDOW } = {}) {
  const games = (logs.get(playerKey(p.name)) || [])
    .filter((g) => !p.gameDate || g.game_date < p.gameDate)
    .slice(0, window);
  const profile = shrinkProfile(summarizeGameLog(games), priorFor(positionGroup(p.position), p.minutes));
  return computeOutcomeRange({
    projection: p.projection,
    minutes: p.minutes,
    salary: p.salary,
    profile,
    blowoutRisk: p.blowoutRisk
  });
}

async function rangesFor(inputs, site) {
  const latest = inputs.reduce((max, p) => (p.gameDate > max ? p.gameDate : max), '');
  const logs = await loadGameLogs(inputs.map((p) => playerKey(p.name)), { site, beforeDate: latest });
  return inputs.map((p) => rangeForPlayer(p, logs));
}

/**
 * Set floor/ceiling/stdDev/volatility/boomProbability/bustProbability/leverageScore
 * on transformed RotoWire players (camelCase objects, before they are stored).
 */
export async function applyRangesToPlayers(players, { site = DEFAULT_SITE, now = new Date() } = {}) {
  const inputs = players.map((p) => ({
    name: p.name,
    position: p.position,
    salary: p.salary,
    projection: p.projectedPoints,
    minutes: p.projectedMinutes,
    blowoutRisk: p.blowoutRisk,
    gameDate: rotowireGameDate(p.rawData) ?? slateGameDate(null, now)
  }));
  const ranges = await rangesFor(inputs, site);
  players.forEach((p, i) => {
    Object.assign(p, ranges[i]);
    p.leverageScore = leverageScore(ranges[i].boomProbability, p.rostership);
  });
  return players;
}

/**
 * Recompute and store the range columns for every player on a slate from its
 * current projected_points / projected_minutes / salary.
 * @returns {Promise<number>} rows updated
 */
export async function recomputeSlateRanges(slateId, { now = new Date() } = {}) {
  const slate = await db.get(`SELECT site, start_time FROM slates WHERE slate_id = ?`, String(slateId));
  const site = slate?.site || DEFAULT_SITE;
  const rows = await db.all(
    `SELECT id, name, position, salary, projected_points, projected_minutes, rostership, blowout_risk, raw_data
     FROM players WHERE slate_id = ?`,
    String(slateId)
  );
  if (!rows.length) return 0;

  const inputs = rows.map((r) => ({
    name: r.name,
    position: r.position,
    salary: r.salary,
    projection: r.projected_points,
    minutes: r.projected_minutes,
    blowoutRisk: r.blowout_risk,
    gameDate: playerGameDate(r, slate?.start_time, now)
  }));
  const ranges = await rangesFor(inputs, site);

  const now_ = DATABASE_TYPE === 'azuresql' ? 'GETDATE()' : 'CURRENT_TIMESTAMP';
  const sql = `UPDATE players SET floor = ?, ceiling = ?, std_dev = ?, volatility = ?,
      boom_probability = ?, bust_probability = ?, leverage_score = ?, updated_at = ${now_}
    WHERE id = ?`;
  const params = rows.map((r, i) => {
    const x = ranges[i];
    return [x.floor, x.ceiling, x.stdDev, x.volatility, x.boomProbability, x.bustProbability,
      leverageScore(x.boomProbability, r.rostership), r.id];
  });

  if (DATABASE_TYPE === 'azuresql') {
    for (const p of params) await db.run(sql, ...p);
  } else {
    db.transaction((list) => { for (const p of list) db.run(sql, ...p); })(params);
  }
  return rows.length;
}

export default { loadGameLogs, rangeForPlayer, applyRangesToPlayers, recomputeSlateRanges, leverageScore };
