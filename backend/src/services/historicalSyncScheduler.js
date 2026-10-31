/**
 * HISTORICAL SYNC SCHEDULER
 *
 * Keeps historical_games current without the manual sync button: once at
 * server start and on the HISTORICAL_SYNC_CRON schedule (server local time,
 * DEFAULT_SYNC_CRON when unset, 'off' disables), load every completed game
 * from the latest stored game_date through yesterday from ESPN. Missed days
 * are caught up on the next run. Each season walked is recorded in
 * sync_runs as source 'espn-scheduled'. Afterwards each season that gained
 * games has its derived tables rebuilt (refreshSeasonDerived).
 */

import cron from 'node-cron';
import db from '../config/database.js';
import espnBoxScoreService from './espnBoxScoreService.js';
import syncRunService from './syncRunService.js';
import { refreshSeasonDefense } from './archetypeDefenseService.js';
import { refreshSeasonProfiles } from './playerProfileService.js';
import { refreshSeasonArchetypes } from './archetypeService.js';
import { refreshTeamRatings } from './teamRatingsService.js';
import { getCurrentSeason, listSeasons, previousSeason, seasonForDate } from '../utils/season.js';

export const SCHEDULED_SOURCE = 'espn-scheduled';

/** Hourly at :30, so a finished game day is loaded within the hour once it is "yesterday" */
export const DEFAULT_SYNC_CRON = '30 * * * *';

/** The cron expression from env: DEFAULT_SYNC_CRON when unset or empty, null for 'off' */
export function scheduleExpression(env = process.env) {
  const value = (env.HISTORICAL_SYNC_CRON || '').trim();
  if (!value) return DEFAULT_SYNC_CRON;
  return value.toLowerCase() === 'off' ? null : value;
}

/**
 * Rebuild the box-score-derived tables for one season, in dependency order:
 * player_season_profiles -> player_archetypes (classified from profiles) ->
 * team_archetype_defense (grouped by archetype), then the current season's
 * team_defense_rankings (pace / efficiency; last season is its early-season
 * prior, so either season's games change it). The opportunity metrics
 * cache is cleared by syncRunService.finish.
 */
export async function refreshSeasonDerived(season) {
  const profiles = await refreshSeasonProfiles(season);
  const archetypes = await refreshSeasonArchetypes(season);
  const defense = await refreshSeasonDefense(season);
  const current = getCurrentSeason();
  const ratings = season === current || season === previousSeason(current) ? await refreshTeamRatings({ season: current }) : null;
  return { season, profiles: profiles.players, archetypes: archetypes.players, defense: defense.rows, teamRatings: ratings?.teams ?? 0 };
}

/** Azure SQL returns DATE columns as Date objects */
const dateString = value => (value instanceof Date ? value.toISOString().slice(0, 10) : value ?? null);

/**
 * Date ranges to load, one per season, from `lastLoaded` (inclusive, so a
 * partially loaded day is finished) through yesterday. Offseason dates are
 * skipped; with nothing loaded, the current season starts at opening night.
 */
export function catchUpRanges(lastLoaded, now = new Date()) {
  const seasons = listSeasons(lastLoaded ? seasonForDate(lastLoaded) : undefined, now).reverse();
  const ranges = [];
  for (const season of lastLoaded ? seasons : seasons.slice(-1)) {
    const range = espnBoxScoreService.seasonDateRange(season, now);
    if (!range) continue;
    let [start, end] = range;
    if (lastLoaded && lastLoaded > start) start = lastLoaded;
    if (start <= end) ranges.push({ season, start, end });
  }
  return ranges;
}

async function lastLoadedGameDate() {
  const row = await db.get('SELECT MAX(game_date) AS latest FROM historical_games');
  return dateString(row?.latest);
}

/**
 * Load all completed games since the last loaded game_date, then refresh
 * the derived tables of each season that gained games (or whose sync failed
 * partway). Returns the sync_runs ids
 * written ([] when already current), or null when another sync is running.
 * source: the sync_runs source (the Data Status panel's "Sync now" passes
 * 'espn'); onRunStart(id) is called as each season's run is recorded.
 */
export async function runIncrementalSync({
  now = new Date(),
  refreshDerived = refreshSeasonDerived,
  source = SCHEDULED_SOURCE,
  onRunStart,
} = {}) {
  const running = await syncRunService.active();
  if (running) {
    console.log(`⏭️ Scheduled historical sync skipped: ${running.source} sync #${running.id} is running`);
    return null;
  }

  const ranges = catchUpRanges(await lastLoadedGameDate(), now);
  if (ranges.length === 0) {
    console.log('✅ Scheduled historical sync: historical_games is up to date');
    return [];
  }

  const runIds = [];
  for (const { season, start, end } of ranges) {
    const id = await syncRunService.start({ source, season });
    runIds.push(id);
    onRunStart?.(id);
    let changed = true;
    try {
      const result = await espnBoxScoreService.syncDates(start, end, {
        skipLoaded: true,
        onProgress: p => syncRunService.progress(id, p.games).catch(() => {}),
      });
      changed = result.games > 0 || result.failed.length > 0;
      await syncRunService.finish(id, {
        gamesInserted: result.games,
        error: syncRunService.failureSummary(result.failed),
      });
    } catch (error) {
      console.error(`❌ ${source} historical sync ${season} failed:`, error.message);
      await syncRunService.finish(id, { gamesInserted: 0, error: error.message });
    }
    if (!changed) continue;
    try {
      const refreshed = await refreshDerived(season);
      if (refreshed?.season) {
        console.log(`✓ ${season} derived tables: ${refreshed.profiles} profiles, ${refreshed.archetypes} archetypes, ${refreshed.defense} defense rows, ${refreshed.teamRatings} team ratings`);
      }
    } catch (error) {
      console.error(`❌ Derived table refresh ${season} failed:`, error.message);
    }
  }
  return runIds;
}

/**
 * Start the scheduled sync: scheduleExpression() from env unless
 * `expression` is given, never from env under tests. runOnStart also runs
 * one catch-up immediately, so days missed while the server was down are
 * loaded at startup. Returns the cron task, or null when off.
 */
export function startHistoricalSyncScheduler({ expression, run = runIncrementalSync, runOnStart = false } = {}) {
  if (expression === undefined && process.env.NODE_ENV !== 'test' && !process.env.VITEST) {
    expression = scheduleExpression();
  }
  if (!expression) return null;
  if (!cron.validate(expression)) {
    console.warn(`⚠️ HISTORICAL_SYNC_CRON "${expression}" is not a valid cron expression; scheduled sync disabled`);
    return null;
  }

  const runSafely = async () => {
    try {
      await run();
    } catch (error) {
      console.error('❌ Scheduled historical sync error:', error);
    }
  };

  console.log(`⏰ Scheduled historical sync (ESPN): ${expression}${runOnStart ? ' (catching up now)' : ''}`);
  const task = cron.schedule(expression, runSafely, { name: 'historical-sync', noOverlap: true });
  if (runOnStart) runSafely();
  return task;
}
