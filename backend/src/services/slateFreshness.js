/**
 * SLATE FRESHNESS
 *
 * Which game date a slate covers and whether it is older than today's DFS
 * day (US Eastern). Chat tools, the suggestions endpoint and the slates API
 * use it so a stale "latest" slate is never presented as tonight's.
 *
 * Slate date, first that is known:
 *   1. slates.start_time when it is a full timestamp (salary imports)
 *   2. earliest RotoWire game.dateTime in the slate players' raw_data
 *   3. latest slate_player_snapshots.game_date for the slate
 *   4. Eastern date of slates.created_at (stored as UTC)
 */

import db from '../config/database.js';
import slateModel from '../models/slateModel.js';
import { easternDate, startTimeDate, rotowireGameDate } from './slateSnapshotService.js';

const DAY_MS = 24 * 60 * 60 * 1000;

const toDateString = (value) => {
  if (value instanceof Date) return isNaN(value) ? null : value.toISOString().slice(0, 10);
  const m = typeof value === 'string' ? value.match(/^(\d{4}-\d{2}-\d{2})/) : null;
  return m ? m[1] : null;
};

// SQLite CURRENT_TIMESTAMP is UTC without a zone ("2026-10-21 21:24:37"); Azure returns a Date
function createdAtDate(createdAt) {
  if (createdAt instanceof Date) return isNaN(createdAt) ? null : easternDate(createdAt);
  if (typeof createdAt !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(createdAt)) return null;
  const iso = /[zZ]|[+-]\d{2}:?\d{2}$/.test(createdAt) ? createdAt : `${createdAt.replace(' ', 'T')}Z`;
  const parsed = new Date(iso);
  return isNaN(parsed) ? null : easternDate(parsed);
}

export function staleWarning({ slateId, slateDate, today, daysOld }) {
  const age = daysOld === 1 ? '1 day old' : `${daysOld} days old`;
  const which = slateId ? `slate ${slateId}` : 'the latest slate';
  return `STALE SLATE: ${which} is from ${slateDate} (${age}); today is ${today} (ET). `
    + 'Its players, salaries, injuries and projections are NOT tonight\'s. '
    + 'Sync tonight\'s slate (Home or Data Status) before building lineups or recommending plays for tonight.';
}

/**
 * Freshness of a slate date against today's Eastern date.
 * Returns { slateDate, today, isStale, daysOld, warning }; an unknown date is never stale.
 */
export function slateFreshness(slateDate, now = new Date(), { slateId = null } = {}) {
  const today = easternDate(now);
  if (!slateDate) return { slateDate: null, today, isStale: false, daysOld: null, warning: null };
  const daysOld = Math.round((Date.parse(today) - Date.parse(slateDate)) / DAY_MS);
  const isStale = slateDate < today;
  return {
    slateDate,
    today,
    isStale,
    daysOld,
    warning: isStale ? staleWarning({ slateId, slateDate, today, daysOld }) : null,
  };
}

/** Game date (YYYY-MM-DD) a slate covers, from a slates row or a slate id; null when unknown. */
export async function getSlateDate(slateOrId) {
  const slate = typeof slateOrId === 'object' && slateOrId !== null
    ? slateOrId
    : await slateModel.getById(String(slateOrId));
  if (!slate) return null;

  const fromStart = startTimeDate(slate.start_time);
  if (fromStart) return fromStart;

  const players = await db.all('SELECT raw_data FROM players WHERE slate_id = ?', slate.slate_id);
  const gameDates = players.map(p => rotowireGameDate(p.raw_data)).filter(Boolean).sort();
  if (gameDates.length > 0) return gameDates[0];

  const snapshot = await db.get(
    'SELECT MAX(game_date) AS game_date FROM slate_player_snapshots WHERE slate_id = ?', slate.slate_id);
  const fromSnapshot = toDateString(snapshot?.game_date);
  if (fromSnapshot) return fromSnapshot;

  return createdAtDate(slate.created_at);
}

/** Freshness for one slate (null when the slate does not exist). */
export async function getSlateFreshness(slateOrId, { now = new Date() } = {}) {
  const slate = typeof slateOrId === 'object' && slateOrId !== null
    ? slateOrId
    : await slateModel.getById(String(slateOrId));
  if (!slate) return null;
  return slateFreshness(await getSlateDate(slate), now, { slateId: slate.slate_id });
}

/**
 * The latest synced slate with its game date and staleness, or null when
 * there are no slates: { slateId, name, site, startTime, createdAt,
 * playerCount, slateDate, today, isStale, daysOld, warning }.
 */
export async function getCurrentSlateInfo({ now = new Date() } = {}) {
  const [slate] = await slateModel.getAll();
  if (!slate) return null;
  const count = await db.get('SELECT COUNT(*) AS n FROM players WHERE slate_id = ?', slate.slate_id);
  return {
    slateId: slate.slate_id,
    name: slate.name,
    site: slate.site ?? null,
    startTime: slate.start_time ?? null,
    createdAt: slate.created_at ?? null,
    playerCount: Number(count?.n ?? 0),
    ...(await getSlateFreshness(slate, { now })),
  };
}

/**
 * Fields slate-based tool outputs carry so answers say which date they cover:
 * { slateDate, today, isStale } plus staleWarning when stale.
 */
export async function slateDateFields(slateId, { now = new Date() } = {}) {
  const f = (await getSlateFreshness(slateId, { now })) ?? slateFreshness(null, now);
  return {
    slateDate: f.slateDate,
    today: f.today,
    isStale: f.isStale,
    ...(f.isStale ? { staleWarning: f.warning } : {}),
  };
}
