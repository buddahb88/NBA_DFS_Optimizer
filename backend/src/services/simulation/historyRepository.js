/**
 * historical_games access for the simulation engine.
 */

import db from '../../config/database.js';
import { summarize, normalizeName } from './variance.js';

export const HIST_GAMES_WINDOW = 40;
export const MIN_HIST_MINUTES = 10;

/**
 * Load recent DK fantasy point history for the given player names.
 * Names are matched accent/suffix-insensitively ("Luka Doncic" -> "Luka Dončić").
 * Works on both sqlite and azuresql (positional ? params are converted by the db wrapper).
 * beforeDate (YYYY-MM-DD): only games before it (a backtest must not see its own night).
 * @returns {Promise<Map<string, {n:number, mean:number, sd:number}>>} keyed by the requested name
 */
export async function fetchHistoricalStats(playerNames, { window = HIST_GAMES_WINDOW, beforeDate = null } = {}) {
  const requested = [...new Set(playerNames.filter(Boolean))];
  const stats = new Map();
  if (requested.length === 0) return stats;

  // Resolve slate names to the spelling stored in historical_games
  const wanted = new Map(requested.map((n) => [normalizeName(n), n]));
  const histToRequested = new Map();
  const distinct = await db.all(`SELECT DISTINCT player_name FROM historical_games`);
  for (const { player_name: histName } of distinct) {
    const req = wanted.get(normalizeName(histName));
    if (req) histToRequested.set(histName, req);
  }
  const names = [...histToRequested.keys()];
  if (names.length === 0) return stats;

  // Azure SQL caps parameters at 2100; chunk to stay well under it.
  const CHUNK = 500;
  const byName = new Map();
  for (let i = 0; i < names.length; i += CHUNK) {
    const chunk = names.slice(i, i + CHUNK);
    const placeholders = chunk.map(() => '?').join(', ');
    const rows = await db.all(
      `SELECT player_name, dk_fantasy_points
       FROM historical_games
       WHERE player_name IN (${placeholders})
         AND dk_fantasy_points IS NOT NULL
         AND minutes >= ${MIN_HIST_MINUTES}
         ${beforeDate ? 'AND game_date < ?' : ''}
       ORDER BY game_date DESC`,
      ...chunk, ...(beforeDate ? [beforeDate] : [])
    );
    for (const row of rows) {
      let list = byName.get(row.player_name);
      if (!list) byName.set(row.player_name, (list = []));
      if (list.length < window) list.push(Number(row.dk_fantasy_points));
    }
  }

  for (const [histName, values] of byName) {
    stats.set(histToRequested.get(histName), summarize(values));
  }
  return stats;
}
