/**
 * HISTORICAL DATA ROUTES
 *
 * API endpoints for fetching and analyzing historical NBA game data
 * Used for ML analysis and AI chat context
 */

import express from 'express';
import nbaStatsService from '../services/nbaStatsService.js';

const router = express.Router();

// Track sync progress
let syncProgress = null;
let isSyncing = false;

/**
 * GET /api/historical/summary
 * Get summary of historical data in database
 */
router.get('/summary', (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    const summary = nbaStatsService.getHistoricalSummary(startDate, endDate);
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
 * Start syncing historical game data from NBA.com
 */
router.post('/sync', async (req, res) => {
  if (isSyncing) {
    return res.status(409).json({
      error: 'Sync already in progress',
      progress: syncProgress
    });
  }

  const { season = '2024-25' } = req.body;

  // Start sync in background
  isSyncing = true;
  syncProgress = { status: 'starting', processed: 0, total: 0, games: 0 };

  res.json({
    success: true,
    message: `Started syncing ${season} season data. Check /api/historical/sync/status for progress.`
  });

  // Run sync
  try {
    const result = await nbaStatsService.fetchSeasonGameLogs(season, (progress) => {
      syncProgress = {
        status: 'syncing',
        ...progress,
        percent: Math.round((progress.processed / progress.total) * 100)
      };
    });

    syncProgress = {
      status: 'complete',
      ...result
    };
  } catch (error) {
    syncProgress = {
      status: 'error',
      error: error.message
    };
  } finally {
    isSyncing = false;
  }
});

/**
 * GET /api/historical/sync/status
 * Get current sync progress
 */
router.get('/sync/status', (req, res) => {
  res.json({
    isSyncing,
    progress: syncProgress
  });
});

/**
 * GET /api/historical/player/:name
 * Get historical game log for a player
 */
router.get('/player/:name', (req, res) => {
  try {
    const { name } = req.params;
    const { limit = 20 } = req.query;

    const games = nbaStatsService.getPlayerHistory(name, parseInt(limit));
    const trends = nbaStatsService.getPerformanceTrends(name);

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
router.get('/matchup/:player/:opponent', (req, res) => {
  try {
    const { player, opponent } = req.params;

    const games = nbaStatsService.getMatchupHistory(player, opponent.toUpperCase());

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
router.get('/top-performers', (req, res) => {
  try {
    const { limit = 20, minGames = 10, startDate, endDate } = req.query;

    const performers = nbaStatsService.getTopPerformers(
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
router.get('/b2b-analysis', (req, res) => {
  try {
    const analysis = nbaStatsService.analyzeB2BImpact();

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
router.get('/ai-context', (req, res) => {
  try {
    const { playerNames } = req.query;

    const summary = nbaStatsService.getHistoricalSummary();
    const b2bAnalysis = nbaStatsService.analyzeB2BImpact();
    const topPerformers = nbaStatsService.getTopPerformers(10, 10);

    let playerContexts = [];
    if (playerNames) {
      const names = playerNames.split(',').map(n => n.trim());
      playerContexts = names.map(name => ({
        name,
        trends: nbaStatsService.getPerformanceTrends(name),
        recentGames: nbaStatsService.getPlayerHistory(name, 5)
      }));
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
router.get('/teammate-impact/:player/:teammate', (req, res) => {
  try {
    const { player, teammate } = req.params;
    const { team } = req.query;

    const result = nbaStatsService.getUsageWithoutTeammate(player, teammate, team);

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
router.post('/roster-context', (req, res) => {
  try {
    const { team, activePlayers, absentPlayers } = req.body;

    if (!team || !activePlayers || !Array.isArray(activePlayers)) {
      return res.status(400).json({
        error: 'Missing required fields: team, activePlayers (array)'
      });
    }

    const result = nbaStatsService.analyzeRosterContext(
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
router.get('/team-roster/:team', (req, res) => {
  try {
    const { team } = req.params;

    const roster = nbaStatsService.getTeamRoster(team.toUpperCase());

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
router.get('/teammates/:player', (req, res) => {
  try {
    const { player } = req.params;

    const teammates = nbaStatsService.getTeammates(player);

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

/**
 * POST /api/historical/slate-insights
 * Analyze all players in the current slate against historical data
 * Returns KPIs: hot streaks, usage bumps, matchup advantages, etc.
 */
router.post('/slate-insights', (req, res) => {
  try {
    const { players, startDate, endDate } = req.body;

    if (!players || !Array.isArray(players) || players.length === 0) {
      return res.status(400).json({ error: 'players array is required' });
    }

    const insights = nbaStatsService.getSlateInsights(players, startDate, endDate);

    res.json({
      success: true,
      insights
    });
  } catch (error) {
    console.error('Error generating slate insights:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/historical/hot-streaks
 * Get players currently on hot streaks (above average recent performance)
 */
router.get('/hot-streaks', (req, res) => {
  try {
    const { limit = 20, minGames = 5, startDate, endDate } = req.query;

    const hotStreaks = nbaStatsService.getHotStreaks(parseInt(limit), parseInt(minGames), startDate, endDate);

    res.json({
      success: true,
      count: hotStreaks.length,
      hotStreaks
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/historical/cold-streaks
 * Get players currently underperforming (below average recent performance)
 */
router.get('/cold-streaks', (req, res) => {
  try {
    const { limit = 20, minGames = 5, startDate, endDate } = req.query;

    const coldStreaks = nbaStatsService.getColdStreaks(parseInt(limit), parseInt(minGames), startDate, endDate);

    res.json({
      success: true,
      count: coldStreaks.length,
      coldStreaks
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/historical/consistency-leaders
 * Get most consistent performers (low variance in DK points)
 */
router.get('/consistency-leaders', (req, res) => {
  try {
    const { limit = 20, minGames = 8, startDate, endDate } = req.query;

    const leaders = nbaStatsService.getConsistencyLeaders(parseInt(limit), parseInt(minGames), startDate, endDate);

    res.json({
      success: true,
      count: leaders.length,
      leaders
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/historical/boom-bust-players
 * Get high-variance players good for GPP tournaments
 */
router.get('/boom-bust-players', (req, res) => {
  try {
    const { limit = 20, minGames = 8, startDate, endDate } = req.query;

    const players = nbaStatsService.getBoomBustPlayers(parseInt(limit), parseInt(minGames), startDate, endDate);

    res.json({
      success: true,
      count: players.length,
      players
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/historical/usage-bumps
 * Detect players who may benefit from missing teammates
 * Compares tonight's slate roster against historical data to find missing high-usage players
 */
router.post('/usage-bumps', (req, res) => {
  try {
    const { players, minGames = 8, minAvgDk = 25 } = req.body;

    if (!players || !Array.isArray(players) || players.length === 0) {
      return res.status(400).json({ error: 'players array is required' });
    }

    const usageBumps = nbaStatsService.detectUsageBumps(
      players,
      parseInt(minGames),
      parseInt(minAvgDk)
    );

    res.json({
      success: true,
      count: usageBumps.length,
      usageBumps
    });
  } catch (error) {
    console.error('Error detecting usage bumps:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/historical/missing-players
 * Get report of high-usage players missing from tonight's slate
 */
router.post('/missing-players', (req, res) => {
  try {
    const { players, minGames = 5, minAvgDk = 20 } = req.body;

    if (!players || !Array.isArray(players) || players.length === 0) {
      return res.status(400).json({ error: 'players array is required' });
    }

    const report = nbaStatsService.getMissingPlayersReport(
      players,
      parseInt(minGames),
      parseInt(minAvgDk)
    );

    res.json({
      success: true,
      teamsWithMissing: report.length,
      report
    });
  } catch (error) {
    console.error('Error getting missing players report:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
