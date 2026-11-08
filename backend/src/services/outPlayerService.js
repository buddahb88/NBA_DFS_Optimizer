/**
 * OUT PLAYERS ON SAVED SLATES
 *
 * RotoWire's players.php payload lists injured players too (injuryStatus
 * "OUT", "OFS", "DOUBT", ... with pts 0 / minutes 0), but the sync transform
 * drops every 0-projection player, so the players table and therefore
 * slate_player_snapshots never knew who was out. "Which teammates are out
 * tonight" is a pre-game signal, so the dropped players that carry an injury
 * tag are kept in slate_player_snapshots as context rows (pool_excluded = 1,
 * projected 0, never in the playable pool; readers filter with inPool()).
 * They are never written to the players table.
 *
 * When the tag is trustworthy (out_evidence):
 *  - live_sync: a sync before the player's game started. A sync after
 *    tip-off writes nothing (the tag may be an in-game injury).
 *  - payload_prelock: a past-slate payload (backfill) fetched before tip-off.
 *  - payload_postlock_confirmed: a payload fetched after lock carries the
 *    tag as of the FETCH date, not the slate (e.g. a player hurt a week later
 *    shows OUT on every earlier slate). Such a tag is only kept for OUT-like
 *    statuses when an absence spell confirms it was already known before the
 *    game (confirmPostlockOut): the player missed the team's previous game
 *    (pre-game knowledge) and every game from the slate date through the
 *    fetch date. The box scores only veto tags, they never create an OUT row.
 */

import db from '../config/database.js';
import rotowireService from './rotowireService.js';
import { isOutStatus } from './minutesModel.js';
import { snapshotRowFor, upsertSnapshotRow, isLocked, playerGameStart, easternDate } from './slateSnapshotService.js';
import { playerKey, canonicalTeam } from '../utils/playerKey.js';
import { seasonForDate } from '../utils/season.js';
import { DEFAULT_SITE } from '../config/sites.js';

export const OUT_EVIDENCE = {
  live: 'live_sync',
  prelock: 'payload_prelock',
  postlock: 'payload_postlock_confirmed'
};

const idOf = (p) => String(p?.rwID ?? p?.rwid ?? p?.id ?? p?.player_id ?? p?.pid ?? '');

/**
 * Raw payload players the sync transform drops (0 projection / minutes)
 * that carry an injury tag, as players-table rows (snake_case, projected 0,
 * pool_excluded 1). keptIds: rwIDs that made the pool (default: run the
 * transform). stripStats: drop the stats block (a past-slate payload's stats
 * are the current season's, lookahead).
 */
export function excludedPlayersFromRotowire(rawPlayers, { keptIds = null, stripStats = false } = {}) {
  const raw = Array.isArray(rawPlayers) ? rawPlayers : [];
  const kept = keptIds ?? new Set(rotowireService.transformPlayerData(raw.map(({ stats, ...p }) => p)).map(t => t.playerId));
  const rows = [];
  for (const p of raw) {
    const status = p?.injuryStatus ?? p?.injury_status ?? null;
    if (status == null || status === '' || kept.has(idOf(p))) continue;
    const name = `${p.firstName ?? ''} ${p.lastName ?? ''}`.trim() || p.name;
    if (!name || !playerKey(name)) continue;
    const team = typeof p.team === 'object' ? (p.team?.abbr ?? null) : (p.team ?? null);
    const opponent = typeof p.opponent === 'object' ? (p.opponent?.team ?? null) : (p.opponent ?? null);
    const { stats, ...rest } = p;
    rows.push({
      player_id: idOf(p) || null,
      name,
      team: canonicalTeam(team) ?? team,
      opponent: canonicalTeam(opponent) ?? opponent,
      position: Array.isArray(p.pos) ? p.pos.join(',') : (p.rotoPos ?? p.position ?? null),
      salary: Number(p.salary) || null,
      projected_points: 0,
      projected_minutes: 0,
      rostership: 0,
      injury_status: typeof status === 'object' ? JSON.stringify(status) : String(status),
      lineup_confirmed: typeof p.lineup?.isConfirmed === 'boolean' ? (p.lineup.isConfirmed ? 1 : 0) : null,
      headshot: p.imageURL ?? null,
      raw_data: JSON.stringify(stripStats ? rest : p),
      pool_excluded: 1
    });
  }
  return rows;
}

/**
 * Live sync: write the slate's excluded players (excludedPlayersFromRotowire)
 * as pool_excluded rows, only for games that have not started. An existing
 * pool row of the same player (an earlier sync before he was ruled out) is
 * replaced. Returns the number of rows written.
 */
export async function snapshotExcludedPlayers(slateId, excluded, { now = new Date() } = {}) {
  if (!excluded?.length) return 0;
  const slate = await db.get(`SELECT slate_id, site, start_time FROM slates WHERE slate_id = ?`, slateId);
  if (!slate) return 0;
  const site = slate.site || DEFAULT_SITE;
  let written = 0;
  for (const p of excluded) {
    const row = snapshotRowFor({ ...p, out_evidence: OUT_EVIDENCE.live }, { slate, site, now });
    if (!row.player_key || isLocked(row, now)) continue;
    await upsertSnapshotRow(row);
    written++;
  }
  return written;
}

const addDays = (date, days) => {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

/**
 * Box-score lookups for confirmPostlockOut, over [from, to] (ET dates).
 * Returns { teamDates: Map(team -> sorted dates), played: Map(player_key -> Set(dates played)) }.
 */
export async function loadAbsenceContext(from, to) {
  const lo = addDays(from, -30);
  const rows = await db.all(`SELECT player_key, team, game_date, minutes FROM historical_games WHERE game_date >= ? AND game_date <= ?`, lo, to);
  const teamDates = new Map();
  const played = new Map();
  for (const r of rows) {
    const date = String(r.game_date).slice(0, 10);
    const team = canonicalTeam(r.team) ?? r.team;
    if (!teamDates.has(team)) teamDates.set(team, new Set());
    teamDates.get(team).add(date);
    if (Number(r.minutes) > 0) {
      if (!played.has(r.player_key)) played.set(r.player_key, new Set());
      played.get(r.player_key).add(date);
    }
  }
  return { teamDates: new Map([...teamDates].map(([t, s]) => [t, [...s].sort()])), played };
}

/**
 * Post-lock payload tag check. A player tagged OUT-like on a payload fetched
 * on fetchDate counts as OUT before the gameDate game only when:
 *  - the team's gameDate game is in the box scores,
 *  - he did not play on any date from gameDate through fetchDate, and
 *  - he did not play in the team's previous game this season (absence known
 *    before tip-off; a team's first game of the season has none to check).
 * Returns { ok, reason, opener }.
 */
export function confirmPostlockOut({ key, team, gameDate, fetchDate, status }, ctx) {
  if (!isOutStatus(status)) return { ok: false, reason: 'not an OUT tag' };
  const dates = ctx.teamDates.get(canonicalTeam(team) ?? team) ?? [];
  if (!dates.includes(gameDate)) return { ok: false, reason: 'team game not in box scores' };
  const playedDates = ctx.played.get(key) ?? new Set();
  for (const d of playedDates) {
    if (d >= gameDate && d <= fetchDate) return { ok: false, reason: `played ${d}` };
  }
  const season = seasonForDate(gameDate);
  const prev = dates.filter(d => d < gameDate && seasonForDate(d) === season).pop() ?? null;
  if (prev && playedDates.has(prev)) return { ok: false, reason: `played previous game ${prev}` };
  return { ok: true, reason: prev ? `missed ${prev} through ${fetchDate}` : `season opener, missed through ${fetchDate}`, opener: !prev };
}

/**
 * Past-slate excluded rows to write (backfill): [{ player, evidence }] for
 * the payload's excluded players, given when the payload was fetched.
 * Pre-lock (fetchedAt before the player's game start): every tagged player.
 * Post-lock: only confirmPostlockOut ones.
 */
export function classifyExcluded(excluded, { gameDate, fetchedAt, ctx }) {
  const fetchMs = new Date(fetchedAt).getTime();
  const fetchDate = easternDate(new Date(fetchedAt));
  const out = [];
  for (const p of excluded) {
    const start = playerGameStart(p);
    if (start && fetchMs < Date.parse(start)) {
      out.push({ player: { ...p, out_evidence: OUT_EVIDENCE.prelock }, evidence: OUT_EVIDENCE.prelock });
      continue;
    }
    const check = confirmPostlockOut({ key: playerKey(p.name), team: p.team, gameDate, fetchDate, status: p.injury_status }, ctx);
    if (check.ok) out.push({ player: { ...p, out_evidence: OUT_EVIDENCE.postlock }, evidence: OUT_EVIDENCE.postlock, opener: check.opener });
  }
  return out;
}

export default { excludedPlayersFromRotowire, snapshotExcludedPlayers, loadAbsenceContext, confirmPostlockOut, classifyExcluded, OUT_EVIDENCE };
