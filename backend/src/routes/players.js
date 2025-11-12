import express from 'express';
import playerModel from '../models/playerModel.js';
import slateModel from '../models/slateModel.js';
import rotowireService from '../services/rotowireService.js';
import espnScraperService from '../services/espnScraperService.js';
import hashtagBasketballService from '../services/hashtagBasketballService.js';

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

export default router;
