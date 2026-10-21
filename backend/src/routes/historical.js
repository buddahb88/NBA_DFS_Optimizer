/**
 * HISTORICAL DATA ROUTES
 *
 * API endpoints for fetching and analyzing historical NBA game data
 * Used for ML analysis and AI chat context
 */

import express from 'express';
import nbaStatsService from '../services/nbaStatsService.js';
import espnBoxScoreService from '../services/espnBoxScoreService.js';
import syncRunService from '../services/syncRunService.js';
import insightsService, { InsightsError } from '../services/insightsService.js';
import { resolveSite } from '../utils/resolveSite.js';
import { getCurrentSeason, getSeasonsInfo, seasonForDate } from '../utils/season.js';

const router = express.Router();

/**
 * Sync runs and progress live in sync_runs (services/syncRunService.js);
 * an unfinished run, manual or scheduled, blocks new syncs with a 409.
 */
async function rejectIfSyncing(res) {
  const running = await syncRunService.active();
  if (!running) return false;
  res.status(409).json({
    error: 'Sync already in progress',
    progress: syncRunService.toProgress(running)
  });
  return true;
}

/**
 * GET /api/historical/status
 * Check if historical data exists and if updates are needed
 * Use this to determine whether to show "Full Populate" or "Update" button
 */
router.get('/status', async (req, res) => {
  try {
    const status = await nbaStatsService.getDataStatus();
    let espn = null;
    try {
      espn = await espnBoxScoreService.getStatus();
    } catch (error) {
      console.warn('⚠️ Could not read ESPN load status:', error.message);
    }
    res.json({
      success: true,
      ...status,
      source: 'espn',
      espn,
      recommendation: status.needsFullSync
        ? 'FULL_SYNC'
        : status.needsUpdate
          ? 'INCREMENTAL_UPDATE'
          : 'UP_TO_DATE'
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/historical/seasons
 * Season list (newest first) and the current season, so clients never hardcode seasons
 */
router.get('/seasons', (req, res) => {
  res.json({ success: true, ...getSeasonsInfo() });
});

/**
 * GET /api/historical/summary
 * Get summary of historical data in database
 */
router.get('/summary', async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    const summary = await nbaStatsService.getHistoricalSummary(startDate, endDate);
    res.json({
      success: true,
      summary: {
        totalGames: summary.total_games,
        uniquePlayers: summary.unique_players,
        uniqueDates: summary.unique_dates,
        dateRange: {
          earliest: summary.earliest_game,
          latest: summary.latest_game
        },
        averages: {
          dkPoints: Math.round(summary.avg_dk_points * 10) / 10,
          minutes: Math.round(summary.avg_minutes * 10) / 10
        }
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/historical/sync
 * Sync historical box scores from ESPN (the default source).
 * Body: { seasons?: string[], season?: string, forceFullSync?: boolean,
 *         start?: 'YYYY-MM-DD', end?: 'YYYY-MM-DD', source?: 'blob' }
 * - Seasons run oldest first; the current season resumes from its latest
 *   loaded date, older seasons are walked in full and skip loaded games.
 * - forceFullSync refetches games that are already loaded.
 * - start/end sync an explicit date range instead of seasons.
 * - source: 'blob' runs the legacy Azure Blob Storage import below.
 */
router.post('/sync', async (req, res, next) => {
  if (req.body?.source === 'blob') return next();

  const { season, seasons: requested, forceFullSync = false, start, end } = req.body || {};
  const current = getCurrentSeason();
  const seasons = [...new Set(requested?.length ? requested : [season || current])].sort();
  const skipLoaded = !forceFullSync;
  const range = start && end ? `${start} → ${end}` : seasons.join(', ');

  let runId;
  try {
    if (await rejectIfSyncing(res)) return;
    runId = await syncRunService.start({ source: 'espn', season: start && end ? null : seasons.join(', ') });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }

  res.json({
    success: true,
    mode: 'espn',
    seasons,
    runId,
    message: `Started ESPN box score sync (${range}). Check /api/historical/sync/status for progress.`
  });

  setImmediate(async () => {
    const startTime = Date.now();
    const totals = { dates: 0, games: 0, rows: 0, skipped: 0, failed: [] };
    const add = (r) => {
      for (const key of ['dates', 'games', 'rows', 'skipped']) totals[key] += r[key] || 0;
      totals.failed.push(...(r.failed || []));
    };
    const onProgress = (p) => {
      syncRunService.progress(runId, totals.games + p.games).catch(() => {});
    };

    try {
      if (start && end) {
        add(await espnBoxScoreService.syncDates(start, end, { skipLoaded, onProgress }));
      } else {
        for (const s of seasons) {
          add(await espnBoxScoreService.syncSeason(s, {
            skipLoaded,
            resumeFromLatest: skipLoaded && s === current,
            onProgress
          }));
        }
      }

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`✅ ESPN sync (${range}): ${totals.games} games, ${totals.rows} player rows in ${elapsed}s` +
        (totals.failed.length ? `, ${totals.failed.length} failed` : ''));
      await syncRunService.finish(runId, {
        gamesInserted: totals.games,
        error: syncRunService.failureSummary(totals.failed)
      });
    } catch (error) {
      console.error('❌ ESPN sync error:', error);
      await syncRunService.finish(runId, { gamesInserted: totals.games, error: error.message }).catch(() => {});
    }
  });
});

/**
 * POST /api/historical/sync with { source: 'blob' }
 * Legacy: sync historical game data from Azure Blob Storage
 * The blob is updated nightly by an Azure Function that scrapes Basketball Reference
 */
router.post('/sync', async (req, res) => {
  // Azure Blob Storage URL for box scores (with SAS token for read access).
  // Read per request: this module loads before server.js calls dotenv.config().
  const blobStorageUrl = process.env.BLOB_STORAGE_URL;
  if (!blobStorageUrl) {
    return res.status(500).json({
      error: 'BLOB_STORAGE_URL environment variable is not set (see backend/.env.example)'
    });
  }

  let runId;
  try {
    if (await rejectIfSyncing(res)) return;
    runId = await syncRunService.start({ source: 'blob' });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }

  // Check current data status (only used for lastGameDate; sync can run without it)
  let status = {};
  try {
    status = await nbaStatsService.getDataStatus();
  } catch (error) {
    console.warn('⚠️ Could not read historical data status:', error.message);
  }

  // Send response IMMEDIATELY before starting background work
  res.json({
    success: true,
    mode: 'blob',
    runId,
    message: 'Started syncing from Azure Blob Storage. Check /api/historical/sync/status for progress.',
    lastGameDate: status.latestGame || null
  });

  // Run sync in background
  setImmediate(async () => {
    let imported = 0;
    try {
      const startTime = Date.now();

      // Fetch box scores from blob storage
      const response = await fetch(blobStorageUrl);
      if (!response.ok) {
        throw new Error(`Failed to fetch blob: ${response.status} ${response.statusText}`);
      }

      const boxScores = await response.json();
      console.log(`Downloaded ${boxScores.length} games from blob storage`);

      // Import games to database
      let skipped = 0;

      for (let i = 0; i < boxScores.length; i++) {
        const game = boxScores[i];
        try {
          const wasInserted = await nbaStatsService.insertGameFromBoxScore(game);
          if (wasInserted) {
            imported++;
          } else {
            skipped++;
          }
        } catch (e) {
          // Skip duplicates or errors
          skipped++;
        }

        // Update progress every 100 games
        if (i % 100 === 0) {
          await syncRunService.progress(runId, imported).catch(() => {});
        }
      }

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      await syncRunService.finish(runId, { gamesInserted: imported });

      console.log(`Sync complete: ${imported} imported, ${skipped} skipped in ${elapsed}s`);

    } catch (error) {
      console.error('Sync error:', error);
      await syncRunService.finish(runId, { gamesInserted: imported, error: error.message }).catch(() => {});
    }
  });
});

/**
 * GET /api/historical/sync/status
 * Progress of the latest sync run (manual or scheduled) plus recent runs
 * from sync_runs. Query: { limit?: number } recent runs (default 10)
 */
router.get('/sync/status', async (req, res) => {
  try {
    const runs = await syncRunService.recent(Number(req.query.limit) || 10);
    const latest = runs[0] || null;
    res.json({
      isSyncing: Boolean(latest && !latest.finished_at),
      progress: syncRunService.toProgress(latest),
      lastRun: latest,
      runs
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/historical/sync/nba-api
 * Sync historical data directly from NBA Stats API (bypasses blob storage).
 * Not the default source: nba.com is blocked from some networks; ESPN
 * (POST /sync) is canonical.
 * Body: { season?: string, fromDate?: string }
 */
router.post('/sync/nba-api', async (req, res) => {
  const { season = getCurrentSeason(), fromDate } = req.body;

  let runId;
  try {
    if (await rejectIfSyncing(res)) return;
    runId = await syncRunService.start({ source: 'nba-api', season });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }

  // Resume from the latest stored game, but only if it belongs to the requested
  // season; otherwise (e.g. backfilling an older season) do a full season sync
  let latestGame = null;
  try {
    latestGame = (await nbaStatsService.getDataStatus()).latestGame || null;
  } catch (error) {
    console.warn('⚠️ Could not read historical data status:', error.message);
  }
  // Azure SQL returns DATE columns as Date objects; game logs compare as 'YYYY-MM-DD'
  if (latestGame instanceof Date) latestGame = latestGame.toISOString().slice(0, 10);
  const latestInSeason = latestGame && seasonForDate(latestGame) === season ? latestGame : null;
  const startDate = fromDate || latestInSeason;

  res.json({
    success: true,
    mode: 'nba-api',
    runId,
    message: `Starting incremental sync from NBA Stats API. Season: ${season}, From: ${startDate || 'season start'}`,
    startDate
  });

  // Run sync in background
  setImmediate(async () => {
    try {
      const startTime = Date.now();

      // Progress callback
      const progressCallback = (progress) => {
        if (Number.isFinite(progress.games)) {
          syncRunService.progress(runId, progress.games).catch(() => {});
        }
      };

      console.log(`\n🏀 Starting NBA API sync: season=${season}, fromDate=${startDate}`);

      let result;
      if (startDate) {
        // Incremental sync from last known date
        result = await nbaStatsService.fetchIncrementalGameLogs(season, startDate, progressCallback);
      } else {
        // Full season sync
        result = await nbaStatsService.fetchSeasonGameLogs(season, progressCallback);
      }

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      await syncRunService.finish(runId, { gamesInserted: result.games || 0 });

      console.log(`✅ NBA API sync complete: ${result.games || 0} games from ${result.players || 0} players in ${elapsed}s`);

    } catch (error) {
      console.error('❌ NBA API sync error:', error);
      await syncRunService.finish(runId, { gamesInserted: 0, error: error.message }).catch(() => {});
    }
  });
});

/**
 * POST /api/historical/import
 * Manually import games from JSON array
 * Body: { games: [{player_name, team, opponent, game_date, ...}] }
 */
router.post('/import', async (req, res) => {
  const { games } = req.body;

  if (!games || !Array.isArray(games)) {
    return res.status(400).json({ error: 'games array is required' });
  }

  console.log(`\n📥 Importing ${games.length} games manually...`);

  let imported = 0;
  let skipped = 0;
  const errors = [];

  for (const game of games) {
    try {
      const wasInserted = await nbaStatsService.insertGameFromBoxScore(game);
      if (wasInserted) {
        imported++;
      } else {
        skipped++;
      }
    } catch (e) {
      errors.push({ game: game.player_name, error: e.message });
      skipped++;
    }
  }

  console.log(`✅ Import complete: ${imported} imported, ${skipped} skipped`);

  res.json({
    success: true,
    imported,
    skipped,
    total: games.length,
    errors: errors.slice(0, 10) // Only show first 10 errors
  });
});

/**
 * GET /api/historical/player/:name
 * Get historical game log for a player
 */
router.get('/player/:name', async (req, res) => {
  try {
    const { name } = req.params;
    const { limit = 20 } = req.query;

    const games = await nbaStatsService.getPlayerHistory(name, parseInt(limit));
    const trends = await nbaStatsService.getPerformanceTrends(name);

    res.json({
      success: true,
      player: name,
      trends,
      games
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/historical/matchup/:player/:opponent
 * Get player's history vs specific opponent
 */
router.get('/matchup/:player/:opponent', async (req, res) => {
  try {
    const { player, opponent } = req.params;

    const games = await nbaStatsService.getMatchupHistory(player, opponent.toUpperCase());

    if (games.length === 0) {
      return res.json({
        success: true,
        message: `No games found for ${player} vs ${opponent}`,
        games: []
      });
    }

    // Calculate averages
    const avgDkPts = games.reduce((sum, g) => sum + g.dk_fantasy_points, 0) / games.length;
    const avgMinutes = games.reduce((sum, g) => sum + g.minutes, 0) / games.length;

    res.json({
      success: true,
      player,
      opponent: opponent.toUpperCase(),
      gamesPlayed: games.length,
      averages: {
        dkPoints: Math.round(avgDkPts * 10) / 10,
        minutes: Math.round(avgMinutes * 10) / 10
      },
      games
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/historical/top-performers
 * Get top performers by average DK fantasy points
 */
router.get('/top-performers', async (req, res) => {
  try {
    const { limit = 20, minGames = 10, startDate, endDate } = req.query;

    const performers = await nbaStatsService.getTopPerformers(
      parseInt(limit),
      parseInt(minGames),
      startDate,
      endDate
    );

    res.json({
      success: true,
      count: performers.length,
      performers
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/historical/b2b-analysis
 * Analyze back-to-back impact on performance
 */
router.get('/b2b-analysis', async (req, res) => {
  try {
    const analysis = await nbaStatsService.analyzeB2BImpact();

    res.json({
      success: true,
      analysis,
      insight: analysis.length === 2
        ? `B2B games average ${(analysis.find(a => a.rest_status === 'Rested')?.avg_dk_pts - analysis.find(a => a.rest_status === 'B2B')?.avg_dk_pts).toFixed(1)} fewer DK points than rested games`
        : 'Insufficient data for B2B analysis'
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/historical/ai-context
 * Get formatted historical context for AI chat
 */
router.get('/ai-context', async (req, res) => {
  try {
    const { playerNames } = req.query;

    const summary = await nbaStatsService.getHistoricalSummary();
    const b2bAnalysis = await nbaStatsService.analyzeB2BImpact();
    const topPerformers = await nbaStatsService.getTopPerformers(10, 10);

    let playerContexts = [];
    if (playerNames) {
      const names = playerNames.split(',').map(n => n.trim());
      playerContexts = await Promise.all(names.map(async name => ({
        name,
        trends: await nbaStatsService.getPerformanceTrends(name),
        recentGames: await nbaStatsService.getPlayerHistory(name, 5)
      })));
    }

    res.json({
      success: true,
      context: {
        dataRange: {
          games: summary.total_games,
          players: summary.unique_players,
          from: summary.earliest_game,
          to: summary.latest_game
        },
        leagueAverages: {
          dkPoints: Math.round(summary.avg_dk_points * 10) / 10,
          minutes: Math.round(summary.avg_minutes * 10) / 10
        },
        b2bImpact: b2bAnalysis,
        topPerformers: topPerformers.slice(0, 5),
        playerContexts
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/historical/teammate-impact/:player/:teammate
 * Analyze player performance when a teammate is OUT
 */
router.get('/teammate-impact/:player/:teammate', async (req, res) => {
  try {
    const { player, teammate } = req.params;
    const { team } = req.query;

    const result = await nbaStatsService.getUsageWithoutTeammate(player, teammate, team);

    if (!result.success) {
      return res.json(result);
    }

    res.json({
      success: true,
      player: result.player,
      teammate: result.teammate,
      team: result.team,
      withTeammate: result.withTeammate,
      withoutTeammate: result.withoutTeammate,
      usageBump: result.usageBump,
      insight: result.usageBump
        ? `${result.player} averages ${result.usageBump.dkPointsDiff > 0 ? '+' : ''}${result.usageBump.dkPointsDiff} DK points (${result.usageBump.percentBoost > 0 ? '+' : ''}${result.usageBump.percentBoost}%) when ${result.teammate} is OUT`
        : 'Insufficient data to calculate usage bump',
      recentGamesWithout: result.recentGamesWithout
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/historical/roster-context
 * Analyze historical games with similar roster configurations
 */
router.post('/roster-context', async (req, res) => {
  try {
    const { team, activePlayers, absentPlayers } = req.body;

    if (!team || !activePlayers || !Array.isArray(activePlayers)) {
      return res.status(400).json({
        error: 'Missing required fields: team, activePlayers (array)'
      });
    }

    const result = await nbaStatsService.analyzeRosterContext(
      team.toUpperCase(),
      activePlayers,
      absentPlayers || []
    );

    res.json({
      success: true,
      team: result.team,
      scenario: {
        activePlayers: result.activePlayers,
        absentPlayers: result.absentPlayers
      },
      matchingGames: {
        count: result.matchingGamesCount,
        dates: result.matchingGameDates
      },
      usageBumps: result.usageBumps,
      topBeneficiaries: result.topBeneficiaries,
      insight: result.topBeneficiaries?.length > 0
        ? `Top beneficiaries when ${(result.absentPlayers || []).join(', ')} out: ${result.topBeneficiaries.map(p => `${p.player} (+${p.percentBoost}%)`).join(', ')}`
        : 'No significant usage bumps found in historical data'
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/historical/team-roster/:team
 * Get historical roster and averages for a team
 */
router.get('/team-roster/:team', async (req, res) => {
  try {
    const { team } = req.params;

    const roster = await nbaStatsService.getTeamRoster(team.toUpperCase());

    if (roster.length === 0) {
      return res.json({
        success: false,
        message: `No historical data found for team ${team}`
      });
    }

    res.json({
      success: true,
      team: team.toUpperCase(),
      playerCount: roster.length,
      roster: roster.map(p => ({
        name: p.player_name,
        games: p.games,
        lastGame: p.last_game,
        avgDkPoints: p.avg_dk,
        avgMinutes: p.avg_min
      }))
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/historical/teammates/:player
 * Get all teammates for a player based on historical games
 */
router.get('/teammates/:player', async (req, res) => {
  try {
    const { player } = req.params;

    const teammates = await nbaStatsService.getTeammates(player);

    res.json({
      success: true,
      player,
      teammateCount: teammates.length,
      teammates: teammates.slice(0, 20) // Top 20 by games played together
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Insights cards (services/insightsService.js) ───────────────────
// Every card takes the same options, from the query string (GET) or body (POST):
// startDate / endDate (YYYY-MM-DD) or lastNDays, site (dk | fd | yahoo, else the
// slateId's site, else DraftKings), plus limit / minGames / minAvgDk.

function readInt(value, name, fallback, { min = 1 } = {}) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min) {
    throw new InsightsError(`${name} must be an integer >= ${min}`);
  }
  return n;
}

async function insightsOptions(params, defaults) {
  const { site, error } = await resolveSite(insightsService.normalizeSite(params.site), params.slateId);
  if (error) throw new InsightsError(error);
  const opts = {
    site,
    startDate: params.startDate,
    endDate: params.endDate,
    lastNDays: params.lastNDays,
  };
  for (const [name, fallback] of Object.entries(defaults)) {
    opts[name] = readInt(params[name], name, fallback, { min: name === 'minAvgDk' ? 0 : 1 });
  }
  return opts;
}

function sendInsightsError(res, error, label) {
  if (error instanceof InsightsError) {
    return res.status(error.status).json({ error: error.message });
  }
  console.error(`Error ${label}:`, error);
  return res.status(500).json({ error: error.message });
}

/**
 * POST /api/historical/slate-insights
 * Hot/cold streaks, matchup advantages, consistency, boom candidates and
 * recent performers for the slate's players.
 * Body: { players: [{ name, team, opponent?, salary?, projected_points? }], ...window, site }
 */
router.post('/slate-insights', async (req, res) => {
  try {
    const opts = await insightsOptions(req.body || {}, {});
    const insights = await insightsService.getSlateInsights(req.body.players, opts);
    res.json({ success: true, site: opts.site, insights });
  } catch (error) {
    sendInsightsError(res, error, 'generating slate insights');
  }
});

/**
 * League-wide cards. Response keys are unchanged from the original routes.
 */
const leagueCards = [
  ['/hot-streaks', 'getHotStreaks', 'hotStreaks', 5],
  ['/cold-streaks', 'getColdStreaks', 'coldStreaks', 5],
  ['/consistency-leaders', 'getConsistencyLeaders', 'leaders', 8],
  ['/boom-bust-players', 'getBoomBustPlayers', 'players', 8],
];
for (const [route, method, key, minGames] of leagueCards) {
  router.get(route, async (req, res) => {
    try {
      const opts = await insightsOptions(req.query, { limit: 20, minGames });
      const rows = await insightsService[method](opts);
      res.json({ success: true, site: opts.site, count: rows.length, [key]: rows });
    } catch (error) {
      sendInsightsError(res, error, `loading ${route}`);
    }
  });
}

/**
 * POST /api/historical/usage-bumps
 * Slate players who score more when a regular missing from tonight's slate sits.
 * Window defaults to the last 30 days of data.
 */
router.post('/usage-bumps', async (req, res) => {
  try {
    const opts = await insightsOptions(req.body || {}, { minGames: 8, minAvgDk: 25 });
    const usageBumps = await insightsService.detectUsageBumps(req.body.players, opts);
    res.json({ success: true, site: opts.site, count: usageBumps.length, usageBumps });
  } catch (error) {
    sendInsightsError(res, error, 'detecting usage bumps');
  }
});

/**
 * POST /api/historical/missing-players
 * Regulars of each slate team who are not on tonight's slate.
 * Window defaults to the last 30 days of data.
 */
router.post('/missing-players', async (req, res) => {
  try {
    const opts = await insightsOptions(req.body || {}, { minGames: 5, minAvgDk: 20 });
    const report = await insightsService.getMissingPlayersReport(req.body.players, opts);
    res.json({ success: true, site: opts.site, teamsWithMissing: report.length, report });
  } catch (error) {
    sendInsightsError(res, error, 'getting missing players report');
  }
});

export default router;
