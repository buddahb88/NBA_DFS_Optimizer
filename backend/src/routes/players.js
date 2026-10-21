import express from 'express';
import playerModel from '../models/playerModel.js';
import slateModel from '../models/slateModel.js';
import rotowireService from '../services/rotowireService.js';
import espnScraperService from '../services/espnScraperService.js';
import hashtagBasketballService from '../services/hashtagBasketballService.js';
import projectionService from '../services/projectionService.js';
import { snapshotAllSlates, snapshotSlate } from '../services/slateSnapshotService.js';
import { DEFAULT_SITE, isValidSite } from '../config/sites.js';

const router = express.Router();

// Get players for a slate
router.get('/:slateId', async (req, res) => {
  try {
    const { slateId } = req.params;
    const { position, minSalary, maxSalary, team } = req.query;

    const filters = {};
    if (position) filters.position = position;
    if (minSalary) filters.minSalary = parseInt(minSalary);
    if (maxSalary) filters.maxSalary = parseInt(maxSalary);
    if (team) filters.team = team;

    const players = await playerModel.getBySlateId(slateId, filters);
    res.json(players);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Fetch and sync players from RotoWire
router.post('/:slateId/sync', async (req, res) => {
  try {
    const { slateId } = req.params;

    // STEP 1: Fetch fresh defense rankings from ESPN and Hashtag Basketball
    console.log(`🔄 Step 1/4: Fetching overall team defense rankings from ESPN...`);
    try {
      await espnScraperService.fetchAndStoreDefenseRankings();
    } catch (error) {
      console.warn('⚠️  Failed to fetch ESPN defense rankings, continuing with cached data:', error.message);
    }

    console.log(`🔄 Step 2/4: Fetching position-specific defense rankings from Hashtag Basketball...`);
    try {
      await hashtagBasketballService.fetchAndStorePositionDefense();
    } catch (error) {
      console.warn('⚠️  Failed to fetch position defense rankings, continuing with cached data:', error.message);
    }

    // STEP 2: Fetch players from RotoWire (will use fresh defense rankings in projections)
    console.log(`🔄 Step 3/4: Fetching players for slate ${slateId} from RotoWire...`);
    const players = await rotowireService.fetchPlayers(slateId);

    console.log(`📊 Received ${players.length} active players (filtered out 0 projection players)`);

    if (!players || players.length === 0) {
      return res.status(404).json({ error: 'No active players found for this slate (all players may have 0 projections)' });
    }

    // STEP 4: Clear existing data and store new slate + players
    console.log(`🔄 Step 4/4: Storing slate and player data...`);

    // Keep the outgoing salaries/projections/ownership before they are wiped
    const preserved = await snapshotAllSlates();
    console.log(`  📸 Snapshotted ${preserved} player row(s) before clearing`);

    // Clear all existing slates and players (single active slate model)
    console.log(`  🗑️  Clearing existing slate data...`);
    await playerModel.deleteAll();
    await slateModel.deleteAll();

    // Create the new slate
    await slateModel.createOrUpdate({
      slateId,
      name: req.body.name || `NBA Slate ${slateId}`,
      sport: 'NBA',
      startTime: req.body.startTime || null
    });

    // Bulk insert players (with defense-adjusted projections)
    await playerModel.bulkCreateOrUpdate(slateId, players);
    await snapshotSlate(slateId);

    console.log(`✅ Complete! Synced ${players.length} players with matchup-adjusted projections (overall defense + pace + position defense)`);

    const syncedPlayers = await playerModel.getBySlateId(slateId);
    res.json({
      message: 'Players synced successfully',
      count: players.length,
      players: syncedPlayers
    });
  } catch (error) {
    console.error('Sync error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get a specific player
router.get('/player/:id', async (req, res) => {
  try {
    const player = await playerModel.getById(req.params.id);
    if (!player) {
      return res.status(404).json({ error: 'Player not found' });
    }
    res.json(player);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// PROJECTION RECALCULATION ENDPOINTS
// ═══════════════════════════════════════════════════════════════

/**
 * Recalculate projections for a slate using our adjustment factors
 * POST /api/players/:slateId/recalculate-projections
 */
router.post('/:slateId/recalculate-projections', async (req, res) => {
  try {
    const { slateId } = req.params;

    console.log(`\n🧮 ═══════════════════════════════════════════════════`);
    console.log(`   RECALCULATING PROJECTIONS FOR SLATE ${slateId}`);
    console.log(`═══════════════════════════════════════════════════════`);

    // Get all players with full data
    const players = await playerModel.getAllForProjections(slateId);

    if (!players || players.length === 0) {
      return res.status(404).json({ error: 'No players found for this slate' });
    }

    console.log(`📊 Found ${players.length} players to process`);

    // Calculate adjusted projections for each player
    const projectionResults = [];
    let totalBaseline = 0;
    let totalAdjusted = 0;

    for (const player of players) {
      const result = await projectionService.calculateAdjustedProjection(player);

      projectionResults.push({
        player_id: player.player_id,
        name: player.name,
        team: player.team,
        opponent: player.opponent,
        position: player.position,
        salary: player.salary,
        baseline: result.baseline,
        adjusted_projection: result.adjusted_projection,
        total_adjustment: result.total_adjustment,
        adjustments: result.adjustments,
        floor: result.baseline * 0.75, // Simple floor calculation
        ceiling: result.baseline * 1.25 // Simple ceiling calculation
      });

      totalBaseline += result.baseline;
      totalAdjusted += result.adjusted_projection;

      // Log significant adjustments
      if (Math.abs(result.total_adjustment) >= 1.5) {
        const direction = result.total_adjustment > 0 ? '📈' : '📉';
        console.log(`${direction} ${player.name}: ${result.baseline.toFixed(1)} → ${result.adjusted_projection.toFixed(1)} (${result.total_adjustment > 0 ? '+' : ''}${result.total_adjustment.toFixed(1)})`);
      }
    }

    // Update database with new projections
    const updated = await playerModel.bulkUpdateProjections(slateId, projectionResults);

    console.log(`\n✅ Projection recalculation complete!`);
    console.log(`   📊 Players updated: ${updated}`);
    console.log(`   📈 Avg baseline: ${(totalBaseline / players.length).toFixed(1)}`);
    console.log(`   📊 Avg adjusted: ${(totalAdjusted / players.length).toFixed(1)}`);

    // Return summary with top adjustments
    const topUp = projectionResults
      .filter(p => p.total_adjustment > 0)
      .sort((a, b) => b.total_adjustment - a.total_adjustment)
      .slice(0, 10);

    const topDown = projectionResults
      .filter(p => p.total_adjustment < 0)
      .sort((a, b) => a.total_adjustment - b.total_adjustment)
      .slice(0, 10);

    res.json({
      success: true,
      message: `Recalculated projections for ${updated} players`,
      summary: {
        totalPlayers: players.length,
        avgBaseline: Math.round(totalBaseline / players.length * 10) / 10,
        avgAdjusted: Math.round(totalAdjusted / players.length * 10) / 10,
        avgAdjustment: Math.round((totalAdjusted - totalBaseline) / players.length * 10) / 10
      },
      topAdjustmentsUp: topUp.map(p => ({
        name: p.name,
        team: p.team,
        opponent: p.opponent,
        baseline: p.baseline,
        adjusted: p.adjusted_projection,
        adjustment: p.total_adjustment,
        factors: projectionService.getAdjustmentExplanation(p.adjustments)
      })),
      topAdjustmentsDown: topDown.map(p => ({
        name: p.name,
        team: p.team,
        opponent: p.opponent,
        baseline: p.baseline,
        adjusted: p.adjusted_projection,
        adjustment: p.total_adjustment,
        factors: projectionService.getAdjustmentExplanation(p.adjustments)
      }))
    });
  } catch (error) {
    console.error('Projection recalculation error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Reset projections to original RotoWire values
 * POST /api/players/:slateId/reset-projections
 */
router.post('/:slateId/reset-projections', async (req, res) => {
  try {
    const { slateId } = req.params;

    console.log(`🔄 Resetting projections to RotoWire baseline for slate ${slateId}`);

    const result = await playerModel.resetProjections(slateId);

    res.json({
      success: true,
      message: `Reset ${result.changes} player projections to RotoWire baseline`
    });
  } catch (error) {
    console.error('Reset projections error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Get projection breakdown for a single player
 * GET /api/players/:slateId/projection/:playerId
 */
router.get('/:slateId/projection/:playerId', async (req, res) => {
  try {
    const { slateId, playerId } = req.params;

    const players = await playerModel.getAllForProjections(slateId);
    const player = players.find(p => p.player_id === playerId);

    if (!player) {
      return res.status(404).json({ error: 'Player not found' });
    }

    const result = await projectionService.calculateAdjustedProjection(player);

    res.json({
      player: {
        name: player.name,
        team: player.team,
        opponent: player.opponent,
        position: player.position,
        salary: player.salary
      },
      projection: result,
      explanation: projectionService.getAdjustmentExplanation(result.adjustments)
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// ENHANCED PROJECTION ENDPOINT (Historical Data Blending)
// ═══════════════════════════════════════════════════════════════

/**
 * Calculate ENHANCED projections using historical data blending
 * POST /api/players/:slateId/enhanced-projections
 *
 * This uses our historical box score data to:
 * - Blend season average, L3 momentum, matchup history with RotoWire
 * - Apply usage bump adjustments when key teammates are OUT
 * - Apply player-specific home/away and B2B adjustments
 * - Apply hot/cold streak momentum factors
 *
 * Body params:
 * - slateDate: (optional) Date string YYYY-MM-DD for backtesting
 * - updateDb: (optional) boolean - whether to update DB with new projections (default: false)
 * - site: (optional) DFS site whose historical fantasy points to use (default: draftkings)
 * - minutesWeight: (optional) 0..1 weight of the minutes x FPPM model (default: PROJECTION_MINUTES_WEIGHT or 0.6)
 * - minutesModel: (optional) false to skip the minutes model
 */
router.post('/:slateId/enhanced-projections', async (req, res) => {
  try {
    const { slateId } = req.params;
    const { slateDate = null, updateDb = false, site = DEFAULT_SITE, minutesWeight = null, minutesModel = true } = req.body;
    if (!isValidSite(site)) {
      return res.status(400).json({ error: `Unknown site "${site}"` });
    }

    console.log(`\n🧠 ═══════════════════════════════════════════════════`);
    console.log(`   ENHANCED PROJECTIONS FOR SLATE ${slateId}`);
    if (slateDate) {
      console.log(`   📅 Backtest mode: Using data before ${slateDate}`);
    }
    console.log(`═══════════════════════════════════════════════════════`);

    // Clear projection cache for fresh calculations
    projectionService.clearCache();

    // Get all players with full data
    const players = await playerModel.getAllForProjections(slateId);

    if (!players || players.length === 0) {
      return res.status(404).json({ error: 'No players found for this slate' });
    }

    console.log(`📊 Found ${players.length} players to process`);

    // Calculate enhanced projections
    const enhancedResults = await projectionService.calculateSlateEnhancedProjections(players, slateDate, site, {
      slateId,
      minutesWeight,
      minutesModel
    });

    // Optionally update database
    if (updateDb) {
      console.log(`💾 Updating database with enhanced projections...`);
      const projectionsToUpdate = enhancedResults.map(r => {
        // OUT players project to 0, so their range does too
        const isOut = r.minutes_model?.source === 'out';
        return {
          player_id: r.player_id,
          adjusted_projection: r.enhanced_projection,
          floor: isOut ? 0 : r.historical?.floor || r.enhanced_projection * 0.7,
          ceiling: isOut ? 0 : r.historical?.ceiling || r.enhanced_projection * 1.3
        };
      });
      await playerModel.bulkUpdateProjections(slateId, projectionsToUpdate);
    }

    // Calculate summary stats
    const enhancedPlayers = enhancedResults.filter(r => r.enhanced);
    const avgRotowire = enhancedPlayers.reduce((sum, r) => sum + (r.rotowire_baseline || 0), 0) / (enhancedPlayers.length || 1);
    const avgEnhanced = enhancedPlayers.reduce((sum, r) => sum + r.enhanced_projection, 0) / (enhancedPlayers.length || 1);
    const avgDiff = avgEnhanced - avgRotowire;

    // Get players with biggest positive changes
    const topUp = enhancedResults
      .filter(r => r.enhanced && r.enhanced_projection > (r.rotowire_baseline || 0))
      .sort((a, b) => (b.enhanced_projection - (b.rotowire_baseline || 0)) - (a.enhanced_projection - (a.rotowire_baseline || 0)))
      .slice(0, 10);

    // Get players with biggest negative changes
    const topDown = enhancedResults
      .filter(r => r.enhanced && r.enhanced_projection < (r.rotowire_baseline || 0))
      .sort((a, b) => (a.enhanced_projection - (a.rotowire_baseline || 0)) - (b.enhanced_projection - (b.rotowire_baseline || 0)))
      .slice(0, 10);

    // Get usage bump beneficiaries
    const usageBumps = enhancedResults
      .filter(r => r.usageBump?.hasUsageBump)
      .sort((a, b) => (b.usageBump?.bump || 0) - (a.usageBump?.bump || 0));

    // Get hot streaks
    const hotStreaks = enhancedResults
      .filter(r => r.historical?.streakPct > 10)
      .sort((a, b) => (b.historical?.streakPct || 0) - (a.historical?.streakPct || 0))
      .slice(0, 10);

    // Get cold streaks
    const coldStreaks = enhancedResults
      .filter(r => r.historical?.streakPct < -10)
      .sort((a, b) => (a.historical?.streakPct || 0) - (b.historical?.streakPct || 0))
      .slice(0, 10);

    res.json({
      success: true,
      message: `Enhanced projections calculated for ${enhancedPlayers.length} players`,
      slateDate,
      updatedDb: updateDb,
      summary: {
        totalPlayers: players.length,
        enhancedPlayers: enhancedPlayers.length,
        fallbackPlayers: enhancedResults.filter(r => !r.enhanced).length,
        avgRotowireProjection: Math.round(avgRotowire * 10) / 10,
        avgEnhancedProjection: Math.round(avgEnhanced * 10) / 10,
        avgChange: Math.round(avgDiff * 10) / 10,
        usageBumpsFound: usageBumps.length,
        hotStreaks: hotStreaks.length,
        coldStreaks: coldStreaks.length
      },
      topProjectionIncreases: topUp.map(p => ({
        name: p.name,
        team: p.team,
        opponent: p.opponent,
        position: p.position,
        salary: p.salary,
        rotowire: p.rotowire_baseline,
        enhanced: p.enhanced_projection,
        change: Math.round((p.enhanced_projection - (p.rotowire_baseline || 0)) * 10) / 10,
        blendedBaseline: p.blended_baseline,
        confidence: p.confidence,
        historical: p.historical,
        adjustments: p.adjustments
      })),
      topProjectionDecreases: topDown.map(p => ({
        name: p.name,
        team: p.team,
        opponent: p.opponent,
        position: p.position,
        salary: p.salary,
        rotowire: p.rotowire_baseline,
        enhanced: p.enhanced_projection,
        change: Math.round((p.enhanced_projection - (p.rotowire_baseline || 0)) * 10) / 10,
        blendedBaseline: p.blended_baseline,
        confidence: p.confidence,
        historical: p.historical,
        adjustments: p.adjustments
      })),
      usageBumpOpportunities: usageBumps.slice(0, 10).map(p => ({
        name: p.name,
        team: p.team,
        salary: p.salary,
        enhanced: p.enhanced_projection,
        usageBump: p.usageBump
      })),
      hotStreakPlayers: hotStreaks.map(p => ({
        name: p.name,
        team: p.team,
        seasonAvg: p.historical?.seasonAvg,
        last3Avg: p.historical?.last3Avg,
        streakPct: p.historical?.streakPct,
        enhanced: p.enhanced_projection
      })),
      coldStreakPlayers: coldStreaks.map(p => ({
        name: p.name,
        team: p.team,
        seasonAvg: p.historical?.seasonAvg,
        last3Avg: p.historical?.last3Avg,
        streakPct: p.historical?.streakPct,
        enhanced: p.enhanced_projection
      })),
      // Full results (for detailed analysis)
      allPlayers: enhancedResults.map(p => ({
        player_id: p.player_id,
        name: p.name,
        team: p.team,
        opponent: p.opponent,
        position: p.position,
        salary: p.salary,
        rotowire_projection: p.rotowire_baseline,
        enhanced_projection: p.enhanced_projection,
        legacy_projection: p.legacy_projection,
        blended_baseline: p.blended_baseline,
        total_adjustment: p.total_adjustment,
        confidence: p.confidence,
        enhanced: p.enhanced,
        historical: p.historical,
        matchup: p.matchup,
        usageBump: p.usageBump,
        adjustments: p.adjustments,
        minutes_model: p.minutes_model
      }))
    });
  } catch (error) {
    console.error('Enhanced projection error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Get enhanced projection breakdown for a single player
 * GET /api/players/:slateId/enhanced-projection/:playerId
 */
router.get('/:slateId/enhanced-projection/:playerId', async (req, res) => {
  try {
    const { slateId, playerId } = req.params;
    const { slateDate = null, site = DEFAULT_SITE } = req.query;
    if (!isValidSite(site)) {
      return res.status(400).json({ error: `Unknown site "${site}"` });
    }

    const players = await playerModel.getAllForProjections(slateId);
    const player = players.find(p => p.player_id === playerId);

    if (!player) {
      return res.status(404).json({ error: 'Player not found' });
    }

    // Get slate roster for usage bump detection
    const slateRoster = players.map(p => p.name);

    const result = await projectionService.calculateEnhancedProjection(player, {
      slateRoster,
      slateDate,
      isHome: player.is_home === 1 || player.is_home === true,
      isB2B: player.rest_days === 0,
      site
    });

    res.json({
      player: {
        name: player.name,
        team: player.team,
        opponent: player.opponent,
        position: player.position,
        salary: player.salary
      },
      projection: result
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
