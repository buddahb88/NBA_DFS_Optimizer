/**
 * RESULTS SERVICE
 *
 * Scores what each slate looked like before lock (slate_player_snapshots)
 * against what happened (historical_games), joined on (player_key, game_date).
 *
 * Per player: projection error, minutes error, actual DK/FD/Yahoo points,
 * value multiple (site points per $1k of salary) and 3x/5x/6x hits.
 * Snapshot players missing from the box score are classified:
 *   PLAYED    box score row with minutes > 0
 *   DNP       game_player_status DNP, or listed with 0 minutes
 *   INACTIVE  game_player_status INACTIVE, or the team's game is in the box
 *             scores but the player is not
 *   PENDING   no box score for the team on that date yet
 * Errors, values and hit rates only count PLAYED rows; aggregates report the
 * DNP / INACTIVE / PENDING counts alongside.
 *
 * Aggregates (overall, by salary tier, position and date) are per site, since
 * salary scales differ; tiers come from SALARY_TIERS_BY_SITE. When no slateId
 * is given, a player on several slates of the same site and date is scored
 * once, from the most recent snapshot.
 */

import db from '../config/database.js';
import { DEFAULT_SITE, getSiteConfig } from '../config/sites.js';
import { SITE_POINTS_COLUMNS } from './scoring.js';
import { canonicalTeam } from '../utils/playerKey.js';
import {
  computeErrorMetrics, salaryTier, salaryTiers, basePositions, DK_POSITIONS
} from './projectionBacktestService.js';

export const RESULT_STATUSES = ['PLAYED', 'DNP', 'INACTIVE', 'PENDING'];
export const VALUE_MULTIPLES = [3, 5, 6];

const round = (v, d = 3) => (v === null || v === undefined || !Number.isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d);

const toNum = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// Azure SQL returns DATE columns as Date objects (UTC midnight)
const toDateStr = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : v ? String(v).slice(0, 10) : null);

const toTime = (v) => {
  const t = v instanceof Date ? v.getTime() : Date.parse(v);
  return Number.isFinite(t) ? t : 0;
};

/**
 * Status of a snapshot player given what the box scores say.
 * @param {Object} box - { minutes, hasRow, boxStatus, boxReason, teamInBox }
 */
export function classifyResult({ minutes = null, hasRow = false, boxStatus = null, boxReason = null, teamInBox = false }) {
  if (hasRow && minutes !== null && minutes > 0) return { status: 'PLAYED', reason: null };
  if (boxStatus === 'DNP' || boxStatus === 'INACTIVE') return { status: boxStatus, reason: boxReason || null };
  if (hasRow) return { status: 'DNP', reason: '0 minutes' };
  if (teamInBox) return { status: 'INACTIVE', reason: 'Not in box score' };
  return { status: 'PENDING', reason: null };
}

/**
 * One result row from a joined snapshot row (see loadJoinedRows).
 */
export function buildResultRow(row, { teamsInBox = new Set() } = {}) {
  const site = row.site;
  const gameDate = toDateStr(row.game_date);
  const minutes = toNum(row.actual_minutes);
  const { status, reason } = classifyResult({
    minutes,
    hasRow: row.has_box_row === 1 || row.has_box_row === true,
    boxStatus: row.box_status,
    boxReason: row.box_reason,
    teamInBox: teamsInBox.has(`${canonicalTeam(row.team)}|${gameDate}`)
  });
  const played = status === 'PLAYED';

  const actualPoints = {};
  for (const [s, column] of Object.entries(SITE_POINTS_COLUMNS)) {
    actualPoints[s] = played ? toNum(row[column]) : null;
  }
  const actual = actualPoints[site] ?? null;
  const salary = toNum(row.salary);
  const projected = toNum(row.projected_points);
  const projectedMinutes = toNum(row.projected_minutes);
  const value = actual !== null && salary > 0 ? actual / (salary / 1000) : null;

  const hits = {};
  for (const m of VALUE_MULTIPLES) {
    hits[`${m}x`] = value === null ? null : actual >= m * (salary / 1000);
  }

  return {
    date: gameDate,
    site,
    slateId: row.slate_id,
    playerKey: row.player_key,
    name: row.player_name,
    team: row.team,
    opponent: row.opponent,
    position: row.position,
    salary,
    projectedPoints: projected,
    projectedMinutes,
    floor: toNum(row.floor),
    ceiling: toNum(row.ceiling),
    rostership: toNum(row.rostership),
    injuryStatus: row.injury_status ?? null,
    status,
    statusReason: reason,
    actualMinutes: played ? minutes : (status === 'PENDING' ? null : 0),
    actualPoints,
    actual,
    projectionError: played && projected !== null && actual !== null ? round(projected - actual) : null,
    minutesError: played && projectedMinutes !== null ? round(projectedMinutes - minutes) : null,
    value: round(value),
    hits
  };
}

/**
 * Aggregate result rows: status counts, projection / minutes error metrics,
 * average value and hit rates (pct of PLAYED rows).
 */
export function aggregateResults(rows) {
  const counts = Object.fromEntries(RESULT_STATUSES.map(s => [s, 0]));
  for (const r of rows) counts[r.status]++;
  const played = rows.filter(r => r.status === 'PLAYED');
  const valued = played.filter(r => r.value !== null);

  const hitRates = {};
  for (const m of VALUE_MULTIPLES) {
    const key = `${m}x`;
    hitRates[key] = valued.length ? round((valued.filter(r => r.hits[key]).length / valued.length) * 100, 1) : null;
  }

  return {
    players: rows.length,
    played: counts.PLAYED,
    dnp: counts.DNP,
    inactive: counts.INACTIVE,
    pending: counts.PENDING,
    projection: computeErrorMetrics(played.map(r => ({ projected: r.projectedPoints, actual: r.actual }))),
    minutes: computeErrorMetrics(played.map(r => ({ projected: r.projectedMinutes, actual: r.actualMinutes }))),
    avgValue: valued.length ? round(valued.reduce((sum, r) => sum + r.value, 0) / valued.length) : null,
    hitRates
  };
}

function groupBy(rows, keyFn, order = null) {
  const groups = new Map();
  for (const r of rows) {
    for (const k of [].concat(keyFn(r)).filter(Boolean)) {
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(r);
    }
  }
  const keys = order
    ? order.filter(k => groups.has(k)).concat([...groups.keys()].filter(k => !order.includes(k)))
    : [...groups.keys()].sort();
  return keys.map(k => ({ group: k, ...aggregateResults(groups.get(k)) }));
}

// ---------------------------------------------------------------------------
// Database loading
// ---------------------------------------------------------------------------

async function loadJoinedRows({ from, to, site, slateId }) {
  const params = [site];
  let where = 's.site = ?';
  if (from) { where += ' AND s.game_date >= ?'; params.push(from); }
  if (to) { where += ' AND s.game_date <= ?'; params.push(to); }
  if (slateId) { where += ' AND s.slate_id = ?'; params.push(String(slateId)); }

  return db.all(`
    SELECT s.id AS snapshot_id, s.slate_id, s.site, s.game_date, s.player_key, s.player_name,
           s.team, s.opponent, s.position, s.salary, s.projected_points, s.projected_minutes,
           s.floor, s.ceiling, s.rostership, s.injury_status, s.captured_at,
           CASE WHEN h.id IS NULL THEN 0 ELSE 1 END AS has_box_row,
           h.minutes AS actual_minutes, h.dk_fantasy_points, h.fd_fantasy_points, h.yahoo_fantasy_points,
           g.status AS box_status, g.reason AS box_reason
    FROM slate_player_snapshots s
    LEFT JOIN historical_games h ON h.player_key = s.player_key AND h.game_date = s.game_date
    LEFT JOIN game_player_status g ON g.player_key = s.player_key AND g.game_date = s.game_date
    WHERE ${where}
  `, ...params);
}

// Teams with a box score on each date: "TEAM|YYYY-MM-DD"
async function loadTeamsInBox(fromDate, toDate) {
  const rows = await db.all(`
    SELECT DISTINCT team, game_date FROM team_game_stats WHERE game_date >= ? AND game_date <= ?
    UNION
    SELECT DISTINCT team, game_date FROM historical_games WHERE game_date >= ? AND game_date <= ?
  `, fromDate, toDate, fromDate, toDate);
  return new Set(rows.map(r => `${canonicalTeam(r.team)}|${toDateStr(r.game_date)}`));
}

/**
 * Per-player results for snapshots matching the filters, sorted by date,
 * then actual points (highest first).
 * @param {Object} options - { from, to, site, slateId, status, player }
 */
export async function getPlayerResults(options = {}) {
  const { from = null, to = null, slateId = null, status = null, player = null } = options;
  const site = getSiteConfig(options.site || DEFAULT_SITE).key;
  const joined = await loadJoinedRows({ from, to, site, slateId });

  // A join can return duplicates (two box score spellings for one key):
  // keep the one with the most minutes per snapshot row
  const bySnapshot = new Map();
  for (const r of joined) {
    const prev = bySnapshot.get(r.snapshot_id);
    if (!prev || (toNum(r.actual_minutes) ?? -1) > (toNum(prev.actual_minutes) ?? -1)) bySnapshot.set(r.snapshot_id, r);
  }

  // Same player on several slates of one site/date: latest snapshot wins
  let snapshots = [...bySnapshot.values()];
  if (!slateId) {
    const latest = new Map();
    for (const r of snapshots) {
      const key = `${r.player_key}|${toDateStr(r.game_date)}`;
      const prev = latest.get(key);
      if (!prev || toTime(r.captured_at) > toTime(prev.captured_at)) latest.set(key, r);
    }
    snapshots = [...latest.values()];
  }

  const dates = snapshots.map(r => toDateStr(r.game_date)).sort();
  const teamsInBox = dates.length ? await loadTeamsInBox(dates[0], dates[dates.length - 1]) : new Set();

  let rows = snapshots.map(r => buildResultRow(r, { teamsInBox }));
  if (status) rows = rows.filter(r => r.status === status);
  if (player) {
    const needle = String(player).toLowerCase();
    rows = rows.filter(r => r.playerKey.includes(needle) || String(r.name).toLowerCase().includes(needle));
  }
  return rows.sort((a, b) => a.date.localeCompare(b.date) || (b.actual ?? -1) - (a.actual ?? -1) || a.name.localeCompare(b.name));
}

/**
 * Aggregated results: overall and by salary tier, position and date.
 * @param {Object} options - { from, to, site, slateId }
 */
export async function getResults(options = {}) {
  const { from = null, to = null, slateId = null } = options;
  const site = getSiteConfig(options.site || DEFAULT_SITE).key;
  const rows = await getPlayerResults({ from, to, site, slateId });
  return {
    filters: { from, to, site, slateId },
    overall: aggregateResults(rows),
    bySalaryTier: groupBy(rows, r => salaryTier(r.salary, site), salaryTiers(site).map(t => t.label)),
    byPosition: groupBy(rows, r => basePositions(r.position), DK_POSITIONS),
    byDate: groupBy(rows, r => r.date)
  };
}

/**
 * Results for specific players on one date, whether or not they were on a
 * saved slate. Snapshot players come from getPlayerResults (salary,
 * projection, value); the rest are built from the box score and
 * game_player_status the same way, with no salary or projection. A player
 * whose team has no box score that date is NO_GAME, or PENDING when the date
 * is after the latest box score. Returns rows in playerKeys order, with
 * `onSnapshot` marking the snapshot ones.
 * @param {Object} options - { playerKeys, date, site }
 */
export async function getPlayerResultsOnDate({ playerKeys, date, site: requestedSite } = {}) {
  const site = getSiteConfig(requestedSite || DEFAULT_SITE).key;
  const keys = [...new Set(playerKeys)];
  if (keys.length === 0) return [];
  const marks = keys.map(() => '?').join(', ');

  const snapshots = new Map(
    (await getPlayerResults({ from: date, to: date, site })).filter(r => keys.includes(r.playerKey)).map(r => [r.playerKey, r])
  );
  const missing = keys.filter(k => !snapshots.has(k));
  const built = new Map();
  if (missing.length > 0) {
    const missingMarks = missing.map(() => '?').join(', ');
    const [box, statuses, lastTeams, latest, teamsInBox] = await Promise.all([
      db.all(`
        SELECT player_key, player_name, team, opponent, position, minutes, dk_fantasy_points, fd_fantasy_points, yahoo_fantasy_points
        FROM historical_games WHERE game_date = ? AND player_key IN (${missingMarks})
        ORDER BY minutes DESC
      `, date, ...missing),
      db.all(`SELECT player_key, player_name, team, status, reason FROM game_player_status WHERE game_date = ? AND player_key IN (${missingMarks})`,
        date, ...missing),
      // Team as of the date, for players with neither a box row nor a listing
      db.all(`
        SELECT h.player_key, h.team, h.player_name FROM historical_games h
        JOIN (SELECT player_key, MAX(game_date) AS d FROM historical_games
              WHERE game_date <= ? AND player_key IN (${missingMarks}) GROUP BY player_key) x
          ON x.player_key = h.player_key AND x.d = h.game_date
      `, date, ...missing),
      db.get('SELECT MAX(game_date) AS d FROM historical_games'),
      loadTeamsInBox(date, date)
    ]);
    const first = (rows) => {
      const m = new Map();
      for (const r of rows) if (!m.has(r.player_key)) m.set(r.player_key, r);
      return m;
    };
    const boxBy = first(box);
    const statusBy = first(statuses);
    const teamBy = first(lastTeams);
    const afterData = !latest?.d || date > toDateStr(latest.d);

    for (const key of missing) {
      const b = boxBy.get(key);
      const s = statusBy.get(key);
      const t = teamBy.get(key);
      const row = buildResultRow({
        site, game_date: date, slate_id: null, player_key: key,
        player_name: b?.player_name ?? s?.player_name ?? t?.player_name ?? key,
        team: b?.team ?? s?.team ?? t?.team ?? null,
        opponent: b?.opponent ?? null,
        position: b?.position ?? null,
        has_box_row: b ? 1 : 0,
        actual_minutes: b?.minutes ?? null,
        dk_fantasy_points: b?.dk_fantasy_points, fd_fantasy_points: b?.fd_fantasy_points, yahoo_fantasy_points: b?.yahoo_fantasy_points,
        box_status: s?.status ?? null,
        box_reason: s?.reason ?? null
      }, { teamsInBox });
      if (row.status === 'PENDING' && !afterData) {
        row.status = 'NO_GAME';
        row.statusReason = 'No box score for his team on this date';
      }
      built.set(key, row);
    }
  }

  return keys.map(k => (snapshots.has(k) ? { ...snapshots.get(k), onSnapshot: true } : { ...built.get(k), onSnapshot: false }));
}

export default { getResults, getPlayerResults, getPlayerResultsOnDate };
