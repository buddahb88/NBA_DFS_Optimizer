/**
 * OPPORTUNITY TEAMMATE SERVICE
 *
 * Teammate-out opportunity for a slate (live, or a past night via slateSource):
 * who is out per team and the usage / minutes / points they vacate, each slate
 * player's usage, minutes, FPPM and points with each OUT teammate off the floor
 * (teammateSplits.js), and the share of the vacated usage he absorbs.
 *
 * Who is out (regulars only, see below), first source wins:
 *   injury_status  OUT / Doubtful on the slate (pre-lock; live or snapshot)
 *   dnp, inactive  backtest: listed in game_player_status that night
 *   absent         backtest: a rostered player with no box score row while
 *                  the team played (ESPN rarely lists injured players)
 *   not_on_slate   live: a rostered player missing from the slate
 * Rostered = an appearance for the team this season before the slate date (a
 * box score row or a listing) and no later box score for another team, as
 * insightsService's roster window. Backtest outs other than injury_status use
 * that night's results (prelock = false).
 *
 * Vacated line: the out player's games for the team before the slate date
 * this season (last season with under REGULAR_MIN_GAMES); a regular has REGULAR_MIN_GAMES+
 * games at REGULAR_MIN_MINUTES+ minutes. vacated_usage = Σ play_share (usage
 * x minutes share). absorbed_by lists the slate teammates' splits with a
 * sample (thin or confirmed).
 *
 * Splits use insightsService.absenceGamesSql (C8b "games without": team games
 * while both were on the roster, in which the teammate did not play), over
 * games before the slate date in the current season, or since last season's
 * start while the team has played under SPLIT_MIN_TEAM_GAMES this season.
 *
 * Queries are set-based: one roster query, the slate night's listings and box
 * scores (backtest), one game-log query for slate and out players, one
 * team-games query for the splits.
 */

import db from '../../config/database.js';
import insightsService from '../insightsService.js';
import { isOutStatus } from '../minutesModel.js';
import { resolveSlate, loadSlatePlayers, withActuals, SlateSourceError } from '../slateSource.js';
import { easternDate } from '../slateSnapshotService.js';
import { playerKey, canonicalTeam } from '../../utils/playerKey.js';
import { seasonForDate, previousSeason, seasonStartDate } from '../../utils/season.js';
import { loadPlayerGames } from './metricsService.js';
import { sampleStats, splitStats, computeSplit, combineSplits } from './teammateSplits.js';

export const REGULAR_MIN_GAMES = 5;
export const REGULAR_MIN_MINUTES = 15;
export const SPLIT_MIN_TEAM_GAMES = 15;

const DOUBTFUL = /^(D|DOUBT|DOUBTFUL)$/i;

// Azure returns DATE columns as Date objects
const toDateStr = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : v ? String(v).slice(0, 10) : null);
const placeholders = (n) => Array(n).fill('?').join(', ');
const round = (x, digits) => (x === null || x === undefined || !Number.isFinite(x) ? null : Number(x.toFixed(digits)) + 0);
const addDays = (date, n) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

const keyOf = (p) => p.player_key ?? playerKey(p.name);
const teamOf = (p) => canonicalTeam(p.team);
const isOut = (status) => isOutStatus(status) || DOUBTFUL.test(String(status ?? '').trim());

/** Rostered players per team this season before the slate date: Map(`key|team` -> { player_key, team, player_name, last_date }). */
async function loadRosters(teams, { season, slateDate }) {
  const t = placeholders(teams.length);
  const rows = await db.all(`
    SELECT player_key, team, MAX(player_name) AS player_name, MAX(game_date) AS last_date FROM (
      SELECT player_key, player_name, team, game_date FROM historical_games
      WHERE team IN (${t}) AND season = ? AND game_date < ?
      UNION ALL
      SELECT player_key, player_name, team, game_date FROM game_player_status
      WHERE team IN (${t}) AND game_date >= ? AND game_date < ?
    ) a
    GROUP BY player_key, team`, ...teams, season, slateDate, ...teams, seasonStartDate(season), slateDate);
  return rows.map(r => ({ ...r, last_date: toDateStr(r.last_date) }));
}

/** The slate night's results (backtest): listings, players with minutes, teams that played. */
async function loadNight(teams, slateDate) {
  const t = placeholders(teams.length);
  const [listings, played, teamGames] = await Promise.all([
    db.all(`SELECT player_key, player_name, team, status, reason FROM game_player_status
      WHERE game_date = ? AND team IN (${t})`, slateDate, ...teams),
    db.all(`SELECT player_key, team FROM historical_games WHERE game_date = ? AND team IN (${t}) AND minutes > 0`,
      slateDate, ...teams),
    db.all(`SELECT team FROM team_game_stats WHERE game_date = ? AND team IN (${t})`, slateDate, ...teams)
  ]);
  return {
    listings,
    played: new Set(played.map(r => `${r.player_key}|${r.team}`)),
    teamsPlayed: new Set(teamGames.map(r => r.team))
  };
}

/** Regular-season team games this season before the slate date: Map(team -> count). */
async function countTeamGames(teams, { season, slateDate }) {
  const rows = await db.all(`SELECT team, COUNT(*) AS games FROM team_game_stats
    WHERE team IN (${placeholders(teams.length)}) AND season = ? AND COALESCE(season_type, 'regular') = 'regular'
      AND game_date < ?
    GROUP BY team`, ...teams, season, slateDate);
  return new Map(rows.map(r => [r.team, Number(r.games)]));
}

/** Out candidates per the header's sources: [{ player_key, team, name, status_source, status, reason, prelock }]. */
function findOutCandidates({ source, all, teams, rosters, night }) {
  const found = new Map();
  const add = (c) => { if (!found.has(`${c.player_key}|${c.team}`)) found.set(`${c.player_key}|${c.team}`, c); };
  const teamSet = new Set(teams);

  for (const p of all) {
    if (!isOut(p.injury_status)) continue;
    add({ player_key: keyOf(p), team: teamOf(p), name: p.name, status_source: 'injury_status',
      status: p.injury_status, reason: null, prelock: true });
  }

  if (source.isBacktest) {
    for (const l of night.listings) {
      if (night.played.has(`${l.player_key}|${l.team}`)) continue;
      add({ player_key: l.player_key, team: l.team, name: l.player_name,
        status_source: l.status === 'DNP' ? 'dnp' : 'inactive', status: l.status, reason: l.reason ?? null, prelock: false });
    }
    for (const r of rosters) {
      if (!night.teamsPlayed.has(r.team) || night.played.has(`${r.player_key}|${r.team}`)) continue;
      add({ player_key: r.player_key, team: r.team, name: r.player_name, status_source: 'absent',
        status: null, reason: null, prelock: false, rosterDate: r.last_date });
    }
  } else {
    const onSlate = new Set(all.map(p => `${keyOf(p)}|${teamOf(p)}`));
    for (const r of rosters) {
      if (!teamSet.has(r.team) || onSlate.has(`${r.player_key}|${r.team}`)) continue;
      add({ player_key: r.player_key, team: r.team, name: r.player_name, status_source: 'not_on_slate',
        status: null, reason: null, prelock: true, rosterDate: r.last_date });
    }
  }
  return [...found.values()];
}

/** The out player's vacated line: this season's games, last season's under REGULAR_MIN_GAMES. */
function vacatedLine(games, season) {
  const current = games.filter(g => g.season === season);
  const baseline = current.length >= REGULAR_MIN_GAMES ? current : games.filter(g => g.season === previousSeason(season));
  return {
    baseline_season: baseline === current ? season : previousSeason(season),
    raw: sampleStats(baseline),
    ...splitStats(baseline)
  };
}

/** Roster-derived candidates who since played for another team are not out (traded). */
const traded = (candidate, games) =>
  candidate.rosterDate && games.some(g => g.team !== candidate.team && g.game_date > candidate.rosterDate);

/** C8b team games per out player: Map(`key|team` -> [{ game_date, played }]). */
async function loadAbsences(outs, { startDate, endDate }) {
  const absences = insightsService.absenceGamesSql(outs.map(o => [o.player_key, o.team]), { startDate, endDate });
  const rows = await db.all(`WITH ${absences.sql}
    SELECT missing_key, team, game_date, played FROM team_games
    WHERE COALESCE(season_type, 'regular') = 'regular'`, ...absences.params);
  const map = new Map();
  for (const r of rows) {
    const key = `${r.missing_key}|${r.team}`;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push({ game_date: toDateStr(r.game_date), played: Number(r.played) === 1 });
  }
  return map;
}

const intersect = (sets) => new Set([...sets[0]].filter(d => sets.every(s => s.has(d))));

/**
 * Teammate opportunity for slate players (players-table shape, OUT ones
 * included). Returns { slateDate, season, teams, players } as
 * getTeammateOpportunity. Exported for validation on dates without a slate.
 */
export async function computeTeammateOpportunity(source, all, { now = new Date() } = {}) {
  const slateDate = source.slateDate ?? easternDate(now);
  const season = seasonForDate(slateDate);
  const priorSeason = previousSeason(season);
  const teams = [...new Set(all.map(teamOf).filter(Boolean))];
  if (teams.length === 0) return { slateDate, season, teams: [], players: [] };

  const [rosters, night, teamGameCounts] = await Promise.all([
    loadRosters(teams, { season, slateDate }),
    source.isBacktest ? loadNight(teams, slateDate) : null,
    countTeamGames(teams, { season, slateDate })
  ]);
  const candidates = findOutCandidates({ source, all, teams, rosters, night });

  const logs = await loadPlayerGames([...all.map(keyOf), ...candidates.map(c => c.player_key)],
    { beforeDate: slateDate, seasons: [season, priorSeason], site: source.site });

  const outs = [];
  for (const c of candidates) {
    const games = logs.get(c.player_key) ?? [];
    if (traded(c, games)) continue;
    // Only usage he had with this team is vacated (offseason movers have none yet)
    const line = vacatedLine(games.filter(g => g.team === c.team), season);
    if (line.games < REGULAR_MIN_GAMES || !(line.min_pg >= REGULAR_MIN_MINUTES)) continue;
    const { rosterDate, ...out } = c;
    outs.push({ ...out, ...line });
  }

  const windowStart = new Map(teams.map(t => [t, (teamGameCounts.get(t) ?? 0) >= SPLIT_MIN_TEAM_GAMES
    ? seasonStartDate(season) : seasonStartDate(priorSeason)]));
  const absences = outs.length
    ? await loadAbsences(outs, { startDate: seasonStartDate(priorSeason), endDate: addDays(slateDate, -1) })
    : new Map();
  for (const o of outs) {
    const start = windowStart.get(o.team);
    const games = (absences.get(`${o.player_key}|${o.team}`) ?? []).filter(g => g.game_date >= start);
    o.absentDates = new Set(games.filter(g => !g.played).map(g => g.game_date));
    o.playedDates = new Set(games.filter(g => g.played).map(g => g.game_date));
    o.absorbed_by = [];
  }

  const outKeys = new Set(outs.map(o => `${o.player_key}|${o.team}`));
  const players = all
    .filter(p => !isOut(p.injury_status) && Number(p.projected_points) > 0)
    .map(p => {
      const team = teamOf(p);
      const key = keyOf(p);
      const isOutTonight = outKeys.has(`${key}|${team}`);
      const teamOuts = isOutTonight ? [] : outs.filter(o => o.team === team);
      const start = windowStart.get(team);
      const games = (logs.get(key) ?? []).filter(g => g.team === team && g.game_date >= start);

      const splits = teamOuts.map(o => ({
        out_key: o.player_key,
        out_name: o.name,
        ...computeSplit(games, { absent: o.absentDates, played: o.playedDates, vacatedShare: o.raw.play_share })
      }));
      teamOuts.forEach((o, i) => {
        if (splits[i].absorbed_pct === null || splits[i].sample === 'none') return;
        o.absorbed_by.push({ player_key: key, name: p.name, absorbed_pct: splits[i].absorbed_pct,
          sample: splits[i].sample, games_without: splits[i].games_without });
      });

      const set = teamOuts.length > 1
        ? {
          out_keys: teamOuts.map(o => o.player_key),
          ...computeSplit(games, {
            absent: intersect(teamOuts.map(o => o.absentDates)),
            played: intersect(teamOuts.map(o => o.playedDates)),
            vacatedShare: teamOuts.reduce((s, o) => s + (o.raw.play_share ?? 0), 0)
          })
        }
        : null;
      const combined = combineSplits(splits, set);
      const names = new Map(teamOuts.map(o => [o.player_key, o.name]));
      let adjusted = null;
      if (combined) {
        const { out_name: _name, ...rest } = combined;
        adjusted = { ...rest, out_names: combined.out_keys.map(k => names.get(k)) };
      }

      return {
        id: p.id,
        player_key: key,
        name: p.name,
        team: p.team,
        opponent: p.opponent,
        position: p.position,
        salary: p.salary,
        projected_points: p.projected_points,
        projected_minutes: p.projected_minutes ?? null,
        injury_status: p.injury_status ?? null,
        is_out: isOutTonight,
        out_teammates: teamOuts.map(o => o.name),
        split_window_start: start,
        games_in_window: games.length,
        splits,
        adjusted,
        ...(source.isBacktest
          ? { actual_points: p.actualPoints ?? null, actual_minutes: p.actualMinutes ?? null, result_status: p.resultStatus ?? null }
          : {})
      };
    })
    .sort((a, b) => (Number(b.salary) || 0) - (Number(a.salary) || 0) || String(a.name).localeCompare(String(b.name)));

  const opponents = new Map(all.map(p => [teamOf(p), canonicalTeam(p.opponent)]));
  const teamRows = teams.map(team => {
    const list = outs.filter(o => o.team === team).map(({ raw, absentDates, playedDates, ...o }) => ({
      ...o,
      absorbed_by: o.absorbed_by.sort((a, b) => b.absorbed_pct - a.absorbed_pct)
    }));
    const total = (f) => outs.filter(o => o.team === team).reduce((s, o) => s + (o.raw[f] ?? 0), 0);
    return {
      team,
      opponent: opponents.get(team) ?? null,
      out_count: list.length,
      vacated_usage: round(total('play_share'), 3),
      vacated_minutes: round(total('min_pg'), 1),
      vacated_fpts: round(total('fpts_pg'), 1),
      split_window_start: windowStart.get(team),
      out: list.sort((a, b) => (b.play_share ?? 0) - (a.play_share ?? 0))
    };
  }).sort((a, b) => b.vacated_usage - a.vacated_usage || a.team.localeCompare(b.team));

  return { slateDate, season, teams: teamRows, players };
}

/**
 * Teammate-out opportunity for a slate: { source, slateDate, season, teams,
 * players }. Slate selection as slateSource.resolveSlate (slateId,
 * slateDate - a past date is a backtest - and site). Backtest player rows
 * carry actual_points / actual_minutes / result_status.
 * Throws SlateSourceError (404 when no slate matches).
 */
export async function getTeammateOpportunity({ slateId = null, slateDate = null, site = null, now = new Date() } = {}) {
  const source = await resolveSlate({ slateId, slateDate, site, now });
  if (!source) throw new SlateSourceError('No slate synced', 404);
  let all = await loadSlatePlayers(source, { includeZero: true });
  if (source.isBacktest) all = await withActuals(source, all);
  return { source, ...await computeTeammateOpportunity(source, all, { now }) };
}

export default { getTeammateOpportunity, computeTeammateOpportunity };
