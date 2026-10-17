/**
 * AnalystAgent - Specialized agent for historical analysis and matchup insights
 *
 * Responsibilities:
 * - Analyze player historical performance
 * - Evaluate matchup advantages/disadvantages
 * - Identify teammate absence impact
 * - Provide data-driven insights
 */

import BaseAgent from './BaseAgent.js';
import db from '../config/database.js';
import nbaStatsService from '../services/nbaStatsService.js';

const SYSTEM_PROMPT = `You are an NBA analytics expert specializing in DFS insights.

Your job is to:
1. Analyze player historical performance (trends, consistency, ceiling/floor)
2. Evaluate matchup advantages and disadvantages
3. Identify teammate absence impact (usage bumps)
4. Analyze roster context and player correlations
5. Provide data-driven insights with statistical backing

HISTORICAL DATA AVAILABLE (historical_games table - 7000+ games):
- player_name, team, opponent, game_date, season
- is_home (1=home, 0=away)
- is_back_to_back (1=B2B, 0=normal rest)
- rest_days (days since last game)
- minutes, points, rebounds, assists, steals, blocks, turnovers
- fg_made, fg_attempted, fg_pct, fg3_made, fg3_attempted, fg3_pct
- ft_made, ft_attempted, ft_pct, oreb, dreb, plus_minus
- dk_fantasy_points (DraftKings fantasy points scored)
- usg_pct (usage rate), ts_pct (true shooting), efg_pct
- off_rtg, def_rtg, bpm (box plus/minus)

Key Analysis Types You Can Run:
- B2B performance: WHERE is_back_to_back = 1
- Rest advantage: GROUP BY rest_days
- Matchup history: WHERE opponent = 'XXX'
- Home/Away splits: WHERE is_home = 1 or 0
- Usage trends: AVG(usg_pct) over time periods
- Value analysis: dk_fantasy_points vs expected (use 5x salary as benchmark)

CRITICAL - NO HALLUCINATION RULES:
- ONLY analyze data that is actually returned from your tool calls
- If a tool returns "no games found" or empty results, say "No historical data available for this query"
- NEVER make up statistics, game logs, or player performance numbers
- NEVER claim a player is playing tonight unless you have verified slate data
- If asked about current matchups but no slate exists, say "No current slate data - cannot analyze tonight's matchups"
- DO NOT use general NBA knowledge to invent specific statistics - only use actual tool results
- If data is missing, acknowledge it honestly rather than filling gaps with assumptions

Always support your analysis with specific numbers from actual query results.
Explain the implications for DFS (cash vs GPP suitability).`;

class AnalystAgent extends BaseAgent {
  constructor() {
    super({
      name: 'analyst',
      description: 'Historical analysis and matchup insights specialist',
      maxIterations: 5,
      systemPrompt: SYSTEM_PROMPT,
      tools: []
    });

    this.tools = this.createTools();
  }

  createTools() {
    return [
      {
        name: 'get_player_history',
        description: 'Get historical game log and performance trends for a player. Use this to analyze recent form, consistency, ceiling/floor.',
        parameters: {
          type: 'object',
          properties: {
            playerName: {
              type: 'string',
              description: 'Player name to look up (e.g., "LeBron James")'
            },
            limit: {
              type: 'number',
              description: 'Number of recent games to return (default 10, max 50)'
            }
          },
          required: ['playerName']
        },
        execute: async ({ playerName, limit = 10 }) => {
          console.log(`\n📊 [AnalystAgent] Getting history for: ${playerName}`);

          try {
            const games = await nbaStatsService.getPlayerHistory(playerName, Math.min(limit, 50));
            const trends = await nbaStatsService.getPerformanceTrends(playerName);

            if (games.length === 0) {
              return {
                success: false,
                message: `No historical data found for "${playerName}". Try syncing historical data first.`
              };
            }

            console.log(`✅ Found ${games.length} games for ${playerName}`);

            return {
              success: true,
              player: playerName,
              gamesFound: games.length,
              trends: {
                avgDkPoints: trends.avg_dk_pts,
                avgMinutes: trends.avg_minutes,
                ceiling: trends.ceiling,
                floor: trends.floor,
                consistency: trends.consistency,
                homeAvg: trends.home_avg,
                awayAvg: trends.away_avg,
                b2bAvg: trends.b2b_avg,
                restedAvg: trends.rested_avg,
              },
              recentGames: games.slice(0, 10).map(g => ({
                date: g.game_date,
                opponent: g.opponent,
                minutes: g.minutes,
                dkPoints: g.dk_fantasy_points,
                points: g.points,
                rebounds: g.rebounds,
                assists: g.assists,
                isHome: g.is_home,
                isB2B: g.is_back_to_back,
              }))
            };
          } catch (error) {
            console.error('❌ Player History Error:', error);
            return { success: false, error: error.message };
          }
        }
      },

      {
        name: 'get_matchup_history',
        description: 'Get a player\'s historical performance against a specific opponent.',
        parameters: {
          type: 'object',
          properties: {
            playerName: {
              type: 'string',
              description: 'Player name to look up'
            },
            opponent: {
              type: 'string',
              description: 'Opponent team abbreviation (e.g., "LAL", "BOS")'
            }
          },
          required: ['playerName', 'opponent']
        },
        execute: async ({ playerName, opponent }) => {
          console.log(`\n🏀 [AnalystAgent] Getting matchup: ${playerName} vs ${opponent}`);

          try {
            const games = await nbaStatsService.getMatchupHistory(playerName, opponent.toUpperCase());

            if (games.length === 0) {
              return {
                success: true,
                message: `No games found for ${playerName} vs ${opponent}`,
                games: []
              };
            }

            // Calculate averages
            const avgDkPts = games.reduce((sum, g) => sum + g.dk_fantasy_points, 0) / games.length;
            const avgMinutes = games.reduce((sum, g) => sum + g.minutes, 0) / games.length;
            const avgPoints = games.reduce((sum, g) => sum + g.points, 0) / games.length;

            console.log(`✅ Found ${games.length} games vs ${opponent}`);

            return {
              success: true,
              player: playerName,
              opponent: opponent.toUpperCase(),
              gamesPlayed: games.length,
              averages: {
                dkPoints: Math.round(avgDkPts * 10) / 10,
                minutes: Math.round(avgMinutes * 10) / 10,
                points: Math.round(avgPoints * 10) / 10,
              },
              games: games.map(g => ({
                date: g.game_date,
                minutes: g.minutes,
                dkPoints: g.dk_fantasy_points,
                points: g.points,
                rebounds: g.rebounds,
                assists: g.assists,
              }))
            };
          } catch (error) {
            console.error('❌ Matchup History Error:', error);
            return { success: false, error: error.message };
          }
        }
      },

      {
        name: 'get_usage_without_teammate',
        description: 'Analyze how a player\'s usage and fantasy production changes when a specific teammate is OUT.',
        parameters: {
          type: 'object',
          properties: {
            playerName: {
              type: 'string',
              description: 'The player to analyze'
            },
            teammateName: {
              type: 'string',
              description: 'The teammate who is OUT'
            },
            team: {
              type: 'string',
              description: 'Team abbreviation to filter by (optional)'
            }
          },
          required: ['playerName', 'teammateName']
        },
        execute: async ({ playerName, teammateName, team }) => {
          console.log(`\n🔄 [AnalystAgent] Analyzing ${playerName} without ${teammateName}...`);

          try {
            const result = await nbaStatsService.getUsageWithoutTeammate(playerName, teammateName, team);

            if (!result.success) {
              return result;
            }

            console.log(`✅ Found data: ${result.withTeammate?.games || 0} WITH, ${result.withoutTeammate?.games || 0} WITHOUT`);

            return {
              success: true,
              analysis: {
                player: result.player,
                teammate: result.teammate,
                team: result.team,
                withTeammate: result.withTeammate,
                withoutTeammate: result.withoutTeammate,
                usageBump: result.usageBump,
                insight: result.usageBump
                  ? `${result.player} averages ${result.usageBump.dkPointsDiff > 0 ? '+' : ''}${result.usageBump.dkPointsDiff} DK points (${result.usageBump.percentBoost > 0 ? '+' : ''}${result.usageBump.percentBoost}%) when ${result.teammate} is OUT`
                  : 'Insufficient data to calculate usage bump',
                recentGamesWithout: result.recentGamesWithout,
              }
            };
          } catch (error) {
            console.error('❌ Usage Analysis Error:', error);
            return { success: false, error: error.message };
          }
        }
      },

      {
        name: 'analyze_roster_context',
        description: 'Analyze historical games with similar roster configurations. Find how players performed when specific teammates were in/out.',
        parameters: {
          type: 'object',
          properties: {
            team: {
              type: 'string',
              description: 'Team abbreviation (e.g., "LAL", "DAL")'
            },
            activePlayers: {
              type: 'array',
              items: { type: 'string' },
              description: 'Array of player names expected to play'
            },
            absentPlayers: {
              type: 'array',
              items: { type: 'string' },
              description: 'Array of player names who are OUT'
            }
          },
          required: ['team', 'activePlayers', 'absentPlayers']
        },
        execute: async ({ team, activePlayers, absentPlayers }) => {
          console.log(`\n🏀 [AnalystAgent] Analyzing roster context for ${team}...`);
          console.log(`Active: ${activePlayers.join(', ')}`);
          console.log(`Absent: ${absentPlayers.join(', ')}`);

          try {
            const result = await nbaStatsService.analyzeRosterContext(team, activePlayers, absentPlayers);

            if (!result.success) {
              return result;
            }

            console.log(`✅ Found ${result.matchingGamesCount} matching historical games`);

            return {
              success: true,
              analysis: {
                team: result.team,
                scenario: {
                  activePlayers: result.activePlayers,
                  absentPlayers: result.absentPlayers,
                },
                matchingGames: {
                  count: result.matchingGamesCount,
                  dates: result.matchingGameDates,
                },
                usageBumps: result.usageBumps,
                topBeneficiaries: result.topBeneficiaries,
                insight: result.topBeneficiaries?.length > 0
                  ? `Top beneficiaries when ${absentPlayers.join(', ')} out: ${result.topBeneficiaries.map(p => `${p.player} (+${p.percentBoost}%)`).join(', ')}`
                  : 'No significant usage bumps found in historical data',
              }
            };
          } catch (error) {
            console.error('❌ Roster Context Error:', error);
            return { success: false, error: error.message };
          }
        }
      },

      {
        name: 'get_team_roster',
        description: 'Get the historical roster and player averages for a specific team.',
        parameters: {
          type: 'object',
          properties: {
            team: {
              type: 'string',
              description: 'Team abbreviation (e.g., "LAL", "DAL")'
            }
          },
          required: ['team']
        },
        execute: async ({ team }) => {
          console.log(`\n📋 [AnalystAgent] Getting roster for ${team}...`);

          try {
            const roster = await nbaStatsService.getTeamRoster(team.toUpperCase());

            if (roster.length === 0) {
              return {
                success: false,
                message: `No historical data found for team ${team}`
              };
            }

            console.log(`✅ Found ${roster.length} players for ${team}`);

            return {
              success: true,
              team: team.toUpperCase(),
              playerCount: roster.length,
              players: roster.map(p => ({
                name: p.player_name,
                gamesPlayed: p.games_played,
                avgMinutes: p.avg_minutes,
                avgDkPoints: p.avg_dk_pts,
                ceiling: p.ceiling,
                floor: p.floor,
                consistency: p.consistency,
              }))
            };
          } catch (error) {
            console.error('❌ Team Roster Error:', error);
            return { success: false, error: error.message };
          }
        }
      },

      {
        name: 'get_historical_summary',
        description: 'Get a summary of all historical data in the database including top performers.',
        parameters: {
          type: 'object',
          properties: {
            topN: {
              type: 'number',
              description: 'Number of top performers to return (default 10)'
            }
          }
        },
        execute: async ({ topN = 10 }) => {
          console.log('\n📈 [AnalystAgent] Getting historical summary...');

          try {
            const summary = await nbaStatsService.getHistoricalSummary();
            const topPerformers = await nbaStatsService.getTopPerformers(topN, 5);
            const b2bAnalysis = await nbaStatsService.analyzeB2BImpact();

            console.log(`✅ Summary: ${summary.total_games} games, ${summary.unique_players} players`);

            return {
              success: true,
              dataRange: {
                totalGames: summary.total_games,
                uniquePlayers: summary.unique_players,
                uniqueDates: summary.unique_dates,
                earliestGame: summary.earliest_game,
                latestGame: summary.latest_game,
              },
              leagueAverages: {
                dkPoints: Math.round(summary.avg_dk_points * 10) / 10,
                minutes: Math.round(summary.avg_minutes * 10) / 10,
              },
              b2bImpact: b2bAnalysis,
              topPerformers: topPerformers.map(p => ({
                name: p.player_name,
                team: p.team,
                gamesPlayed: p.games_played,
                avgDkPoints: p.avg_dk_pts,
                avgMinutes: p.avg_minutes,
                ceiling: p.ceiling,
              }))
            };
          } catch (error) {
            console.error('❌ Historical Summary Error:', error);
            return { success: false, error: error.message };
          }
        }
      },

      {
        name: 'compare_players',
        description: 'Compare two or more players head-to-head on key metrics.',
        parameters: {
          type: 'object',
          properties: {
            playerNames: {
              type: 'array',
              items: { type: 'string' },
              description: 'Array of player names to compare'
            }
          },
          required: ['playerNames']
        },
        execute: async ({ playerNames }) => {
          console.log(`\n⚖️ [AnalystAgent] Comparing: ${playerNames.join(' vs ')}`);

          const comparisons = [];

          for (const name of playerNames) {
            try {
              const trends = await nbaStatsService.getPerformanceTrends(name);
              const games = await nbaStatsService.getPlayerHistory(name, 10);

              if (games.length > 0) {
                comparisons.push({
                  name,
                  gamesAnalyzed: games.length,
                  avgDkPoints: trends.avg_dk_pts,
                  avgMinutes: trends.avg_minutes,
                  ceiling: trends.ceiling,
                  floor: trends.floor,
                  consistency: trends.consistency,
                  homeAvg: trends.home_avg,
                  awayAvg: trends.away_avg,
                  b2bAvg: trends.b2b_avg,
                  lastGame: games[0] ? {
                    date: games[0].game_date,
                    dkPoints: games[0].dk_fantasy_points,
                    opponent: games[0].opponent
                  } : null
                });
              }
            } catch (error) {
              console.log(`❌ Could not get data for ${name}`);
            }
          }

          if (comparisons.length === 0) {
            return {
              success: false,
              message: 'No historical data found for any of the requested players'
            };
          }

          // Sort by avg DK points
          comparisons.sort((a, b) => b.avgDkPoints - a.avgDkPoints);

          return {
            success: true,
            playersCompared: comparisons.length,
            comparison: comparisons,
            recommendation: comparisons.length >= 2
              ? `${comparisons[0].name} has the highest average (${comparisons[0].avgDkPoints} DK pts) but ${comparisons.find(p => p.consistency === Math.max(...comparisons.map(c => c.consistency)))?.name} is most consistent.`
              : null
          };
        }
      },

      {
        name: 'query_historical_data',
        description: 'Execute a custom SQL query against the historical_games table. Use this for complex analysis like B2B splits, rest day analysis, multi-condition filters. Table has: player_name, team, opponent, game_date, is_home, is_back_to_back, rest_days, minutes, points, rebounds, assists, steals, blocks, turnovers, dk_fantasy_points, usg_pct, ts_pct, plus_minus, off_rtg, def_rtg.',
        parameters: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'SQL SELECT query (must start with SELECT, only reads allowed)'
            },
            explanation: {
              type: 'string',
              description: 'Brief explanation of what this query analyzes'
            }
          },
          required: ['query', 'explanation']
        },
        execute: async ({ query, explanation }) => {
          console.log(`\n🔍 [AnalystAgent] Custom query: ${explanation}`);

          // Security: Only allow SELECT queries on historical_games
          const normalizedQuery = query.trim().toUpperCase();
          if (!normalizedQuery.startsWith('SELECT')) {
            return { success: false, error: 'Only SELECT queries are allowed' };
          }
          if (!query.toLowerCase().includes('historical_games')) {
            return { success: false, error: 'Query must reference the historical_games table' };
          }
          if (/\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE)\b/i.test(query)) {
            return { success: false, error: 'Only read-only SELECT queries are allowed' };
          }

          try {
            const results = await db.all(query);
            console.log(`✅ Query returned ${results.length} rows`);

            return {
              success: true,
              rowCount: results.length,
              data: results.slice(0, 50), // Limit to 50 rows
              truncated: results.length > 50,
              explanation
            };
          } catch (error) {
            console.error('❌ Query Error:', error);
            return { success: false, error: error.message, query };
          }
        }
      }
    ];
  }
}

export default AnalystAgent;
