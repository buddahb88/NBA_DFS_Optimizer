/**
 * Outcome-model ranges for saved slates (slate_player_snapshots), so a
 * backtest can use the current floor / ceiling / boom / bust model instead of
 * whatever the slate had before lock. Inputs are the saved pre-lock
 * projection, minutes and salary; game logs are read strictly before the
 * slate date (loadGameLogs beforeDate), so nothing from that night or later
 * leaks in. Results go to the *_model columns (config/snapshotMigrations.js
 * RANGE_MODEL_COLUMNS); the pre-lock columns are never written.
 */

import db from '../../config/database.js';
import { DEFAULT_SITE } from '../../config/sites.js';
import { playerKey } from '../../utils/playerKey.js';
import { CALIBRATION, CEILING_PCTL, FLOOR_PCTL, GAME_WINDOW } from './outcomeDistribution.js';
import { leverageScore, loadGameLogs, rangeForPlayer } from './outcomeRangeService.js';

const DATABASE_TYPE = process.env.DATABASE_TYPE || 'sqlite';

/** Identifies the model settings a stored range was computed with. */
export const RANGE_MODEL_VERSION =
  `outcome-v1:w${GAME_WINDOW}:p${FLOOR_PCTL * 100}-${CEILING_PCTL * 100}:k${CALIBRATION.kappaScale}:m${CALIBRATION.minutesScale}`;

const toDateStr = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));

/**
 * Recompute model ranges for every snapshot row of one game date.
 * Options: { site, slateId, now } narrow the rows / stamp range_model_at.
 * @returns {Promise<{gameDate, rows, version}>}
 */
export async function recomputeSnapshotRanges(gameDate, { site = null, slateId = null, now = new Date() } = {}) {
  let sql = `SELECT id, site, player_name, position, salary, projected_points, projected_minutes, blowout_risk, rostership
    FROM slate_player_snapshots WHERE game_date = ?`;
  const params = [gameDate];
  if (site) { sql += ' AND site = ?'; params.push(site); }
  if (slateId) { sql += ' AND slate_id = ?'; params.push(String(slateId)); }
  const rows = await db.all(sql, ...params);
  if (!rows.length) return { gameDate, rows: 0, version: RANGE_MODEL_VERSION };

  const stamp = now.toISOString();
  const updates = [];
  const bySite = new Map();
  for (const r of rows) {
    const key = r.site || DEFAULT_SITE;
    if (!bySite.has(key)) bySite.set(key, []);
    bySite.get(key).push(r);
  }
  for (const [siteKey, list] of bySite) {
    // Strictly before the slate date: no box score from that night or later
    const logs = await loadGameLogs(list.map((r) => playerKey(r.player_name)), { site: siteKey, beforeDate: toDateStr(gameDate) });
    for (const r of list) {
      const x = rangeForPlayer({
        name: r.player_name,
        position: r.position,
        salary: r.salary,
        projection: r.projected_points,
        minutes: r.projected_minutes,
        blowoutRisk: r.blowout_risk,
        gameDate: toDateStr(gameDate)
      }, logs);
      updates.push([x.floor, x.ceiling, x.stdDev, x.volatility, x.boomProbability, x.bustProbability,
        leverageScore(x.boomProbability, r.rostership), RANGE_MODEL_VERSION, stamp, r.id]);
    }
  }

  const update = `UPDATE slate_player_snapshots SET floor_model = ?, ceiling_model = ?, std_dev_model = ?,
      volatility_model = ?, boom_model = ?, bust_model = ?, leverage_model = ?, range_model_version = ?, range_model_at = ?
    WHERE id = ?`;
  if (DATABASE_TYPE === 'azuresql') {
    for (const u of updates) await db.run(update, ...u);
  } else {
    db.transaction((list) => { for (const u of list) db.run(update, ...u); })(updates);
  }
  return { gameDate: toDateStr(gameDate), rows: updates.length, version: RANGE_MODEL_VERSION };
}

export default { recomputeSnapshotRanges, RANGE_MODEL_VERSION };
