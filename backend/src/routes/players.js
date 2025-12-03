import express from 'express';
import playerModel from '../models/playerModel.js';
import slateModel from '../models/slateModel.js';
import rotowireService from '../services/rotowireService.js';
import espnScraperService from '../services/espnScraperService.js';
import hashtagBasketballService from '../services/hashtagBasketballService.js';
import projectionService from '../services/projectionService.js';

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

    const players = playerModel.getBySlateId(slateId, filters);
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

    // Clear all existing slates and players (single active slate model)
    console.log(`  🗑️  Clearing existing slate data...`);
    playerModel.deleteAll();
    slateModel.deleteAll();

    // Create the new slate
    slateModel.createOrUpdate({
      slateId,
      name: req.body.name || `NBA Slate ${slateId}`,
      sport: 'NBA',
      startTime: req.body.startTime || null
    });

    // Bulk insert players (with defense-adjusted projections)
    playerModel.bulkCreateOrUpdate(slateId, players);

    console.log(`✅ Complete! Synced ${players.length} players with matchup-adjusted projections (overall defense + pace + position defense)`);

    const syncedPlayers = playerModel.getBySlateId(slateId);
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
    const player = playerModel.getById(req.params.id);
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
    const players = playerModel.getAllForProjections(slateId);

    if (!players || players.length === 0) {
      return res.status(404).json({ error: 'No players found for this slate' });
    }

    console.log(`📊 Found ${players.length} players to process`);

    // Calculate adjusted projections for each player
    const projectionResults = [];
    let totalBaseline = 0;
    let totalAdjusted = 0;

    for (const player of players) {
      const result = projectionService.calculateAdjustedProjection(player);

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
    const updated = playerModel.bulkUpdateProjections(slateId, projectionResults);

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

    const result = playerModel.resetProjections(slateId);

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

    const players = playerModel.getAllForProjections(slateId);
    const player = players.find(p => p.player_id === playerId);

    if (!player) {
      return res.status(404).json({ error: 'Player not found' });
    }

    const result = projectionService.calculateAdjustedProjection(player);

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

export default router;
