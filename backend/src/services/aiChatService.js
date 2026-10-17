import OpenAI from 'openai';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import yaml from 'js-yaml';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import db, { DATABASE_TYPE } from '../config/database.js';
import optimizerService from './optimizerService.js';
import nbaStatsService from './nbaStatsService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class AIChatService {
  constructor() {
    this.model = null;
    this.toolsMap = null;
    this.modelWithTools = null;
    this.initialized = false;
  }

  /**
   * Ensure the service is initialized (lazy loading)
   */
  ensureInitialized() {
    if (!this.initialized) {
      this.initializeModel();
      this.initialized = true;
    }
  }

  /**
   * Initialize Azure OpenAI model
   */
  initializeModel() {
    try {
      console.log('🔧 Initializing Azure OpenAI...');
      console.log('Endpoint:', process.env.AZURE_OPENAI_ENDPOINT);
      console.log('Model:', process.env.AZURE_OPENAI_MODEL);
      console.log('Key present:', !!process.env.AZURE_OPENAI_KEY);

      if (!process.env.AZURE_OPENAI_KEY) {
        throw new Error('AZURE_OPENAI_KEY not found in environment variables');
      }

      if (!process.env.AZURE_OPENAI_ENDPOINT) {
        throw new Error('AZURE_OPENAI_ENDPOINT not found in environment variables');
      }

      // Initialize OpenAI client with Azure configuration
      const apiVersion = process.env.AZURE_OPENAI_API_VERSION || '2024-04-01-preview';
      this.client = new OpenAI({
        apiKey: process.env.AZURE_OPENAI_KEY,
        baseURL: `${process.env.AZURE_OPENAI_ENDPOINT}/openai/deployments/${process.env.AZURE_OPENAI_MODEL || 'gpt-4.1-mini'}`,
        defaultQuery: { 'api-version': apiVersion },
        defaultHeaders: { 'api-key': process.env.AZURE_OPENAI_KEY },
      });

      this.deploymentName = process.env.AZURE_OPENAI_MODEL || 'gpt-4.1-mini';

      console.log('✅ Azure OpenAI client initialized');
      this.initializeAgent();
    } catch (error) {
      console.error('❌ Failed to initialize Azure OpenAI:', error);
      throw error;
    }
  }

  /**
   * Initialize LangChain agent with tools
   */
  async initializeAgent() {
    const tools = this.createTools();

    // Store tools for function calling
    this.toolsMap = new Map(tools.map(tool => [tool.name, tool]));
    this.tools = tools;

    console.log(`✅ LangChain agent initialized with ${tools.length} tools`);
  }

  /**
   * Load database schema from YAML
   */
  loadDatabaseSchema() {
    try {
      const schemaPath = path.join(__dirname, '../config/database-schema.yaml');
      const schemaFile = fs.readFileSync(schemaPath, 'utf8');
      return yaml.load(schemaFile);
    } catch (error) {
      console.error('Failed to load database schema:', error);
      return null;
    }
  }

  /**
   * Get system prompt for NBA DFS expert
   */
  getSystemPrompt() {
    const schema = this.loadDatabaseSchema();

    let schemaDoc = '';
    if (schema) {
      // Format the schema for the prompt
      schemaDoc = `
## DATABASE SCHEMA

**CRITICAL: Read this schema carefully before writing ANY SQL queries!**

### AVAILABLE TABLES:
You have access to the following tables:
1. **players** - Core player data with projections, stats, salaries, and matchup metrics (PRIMARY TABLE)
2. **slates** - DFS contest slate information
3. **team_defense_rankings** - Team defensive efficiency, pace, and advanced stats (from ESPN)
4. **team_defense_vs_position** - Position-specific defensive rankings (DVP) (from HashtagBasketball)
5. **lineups** - Saved DFS lineups
6. **lineup_players** - Junction table linking players to lineups
7. **chat_sessions** - AI chat conversation sessions
8. **chat_messages** - Individual chat messages

### Players Table (Primary table for queries)

**Important Columns:**
${schema.tables.players.columns.map(col => `- **${col.name}** (${col.type}): ${col.description}${col.valid_values ? `\n  Valid values: ${JSON.stringify(col.valid_values)}` : ''}${col.notes ? `\n  Notes: ${col.notes}` : ''}`).join('\n')}

### Common Filters:
${Object.entries(schema.tables.players.common_filters).map(([name, sql]) => `- ${name}: ${sql}`).join('\n')}

### Example Queries:
${schema.tables.players.example_queries.basic.map(ex => `**${ex.description}:**\n\`\`\`sql\n${ex.query}\n\`\`\`\n`).join('\n')}

### Team Defense Rankings Table

**Description:** ${schema.tables.team_defense_rankings.description}

**Important Columns:**
${schema.tables.team_defense_rankings.columns.map(col => `- **${col.name}** (${col.type}): ${col.description}${col.range ? ` (Range: ${col.range.join('-')})` : ''}${col.notes ? `\n  Notes: ${col.notes}` : ''}`).join('\n')}

**Example Queries:**
${schema.tables.team_defense_rankings.example_queries.map(ex => typeof ex === 'string' ? `\`\`\`sql\n${ex}\n\`\`\`` : `**${ex.description}:**\n\`\`\`sql\n${ex.query}\n\`\`\``).join('\n\n')}

### Team Defense vs Position Table (DVP)

**Description:** ${schema.tables.team_defense_vs_position.description}

**Important Columns:**
${schema.tables.team_defense_vs_position.columns.map(col => `- **${col.name}** (${col.type}): ${col.description}${col.range ? ` (Range: ${col.range.join('-')})` : ''}${col.notes ? `\n  Notes: ${col.notes}` : ''}`).join('\n')}

**Example Queries:**
${schema.tables.team_defense_vs_position.example_queries.map(ex => typeof ex === 'string' ? `\`\`\`sql\n${ex}\n\`\`\`` : `**${ex.description}:**\n\`\`\`sql\n${ex.query}\n\`\`\``).join('\n\n')}

### Slates Table

**Description:** ${schema.tables.slates.description}

**Columns:** ${schema.tables.slates.columns.map(col => col.name).join(', ')}

### CRITICAL QUERY TIPS:
${schema.query_tips.map(tip => `- ${tip}`).join('\n')}

**INJURY_STATUS FIELD - READ THIS:**
- There is NO "ACTIVE" value in injury_status!
- NULL or empty string = healthy/active player
- To find healthy players: \`WHERE (injury_status IS NULL OR injury_status = '')\`
- Valid injury statuses: GTD, Questionable, Doubtful, OUT, Probable
- To exclude injured: \`WHERE (injury_status IS NULL OR injury_status = '' OR injury_status NOT IN ('OUT', 'Doubtful'))\`

**IMPORTANT MATCHUP DATA:**
- The players table has PRE-JOINED matchup data: dvp_pts_allowed and opp_def_eff
- Use team_defense_rankings for pace and overall defensive efficiency analysis
- Use team_defense_vs_position for detailed position-specific matchup analysis
- All defensive data is auto-populated when slates are loaded!
`;
    }

    return `You are an expert NBA Daily Fantasy Sports (DFS) and sports betting advisor with deep knowledge of basketball analytics, player performance, Vegas lines, and game theory.

${schemaDoc}

**Your Expertise:**
- Player projections, matchup analysis, and advanced stats (PER, Usage%, etc.)
- DFS lineup construction and optimization strategies
- Cash game vs GPP (tournament) strategies
- Game stacking and correlation plays
- Vegas betting lines, spreads, over/unders, and implied totals
- Ownership projections and leverage plays
- Injury impact analysis and news interpretation

**DFS Lineup Constraints (DraftKings):**
- Exactly 8 players
- Positions: PG, SG, SF, PF, C, G (guard flex), F (forward flex), UTIL (any position)
- Salary cap: $50,000
- Each player can only be used once per lineup

**Communication Style:**
- Be conversational and insightful
- Provide data-driven reasoning for recommendations
- Show SQL queries when executed (users like transparency)
- Format lineup results clearly with positions, salaries, and projections
- Include strategic rationale: WHY you made certain selections

**Important Notes:**
- ALWAYS use tools to get actual data - never make up stats or player names
- When users ask to "lock" or "build around" players, extract their names and use the lineup_builder tool
- Show your work: explain SQL queries and optimization parameters
- If data is missing or unclear, ask clarifying questions`;
  }

  /**
   * Create tools for the agent
   */
  createTools() {
    return [
      // SQL Query Tool
      new DynamicStructuredTool({
        name: 'sql_query',
        description: 'Execute SQL queries against the NBA DFS database. Use this to query player stats, Vegas lines, recent performance, or any data analysis. Returns rows as JSON array.',
        schema: z.object({
          query: z.string().describe('SQL SELECT query to execute'),
          explanation: z.string().describe('Brief explanation of what this query does'),
        }),
        func: async ({ query, explanation }) => {
          try {
            console.log(`\n📊 Executing SQL: ${explanation}`);
            console.log(`Query: ${query}`);

            const results = await db.all(query);

            console.log(`✅ Returned ${results.length} rows`);
            return JSON.stringify({
              success: true,
              rowCount: results.length,
              data: results,
              explanation,
            }, null, 2);
          } catch (error) {
            console.error('❌ SQL Error:', error);
            return JSON.stringify({
              success: false,
              error: error.message,
              query,
            });
          }
        },
      }),

      // Player Search Tool
      new DynamicStructuredTool({
        name: 'search_players',
        description: 'Search for players by name to get their IDs and details. Use this before building lineups to find player IDs. Supports partial name matching.',
        schema: z.object({
          playerNames: z.array(z.string()).describe('Array of player names to search for'),
          slateId: z.string().optional().describe('Optional slate ID to filter by'),
        }),
        func: async ({ playerNames, slateId }) => {
          try {
            console.log(`\n🔍 Searching for players: ${playerNames.join(', ')}`);

            const foundPlayers = [];
            const notFound = [];

            for (const name of playerNames) {
              let query = `
                SELECT id, name, position, team, salary, projected_points, injury_status, slate_id
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

            return JSON.stringify({
              success: true,
              found: foundPlayers,
              notFound,
              totalMatches: foundPlayers.length,
            }, null, 2);
          } catch (error) {
            console.error('❌ Player Search Error:', error);
            return JSON.stringify({ success: false, error: error.message });
          }
        },
      }),

      // Lineup Builder Tool
      new DynamicStructuredTool({
        name: 'build_lineup',
        description: 'Build optimal DFS lineups using Linear Programming optimization. Can lock specific players and generate multiple lineups. This is the PRIMARY tool for lineup construction requests.',
        schema: z.object({
          slateId: z.string().describe('Slate ID to build lineup for'),
          lockedPlayerIds: z.array(z.number()).optional().describe('Array of player IDs to lock/force into lineup'),
          excludedPlayerIds: z.array(z.number()).optional().describe('Array of player IDs to exclude from consideration'),
          mode: z.enum(['cash', 'gpp']).default('cash').describe('Optimization mode: cash for safe plays, gpp for tournaments'),
          numLineups: z.number().default(1).describe('Number of lineups to generate (1-20)'),
          minSalary: z.number().default(49000).describe('Minimum salary to use (default 49000)'),
          randomness: z.number().default(0).describe('Randomness 0-100 for GPP variance (default 0)'),
        }),
        func: async ({ slateId, lockedPlayerIds = [], excludedPlayerIds = [], mode = 'cash', numLineups = 1, minSalary = 49000, randomness = 0 }) => {
          try {
            console.log(`\n🏀 Building ${numLineups} ${mode.toUpperCase()} lineup(s) for slate ${slateId}`);
            if (lockedPlayerIds.length > 0) {
              console.log(`🔒 Locked players: ${lockedPlayerIds.join(', ')}`);
            }

            // Get all players for this slate
            const players = await db.all('SELECT * FROM players WHERE slate_id = ?', slateId);

            if (players.length === 0) {
              return JSON.stringify({
                success: false,
                error: `No players found for slate ${slateId}`,
              });
            }

            console.log(`✅ Found ${players.length} players for slate`);

            // Use optimizer service
            const lineups = optimizerService.optimize(players, {
              mode,
              numLineups,
              lockedPlayers: lockedPlayerIds,
              excludedPlayers: excludedPlayerIds,
              minSalary,
              randomness,
            });

            if (lineups.length === 0) {
              return JSON.stringify({
                success: false,
                error: 'Could not generate valid lineups with given constraints',
              });
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
                } : null,
              })),
              totalSalary: lineup.totalSalary,
              projectedPoints: lineup.projectedPoints,
              remainingSalary: lineup.remainingSalary,
            }));

            return JSON.stringify({
              success: true,
              lineups: formattedLineups,
              count: formattedLineups.length,
              mode,
              slateId,
            }, null, 2);
          } catch (error) {
            console.error('❌ Lineup Builder Error:', error);
            return JSON.stringify({
              success: false,
              error: error.message,
            });
          }
        },
      }),

      // Get Current Slate Tool
      new DynamicStructuredTool({
        name: 'get_current_slate',
        description: 'Get the most recent slate ID and details. Use this when slate_id is not provided by user.',
        schema: z.object({}),
        func: async () => {
          try {
            console.log('\n📅 Getting current slate...');

            const slate = await db.get(`
              SELECT slate_id, name, start_time, created_at
              FROM slates
              ORDER BY created_at DESC
              LIMIT 1
            `);

            if (!slate) {
              return JSON.stringify({
                success: false,
                error: 'No slates found in database',
              });
            }

            console.log(`✅ Current slate: ${slate.slate_id} (${slate.name})`);

            return JSON.stringify({
              success: true,
              slate,
            }, null, 2);
          } catch (error) {
            console.error('❌ Get Slate Error:', error);
            return JSON.stringify({ success: false, error: error.message });
          }
        },
      }),

      // Historical Player Analysis Tool
      new DynamicStructuredTool({
        name: 'get_player_history',
        description: 'Get historical game log and performance trends for a player. Use this to analyze recent form, consistency, ceiling/floor, and matchup history. Great for supporting lineup decisions with data.',
        schema: z.object({
          playerName: z.string().describe('Player name to look up (e.g., "LeBron James", "Luka Doncic")'),
          limit: z.number().optional().describe('Number of recent games to return (default 10, max 50)'),
        }),
        func: async ({ playerName, limit = 10 }) => {
          try {
            console.log(`\n📊 Getting historical data for: ${playerName}`);

            const games = await nbaStatsService.getPlayerHistory(playerName, Math.min(limit, 50));
            const trends = await nbaStatsService.getPerformanceTrends(playerName);

            if (games.length === 0) {
              return JSON.stringify({
                success: false,
                message: `No historical data found for "${playerName}". Try syncing historical data first.`,
              });
            }

            console.log(`✅ Found ${games.length} games for ${playerName}`);

            return JSON.stringify({
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
              })),
            }, null, 2);
          } catch (error) {
            console.error('❌ Player History Error:', error);
            return JSON.stringify({ success: false, error: error.message });
          }
        },
      }),

      // Matchup History Tool
      new DynamicStructuredTool({
        name: 'get_matchup_history',
        description: 'Get a player\'s historical performance against a specific opponent. Use this to analyze how a player performs against certain teams.',
        schema: z.object({
          playerName: z.string().describe('Player name to look up'),
          opponent: z.string().describe('Opponent team abbreviation (e.g., "LAL", "BOS", "MIA")'),
        }),
        func: async ({ playerName, opponent }) => {
          try {
            console.log(`\n🏀 Getting matchup history: ${playerName} vs ${opponent}`);

            const games = await nbaStatsService.getMatchupHistory(playerName, opponent.toUpperCase());

            if (games.length === 0) {
              return JSON.stringify({
                success: true,
                message: `No games found for ${playerName} vs ${opponent}`,
                games: [],
              });
            }

            // Calculate averages
            const avgDkPts = games.reduce((sum, g) => sum + g.dk_fantasy_points, 0) / games.length;
            const avgMinutes = games.reduce((sum, g) => sum + g.minutes, 0) / games.length;
            const avgPoints = games.reduce((sum, g) => sum + g.points, 0) / games.length;

            console.log(`✅ Found ${games.length} games vs ${opponent}`);

            return JSON.stringify({
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
              })),
            }, null, 2);
          } catch (error) {
            console.error('❌ Matchup History Error:', error);
            return JSON.stringify({ success: false, error: error.message });
          }
        },
      }),

      // Historical Data Summary Tool
      new DynamicStructuredTool({
        name: 'get_historical_summary',
        description: 'Get a summary of all historical data in the database, including date range, total games, and top performers. Use this to understand what data is available.',
        schema: z.object({
          topN: z.number().optional().describe('Number of top performers to return (default 10)'),
        }),
        func: async ({ topN = 10 }) => {
          try {
            console.log('\n📈 Getting historical data summary...');

            const summary = await nbaStatsService.getHistoricalSummary();
            const topPerformers = await nbaStatsService.getTopPerformers(topN, 5);
            const b2bAnalysis = await nbaStatsService.analyzeB2BImpact();

            console.log(`✅ Summary: ${summary.total_games} games, ${summary.unique_players} players`);

            return JSON.stringify({
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
              })),
            }, null, 2);
          } catch (error) {
            console.error('❌ Historical Summary Error:', error);
            return JSON.stringify({ success: false, error: error.message });
          }
        },
      }),

      // Teammate Impact Tool
      new DynamicStructuredTool({
        name: 'get_usage_without_teammate',
        description: 'Analyze how a player\'s usage and fantasy production changes when a specific teammate is OUT.',
        schema: z.object({
          playerName: z.string().describe('The player to analyze (e.g., "Kyrie Irving")'),
          teammateName: z.string().describe('The teammate who is OUT (e.g., "Luka Doncic")'),
          team: z.string().optional().describe('Team abbreviation to filter by (e.g., "DAL")'),
        }),
        func: async ({ playerName, teammateName, team }) => {
          try {
            console.log(`\n🔄 Analyzing ${playerName} usage without ${teammateName}...`);

            const result = await nbaStatsService.getUsageWithoutTeammate(playerName, teammateName, team);

            if (!result.success) {
              return JSON.stringify(result);
            }

            console.log(`✅ Found data: ${result.withTeammate?.games || 0} games WITH, ${result.withoutTeammate?.games || 0} games WITHOUT`);

            return JSON.stringify({
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
              },
            }, null, 2);
          } catch (error) {
            console.error('❌ Teammate Impact Error:', error);
            return JSON.stringify({ success: false, error: error.message });
          }
        },
      }),

      // Roster Context Analysis Tool
      new DynamicStructuredTool({
        name: 'analyze_roster_context',
        description: 'Analyze historical games with similar roster configurations.',
        schema: z.object({
          team: z.string().describe('Team abbreviation (e.g., "LAL", "DAL", "BOS")'),
          activePlayers: z.array(z.string()).describe('Array of player names expected to play tonight'),
          absentPlayers: z.array(z.string()).describe('Array of player names who are OUT tonight'),
        }),
        func: async ({ team, activePlayers, absentPlayers }) => {
          try {
            console.log(`\n🏀 Analyzing roster context for ${team}...`);
            console.log(`Active: ${activePlayers.join(', ')}`);
            console.log(`Absent: ${absentPlayers.join(', ')}`);

            const result = await nbaStatsService.analyzeRosterContext(team, activePlayers, absentPlayers);

            if (!result.success) {
              return JSON.stringify(result);
            }

            console.log(`✅ Found ${result.matchingGamesCount} matching historical games`);

            return JSON.stringify({
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
              },
            }, null, 2);
          } catch (error) {
            console.error('❌ Roster Context Error:', error);
            return JSON.stringify({ success: false, error: error.message });
          }
        },
      }),

      // Get Team Roster Tool
      new DynamicStructuredTool({
        name: 'get_team_roster',
        description: 'Get the historical roster and player averages for a specific team.',
        schema: z.object({
          team: z.string().describe('Team abbreviation (e.g., "LAL", "DAL", "BOS")'),
        }),
        func: async ({ team }) => {
          try {
            console.log(`\n📋 Getting roster for ${team}...`);

            const roster = await nbaStatsService.getTeamRoster(team.toUpperCase());

            if (roster.length === 0) {
              return JSON.stringify({
                success: false,
                message: `No historical data found for team ${team}`,
              });
            }

            console.log(`✅ Found ${roster.length} players for ${team}`);

            return JSON.stringify({
              success: true,
              team: team.toUpperCase(),
              playerCount: roster.length,
              roster: roster.map(p => ({
                name: p.player_name,
                games: p.games,
                lastGame: p.last_game,
                avgDkPoints: p.avg_dk,
                avgMinutes: p.avg_min,
              })),
            }, null, 2);
          } catch (error) {
            console.error('❌ Team Roster Error:', error);
            return JSON.stringify({ success: false, error: error.message });
          }
        },
      }),
    ];
  }

  /**
   * Process chat message
   */
  async chat(message, sessionId, chatHistory = []) {
    try {
      // Ensure service is initialized
      this.ensureInitialized();

      console.log(`\n💬 Processing chat message for session ${sessionId}`);
      console.log(`Message: ${message}`);

      // Build messages array
      const messages = [
        { role: 'system', content: this.getSystemPrompt() },
      ];

      // Add chat history
      chatHistory.forEach(msg => {
        if (msg.role === 'user' || msg.role === 'assistant') {
          messages.push({
            role: msg.role,
            content: msg.content,
          });
        }
      });

      // Add current message
      messages.push({ role: 'user', content: message });

      // Convert tools to OpenAI function format
      const functions = this.tools.map(tool => this.convertToolToFunction(tool));

      let iterations = 0;
      const maxIterations = 10;
      const toolsUsed = [];

      // Function calling loop
      while (iterations < maxIterations) {
        // Call OpenAI API (configured for Azure)
        const response = await this.client.chat.completions.create({
          model: this.deploymentName,
          messages: messages,
          functions: functions,
          function_call: 'auto',
          temperature: 0.7,
        });

        const choice = response.choices[0];
        const assistantMessage = choice.message;

        // If no function call, we're done
        if (!assistantMessage.function_call) {
          console.log(`✅ Response generated (${iterations} tool calls)`);
          return {
            success: true,
            message: assistantMessage.content,
            toolsUsed,
          };
        }

        // Execute function call
        iterations++;
        const functionCall = assistantMessage.function_call;
        const toolName = functionCall.name;
        const toolArgs = JSON.parse(functionCall.arguments || '{}');

        console.log(`🔧 Tool call ${iterations}: ${toolName}`);
        console.log(`Args:`, toolArgs);
        toolsUsed.push(toolName);

        const tool = this.toolsMap.get(toolName);
        if (!tool) {
          throw new Error(`Tool ${toolName} not found`);
        }

        // Execute tool
        const toolResult = await tool.func(toolArgs);

        // Add assistant message with function call
        messages.push({
          role: 'assistant',
          content: '',
          function_call: functionCall,
        });

        // Add function result
        messages.push({
          role: 'function',
          name: toolName,
          content: toolResult,
        });
      }

      // Max iterations reached
      console.log(`⚠️ Max iterations (${maxIterations}) reached`);
      return {
        success: true,
        message: 'I apologize, but I needed to make too many tool calls. Please try rephrasing your question.',
        toolsUsed,
      };
    } catch (error) {
      console.error('❌ Chat Error:', error);
      console.error('Stack:', error.stack);
      return {
        success: false,
        error: error.message,
        message: 'Sorry, I encountered an error processing your request. Please try again.',
      };
    }
  }

  /**
   * Convert DynamicStructuredTool to OpenAI function format
   */
  convertToolToFunction(tool) {
    const properties = {};
    const required = [];

    // Convert Zod schema to JSON Schema
    Object.entries(tool.schema.shape).forEach(([key, value]) => {
      const zodType = value._def.typeName;

      let propDef = {
        description: value.description || '',
      };

      if (zodType === 'ZodString') {
        propDef.type = 'string';
      } else if (zodType === 'ZodNumber') {
        propDef.type = 'number';
      } else if (zodType === 'ZodBoolean') {
        propDef.type = 'boolean';
      } else if (zodType === 'ZodArray') {
        propDef.type = 'array';
        propDef.items = { type: 'string' };
      } else if (zodType === 'ZodEnum') {
        propDef.type = 'string';
        propDef.enum = value._def.values;
      } else if (zodType === 'ZodOptional') {
        const innerType = value._def.innerType._def.typeName;
        if (innerType === 'ZodString') propDef.type = 'string';
        else if (innerType === 'ZodNumber') propDef.type = 'number';
        else if (innerType === 'ZodArray') {
          propDef.type = 'array';
          propDef.items = { type: 'string' };
        }
      }

      properties[key] = propDef;

      // Check if required
      if (!value.isOptional || zodType !== 'ZodOptional') {
        required.push(key);
      }
    });

    return {
      name: tool.name,
      description: tool.description,
      parameters: {
        type: 'object',
        properties,
        required,
      },
    };
  }

  /**
   * Create new chat session
   */
  async createSession(slateId = null, title = null) {
    try {
      if (DATABASE_TYPE === 'azuresql') {
        const result = await db.get(`
          INSERT INTO chat_sessions (slate_id, title)
          OUTPUT INSERTED.id
          VALUES (@slateId, @title)
        `, { slateId, title: title || 'New Chat' });

        console.log(`✅ Created chat session ${result?.id}`);
        return { success: true, sessionId: result?.id };
      } else {
        const result = await db.run(`
          INSERT INTO chat_sessions (slate_id, title)
          VALUES (?, ?)
        `, slateId, title || 'New Chat');

        console.log(`✅ Created chat session ${result.lastInsertRowid}`);
        return { success: true, sessionId: result.lastInsertRowid };
      }
    } catch (error) {
      console.error('❌ Create Session Error:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Save message to database
   */
  async saveMessage(sessionId, role, content, metadata = null) {
    try {
      if (DATABASE_TYPE === 'azuresql') {
        const result = await db.get(`
          INSERT INTO chat_messages (session_id, role, content, metadata)
          OUTPUT INSERTED.id
          VALUES (@sessionId, @role, @content, @metadata)
        `, {
          sessionId,
          role,
          content,
          metadata: metadata ? JSON.stringify(metadata) : null
        });

        await db.run(`
          UPDATE chat_sessions
          SET updated_at = GETDATE()
          WHERE id = @sessionId
        `, { sessionId });

        return { success: true, messageId: result?.id };
      } else {
        const result = await db.run(`
          INSERT INTO chat_messages (session_id, role, content, metadata)
          VALUES (?, ?, ?, ?)
        `,
          sessionId,
          role,
          content,
          metadata ? JSON.stringify(metadata) : null
        );

        await db.run(`
          UPDATE chat_sessions
          SET updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `, sessionId);

        return { success: true, messageId: result.lastInsertRowid };
      }
    } catch (error) {
      console.error('❌ Save Message Error:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Get chat history for session
   */
  async getChatHistory(sessionId, limit = 50) {
    try {
      const messages = await db.all(`
        SELECT id, role, content, metadata, created_at
        FROM chat_messages
        WHERE session_id = ?
        ORDER BY created_at ASC
        LIMIT ?
      `, sessionId, limit);

      return {
        success: true,
        messages: messages.map(msg => ({
          ...msg,
          metadata: msg.metadata ? JSON.parse(msg.metadata) : null,
        })),
      };
    } catch (error) {
      console.error('❌ Get History Error:', error);
      return { success: false, error: error.message, messages: [] };
    }
  }

  /**
   * Get all chat sessions
   */
  async getAllSessions(limit = 20) {
    try {
      const sessions = await db.all(`
        SELECT
          cs.id,
          cs.title,
          cs.slate_id,
          cs.created_at,
          cs.updated_at,
          COUNT(cm.id) as message_count
        FROM chat_sessions cs
        LEFT JOIN chat_messages cm ON cs.id = cm.session_id
        GROUP BY cs.id
        ORDER BY cs.updated_at DESC
        LIMIT ?
      `, limit);

      return { success: true, sessions };
    } catch (error) {
      console.error('❌ Get Sessions Error:', error);
      return { success: false, error: error.message, sessions: [] };
    }
  }

  /**
   * Delete chat session
   */
  async deleteSession(sessionId) {
    try {
      await db.run('DELETE FROM chat_sessions WHERE id = ?', sessionId);
      console.log(`✅ Deleted chat session ${sessionId}`);
      return { success: true };
    } catch (error) {
      console.error('❌ Delete Session Error:', error);
      return { success: false, error: error.message };
    }
  }
}

export default new AIChatService();
