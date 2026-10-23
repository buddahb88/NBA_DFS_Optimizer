/**
 * ResearchAgent - Specialized agent for database queries and player search
 *
 * Responsibilities:
 * - Execute SQL queries against the database
 * - Search for players by name
 * - Get current slate information
 * - Provide raw data for analysis
 */

import BaseAgent from './BaseAgent.js';
import db from '../config/database.js';
import { createResearchTools } from '../services/chatTools/researchTools.js';
import { getCurrentSlateInfo } from '../services/slateFreshness.js';

const SYSTEM_PROMPT = `You are a DFS research specialist with expertise in database queries and data retrieval.

Your job is to:
1. Query the NBA DFS database for player stats, Vegas lines, and performance data
2. Search for players by name (partial matching supported)
3. Get current slate information
4. Provide accurate, structured data for analysis

USE THE DEDICATED TOOLS FIRST; sql_query is only a fallback for questions they do not cover:
- get_archetype_matchups: tonight's best archetype matchups, ranked by adjusted edge (matchup x minutes x crowding)
- get_team_defense_profile: one defense vs each archetype and G/F/C (fp over expectation, per-stat deltas, rank, games)
- get_player_profile: role by season - archetype, usage/assist/rebound rates (fractions), minutes, per-36, fppm
- get_missing_players / get_usage_bumps: regulars missing from the slate and who benefits
- get_streaks_and_consistency: hot, cold, consistency, boom_bust
- score_lineup: actual points for players on a past date; get_projection_results: projection accuracy
- search_players, get_slate_summary, get_game_environment: tonight's slate

Database Tables Available:
- players: Current slate player data (name, salary, projected_points, position, team, opponent, vegas data, advanced metrics)
- slates: Available contest slates
- historical_games: ESPN game logs for every game since the 2024-25 season, keyed by player_key
- slate_player_snapshots: Saved past slates (salary, projection, projected ownership) per player_key and game_date
- player_season_profiles: Season role profile per (season, player_key) - usg_pct, ast_pct, reb_pct (fractions), minutes_pg, per-36, dk_fppm
- player_archetypes: Archetype per (season, player_key), e.g. primary_creator, stretch_big, rim_running_big
- team_archetype_defense: How each defense does vs each archetype / G-F-C position relative to expectation (the matchup table)
- team_defense_rankings: Team defensive efficiency and pace
- team_defense_vs_position: Legacy HashtagBasketball DVP (pts_allowed = REAL points, not fantasy points)

HISTORICAL_GAMES TABLE COLUMNS:
- player_key (match key, e.g. 'luka doncic'), player_name, team, opponent, position (G/F/C), game_date
- season ('2025-26'), season_type ('regular' / 'play-in' / 'playoffs'), is_starter, is_home, is_back_to_back, rest_days
- minutes, points, rebounds, assists, steals, blocks, turnovers, fg3_made, ts_pct
- dk_fantasy_points, fd_fantasy_points, yahoo_fantasy_points
- usg_pct, off_rtg, def_rtg, bpm are EMPTY - use player_season_profiles for usage and rates

TEAM_ARCHETYPE_DEFENSE (filter season, site 'draftkings'/'fanduel'/'yahoo', group_by 'archetype' or 'position'):
- team = DEFENDING team (match players.opponent), group_key = archetype key or G/F/C, games = sample size
- fp_over_expectation: fantasy points per player-game allowed above (+) / below (-) expectation, shrunk toward 0 when games are few
- Early in a season use the prior season until 20+ defenses have 10+ games

Important Query Tips:
- Player names: resolve them to player_key with the tools (the analyst's history tools or the player_key utility), which handle accents, punctuation and Jr./III; filter history tables by player_key, not by name
- Tonight's archetype matchups: players -> player_season_profiles -> player_archetypes (same season) -> team_archetype_defense
- Filter season_type = 'regular' and minutes > 0 for season averages
- Use LOWER() for case-insensitive name searches
- Players table has pre-joined dvp_pts_allowed (real points allowed to the position, about 18-28, NOT fantasy points; legacy) and opp_def_eff
- Vegas data includes: vegas_implied_total, vegas_spread, vegas_over_under, vegas_win_prob
- Advanced metrics: floor, ceiling, volatility, boom_probability, bust_probability, leverage_score

CRITICAL - NO HALLUCINATION RULES:
- ONLY report data that is actually returned from your tool calls
- If a query returns 0 rows or "no data found", report that honestly - DO NOT make up data
- NEVER invent player names, salaries, stats, or matchups that weren't in the query results
- If there's no slate data, say "No slate data available in the database"
- If a player search returns empty, say "Player not found in current slate"

STALE SLATE GUARD:
- get_current_slate returns slateDate (the night the slate covers), today (ET) and isStale
- If isStale is true, do not present the slate as tonight's: report the warning, do not recommend plays or build lineups for tonight, and tell the user to sync tonight's slate (Home or Data Status page). Only use it when the user explicitly asks about that past date
- State the slate date your answer covers (slate tools return slateDate)
- DO NOT use your general NBA knowledge to fill gaps - only use actual query results

Always show your SQL queries and explain what data you retrieved.`;

class ResearchAgent extends BaseAgent {
  constructor() {
    super({
      name: 'research',
      description: 'Database queries and player search specialist',
      maxIterations: 5,
      systemPrompt: SYSTEM_PROMPT,
      tools: []
    });

    this.tools = this.createTools();
  }

  createTools() {
    return [
      {
        name: 'sql_query',
        description: 'FALLBACK ONLY: execute SQL SELECT queries against the NBA DFS database when no dedicated tool answers the question. Returns data as JSON array.',
        parameters: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'SQL SELECT query to execute (SELECT only for safety)'
            },
            explanation: {
              type: 'string',
              description: 'Brief explanation of what this query does'
            }
          },
          required: ['query', 'explanation']
        },
        execute: async ({ query, explanation }) => {
          console.log(`\n📊 [ResearchAgent] SQL: ${explanation}`);
          console.log(`Query: ${query}`);

          // Safety check - only allow SELECT
          const normalizedQuery = query.trim().toUpperCase();
          if (!normalizedQuery.startsWith('SELECT')) {
            return {
              success: false,
              error: 'Only SELECT queries are allowed for safety'
            };
          }

          try {
            const results = await db.all(query);
            console.log(`✅ Returned ${results.length} rows`);

            // Limit results to prevent token overflow
            const limitedResults = results.slice(0, 100);

            return {
              success: true,
              rowCount: results.length,
              data: limitedResults,
              truncated: results.length > 100,
              explanation
            };
          } catch (error) {
            console.error('❌ SQL Error:', error.message);
            return {
              success: false,
              error: error.message,
              query
            };
          }
        }
      },

      {
        name: 'search_players',
        description: 'Search for players by name to get their IDs and details. Supports partial name matching.',
        parameters: {
          type: 'object',
          properties: {
            playerNames: {
              type: 'array',
              items: { type: 'string' },
              description: 'Array of player names to search for'
            },
            slateId: {
              type: 'string',
              description: 'Optional slate ID to filter by'
            }
          },
          required: ['playerNames']
        },
        execute: async ({ playerNames, slateId }) => {
          console.log(`\n🔍 [ResearchAgent] Searching for: ${playerNames.join(', ')}`);

          const foundPlayers = [];
          const notFound = [];

          for (const name of playerNames) {
            let query = `
              SELECT id, name, position, team, opponent, salary, projected_points,
                     floor, ceiling, ownership, leverage_score, injury_status, slate_id
              FROM players
              WHERE LOWER(name) LIKE LOWER(?)
            `;
            const params = [`%${name}%`];

            if (slateId) {
              query += ' AND slate_id = ?';
              params.push(slateId);
            }

            query += ' ORDER BY projected_points DESC LIMIT 5';

            const results = await db.all(query, ...params);

            if (results.length > 0) {
              foundPlayers.push(...results);
              console.log(`✅ Found ${results.length} matches for "${name}"`);
            } else {
              notFound.push(name);
              console.log(`❌ No matches for "${name}"`);
            }
          }

          return {
            success: true,
            found: foundPlayers.map(p => ({
              id: p.id,
              name: p.name,
              position: p.position,
              team: p.team,
              opponent: p.opponent,
              salary: p.salary,
              projection: p.projected_points,
              floor: p.floor,
              ceiling: p.ceiling,
              ownership: p.ownership,
              leverage: p.leverage_score,
              injury: p.injury_status,
              slateId: p.slate_id
            })),
            notFound,
            totalMatches: foundPlayers.length
          };
        }
      },

      {
        name: 'get_current_slate',
        description: 'Get the latest slate: ID, details, slateDate (night it covers), today (ET), isStale and a warning when it is not tonight\'s. Use this when slate_id is not provided.',
        parameters: {
          type: 'object',
          properties: {}
        },
        execute: async () => {
          console.log('\n📅 [ResearchAgent] Getting current slate...');

          const slate = await getCurrentSlateInfo();
          if (!slate) {
            return { success: false, error: 'No slates found in database' };
          }

          console.log(`✅ Current slate: ${slate.slateId} (${slate.name}) for ${slate.slateDate}${slate.isStale ? ' - STALE' : ''}`);

          return { success: true, slate };
        }
      },

      {
        name: 'get_slate_summary',
        description: 'Get a summary of all players on a slate including position breakdown, salary distribution, and top plays.',
        parameters: {
          type: 'object',
          properties: {
            slateId: {
              type: 'string',
              description: 'Slate ID to summarize'
            }
          },
          required: ['slateId']
        },
        execute: async ({ slateId }) => {
          console.log(`\n📈 [ResearchAgent] Getting slate summary for ${slateId}`);

          // Get position breakdown
          const positionBreakdown = await db.all(`
            SELECT position, COUNT(*) as count, AVG(salary) as avg_salary, AVG(projected_points) as avg_projection
            FROM players WHERE slate_id = ?
            GROUP BY position
          `, slateId);

          // Get salary tiers
          const salaryTiers = await db.all(`
            SELECT
              CASE
                WHEN salary >= 9000 THEN 'Premium ($9k+)'
                WHEN salary >= 7000 THEN 'Mid ($7-9k)'
                WHEN salary >= 5000 THEN 'Value ($5-7k)'
                ELSE 'Punt (<$5k)'
              END as tier,
              COUNT(*) as count,
              AVG(projected_points) as avg_projection
            FROM players WHERE slate_id = ?
            GROUP BY tier
          `, slateId);

          // Get top projected players
          const topProjected = await db.all(`
            SELECT name, position, team, salary, projected_points, ownership, leverage_score
            FROM players WHERE slate_id = ?
            ORDER BY projected_points DESC LIMIT 10
          `, slateId);

          // Get best value plays
          const bestValue = await db.all(`
            SELECT name, position, team, salary, projected_points,
                   (projected_points / salary * 1000) as value_score
            FROM players WHERE slate_id = ? AND salary > 0
            ORDER BY value_score DESC LIMIT 10
          `, slateId);

          // Get top leverage plays (GPP)
          const topLeverage = await db.all(`
            SELECT name, position, team, salary, projected_points, ownership, leverage_score, ceiling
            FROM players WHERE slate_id = ? AND leverage_score IS NOT NULL
            ORDER BY leverage_score DESC LIMIT 10
          `, slateId);

          return {
            success: true,
            slateId,
            positionBreakdown: positionBreakdown.map(p => ({
              position: p.position,
              count: p.count,
              avgSalary: Math.round(p.avg_salary),
              avgProjection: Math.round(p.avg_projection * 10) / 10
            })),
            salaryTiers,
            topProjected: topProjected.map(p => ({
              name: p.name,
              position: p.position,
              team: p.team,
              salary: p.salary,
              projection: p.projected_points,
              ownership: p.ownership
            })),
            bestValue: bestValue.map(p => ({
              name: p.name,
              position: p.position,
              team: p.team,
              salary: p.salary,
              projection: p.projected_points,
              valueScore: Math.round(p.value_score * 100) / 100
            })),
            topLeverage: topLeverage.map(p => ({
              name: p.name,
              position: p.position,
              team: p.team,
              salary: p.salary,
              projection: p.projected_points,
              ownership: p.ownership,
              leverage: p.leverage_score,
              ceiling: p.ceiling
            }))
          };
        }
      },

      {
        name: 'get_game_environment',
        description: 'Get Vegas lines and game environment data for all games on a slate.',
        parameters: {
          type: 'object',
          properties: {
            slateId: {
              type: 'string',
              description: 'Slate ID'
            }
          },
          required: ['slateId']
        },
        execute: async ({ slateId }) => {
          console.log(`\n🎰 [ResearchAgent] Getting game environment for slate ${slateId}`);

          const games = await db.all(`
            SELECT DISTINCT
              team, opponent,
              vegas_implied_total, vegas_spread, vegas_over_under, vegas_win_prob,
              game_info
            FROM players
            WHERE slate_id = ?
            GROUP BY team, opponent
          `, slateId);

          // Sort by implied total (highest scoring games first)
          games.sort((a, b) => (b.vegas_implied_total || 0) - (a.vegas_implied_total || 0));

          return {
            success: true,
            slateId,
            gameCount: games.length / 2, // Each game has 2 teams
            games: games.map(g => ({
              team: g.team,
              opponent: g.opponent,
              impliedTotal: g.vegas_implied_total,
              spread: g.vegas_spread,
              overUnder: g.vegas_over_under,
              winProb: g.vegas_win_prob,
              gameInfo: g.game_info
            }))
          };
        }
      },

      ...createResearchTools()
    ];
  }
}

export default ResearchAgent;
