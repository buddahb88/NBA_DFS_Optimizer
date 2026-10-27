/**
 * OPPORTUNITY METRICS SERVICE
 *
 * One row of opportunity metrics per slate player (playerMetrics.js for the
 * player's game log, teamContext.js for rest / pace / Vegas environment,
 * rateProjection.js for the rate projection vs the posted one - with O2's
 * teammate-out split for pre-lock outs - and salaryLag.js for salary vs
 * recent production), for the live slate or a past one (Backtest, via
 * slateSource).
 *
 * No lookahead: only games (and earlier slates' salaries) before the slate
 * date are read, so a backtest date sees what was known that morning.
 * Backtest rows also carry the night's actual_points / actual_minutes /
 * result_status.
 *
 * Set-based queries per slate (player game logs with team totals, team
 * schedules, league pace, earlier slates' salaries, and O2's teammate
 * queries), chunked for Azure SQL's parameter cap. The history-derived
 * part is cached in memory per slate + date + site (slate fields such as
 * projections, minutes, ownership and Vegas lines are re-read on every
 * request; a changed player list, salary or injury status recomputes):
 * primeOpportunityMetrics()
 * refreshes the live slate after a sync, clearOpportunityCache() drops
 * everything after new box scores load; backtest dates are computed on
 * first request.
 */

import db from '../../config/database.js';
import { fantasyPointsColumn } from '../scoring.js';
import { GAME_ROWS_SELECT } from '../playerProfileService.js';
import { resolveSlate, loadSlatePlayers, withActuals, SlateSourceError } from '../slateSource.js';
import { easternDate } from '../slateSnapshotService.js';
import { playerKey, canonicalTeam } from '../../utils/playerKey.js';
import { seasonForDate, previousSeason } from '../../utils/season.js';
import { computePlayerMetrics } from './playerMetrics.js';
import { computeTeamContext, gameEnvironment } from './teamContext.js';
import { blendFppm, rateProjection } from './rateProjection.js';
import { loadSalaryHistory, computeSalaryLag } from './salaryLag.js';
import { computeTeammateOpportunity } from './teammateService.js';

// Azure SQL caps parameters at 2100
const CHUNK = 500;
const CACHE_LIMIT = 50;
const DAY_MS = 86400000;

const cache = new Map();

// Azure returns DATE columns as Date objects
const toDateStr = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : v ? String(v).slice(0, 10) : null);
const daysBetween = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);

async function chunked(values, query) {
  const out = [];
  for (let i = 0; i < values.length; i += CHUNK) out.push(...await query(values.slice(i, i + CHUNK)));
  return out;
}

const groupBy = (rows, key) => {
  const map = new Map();
  for (const row of rows) {
    let list = map.get(row[key]);
    if (!list) map.set(row[key], (list = []));
    list.push(row);
  }
  return map;
};

/**
 * Regular-season games (minutes > 0) before `beforeDate` in `seasons`, with
 * team totals and `fp` = the site's fantasy points.
 * Map(player_key -> rows, most recent first).
 */
export async function loadPlayerGames(keys, { beforeDate, seasons, site }) {
  const col = fantasyPointsColumn(site);
  const rows = await chunked([...new Set(keys.filter(Boolean))], (chunk) => db.all(`${GAME_ROWS_SELECT}
    WHERE h.player_key IN (${chunk.map(() => '?').join(', ')})
      AND h.season IN (${seasons.map(() => '?').join(', ')})
      AND COALESCE(h.season_type, 'regular') = 'regular' AND h.minutes > 0
      AND h.game_date < ?
    ORDER BY h.player_key, h.game_date DESC`, ...chunk, ...seasons, beforeDate));
  return groupBy(rows.map(r => ({ ...r, game_date: toDateStr(r.game_date), fp: r[col] })), 'player_key');
}

/** Team schedules (team_game_stats) before `beforeDate`: Map(team -> rows, most recent first). */
export async function loadTeamGames(teams, { beforeDate, seasons }) {
  const rows = await chunked([...new Set(teams.filter(Boolean))], (chunk) => db.all(`
    SELECT team, season, game_date, possessions FROM team_game_stats
    WHERE team IN (${chunk.map(() => '?').join(', ')})
      AND season IN (${seasons.map(() => '?').join(', ')})
      AND COALESCE(season_type, 'regular') = 'regular'
      AND game_date < ?
    ORDER BY team, game_date DESC`, ...chunk, ...seasons, beforeDate));
  return groupBy(rows.map(r => ({ ...r, game_date: toDateStr(r.game_date) })), 'team');
}

// League pace needs this many team games in the season, else last season's
export const LEAGUE_PACE_MIN_GAMES = 50;

/** Average possessions per team game before `beforeDate`: this season, last season's under LEAGUE_PACE_MIN_GAMES. */
export async function loadLeaguePace({ beforeDate, season }) {
  const rows = await db.all(`
    SELECT season, COUNT(*) AS games, AVG(possessions) AS pace FROM team_game_stats
    WHERE season IN (?, ?) AND COALESCE(season_type, 'regular') = 'regular'
      AND game_date < ? AND possessions > 0
    GROUP BY season`, season, previousSeason(season), beforeDate);
  const bySeason = new Map(rows.map(r => [r.season, r]));
  const current = bySeason.get(season);
  const row = Number(current?.games) >= LEAGUE_PACE_MIN_GAMES ? current : bySeason.get(previousSeason(season)) ?? current;
  return row?.pace === null || row?.pace === undefined ? null : Number(row.pace);
}

const keyOf = (p) => p.player_key ?? playerKey(p.name);
const teamOf = (p) => canonicalTeam(p.team);
const oppOf = (p) => canonicalTeam(p.opponent);

/** What the cached history depends on from the slate: players, salaries, injury statuses. */
const signature = (players) =>
  players.map(p => `${keyOf(p)}|${p.salary}|${p.injury_status ?? ''}`).sort().join(',');

/**
 * The history-derived part of a slate's metrics (what the cache holds):
 * { slateDate, season, signature, leaguePace, players: Map(player_key ->
 * { metrics, fppm, salaryLag, adjusted }), teams: Map(team -> computeTeamContext) }.
 * all: every slate player including ruled-out ones (who is out); defaults
 * to players.
 */
export async function computeHistory(source, players, { now = new Date(), all = players } = {}) {
  const slateDate = source.slateDate ?? easternDate(now);
  const season = seasonForDate(slateDate);
  const seasons = [season, previousSeason(season)];
  const teamList = [...new Set(players.flatMap(p => [teamOf(p), oppOf(p)]).filter(Boolean))];
  const keys = players.map(keyOf);
  const [logs, schedules, leaguePace, salaries, teammates] = await Promise.all([
    loadPlayerGames(keys, { beforeDate: slateDate, seasons, site: source.site }),
    loadTeamGames(teamList, { beforeDate: slateDate, seasons }),
    loadLeaguePace({ beforeDate: slateDate, season }),
    loadSalaryHistory(keys, { site: source.site, beforeDate: slateDate }),
    // Pre-lock outs only, also in a backtest: the projection must not see the night's results
    computeTeammateOpportunity(source, all, { now, prelockOnly: true })
  ]);
  const adjusted = new Map(teammates.players.map(p => [p.player_key, p.adjusted]));
  const vacated = new Map(teammates.teams.map(t => [t.team, {
    team_vacated_usage: t.vacated_usage, team_out_names: t.out.map(o => o.name)
  }]));

  const teams = new Map(teamList.map(t => [t, computeTeamContext(schedules.get(t) ?? [], { season, slateDate })]));
  const byKey = new Map(players.map(p => {
    const games = logs.get(keyOf(p)) ?? [];
    return [keyOf(p), {
      metrics: computePlayerMetrics(games, { season, salary: Number(p.salary) || null }),
      fppm: blendFppm(games, { season }),
      salaryLag: computeSalaryLag({ salary: p.salary, history: salaries.get(keyOf(p)) ?? [], games }),
      adjusted: adjusted.get(keyOf(p)) ?? null
    }];
  }));
  return { slateDate, season, signature: signature(players), leaguePace, players: byKey, teams, vacated };
}

/** O2's combined split for the row: who is out, the sample, and what the player absorbs. */
function teammateFields(adjusted) {
  return {
    teammate_out_names: adjusted?.out_names ?? [],
    teammate_sample: adjusted?.sample ?? null,
    teammate_games_without: adjusted?.games_without ?? null,
    teammate_min_delta: adjusted?.min_delta ?? null,
    teammate_usg_delta: adjusted?.usg_delta ?? null,
    teammate_play_share_delta: adjusted && adjusted.play_share_without !== null && adjusted.play_share_with !== null
      ? Number((adjusted.play_share_without - adjusted.play_share_with).toFixed(3)) + 0
      : null,
    teammate_absorbed_pct: adjusted?.absorbed_pct ?? null
  };
}

/** Whether cached history still covers these slate players (same players, salaries and statuses). */
const covers = (history, players) => history.signature === signature(players);

/** Response rows: slate fields as of now, history metrics, environment, and actuals (backtest). */
function buildRows(source, players, history) {
  const rows = players.map(p => {
    const { metrics, fppm, salaryLag, adjusted } = history.players.get(keyOf(p));
    const team = history.teams.get(teamOf(p)) ?? null;
    const environment = gameEnvironment(p, team, history.teams.get(oppOf(p)) ?? null);
    return {
      id: p.id,
      player_key: keyOf(p),
      name: p.name,
      team: p.team,
      opponent: p.opponent,
      position: p.position,
      headshot: p.headshot ?? null,
      salary: p.salary,
      projected_points: p.projected_points,
      projected_minutes: p.projected_minutes ?? null,
      // Projection sanity layer (slateSource): the posted value and why it moved
      ...(p.projection_sanity ? {
        projection_raw: p.projection_raw,
        projection_adjustment: p.projection_adjustment,
        projection_reasons: p.projection_reasons,
        projection_sanity: true
      } : {}),
      rostership: p.rostership ?? null,
      floor: p.floor ?? null,
      ceiling: p.ceiling ?? null,
      injury_status: p.injury_status ?? null,
      ...metrics,
      days_since_last_game: metrics.last_game_date ? daysBetween(metrics.last_game_date, history.slateDate) : null,
      rest_days: team?.rest_days ?? null,
      back_to_back: team?.back_to_back ?? null,
      ...environment,
      league_pace: history.leaguePace === null ? null : Number(history.leaguePace.toFixed(1)),
      ...rateProjection({
        fppm,
        projectedMinutes: p.projected_minutes,
        projectedPoints: p.projected_points,
        salary: p.salary,
        impliedTotal: environment.implied_total,
        paceProxy: environment.pace_proxy,
        leaguePace: history.leaguePace,
        adjusted
      }),
      ...salaryLag,
      ...teammateFields(adjusted),
      ...(history.vacated?.get(teamOf(p)) ?? { team_vacated_usage: 0, team_out_names: [] }),
      ...(source.isBacktest
        ? { actual_points: p.actualPoints ?? null, actual_minutes: p.actualMinutes ?? null, result_status: p.resultStatus ?? null }
        : {})
    };
  });
  return rows.sort((a, b) => (Number(b.salary) || 0) - (Number(a.salary) || 0) || String(a.name).localeCompare(String(b.name)));
}

const cacheKey = (source) => `${source.slateId}|${source.slateDate ?? ''}|${source.site}`;

function remember(key, entry) {
  cache.delete(key);
  cache.set(key, entry);
  while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
}

/**
 * Opportunity metrics for a slate: { source, slateDate, season, computedAt,
 * cached, players }. Slate selection as slateSource.resolveSlate (slateId,
 * slateDate - a past date is a backtest - and site). refresh: recompute.
 * Throws SlateSourceError (404 when no slate matches).
 */
export async function getOpportunityMetrics({ slateId = null, slateDate = null, site = null, refresh = false, now = new Date() } = {}) {
  const source = await resolveSlate({ slateId, slateDate, site, now });
  if (!source) throw new SlateSourceError('No slate synced', 404);

  let players = await loadSlatePlayers(source);
  if (source.isBacktest) players = await withActuals(source, players);

  const key = cacheKey(source);
  let history = refresh ? null : cache.get(key);
  const cached = Boolean(history && covers(history, players));
  if (!cached) {
    const all = await loadSlatePlayers(source, { includeZero: true });
    history = { ...await computeHistory(source, players, { now, all }), computedAt: new Date().toISOString() };
    remember(key, history);
  }
  return {
    source,
    slateDate: history.slateDate,
    season: history.season,
    computedAt: history.computedAt,
    cached,
    players: buildRows(source, players, history)
  };
}

/**
 * Recompute and cache a slate's metrics (after a sync). Never throws: a
 * failure is logged and returns null, so the sync itself still succeeds.
 */
export async function primeOpportunityMetrics(slateId, { now = new Date() } = {}) {
  try {
    return await getOpportunityMetrics({ slateId, refresh: true, now });
  } catch (error) {
    console.warn(`  Opportunity metrics for slate ${slateId} not precomputed: ${error.message}`);
    return null;
  }
}

/** Drop every cached slate (new box scores change every slate on or after them). */
export function clearOpportunityCache() {
  cache.clear();
}

export default { getOpportunityMetrics, primeOpportunityMetrics, clearOpportunityCache, computeHistory };
