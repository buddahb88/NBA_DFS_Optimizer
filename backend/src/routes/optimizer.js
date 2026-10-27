import express from 'express';
import { generateLineupBatch, ExposureConfigError } from '../services/optimizer/constraints/exposure.js';
import { reviewLineup } from '../utils/autoTuneSettings.js';
import { generateSlateBreakdown } from '../utils/slateAnalyzer.js';
import { resolveSite } from '../utils/resolveSite.js';
import { validateStackRules, STACK_PRESETS } from '../services/optimizer/constraints/stacking.js';
import {
  RANGE_OPTIONS, SlateSourceError, loadSlatePlayers, resolveSlate, scoreLineups, sourceFields, withActuals
} from '../services/slateSource.js';
import { withOpportunity, validateOpportunityWeight } from '../services/opportunity/optimizerNudge.js';

const router = express.Router();

/**
 * Slate players for a request body: { slateId, slateDate?, site?, ranges? }.
 * slateDate before today rebuilds that saved slate (services/slateSource.js)
 * with the outcome-model ranges, or the pre-lock ones with ranges: 'original';
 * site defaults to the slate's. Returns { source, site, players } or { status, error }.
 */
async function requestSlate(body = {}) {
  const { slateId, slateDate, ranges = 'model' } = body;
  if (!slateId && !slateDate) return { status: 400, error: 'slateId is required' };
  if (!RANGE_OPTIONS.includes(ranges)) return { status: 400, error: `ranges must be one of: ${RANGE_OPTIONS.join(', ')}` };
  let source;
  try {
    source = await resolveSlate({ slateId, slateDate });
  } catch (error) {
    if (error instanceof SlateSourceError) return { status: error.status, error: error.message };
    throw error;
  }
  const { site, error: siteError } = source?.isBacktest && !body.site
    ? { site: source.site }
    : await resolveSite(body.site, source?.slateId ?? slateId);
  if (siteError) return { status: 400, error: siteError };
  const players = await loadSlatePlayers(source, { ranges });
  if (!players.length) return { status: 404, error: 'No players found for this slate' };
  return { source: source.isBacktest ? { ...source, ranges } : source, site, players };
}

/**
 * POST /api/optimizer/generate
 * Generate optimized lineup(s)
 *
 * Optional body fields: site ('draftkings' | 'fanduel' | 'yahoo', defaults to
 * the slate's site), lockedPlayers, excludedPlayers, minUniqueness (min players
 * each lineup differs from every earlier lineup in the request), stackRules
 * (team/game stack rules and presets, see services/optimizer/constraints/stacking.js;
 * teamStacks is an alias), slateDate (YYYY-MM-DD: before today rebuilds that
 * night's saved slate; lineups then carry actual points per player and in total),
 * opportunityWeight (0-1, default 0 = off: projections nudged by the
 * Opportunity Radar score for the mode, services/opportunity/optimizerNudge.js;
 * the response then carries `opportunity` and nudged players their
 * opportunity_score / base_projected_points)
 */
router.post('/generate', async (req, res) => {
  try {
    const {
      mode = 'cash',
      numLineups = 1,
      teamStacks = []
    } = req.body;

    const weightError = validateOpportunityWeight(req.body.opportunityWeight);
    if (weightError) return res.status(400).json({ error: weightError });

    const stackErrors = [
      ...validateStackRules(req.body.stackRules),
      ...validateStackRules(teamStacks).map(e => e.replace('stackRules', 'teamStacks'))
    ];
    if (stackErrors.length) {
      return res.status(400).json({ error: 'Invalid stack rules', details: stackErrors });
    }

    const slate = await requestSlate(req.body);
    if (slate.error) {
      return res.status(slate.status).json({ error: slate.error });
    }
    const { source, site } = slate;
    const { players, opportunity } = await withOpportunity(source, slate.players, { weight: req.body.opportunityWeight, mode, site });

    console.log(`🎯 Optimizing ${numLineups} lineup(s) for slate ${source.slateId} (${site}, ${mode} mode, ${source.label})`);
    console.log(`📊 Found ${players.length} active players${opportunity ? `, opportunity weight ${opportunity.weight}` : ''}`);

    // Exposure / uniqueness / randomness are hard constraints across the batch
    // (request contract documented in services/optimizer/constraints/exposure.js);
    // each solve runs the site-aware constraint pipeline, so stacking applies too
    const result = generateLineupBatch(players, { ...req.body, site });
    const lineups = await scoreLineups(source, result.lineups || [], players);

    console.log(`✅ Generated ${lineups.length} valid lineup(s)`);

    res.json({
      success: true,
      ...sourceFields(source),
      lineups,
      count: lineups.length,
      exposureStats: result.exposureStats,
      exposureSummary: result.exposureSummary,
      ...(opportunity ? { opportunity } : {}),
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
    const { mode = 'gpp' } = req.body;

    const slate = await requestSlate(req.body);
    if (slate.error) {
      return res.status(slate.status).json({ error: slate.error });
    }
    const { source, players } = slate;

    console.log(`🤖 Generating AI slate breakdown for slate ${source.slateId} (${mode} mode, ${source.label})`);

    // Generate comprehensive breakdown (pre-lock data only; actuals ride along for a backtest)
    const breakdown = await generateSlateBreakdown(players, mode);

    console.log(`✅ Slate breakdown complete`);

    const response = { success: true, ...sourceFields(source), ...breakdown };
    if (source.isBacktest) {
      const scored = await withActuals(source, players);
      response.actualResults = scored
        .filter(p => p.actualPoints !== null && p.actualPoints !== undefined)
        .sort((a, b) => b.actualPoints - a.actualPoints)
        .slice(0, 15)
        .map(p => ({ id: p.id, name: p.name, team: p.team, salary: p.salary, projected: p.projected_points,
          actualPoints: p.actualPoints, resultStatus: p.resultStatus }));
    }
    res.json(response);
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
    const { lineup, mode = 'gpp' } = req.body;

    if ((!req.body.slateId && !req.body.slateDate) || !lineup) {
      return res.status(400).json({ error: 'slateId and lineup are required' });
    }

    const slate = await requestSlate(req.body);
    if (slate.error) {
      return res.status(slate.status).json({ error: slate.error });
    }
    const { source, site, players } = slate;

    console.log(`🤖 AI reviewing lineup for slate ${source.slateId} (${site}, ${mode} mode, ${source.label})`);

    // Get AI review
    const result = await reviewLineup(lineup, players, mode, site);

    console.log(`✅ Lineup review complete`);

    const response = { ...result, ...sourceFields(source) };
    if (source.isBacktest && Array.isArray(lineup.players)) {
      const slots = lineup.players.map(slot => (slot?.player ? slot : { position: slot?.position, player: slot }));
      const [scored] = await scoreLineups(source, [{ players: slots }], players);
      response.actualPoints = scored.actualPoints;
      response.playerActuals = scored.players
        .filter(s => s.player)
        .map(s => ({ id: s.player.id, name: s.player.name, actualPoints: s.player.actualPoints ?? null,
          resultStatus: s.player.resultStatus ?? null }));
    }
    res.json(response);
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
