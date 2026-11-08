/**
 * SNAPSHOT REST DAYS
 *
 * RotoWire backfilled slates (and a few live rows) have rest_days NULL: the
 * past-slate payload's stats block is the current season's, so it is dropped.
 * The schedule gives the same pre-game value without lookahead: days since
 * the player's previous game in historical_games, minus 1 (0 = back-to-back),
 * the convention historical_games.rest_days uses. A player with no earlier
 * game stays NULL. Only NULL rows are filled (idempotent); live-captured
 * values are left as RotoWire sent them.
 */

import db from '../config/database.js';

const dayNumber = (d) => Math.round(Date.parse(`${String(d).slice(0, 10)}T00:00:00Z`) / 86400000);

/** Rest days before gameDate given the player's earlier game dates (any order), else null. */
export function restDaysBefore(gameDate, priorDates) {
  const target = dayNumber(gameDate);
  let last = null;
  for (const d of priorDates) {
    const n = dayNumber(d);
    if (n < target && (last === null || n > last)) last = n;
  }
  return last === null ? null : target - last - 1;
}

/**
 * Fill rest_days where NULL. Options: { from, to } (game_date bounds), dryRun.
 * Returns { candidates, filled, noPriorGame }.
 */
export async function fillSnapshotRestDays({ from = null, to = null, dryRun = false } = {}) {
  const params = [];
  let where = 'rest_days IS NULL';
  if (from) { where += ' AND game_date >= ?'; params.push(from); }
  if (to) { where += ' AND game_date <= ?'; params.push(to); }
  const rows = await db.all(`SELECT id, player_key, game_date FROM slate_player_snapshots WHERE ${where}`, ...params);
  const keys = [...new Set(rows.map(r => r.player_key))];
  const dates = new Map();
  for (let i = 0; i < keys.length; i += 500) {
    const chunk = keys.slice(i, i + 500);
    const games = await db.all(`SELECT DISTINCT player_key, game_date FROM historical_games WHERE player_key IN (${chunk.map(() => '?').join(', ')})`, ...chunk);
    for (const g of games) {
      if (!dates.has(g.player_key)) dates.set(g.player_key, []);
      dates.get(g.player_key).push(String(g.game_date).slice(0, 10));
    }
  }
  let filled = 0;
  let noPriorGame = 0;
  for (const r of rows) {
    const rest = restDaysBefore(r.game_date, dates.get(r.player_key) ?? []);
    if (rest === null) { noPriorGame++; continue; }
    if (!dryRun) await db.run(`UPDATE slate_player_snapshots SET rest_days = ? WHERE id = ? AND rest_days IS NULL`, rest, r.id);
    filled++;
  }
  return { candidates: rows.length, filled, noPriorGame };
}

export default { restDaysBefore, fillSnapshotRestDays };
