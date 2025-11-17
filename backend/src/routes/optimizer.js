import express from 'express';
import playerModel from '../models/playerModel.js';
import optimizerService from '../services/optimizerService.js';
import { autoTuneSettings } from '../utils/autoTuneSettings.js';
import { generateSlateBreakdown } from '../utils/slateAnalyzer.js';

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

    // Run optimization with all settings from request body
    const result = optimizerService.optimize(players, req.body);

    console.log(`✅ Generated ${result.lineups?.length || 0} valid lineup(s)`);

    res.json({
      success: true,
      lineups: result.lineups || [],
      count: result.lineups?.length || 0,
      exposureStats: result.exposureStats,
      settings: result.settings
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
 * POST /api/optimizer/auto-tune
 * Analyze player pool and recommend optimal settings
 */
router.post('/auto-tune', async (req, res) => {
  try {
    const { slateId, mode = 'gpp' } = req.body;

    if (!slateId) {
      return res.status(400).json({ error: 'slateId is required' });
    }

    console.log(`🤖 Auto-tuning settings for slate ${slateId} (${mode} mode)`);

    // Get all players for the slate
    const players = playerModel.getBySlateId(slateId);

    if (!players || players.length === 0) {
      return res.status(404).json({ error: 'No players found for this slate' });
    }

    // Analyze and generate recommendations
    const result = autoTuneSettings(players, mode);

    if (result.error) {
      return res.status(400).json(result);
    }

    console.log(`✅ Auto-tune complete: ${result.recommendations.estimatedPlayersPass}/${result.totalPlayers} players will pass`);

    res.json({
      success: true,
      ...result
    });
  } catch (error) {
    console.error('Auto-tune error:', error);
    res.status(500).json({
      error: 'Auto-tune failed',
      message: error.message
    });
  }
});

/**
 * POST /api/optimizer/slate-breakdown
 * Generate AI-powered slate analysis and recommendations
 */
router.post('/slate-breakdown', async (req, res) => {
  try {
    const { slateId, mode = 'gpp' } = req.body;

    if (!slateId) {
      return res.status(400).json({ error: 'slateId is required' });
    }

    console.log(`🤖 Generating AI slate breakdown for slate ${slateId} (${mode} mode)`);

    // Get all players for the slate
    const players = playerModel.getBySlateId(slateId);

    if (!players || players.length === 0) {
      return res.status(404).json({ error: 'No players found for this slate' });
    }

    // Generate comprehensive breakdown
    const breakdown = await generateSlateBreakdown(players, mode);

    console.log(`✅ Slate breakdown complete`);

    res.json({
      success: true,
      ...breakdown
    });
  } catch (error) {
    console.error('Slate breakdown error:', error);
    res.status(500).json({
      error: 'Slate breakdown failed',
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
