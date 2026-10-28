/**
 * OptimizerAgent - Specialized agent for DFS lineup building and optimization
 *
 * Responsibilities:
 * - Build optimal lineups using LP optimization
 * - Validate lineup constraints
 * - Explain lineup construction strategy
 */

import BaseAgent from './BaseAgent.js';
import optimizerService from '../services/optimizerService.js';
import { resolveSite } from '../utils/resolveSite.js';
import { withUiBlocks } from '../services/chatTools/uiBlockBuilders.js';
import { chatSlate, loadSlatePlayers, scoreLineups, withActuals, lineupActualTotal } from '../services/slateSource.js';
import { withOpportunity, validateOpportunityWeight } from '../services/opportunity/optimizerNudge.js';
import { chatSourceFields } from '../services/projections/sourceLayer.js';

const SLATE_DATE_PROP = {
  type: 'string',
  description: 'YYYY-MM-DD. Only for an explicit backtest of a past night ("rebuild 10/21"): uses that night\'s saved slate and returns actual points. Omit for tonight.'
};
const actualOf = (p) => (p.actualPoints === undefined ? {} : { actualPoints: p.actualPoints, resultStatus: p.resultStatus ?? null });

const SYSTEM_PROMPT = `You are an expert DFS lineup optimizer for DraftKings NBA.

Your job is to:
1. Understand lineup requirements (locks, exclusions, mode, constraints)
2. Build optimal lineups using the linear programming optimizer
3. Validate lineups meet all DraftKings constraints
4. Explain your lineup construction strategy and player selections

DraftKings NBA Rules:
- Salary Cap: $50,000
- Roster: 8 players (PG, SG, SF, PF, C, G, F, UTIL)
- G slot: PG or SG eligible
- F slot: SF or PF eligible
- UTIL slot: Any position

Optimization Modes:
- CASH: Prioritize floor, consistency, lower variance plays
- GPP: Prioritize ceiling, upside, leverage (low ownership + high upside)

Stale slates: build_lineup and get_player_pool return slateDate and isStale (with staleWarning).
If isStale is true, do not present the lineup as tonight's: say the slate is from <slateDate> and tell the user to sync tonight's slate (Home or Data Status page), unless the task explicitly asks about that past date.

Backtests: when the task explicitly asks to rebuild or backtest a past night (e.g. "rebuild 10/21"), pass slateDate (YYYY-MM-DD) to build_lineup / get_player_pool / validate_lineup. They then use that night's saved pre-lock slate and return backtest: true, a label and actual points (per player and lineup actualPoints). Start the answer with the label (e.g. "Backtest 2026-10-21") and report projected vs actual.

Always explain WHY you selected players - ownership, matchups, value, ceiling potential.`;

class OptimizerAgent extends BaseAgent {
  constructor() {
    super({
      name: 'optimizer',
      description: 'Builds and validates DFS lineups using LP optimization',
      maxIterations: 3,
      systemPrompt: SYSTEM_PROMPT,
      tools: []
    });

    // Initialize tools
    this.tools = this.createTools();
  }

  createTools() {
    return [
      {
        name: 'build_lineup',
        description: 'Build optimal DFS lineups using Linear Programming optimization. Can lock specific players and generate multiple lineups.',
        parameters: {
          type: 'object',
          properties: {
            slateId: {
              type: 'string',
              description: 'Slate ID to build lineup for (default: the latest slate, or the saved slate of slateDate)'
            },
            slateDate: SLATE_DATE_PROP,
            lockedPlayerIds: {
              type: 'array',
              items: { type: 'number' },
              description: 'Array of player IDs to lock/force into lineup'
            },
            excludedPlayerIds: {
              type: 'array',
              items: { type: 'number' },
              description: 'Array of player IDs to exclude from consideration'
            },
            mode: {
              type: 'string',
              enum: ['cash', 'gpp'],
              description: 'Optimization mode: cash for safe plays, gpp for tournaments'
            },
            numLineups: {
              type: 'number',
              description: 'Number of lineups to generate (1-20)'
            },
            minSalary: {
              type: 'number',
              description: 'Minimum salary to use (default 49000)'
            },
            randomness: {
              type: 'number',
              description: 'Randomness 0-100 for GPP variance (default 0)'
            },
            opportunityWeight: {
              type: 'number',
              description: 'Opportunity factor 0-1 (default 0 = off): nudges projections up to +-10% by the Opportunity Radar score for the mode (cash or gpp). Use when the task asks to lean into players in a good spot.'
            }
          },
          required: []
        },
        execute: async ({ slateId, slateDate, lockedPlayerIds = [], excludedPlayerIds = [], mode = 'cash', numLineups = 1, minSalary = 49000, randomness = 0, opportunityWeight = 0 }) => {
          console.log(`\n🏀 [OptimizerAgent] Building ${numLineups} ${mode.toUpperCase()} lineup(s)`);
          if (lockedPlayerIds.length > 0) {
            console.log(`🔒 Locked players: ${lockedPlayerIds.join(', ')}`);
          }
          const weightError = validateOpportunityWeight(opportunityWeight);
          if (weightError) return { success: false, error: weightError };

          const slate = await chatSlate({ slateId, slateDate });
          if (slate.error) return { success: false, error: slate.error };
          const { source, dateFields } = slate;

          // Get all players for this slate (live table, or the saved slate for a backtest)
          const loaded = await loadSlatePlayers(source, { includeZero: true });

          if (loaded.length === 0) {
            return { success: false, error: `No players found for slate ${source.slateId}` };
          }

          console.log(`✅ Found ${loaded.length} players for slate (${source.label})`);

          // Use optimizer service (site rules follow the slate's site)
          const { site } = source.isBacktest ? { site: source.site } : await resolveSite(undefined, source.slateId);
          const { players, opportunity } = await withOpportunity(source, loaded, { weight: opportunityWeight, mode, site });
          const { lineups: built } = optimizerService.optimize(players, {
            site,
            mode,
            numLineups: Math.min(numLineups, 20),
            lockedPlayers: lockedPlayerIds,
            excludedPlayers: excludedPlayerIds,
            minSalary,
            randomness,
          });

          if (built.length === 0) {
            return { success: false, error: 'Could not generate valid lineups with given constraints' };
          }
          const lineups = await scoreLineups(source, built, players);

          // Format results
          const formattedLineups = lineups.map(lineup => ({
            players: lineup.players.map(slot => ({
              position: slot.position,
              player: slot.player ? {
                id: slot.player.id,
                name: slot.player.name,
                team: slot.player.team,
                salary: slot.player.salary,
                projectedPoints: slot.player.projected_points,
                ownership: slot.player.rostership,
                floor: slot.player.floor,
                ceiling: slot.player.ceiling,
                ...(opportunity ? { opportunityScore: slot.player.opportunity_score ?? null, baseProjectedPoints: slot.player.base_projected_points ?? null } : {}),
                ...actualOf(slot.player),
              } : null,
            })),
            totalSalary: lineup.totalSalary,
            projectedPoints: lineup.projectedPoints,
            remainingSalary: lineup.remainingSalary,
            ...(source.isBacktest ? { actualPoints: lineup.actualPoints } : {}),
          }));

          const result = {
            success: true,
            lineups: formattedLineups,
            count: formattedLineups.length,
            mode,
            slateId: source.slateId,
            ...(opportunity ? { opportunityWeight: opportunity.weight, opportunityNote: 'Projections nudged by the Opportunity Radar score (projectedPoints; baseProjectedPoints is the posted one).' } : {}),
            ...dateFields,
          };
          return withUiBlocks('build_lineup', result);
        }
      },

      {
        name: 'validate_lineup',
        description: 'Validate that a lineup meets all DraftKings constraints (salary cap, positions, etc.)',
        parameters: {
          type: 'object',
          properties: {
            playerIds: {
              type: 'array',
              items: { type: 'number' },
              description: 'Array of 8 player IDs in the lineup'
            },
            slateId: {
              type: 'string',
              description: 'Slate ID to validate against'
            },
            slateDate: SLATE_DATE_PROP
          },
          required: ['playerIds']
        },
        execute: async ({ playerIds, slateId, slateDate }) => {
          console.log(`\n✅ [OptimizerAgent] Validating lineup with ${playerIds.length} players`);

          if (playerIds.length !== 8) {
            return {
              valid: false,
              error: `Lineup must have exactly 8 players, got ${playerIds.length}`
            };
          }

          const slate = await chatSlate({ slateId, slateDate });
          if (slate.error) return { valid: false, error: slate.error };
          const { source, dateFields } = slate;

          // Get players
          const wanted = new Set(playerIds.map(Number));
          const players = await withActuals(source,
            (await loadSlatePlayers(source, { includeZero: true })).filter(p => wanted.has(Number(p.id))));

          if (players.length !== 8) {
            return {
              valid: false,
              error: `Only found ${players.length}/8 players in the slate`
            };
          }

          // Check salary
          const totalSalary = players.reduce((sum, p) => sum + p.salary, 0);
          if (totalSalary > 50000) {
            return {
              valid: false,
              error: `Lineup exceeds salary cap: $${totalSalary} > $50,000`,
              totalSalary
            };
          }

          // Check positions (simplified)
          const positions = players.map(p => p.position);
          const hasAllPositions = ['PG', 'SG', 'SF', 'PF', 'C'].every(pos =>
            positions.some(p => p.includes(pos))
          );

          if (!hasAllPositions) {
            return {
              valid: false,
              error: 'Lineup does not have required position coverage',
              positions
            };
          }

          // Calculate projections
          const totalProjection = players.reduce((sum, p) => sum + (p.projected_points || 0), 0);

          return {
            valid: true,
            slateId: source.slateId,
            ...(source.isBacktest ? { ...dateFields, actualPoints: lineupActualTotal(players) } : {}),
            totalSalary,
            remainingSalary: 50000 - totalSalary,
            totalProjection: Math.round(totalProjection * 10) / 10,
            players: players.map(p => ({
              id: p.id,
              name: p.name,
              position: p.position,
              salary: p.salary,
              projection: p.projected_points,
              ...actualOf(p)
            }))
          };
        }
      },

      {
        name: 'get_player_pool',
        description: 'Get filtered player pool for optimization. Use to find players by position, salary range, or projection threshold.',
        parameters: {
          type: 'object',
          properties: {
            slateId: {
              type: 'string',
              description: 'Slate ID'
            },
            slateDate: SLATE_DATE_PROP,
            position: {
              type: 'string',
              description: 'Filter by position (PG, SG, SF, PF, C)'
            },
            minSalary: {
              type: 'number',
              description: 'Minimum salary'
            },
            maxSalary: {
              type: 'number',
              description: 'Maximum salary'
            },
            minProjection: {
              type: 'number',
              description: 'Minimum projected points'
            },
            limit: {
              type: 'number',
              description: 'Max players to return (default 20)'
            }
          },
          required: []
        },
        execute: async ({ slateId, slateDate, position, minSalary, maxSalary, minProjection, limit = 20 }) => {
          console.log(`\n📋 [OptimizerAgent] Getting player pool for slate ${slateId ?? slateDate ?? 'latest'}`);

          const slate = await chatSlate({ slateId, slateDate });
          if (slate.error) return { success: false, error: slate.error };
          const { source, dateFields } = slate;

          const pool = (await loadSlatePlayers(source, { includeZero: true, filters: { position, minSalary, maxSalary } }))
            .filter(p => !minProjection || Number(p.projected_points) >= minProjection)
            .sort((a, b) => (Number(b.projected_points) || 0) - (Number(a.projected_points) || 0))
            .slice(0, limit)
            .map(p => ({ ...p, ownership: p.rostership }));
          const players = await withActuals(source, pool);

          return {
            success: true,
            slateId: source.slateId,
            ...dateFields,
            count: players.length,
            filters: { position, minSalary, maxSalary, minProjection },
            players: players.map(p => ({
              id: p.id,
              name: p.name,
              position: p.position,
              team: p.team,
              salary: p.salary,
              projection: p.projected_points,
              floor: p.floor,
              ceiling: p.ceiling,
              ownership: p.ownership,
              leverage: p.leverage_score,
              boomProb: p.boom_probability,
              injury: p.injury_status,
              ...chatSourceFields(p),
              ...actualOf(p)
            }))
          };
        }
      }
    ];
  }
}

export default OptimizerAgent;
