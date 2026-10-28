/**
 * ROTOWIRE SLATE BACKFILL
 *
 * Rebuilds past DraftKings classic slates into slate_player_snapshots from
 * RotoWire (scripts/backfill-rotowire-slates.js), so a night we never synced
 * live can still be backtested. RotoWire keeps serving players.php by slate
 * id after lock; slate-list.php only lists current slates, so ids are
 * scanned and each payload is classified (date, site, contest type, games).
 *
 * Lookahead: a past-slate payload carries the CURRENT season's stats blocks
 * (avgFpts, PER, usage, rest) and null odds. Only pre-game fields are kept:
 * salary, RotoWire projection and minutes, ownership, DK positions, injury
 * status, confirmed flag, game time, ids and headshot. raw_data is stored
 * without `stats`. Vegas comes from ESPN's pickcenter (the line at tip-off),
 * archetypes from the prior season. Floor / ceiling / std_dev / boom / bust
 * stay NULL: no pre-lock range was ever computed for these nights, and
 * scripts/recompute-snapshot-ranges.js fills the *_model ones without
 * lookahead. value / value_gpp, DVP and recent form stay NULL too (they read
 * the stats blocks or today's defense tables).
 *
 * Rows are tagged capture_source = 'rotowire_backfill'. A slate with any row
 * captured live (capture_source NULL) is never overwritten unless forced:
 * its existing rows only gain detail columns and Vegas that are still NULL.
 * Every DK classic slate found is written to slate_catalog; is_main marks
 * the main slate of each date (most games, then earliest lock), recomputed
 * over every cataloged slate of the date, live ones included
 * (slateCatalogService).
 */

import fs from 'fs';
import path from 'path';
import db from '../config/database.js';
import { getEligibleSlots } from '../config/sites.js';
import rotowireService from './rotowireService.js';
import { upsertCatalogSlate, slateName, mainOrder } from './slateCatalogService.js';
import { snapshotRowFor, upsertSnapshotRow, playerGameStart, rotowireGameDate } from './slateSnapshotService.js';
import { loadArchetypeLookup } from './archetypeDefenseService.js';
import { playerKey, canonicalTeam } from '../utils/playerKey.js';
import { seasonForDate, previousSeason } from '../utils/season.js';

export const CAPTURE_SOURCE = 'rotowire_backfill';
const SITE = 'draftkings';
// DK classic salaries; Yahoo's $10-60 and showdown captain prices fall outside
const DK_SALARY = { min: 3000, max: 15000 };
const SHOWDOWN_SLOTS = new Set(['CPTN', 'CPT', 'MVP']);

const teamOf = (p) => {
  const raw = typeof p.team === 'object' ? p.team?.abbr : p.team;
  return canonicalTeam(raw) ?? raw ?? null;
};
const oppOf = (p) => {
  const raw = typeof p.opponent === 'object' ? p.opponent?.team : p.opponent;
  return canonicalTeam(raw) ?? raw ?? null;
};

// A DK classic player lists exactly the DK slots their positions allow
function isDkClassicPositions(pos) {
  if (!Array.isArray(pos) || pos.length === 0 || new Set(pos).size !== pos.length) return false;
  const slots = getEligibleSlots(SITE, pos);
  return slots.length === pos.length && slots.every(s => pos.includes(s));
}

/**
 * Classify one players.php payload: { slateId, site ('draftkings' for DK
 * classic, else null), contestType ('classic' | 'showdown' | 'other' |
 * 'empty'), gameDate (ET), games, players, firstGameTime (ISO UTC) }.
 */
export function classifySlate(slateId, players) {
  const base = { slateId: String(slateId), site: null, gameDate: null, games: 0, players: 0, firstGameTime: null };
  if (!Array.isArray(players) || players.length === 0) return { ...base, contestType: 'empty' };

  const dates = players.map(p => rotowireGameDate(p)).filter(Boolean).sort();
  const starts = players.map(p => playerGameStart({ raw_data: p })).filter(Boolean).sort();
  const games = new Set(players.map(p => [teamOf(p), oppOf(p)].sort().join('@'))).size;
  const withPos = players.filter(p => Array.isArray(p.pos) && p.pos.length);
  const salaries = players.map(p => Number(p.salary)).filter(s => s > 0);

  const showdown = withPos.some(p => p.pos.some(s => SHOWDOWN_SLOTS.has(s)));
  const dk = withPos.length > 0 && withPos.every(p => isDkClassicPositions(p.pos))
    && salaries.length > 0 && Math.min(...salaries) >= DK_SALARY.min && Math.max(...salaries) <= DK_SALARY.max;
  const contestType = showdown ? 'showdown' : (dk && games >= 2 ? 'classic' : 'other');

  return {
    ...base,
    site: contestType === 'classic' ? SITE : null,
    contestType,
    gameDate: dates[0] ?? null,
    games,
    players: players.length,
    firstGameTime: starts[0] ?? null
  };
}

/** DK classic slates with isMain set on the main slate of each date (most games, then earliest lock). */
export function markMainSlates(slates) {
  const main = new Map();
  for (const s of slates) {
    if (s.site !== SITE || s.contestType !== 'classic') continue;
    const current = main.get(s.gameDate);
    if (!current || mainOrder(s, current) < 0) main.set(s.gameDate, s);
  }
  return slates.map(s => ({ ...s, isMain: main.get(s.gameDate) === s }));
}

const NULL_ODDS = { moneyline: null, overUnder: null, spread: null, impliedPts: null, impliedWinProb: null };

/**
 * players-table rows (snake_case, as snapshotRowFor reads them) for a past
 * slate payload, without lookahead (see the header). odds: Map(team ->
 * { vegas_implied_total, vegas_spread, over_under }) from ESPN. Players
 * RotoWire projects for 0 points or 0 minutes are left out, as in a sync.
 */
export function snapshotPlayersFromRotowire(rawPlayers, { odds = new Map() } = {}) {
  // Without stats the transform cannot fall back to season minutes or read recent form
  const pregame = (rawPlayers || []).map(({ stats, ...p }) => ({ ...p, odds: { ...NULL_ODDS, ...p.odds } }));
  return rotowireService.transformPlayerData(pregame).map(t => {
    const line = odds.get(canonicalTeam(t.team) ?? t.team) ?? null;
    return {
      player_id: t.playerId || null,
      name: t.name,
      team: t.team,
      opponent: t.opponent,
      position: t.position,
      salary: t.salary,
      projected_points: t.projectedPoints,
      projected_minutes: t.projectedMinutes,
      value: null,
      value_gpp: null,
      game_info: t.gameInfo,
      injury_status: t.injuryStatus,
      lineup_confirmed: t.lineupConfirmed,
      per: null,
      usage: null,
      rest_days: null,
      fpts_last3: null,
      fpts_last5: null,
      fpts_last7: null,
      fpts_last14: null,
      vegas_implied_total: line?.vegas_implied_total ?? null,
      vegas_spread: line?.vegas_spread ?? null,
      vegas_over_under: line?.over_under ?? null,
      vegas_win_prob: null,
      rostership: t.rostership,
      headshot: t.headshot,
      dvp_pts_allowed: null,
      opp_def_eff: null,
      fppm: t.fppm,
      blowout_risk: line ? rotowireService.getBlowoutRisk(line.vegas_spread).risk : null,
      raw_data: t.rawData
    };
  });
}

/**
 * fetchSlate(id) that reads <cacheDir>/<id>.json when present, else calls
 * fetchRaw (default RotoWire) at most once per delayMs and caches the result.
 */
export function cachedSlateFetcher({ cacheDir, delayMs = 1000, fetchRaw = (id) => rotowireService.fetchRawPlayers(id) } = {}) {
  fs.mkdirSync(cacheDir, { recursive: true });
  let last = 0;
  return async (slateId) => {
    const file = path.join(cacheDir, `${slateId}.json`);
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
    const wait = last + delayMs - Date.now();
    if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
    last = Date.now();
    const data = await fetchRaw(slateId);
    fs.writeFileSync(file, JSON.stringify(data));
    return data;
  };
}

const catalogValues = (slate) => ({
  site: SITE, slate_id: slate.slateId, game_date: slate.gameDate, name: slateName(slate), contest_type: slate.contestType,
  games: slate.games, players: slate.players, first_game_time: slate.firstGameTime, is_main: slate.isMain ? 1 : 0, source: 'rotowire'
});

// Prior-season archetype only: this season's is built from games after the slate
async function priorArchetypeLookup() {
  const bySeason = new Map();
  return async (key, gameDate) => {
    const season = previousSeason(seasonForDate(gameDate));
    if (!bySeason.has(season)) bySeason.set(season, await loadArchetypeLookup(season));
    return bySeason.get(season)(key) ?? null;
  };
}

const VEGAS_COLUMNS = [['vegas_implied_total', 'vegas_implied_total'], ['vegas_spread', 'vegas_spread'], ['over_under', 'over_under']];

// Live capture: Vegas only where it is missing (NULL, or the 0 a sync stores without odds)
async function fillMissingVegas(slateId, gameDate, odds) {
  for (const [team, line] of odds) {
    const set = VEGAS_COLUMNS.map(([col]) => `${col} = CASE WHEN ${col} IS NULL OR ${col} = 0 THEN ? ELSE ${col} END`).join(', ');
    await db.run(`UPDATE slate_player_snapshots SET ${set} WHERE site = ? AND slate_id = ? AND game_date = ? AND team = ?`,
      ...VEGAS_COLUMNS.map(([, key]) => line[key]), SITE, slateId, gameDate, team);
  }
}

async function writeSlate(slate, players, { mode, now, archetypeOf, odds }) {
  const catalogSlate = { slate_id: slate.slateId, start_time: null };
  const liveKeys = mode === 'fill'
    ? new Set((await db.all(`SELECT player_key FROM slate_player_snapshots WHERE site = ? AND slate_id = ? AND game_date = ?`,
      SITE, slate.slateId, slate.gameDate)).map(r => r.player_key))
    : null;
  let written = 0;
  for (const p of players) {
    const key = playerKey(p.name);
    if (!key || (liveKeys && !liveKeys.has(key))) continue;
    const archetype = await archetypeOf(key, slate.gameDate);
    await upsertSnapshotRow(snapshotRowFor(p, { slate: catalogSlate, site: SITE, now, archetype }), { locked: mode === 'fill' });
    written++;
  }
  if (mode === 'fill') {
    await fillMissingVegas(slate.slateId, slate.gameDate, odds);
  } else {
    await db.run(`UPDATE slate_player_snapshots SET capture_source = ? WHERE site = ? AND slate_id = ? AND game_date = ?`,
      CAPTURE_SOURCE, SITE, slate.slateId, slate.gameDate);
  }
  return written;
}

/**
 * Backfill every DK classic slate among `slateIds` whose games fall in
 * [from, to] (ET dates). fetchSlate(id) -> players.php payload; fetchOdds(date)
 * -> Map(team -> Vegas). Options: dryRun (classify only), force (overwrite
 * live captures), now, log.
 * Returns { dates: { [date]: { mainSlateId, odds, slates: [...], skipped: [...] } } }.
 */
export async function backfillRotowireSlates({
  from, to, slateIds, fetchSlate, fetchOdds, dryRun = false, force = false, now = new Date(), log = () => {}
}) {
  const dates = {};
  const dateEntry = (d) => (dates[d] ??= { mainSlateId: null, odds: null, slates: [], skipped: [] });
  const found = [];
  for (const id of slateIds) {
    let players;
    try {
      players = await fetchSlate(String(id));
    } catch (error) {
      log(`slate ${id}: fetch failed (${error.message})`);
      continue;
    }
    const slate = classifySlate(id, players);
    if (!slate.gameDate || slate.gameDate < from || slate.gameDate > to) continue;
    if (slate.contestType !== 'classic') {
      dateEntry(slate.gameDate).skipped.push({ slateId: slate.slateId, contestType: slate.contestType, games: slate.games, players: slate.players });
      continue;
    }
    found.push({ ...slate, raw: players });
  }

  const archetypeOf = await priorArchetypeLookup();
  const oddsByDate = new Map();
  for (const slate of markMainSlates(found).sort((a, b) => a.gameDate.localeCompare(b.gameDate) || mainOrder(a, b))) {
    const entry = dateEntry(slate.gameDate);
    if (slate.isMain) entry.mainSlateId = slate.slateId;
    if (!oddsByDate.has(slate.gameDate)) {
      let odds = new Map();
      try {
        odds = await fetchOdds(slate.gameDate);
      } catch (error) {
        log(`${slate.gameDate}: ESPN odds unavailable (${error.message})`);
      }
      oddsByDate.set(slate.gameDate, odds);
      entry.odds = { teams: odds.size };
    }
    const odds = oddsByDate.get(slate.gameDate);
    const players = snapshotPlayersFromRotowire(slate.raw, { odds });
    const existing = await db.get(
      `SELECT COUNT(*) AS n, SUM(CASE WHEN capture_source IS NULL THEN 1 ELSE 0 END) AS live
       FROM slate_player_snapshots WHERE site = ? AND slate_id = ? AND game_date = ?`, SITE, slate.slateId, slate.gameDate);
    const mode = Number(existing?.live) > 0 && !force ? 'fill' : 'upsert';
    const written = dryRun ? 0 : await writeSlate(slate, players, { mode, now, archetypeOf, odds });
    if (!dryRun) await upsertCatalogSlate(catalogValues(slate), { now });
    entry.slates.push({
      slateId: slate.slateId, name: slateName(slate), isMain: slate.isMain, games: slate.games, firstGameTime: slate.firstGameTime,
      rotowirePlayers: slate.players, projectedPlayers: players.length, before: Number(existing?.n) || 0, mode, written
    });
    log(`${slate.gameDate} slate ${slate.slateId} (${slateName(slate)}): ${players.length} projected, mode ${mode}, ${dryRun ? 'dry run' : `${written} written`}`);
  }
  return { dates };
}

export { slateName };

export default { classifySlate, markMainSlates, slateName, snapshotPlayersFromRotowire, cachedSlateFetcher, backfillRotowireSlates };
