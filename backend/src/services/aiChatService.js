import OpenAI from 'openai';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import yaml from 'js-yaml';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import db, { DATABASE_TYPE } from '../config/database.js';
import optimizerService from './optimizerService.js';
import { createHistoryTools } from './chatTools/historyTools.js';
import { createResearchTools } from './chatTools/researchTools.js';
import { SITE_KEYS } from '../config/sites.js';
import { resolveSite } from '../utils/resolveSite.js';
import { getCurrentSeason } from '../utils/season.js';
import { createClaudeClient, isClaudeEndpoint, runClaudeToolLoop, toClaudeHistory, toClaudeTool } from './llm/claude.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// History / matchup tables documented in database-schema.yaml, in prompt order
const HISTORY_TABLES = ['historical_games', 'player_season_profiles', 'player_archetypes', 'team_archetype_defense', 'slate_player_snapshots'];

const formatColumn = (col) => `- **${col.name}** (${col.type}): ${col.description}${col.valid_values ? `\n  Valid values: ${JSON.stringify(col.valid_values)}` : ''}${col.range ? ` (Range: ${col.range.join(' to ')})` : ''}${col.notes ? `\n  Notes: ${col.notes}` : ''}`;
const formatExample = (ex) => (typeof ex === 'string' ? `\`\`\`sql\n${ex}\n\`\`\`` : `**${ex.description}:**\n\`\`\`sql\n${ex.query}\n\`\`\``);

/** One database-schema.yaml table as a prompt section: description, columns, example queries, notes. */
function formatTableSection(name, table) {
  const examples = table.example_queries?.length
    ? `\n**Example Queries:**\n${table.example_queries.map(formatExample).join('\n\n')}\n`
    : '';
  return `### ${name}

**Description:** ${table.description}

**Columns:**
${table.columns.map(formatColumn).join('\n')}
${examples}${table.notes ? `\n**Notes:**\n${table.notes}` : ''}`;
}

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

      if (isClaudeEndpoint()) {
        this.claudeClient = createClaudeClient();
        console.log('✅ Claude (Azure AI Foundry) client initialized');
        this.initializeAgent();
        return;
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
3. **team_archetype_defense** - How each defense does vs each player archetype and G/F/C position, relative to expectation (THE matchup table; the projections use it)
4. **player_archetypes** - Each player's archetype per season
5. **player_season_profiles** - Each player's season role profile (usage, assist/rebound rates, per-36, fantasy points per minute)
6. **historical_games** - ESPN game logs for every game since 2024-25 (keyed by player_key)
7. **slate_player_snapshots** - Saved past slates (salary, projection, projected ownership) to compare with actual results
8. **team_defense_rankings** - Team defensive efficiency, pace, and advanced stats (from ESPN)
9. **team_defense_vs_position** - Legacy position DVP from HashtagBasketball (REAL points allowed, not fantasy points)
10. **lineups** - Saved DFS lineups
11. **lineup_players** - Junction table linking players to lineups
12. **chat_sessions** - AI chat conversation sessions
13. **chat_messages** - Individual chat messages

The current NBA season is ${getCurrentSeason()}. Seasons are labelled like '2025-26'.

### Players Table (Primary table for queries)

**Important Columns:**
${schema.tables.players.columns.map(col => `- **${col.name}** (${col.type}): ${col.description}${col.valid_values ? `\n  Valid values: ${JSON.stringify(col.valid_values)}` : ''}${col.notes ? `\n  Notes: ${col.notes}` : ''}`).join('\n')}

### Common Filters:
${Object.entries(schema.tables.players.common_filters).map(([name, sql]) => `- ${name}: ${sql}`).join('\n')}

### Example Queries:
${schema.tables.players.example_queries.basic.map(ex => `**${ex.description}:**\n\`\`\`sql\n${ex.query}\n\`\`\`\n`).join('\n')}

${HISTORY_TABLES.map(name => formatTableSection(name, schema.tables[name])).join('\n\n')}

${formatTableSection('team_defense_rankings', schema.tables.team_defense_rankings)}

${formatTableSection('team_defense_vs_position (legacy DVP)', schema.tables.team_defense_vs_position)}

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
- For matchup questions use team_archetype_defense.fp_over_expectation: fantasy points per player-game a defense allows above (+) or below (-) what that archetype normally scores. Filter site, season and group_by, and mention the games sample
- Link tonight's players to it: players -> player_season_profiles -> player_archetypes (same season) -> team_archetype_defense (team = players.opponent)
- Player names: resolve them with the history tools (get_player_history, compare_players, get_usage_without_teammate, ...), which map accents, punctuation and Jr./III to player_key and return closest matches; filter history tables by player_key, never player_name LIKE '%name%'
- players.dvp_pts_allowed and team_defense_vs_position.pts_allowed are REAL points allowed to a position (about 18-28), NOT fantasy points; treat them as a secondary, legacy signal
- players.opp_def_eff is pre-joined from team_defense_rankings; use that table for pace and overall defensive efficiency
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

**Tool Choice (dedicated tools first, sql_query only as a fallback):**
- Tonight's best matchups: get_archetype_matchups (adjusted edge = matchup x minutes x crowding)
- A defense's strengths/weaknesses: get_team_defense_profile
- A player's role, usage, archetype: get_player_profile (rates are fractions: 0.28 = 28%)
- Injuries / who benefits: get_missing_players, get_usage_bumps, get_usage_without_teammate
- Form: get_streaks_and_consistency, get_player_history
- Past results: score_lineup (a lineup on a date), get_projection_results (projection accuracy)

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
        description: 'FALLBACK: execute SQL queries against the NBA DFS database, only when no dedicated tool (get_archetype_matchups, get_player_profile, get_team_defense_profile, get_usage_bumps, score_lineup, get_player_history, ...) answers the question. Returns rows as JSON array.',
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
          minSalary: z.number().optional().describe('Minimum salary to use (default 98% of the site cap, e.g. 49000 on DraftKings)'),
          randomness: z.number().default(0).describe('Randomness 0-100 for GPP variance (default 0)'),
          site: z.enum(SITE_KEYS).optional().describe('DFS site (default: the slate\'s site, usually draftkings)'),
          minUniqueness: z.number().optional().describe('Min players each lineup must differ from every earlier lineup (default 0)'),
        }),
        func: async ({ slateId, lockedPlayerIds = [], excludedPlayerIds = [], mode = 'cash', numLineups = 1, minSalary, randomness = 0, site: requestedSite, minUniqueness = 0 }) => {
          try {
            const { site, error: siteError } = await resolveSite(requestedSite, slateId);
            if (siteError) {
              return JSON.stringify({ success: false, error: siteError });
            }

            console.log(`\n🏀 Building ${numLineups} ${site} ${mode.toUpperCase()} lineup(s) for slate ${slateId}`);
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
            const { lineups } = optimizerService.optimize(players, {
              site,
              mode,
              numLineups,
              lockedPlayers: lockedPlayerIds,
              excludedPlayers: excludedPlayerIds,
              minSalary,
              randomness,
              minUniqueness,
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
              site,
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

      // Research and historical tools shared with ResearchAgent / AnalystAgent
      ...[...createResearchTools(), ...createHistoryTools()].map(tool => ({
        ...tool,
        func: async (args) => JSON.stringify(await tool.execute(args), null, 2),
      })),
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

      if (this.claudeClient) {
        return await this.chatWithClaude(message, chatHistory);
      }

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
   * Same tool loop as chat(), against Claude on Azure AI Foundry
   */
  async chatWithClaude(message, chatHistory) {
    const toolsUsed = [];
    const result = await runClaudeToolLoop({
      client: this.claudeClient,
      system: this.getSystemPrompt(),
      messages: [...toClaudeHistory(chatHistory), { role: 'user', content: message }],
      tools: this.tools.map(tool => toClaudeTool(this.convertToolToFunction(tool))),
      executeTool: async (toolName, toolArgs) => {
        console.log(`🔧 Tool call ${toolsUsed.length + 1}: ${toolName}`);
        console.log(`Args:`, toolArgs);
        toolsUsed.push(toolName);
        const tool = this.toolsMap.get(toolName);
        if (!tool) throw new Error(`Tool ${toolName} not found`);
        return tool.func(toolArgs);
      },
    });

    if (result.maxIterationsReached) {
      console.log('⚠️ Max iterations (10) reached');
      return {
        success: true,
        message: 'I apologize, but I needed to make too many tool calls. Please try rephrasing your question.',
        toolsUsed,
      };
    }

    console.log(`✅ Response generated (${toolsUsed.length} tool calls)`);
    return { success: true, message: result.text, toolsUsed };
  }

  /**
   * Convert DynamicStructuredTool to OpenAI function format
   */
  convertToolToFunction(tool) {
    // Shared tools already carry a JSON schema
    if (tool.parameters) {
      return { name: tool.name, description: tool.description, parameters: tool.parameters };
    }

    // io: 'input' leaves fields with defaults optional for the caller
    const { $schema, ...parameters } = z.toJSONSchema(tool.schema, { io: 'input' });

    return {
      name: tool.name,
      description: tool.description,
      parameters,
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
