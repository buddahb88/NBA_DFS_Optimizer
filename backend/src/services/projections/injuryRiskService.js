/**
 * INJURY-RISK SERVICE (read-only on the database)
 *
 * calibrationRows({ before }): one row per player-night on saved slates -
 * the tag at the last sync (latest captured_at across that night's slates,
 * any site), max salary, played (a box score with minutes > 0). Nights whose
 * team has no box score yet (not played / not synced) are left out.
 *
 * tableFor(source): the table a slate read uses - live slates the committed
 * config/injuryRiskTable.json; backtest slates a table calibrated as of the
 * slate's date (nights strictly before it), so a backtest never sees its own
 * outcomes. Cached per date + data signature.
 *
 * applyInjuryRiskToSlate(source, players, { table }): sourceLayer.applyInjuryRisk
 * on every player; returns { players, summary: { enabled, tagged, adjusted,
 * byTag, table } }.
 */

import db from '../../config/database.js';
import { inPool } from '../../config/snapshotMigrations.js';
import { injuryRiskTable } from '../../config/injuryRisk.js';
import { calibrateInjuryRisk } from './injuryRisk.js';
import { applyInjuryRisk } from './sourceLayer.js';

const dateStr = (d) => String(d ?? '').slice(0, 10);

export async function calibrationRows({ before = null } = {}) {
  const rows = await db.all(`
    SELECT s.game_date, s.player_key, s.team, s.salary, s.injury_status, s.captured_at, s.id,
      EXISTS (SELECT 1 FROM historical_games h
              WHERE h.player_key = s.player_key AND h.game_date = s.game_date AND h.minutes > 0) AS played,
      EXISTS (SELECT 1 FROM historical_games t WHERE t.game_date = s.game_date AND t.team = s.team) AS team_played
    FROM slate_player_snapshots s
    WHERE s.projected_points > 0 AND s.player_key IS NOT NULL AND ${inPool('s')}
      ${before ? 'AND s.game_date < ?' : ''}`, ...(before ? [before] : []));
  // One row per player-night: the latest sync's tag, the highest salary
  const nights = new Map();
  for (const r of rows) {
    if (!Number(r.team_played)) continue;
    const key = `${dateStr(r.game_date)}|${r.player_key}`;
    const prev = nights.get(key);
    const later = !prev || String(r.captured_at ?? '') > String(prev.captured_at ?? '')
      || (String(r.captured_at ?? '') === String(prev.captured_at ?? '') && r.id > prev.id);
    nights.set(key, {
      game_date: dateStr(r.game_date),
      player_key: r.player_key,
      salary: Math.max(Number(r.salary) || 0, Number(prev?.salary) || 0),
      tag: later ? r.injury_status : prev.tag,
      captured_at: later ? r.captured_at : prev.captured_at,
      id: later ? r.id : prev.id,
      played: Boolean(Number(r.played))
    });
  }
  return [...nights.values()].map(({ captured_at, id, ...r }) => r);
}

/** Full-history table (the calibration script). */
export async function calibrateFromDb({ before = null } = {}) {
  const rows = await calibrationRows({ before });
  const dates = [...new Set(rows.map(r => r.game_date))].sort();
  return {
    ...calibrateInjuryRisk(rows),
    generated_at: new Date().toISOString(),
    dates: { first: dates[0] ?? null, last: dates.at(-1) ?? null, nights: dates.length },
    ...(before ? { before } : {})
  };
}

const asOfCache = new Map();

async function signature() {
  const r = await db.get(`SELECT COUNT(*) AS n, MAX(captured_at) AS last FROM slate_player_snapshots`);
  const h = await db.get(`SELECT MAX(game_date) AS last FROM historical_games`);
  return `${r?.n}|${r?.last}|${h?.last}`;
}

/** The table a slate read uses (see header). */
export async function tableFor(source) {
  if (!source?.isBacktest || !source.slateDate) return injuryRiskTable();
  const key = `${source.slateDate}|${await signature()}`;
  if (!asOfCache.has(key)) {
    if (asOfCache.size > 50) asOfCache.clear();
    asOfCache.set(key, calibrateFromDb({ before: source.slateDate }).catch((e) => {
      asOfCache.delete(key);
      console.warn(`⚠️ Injury risk: as-of calibration for ${source.slateDate} failed, using the committed table: ${e.message}`);
      return injuryRiskTable();
    }));
  }
  return asOfCache.get(key);
}

export async function applyInjuryRiskToSlate(source, players, { table = null } = {}) {
  const t = table ?? await tableFor(source);
  const out = players.map(p => applyInjuryRisk(p, t));
  const tagged = out.filter(p => p.injury_tag);
  const adjusted = out.filter(p => Number.isFinite(p.injury_discount) && p.injury_discount < 1);
  const byTag = {};
  for (const p of tagged) byTag[p.injury_tag] = (byTag[p.injury_tag] ?? 0) + 1;
  return {
    players: out,
    summary: {
      enabled: true, tagged: tagged.length, adjusted: adjusted.length, byTag,
      table: t.before ? `as of ${t.before}` : (t.missing ? 'fallback' : 'committed')
    }
  };
}

export function clearInjuryRiskCache() {
  asOfCache.clear();
}

export default { calibrationRows, calibrateFromDb, tableFor, applyInjuryRiskToSlate, clearInjuryRiskCache };
