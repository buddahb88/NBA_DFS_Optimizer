import express from 'express';
import playerModel from '../models/playerModel.js';
import optimizerService from '../services/optimizerService.js';
import { autoTuneSettings, reviewLineup } from '../utils/autoTuneSettings.js';
import { generateSlateBreakdown } from '../utils/slateAnalyzer.js';
import { resolveSite } from '../utils/resolveSite.js';
import { getSiteConfig } from '../config/sites.js';
import { defaultMinSalary } from '../services/optimizer/scoring.js';

const router = express.Router();

/**
 * POST /api/optimizer/generate
 * Generate optimized lineup(s)
 *
 * Optional body fields: site ('draftkings' | 'fanduel' | 'yahoo', defaults to
 * the slate's site), lockedPlayers, excludedPlayers, minUniqueness (min players
 * each lineup differs from every earlier lineup in the request)
 */
router.post('/generate', async (req, res) => {
  try {
    const {
      slateId,
      mode = 'cash',
      numLineups = 1,
      lockedPlayers = [],
      excludedPlayers = [],
      minSalary,
      maxExposure = 100,
      teamStacks = [],
      randomness = 0,
      useProjections = true
    } = req.body;

    if (!slateId) {
      return res.status(400).json({ error: 'slateId is required' });
    }

    const { site, error: siteError } = await resolveSite(req.body.site, slateId);
    if (siteError) {
      return res.status(400).json({ error: siteError });
    }

    console.log(`🎯 Optimizing ${numLineups} lineup(s) for slate ${slateId} (${site}, ${mode} mode)`);

    // Get all players for the slate
    const players = await playerModel.getBySlateId(slateId);

    if (!players || players.length === 0) {
      return res.status(404).json({ error: 'No players found for this slate' });
    }

    console.log(`📊 Found ${players.length} active players`);

    // Run optimization with all settings from request body
    const result = optimizerService.optimize(players, { ...req.body, site });

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

    const { site, error: siteError } = await resolveSite(req.body.site, slateId);
    if (siteError) {
      return res.status(400).json({ error: siteError });
    }

    console.log(`🤖 Auto-tuning settings for slate ${slateId} (${site}, ${mode} mode)`);

    // Get all players for the slate
    const players = await playerModel.getBySlateId(slateId);

    if (!players || players.length === 0) {
      return res.status(404).json({ error: 'No players found for this slate' });
    }

    // Analyze and generate recommendations (async now)
    const result = await autoTuneSettings(players, mode, site);

    if (result.error) {
      return res.status(400).json(result);
    }

    console.log(`✅ Auto-tune complete: ${result.totalPlayers} players analyzed`);

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
    const players = await playerModel.getBySlateId(slateId);

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
 * POST /api/optimizer/review-lineup
 * AI reviews a generated lineup and gives honest feedback
 */
router.post('/review-lineup', async (req, res) => {
  try {
    const { slateId, lineup, mode = 'gpp' } = req.body;

    if (!slateId || !lineup) {
      return res.status(400).json({ error: 'slateId and lineup are required' });
    }

    const { site, error: siteError } = await resolveSite(req.body.site, slateId);
    if (siteError) {
      return res.status(400).json({ error: siteError });
    }

    console.log(`🤖 AI reviewing lineup for slate ${slateId} (${site}, ${mode} mode)`);

    // Get all players for context
    const players = await playerModel.getBySlateId(slateId);

    if (!players || players.length === 0) {
      return res.status(404).json({ error: 'No players found for this slate' });
    }

    // Get AI review
    const result = await reviewLineup(lineup, players, mode, site);

    console.log(`✅ Lineup review complete`);

    res.json(result);
  } catch (error) {
    console.error('Lineup review error:', error);
    res.status(500).json({
      success: false,
      error: 'Lineup review failed',
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
    const { players, slateId } = req.body;

    const { site, error: siteError } = await resolveSite(req.body.site, slateId);
    if (siteError) {
      return res.status(400).json({ error: siteError });
    }
    const siteConfig = getSiteConfig(site);
    const { salaryCap } = siteConfig;
    const rosterSize = siteConfig.rosterSlots.length;
    const minSalary = req.body.minSalary ?? defaultMinSalary(siteConfig);

    if (!players || !Array.isArray(players) || players.length !== rosterSize) {
      return res.status(400).json({ error: `Must provide exactly ${rosterSize} players` });
    }

    const totalSalary = players.reduce((sum, p) => sum + (p.salary || 0), 0);
    const projectedPoints = players.reduce((sum, p) => sum + (p.projected_points || 0), 0);

    const validation = {
      isValid: true,
      errors: [],
      warnings: [],
      site,
      totalSalary,
      projectedPoints,
      remainingSalary: salaryCap - totalSalary
    };

    // Check salary cap
    if (totalSalary > salaryCap) {
      validation.isValid = false;
      validation.errors.push(`Over salary cap by $${totalSalary - salaryCap}`);
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
