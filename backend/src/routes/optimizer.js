import express from 'express';
import playerModel from '../models/playerModel.js';
import optimizerService from '../services/optimizerService.js';

const router = express.Router();

/**
 * POST /api/optimizer/generate
 * Generate optimized lineup(s)
 */
router.post('/generate', async (req, res) => {
  try {
    const {
      slateId,
      mode = 'cash',
      numLineups = 1,
      lockedPlayers = [],
      excludedPlayers = [],
      minSalary = 49000,
      maxExposure = 100,
      teamStacks = [],
      randomness = 0,
      useProjections = true
    } = req.body;

    if (!slateId) {
      return res.status(400).json({ error: 'slateId is required' });
    }

    console.log(`🎯 Optimizing ${numLineups} lineup(s) for slate ${slateId} (${mode} mode)`);

    // Get all players for the slate
    const players = playerModel.getBySlateId(slateId);

    if (!players || players.length === 0) {
      return res.status(404).json({ error: 'No players found for this slate' });
    }

    console.log(`📊 Found ${players.length} active players`);

    // Run optimization
    const lineups = optimizerService.optimize(players, {
      mode,
      numLineups,
      lockedPlayers,
      excludedPlayers,
      minSalary,
      maxExposure,
      teamStacks,
      randomness,
      useProjections
    });

    console.log(`✅ Generated ${lineups.length} valid lineup(s)`);

    // Get exposure stats if multiple lineups
    let exposureStats = null;
    if (numLineups > 1) {
      exposureStats = optimizerService.getExposureStats(lineups);
    }

    res.json({
      success: true,
      lineups,
      count: lineups.length,
      exposureStats,
      settings: {
        mode,
        numLineups,
        lockedPlayers: lockedPlayers.length,
        excludedPlayers: excludedPlayers.length,
        minSalary,
        maxExposure
      }
    });
  } catch (error) {
    console.error('Optimizer error:', error);
    res.status(500).json({
      error: 'Optimization failed',
      message: error.message
    });
  }
});

/**
 * POST /api/optimizer/validate
 * Validate a lineup
 */
router.post('/validate', async (req, res) => {
  try {
    const { players, minSalary = 49000 } = req.body;

    if (!players || !Array.isArray(players) || players.length !== 8) {
      return res.status(400).json({ error: 'Must provide exactly 8 players' });
    }

    const totalSalary = players.reduce((sum, p) => sum + (p.salary || 0), 0);
    const projectedPoints = players.reduce((sum, p) => sum + (p.projected_points || 0), 0);

    const validation = {
      isValid: true,
      errors: [],
      warnings: [],
      totalSalary,
      projectedPoints,
      remainingSalary: 50000 - totalSalary
    };

    // Check salary cap
    if (totalSalary > 50000) {
      validation.isValid = false;
      validation.errors.push(`Over salary cap by $${totalSalary - 50000}`);
    }

    // Check minimum salary
    if (totalSalary < minSalary) {
      validation.warnings.push(`Below minimum salary of $${minSalary}`);
    }

    // Check for duplicates
    const playerIds = players.map(p => p.id);
    if (playerIds.length !== new Set(playerIds).size) {
      validation.isValid = false;
      validation.errors.push('Duplicate players in lineup');
    }

    // Check all slots filled
    if (players.some(p => !p || !p.id)) {
      validation.isValid = false;
      validation.errors.push('Not all lineup slots are filled');
    }

    res.json(validation);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
