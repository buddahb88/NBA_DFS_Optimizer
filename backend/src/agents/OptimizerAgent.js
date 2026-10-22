/**
 * OptimizerAgent - Specialized agent for DFS lineup building and optimization
 *
 * Responsibilities:
 * - Build optimal lineups using LP optimization
 * - Validate lineup constraints
 * - Explain lineup construction strategy
 */

import BaseAgent from './BaseAgent.js';
import db from '../config/database.js';
import optimizerService from '../services/optimizerService.js';
import { resolveSite } from '../utils/resolveSite.js';
import { withUiBlocks } from '../services/chatTools/uiBlockBuilders.js';

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
              description: 'Slate ID to build lineup for'
            },
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
            }
          },
          required: ['slateId']
        },
        execute: async ({ slateId, lockedPlayerIds = [], excludedPlayerIds = [], mode = 'cash', numLineups = 1, minSalary = 49000, randomness = 0 }) => {
          console.log(`\n🏀 [OptimizerAgent] Building ${numLineups} ${mode.toUpperCase()} lineup(s)`);
          if (lockedPlayerIds.length > 0) {
            console.log(`🔒 Locked players: ${lockedPlayerIds.join(', ')}`);
          }

          // Get all players for this slate
          const players = await db.all('SELECT * FROM players WHERE slate_id = ?', slateId);

          if (players.length === 0) {
            return { success: false, error: `No players found for slate ${slateId}` };
          }

          console.log(`✅ Found ${players.length} players for slate`);

          // Use optimizer service (site rules follow the slate's site)
          const { site } = await resolveSite(undefined, slateId);
          const { lineups } = optimizerService.optimize(players, {
            site,
            mode,
            numLineups: Math.min(numLineups, 20),
            lockedPlayers: lockedPlayerIds,
            excludedPlayers: excludedPlayerIds,
            minSalary,
            randomness,
          });

          if (lineups.length === 0) {
            return { success: false, error: 'Could not generate valid lineups with given constraints' };
          }

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
              } : null,
            })),
            totalSalary: lineup.totalSalary,
            projectedPoints: lineup.projectedPoints,
            remainingSalary: lineup.remainingSalary,
          }));

          const result = {
            success: true,
            lineups: formattedLineups,
            count: formattedLineups.length,
            mode,
            slateId,
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
            }
          },
          required: ['playerIds', 'slateId']
        },
        execute: async ({ playerIds, slateId }) => {
          console.log(`\n✅ [OptimizerAgent] Validating lineup with ${playerIds.length} players`);

          if (playerIds.length !== 8) {
            return {
              valid: false,
              error: `Lineup must have exactly 8 players, got ${playerIds.length}`
            };
          }

          // Get players
          const placeholders = playerIds.map(() => '?').join(',');
          const players = await db.all(
            `SELECT * FROM players WHERE id IN (${placeholders}) AND slate_id = ?`,
            ...playerIds, slateId
          );

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
            totalSalary,
            remainingSalary: 50000 - totalSalary,
            totalProjection: Math.round(totalProjection * 10) / 10,
            players: players.map(p => ({
              id: p.id,
              name: p.name,
              position: p.position,
              salary: p.salary,
              projection: p.projected_points
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
          required: ['slateId']
        },
        execute: async ({ slateId, position, minSalary, maxSalary, minProjection, limit = 20 }) => {
          console.log(`\n📋 [OptimizerAgent] Getting player pool for slate ${slateId}`);

          let query = `SELECT id, name, position, team, salary, projected_points, floor, ceiling,
                       rostership AS ownership, leverage_score, boom_probability, injury_status
                       FROM players WHERE slate_id = ?`;
          const params = [slateId];

          if (position) {
            query += ` AND position LIKE ?`;
            params.push(`%${position}%`);
          }
          if (minSalary) {
            query += ` AND salary >= ?`;
            params.push(minSalary);
          }
          if (maxSalary) {
            query += ` AND salary <= ?`;
            params.push(maxSalary);
          }
          if (minProjection) {
            query += ` AND projected_points >= ?`;
            params.push(minProjection);
          }

          query += ` ORDER BY projected_points DESC LIMIT ?`;
          params.push(limit);

          const players = await db.all(query, ...params);

          return {
            success: true,
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
              injury: p.injury_status
            }))
          };
        }
      }
    ];
  }
}

export default OptimizerAgent;
