import express from 'express';
import playerModel from '../models/playerModel.js';
import { generateLineupBatch, ExposureConfigError } from '../services/optimizer/constraints/exposure.js';
import { reviewLineup } from '../utils/autoTuneSettings.js';
import { generateSlateBreakdown } from '../utils/slateAnalyzer.js';
import { resolveSite } from '../utils/resolveSite.js';
import { validateStackRules, STACK_PRESETS } from '../services/optimizer/constraints/stacking.js';

const router = express.Router();

/**
 * POST /api/optimizer/generate
 * Generate optimized lineup(s)
 *
 * Optional body fields: site ('draftkings' | 'fanduel' | 'yahoo', defaults to
 * the slate's site), lockedPlayers, excludedPlayers, minUniqueness (min players
 * each lineup differs from every earlier lineup in the request), stackRules
 * (team/game stack rules and presets, see services/optimizer/constraints/stacking.js;
 * teamStacks is an alias)
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

    const stackErrors = [
      ...validateStackRules(req.body.stackRules),
      ...validateStackRules(teamStacks).map(e => e.replace('stackRules', 'teamStacks'))
    ];
    if (stackErrors.length) {
      return res.status(400).json({ error: 'Invalid stack rules', details: stackErrors });
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

    // Exposure / uniqueness / randomness are hard constraints across the batch
    // (request contract documented in services/optimizer/constraints/exposure.js);
    // each solve runs the site-aware constraint pipeline, so stacking applies too
    const result = generateLineupBatch(players, { ...req.body, site });

    console.log(`✅ Generated ${result.lineups?.length || 0} valid lineup(s)`);

    res.json({
      success: true,
      lineups: result.lineups || [],
      count: result.lineups?.length || 0,
      exposureStats: result.exposureStats,
      exposureSummary: result.exposureSummary,
      warnings: result.warnings,
      error: result.error,
      settings: result.settings
    });
  } catch (error) {
    if (error instanceof ExposureConfigError) {
      return res.status(400).json({ error: error.message });
    }
    console.error('Optimizer error:', error);
    res.status(500).json({
      error: 'Optimization failed',
      message: error.message
    });
  }
});

/**
 * GET /api/optimizer/stack-presets
 * NBA stacking presets usable as { preset: key } entries in stackRules
 */
router.get('/stack-presets', (req, res) => {
  res.json(Object.entries(STACK_PRESETS).map(([key, preset]) => ({ key, ...preset })));
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

export default router;
