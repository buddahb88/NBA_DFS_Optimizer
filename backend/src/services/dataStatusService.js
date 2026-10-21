/**
 * DATA STATUS SERVICE
 *
 * One read-only report for the Data Status panel (GET /api/historical/data-status):
 * historical_games coverage per season, sync_runs history and
 * slate_player_snapshots coverage. Each section is read independently and
 * carries its own `error`, so one broken table never hides the others and a
 * failure is always shown rather than reported as "no data".
 */

import db from '../config/database.js';
import syncRunService from './syncRunService.js';
import { getCurrentSeason, listSeasons } from '../utils/season.js';

/** Azure SQL returns DATE columns as Date objects */
const dateString = value => (value instanceof Date ? value.toISOString().slice(0, 10) : value ?? null);
/** captured_at: sqlite 'YYYY-MM-DD HH:MM:SS' text, Azure SQL Date */
const timestampString = value => (value instanceof Date ? value.toISOString() : value ?? null);
const count = value => Number(value) || 0;

async function section(read) {
  try {
    return { ...(await read()), error: null };
  } catch (error) {
    console.error('❌ Data status:', error.message);
    return { error: error.message };
  }
}

async function readCoverage(now) {
  const rows = await db.all(`
    SELECT season,
      COUNT(DISTINCT game_id) AS games,
      COUNT(*) AS playerGames,
      COUNT(DISTINCT player_name) AS players,
      MIN(game_date) AS earliestGame,
      MAX(game_date) AS latestGame
    FROM historical_games
    GROUP BY season
  `);
  const totals = await db.get(`
    SELECT COUNT(DISTINCT game_id) AS games,
      COUNT(*) AS playerGames,
      COUNT(DISTINCT player_name) AS players,
      MIN(game_date) AS earliestGame,
      MAX(game_date) AS latestGame
    FROM historical_games
  `);

  const current = getCurrentSeason(now);
  const bySeason = new Map(rows.map(r => [r.season ?? null, r]));
  // Every season we sync is listed, so a season with no games shows as missing
  const seasons = [...new Set([...listSeasons(undefined, now), ...bySeason.keys()])]
    .sort((a, b) => (a === null ? 1 : b === null ? -1 : b.localeCompare(a)))
    .map(season => {
      const r = bySeason.get(season) || {};
      return {
        season,
        current: season === current,
        games: count(r.games),
        playerGames: count(r.playerGames),
        players: count(r.players),
        earliestGame: dateString(r.earliestGame),
        latestGame: dateString(r.latestGame),
      };
    });

  return {
    seasons,
    totals: {
      games: count(totals?.games),
      playerGames: count(totals?.playerGames),
      players: count(totals?.players),
      earliestGame: dateString(totals?.earliestGame),
      latestGame: dateString(totals?.latestGame),
    },
  };
}

async function readSync(limit) {
  const runs = await syncRunService.recent(limit);
  const withStatus = runs.map(run => ({ ...run, status: syncRunService.toProgress(run).status }));
  return {
    isSyncing: withStatus.some(r => r.status === 'syncing'),
    lastRun: withStatus[0] || null,
    lastSuccess: withStatus.find(r => r.status === 'complete') || null,
    lastError: withStatus.find(r => r.status === 'error') || null,
    recentRuns: withStatus,
  };
}

async function readSnapshots() {
  const totals = await db.get(`
    SELECT COUNT(*) AS rows_count,
      COUNT(DISTINCT slate_id) AS slates,
      COUNT(DISTINCT player_key) AS players,
      COUNT(DISTINCT game_date) AS gameDates,
      MIN(game_date) AS earliestGameDate,
      MAX(game_date) AS latestGameDate,
      MAX(captured_at) AS lastCapturedAt
    FROM slate_player_snapshots
  `);
  const sites = await db.all(`
    SELECT site,
      COUNT(*) AS rows_count,
      COUNT(DISTINCT slate_id) AS slates,
      COUNT(DISTINCT game_date) AS gameDates,
      MAX(game_date) AS latestGameDate
    FROM slate_player_snapshots
    GROUP BY site
    ORDER BY site
  `);
  return {
    rows: count(totals?.rows_count),
    slates: count(totals?.slates),
    players: count(totals?.players),
    gameDates: count(totals?.gameDates),
    earliestGameDate: dateString(totals?.earliestGameDate),
    latestGameDate: dateString(totals?.latestGameDate),
    lastCapturedAt: timestampString(totals?.lastCapturedAt),
    bySite: sites.map(s => ({
      site: s.site,
      rows: count(s.rows_count),
      slates: count(s.slates),
      gameDates: count(s.gameDates),
      latestGameDate: dateString(s.latestGameDate),
    })),
  };
}

class DataStatusService {
  async getDataStatus({ now = new Date(), runLimit = 10 } = {}) {
    const [coverage, sync, snapshots] = await Promise.all([
      section(() => readCoverage(now)),
      section(() => readSync(runLimit)),
      section(() => readSnapshots()),
    ]);
    return { currentSeason: getCurrentSeason(now), coverage, sync, snapshots };
  }
}

export default new DataStatusService();
