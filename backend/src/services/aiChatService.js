import OpenAI from 'openai';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import yaml from 'js-yaml';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import db from '../config/database.js';
import optimizerService from './optimizerService.js';

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
      this.client = new OpenAI({
        apiKey: process.env.AZURE_OPENAI_KEY,
        baseURL: `${process.env.AZURE_OPENAI_ENDPOINT}/openai/deployments/${process.env.AZURE_OPENAI_MODEL || 'gpt-4.1-mini'}`,
        defaultQuery: { 'api-version': '2024-02-15-preview' },
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

### Players Table (Primary table for queries)

**Important Columns:**
${schema.tables.players.columns.map(col => `- **${col.name}** (${col.type}): ${col.description}${col.valid_values ? `\n  Valid values: ${JSON.stringify(col.valid_values)}` : ''}${col.notes ? `\n  Notes: ${col.notes}` : ''}`).join('\n')}

### Common Filters:
${Object.entries(schema.tables.players.common_filters).map(([name, sql]) => `- ${name}: ${sql}`).join('\n')}

### Example Queries:
${schema.tables.players.example_queries.basic.map(ex => `**${ex.description}:**\n\`\`\`sql\n${ex.query}\n\`\`\`\n`).join('\n')}

### CRITICAL QUERY TIPS:
${schema.query_tips.map(tip => `- ${tip}`).join('\n')}

**INJURY_STATUS FIELD - READ THIS:**
- There is NO "ACTIVE" value in injury_status!
- NULL or empty string = healthy/active player
- To find healthy players: \`WHERE (injury_status IS NULL OR injury_status = '')\`
- Valid injury statuses: GTD, Questionable, Doubtful, OUT, Probable
- To exclude injured: \`WHERE (injury_status IS NULL OR injury_status = '' OR injury_status NOT IN ('OUT', 'Doubtful'))\`
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

**Key DFS Strategies:**
1. **Cash Games**: Prioritize safety, high floors, chalk plays, use 'value' metric
2. **GPP/Tournaments**: Prioritize ceiling, leverage, contrarian plays, use 'value_gpp' metric
3. **Stacking**: Pair players from same team in high-scoring games (use vegas_implied_total)
4. **Correlation**: Consider game environments (both teams from same matchup)
5. **Leverage**: Fade high-owned players in tournaments for differentiation
6. **Punt Plays**: Use minimum salary players to afford studs
7. **News Reactions**: Injury replacements often underpriced with low ownership

**When Building Lineups:**
- Always check current slate_id first if not provided
- Parse player names carefully (handle variations like "LeBron James" vs "Lebron")
- Use the lineup_builder tool with locked player IDs when user requests specific players
- Consider game theory: in GPP, differentiation matters more than raw projections
- Factor in Vegas lines: high totals = more fantasy points
- **IMPORTANT: injury_status filtering:**
  - Healthy players have NULL or empty injury_status
  - NEVER filter for injury_status = 'ACTIVE' (this value doesn't exist!)
  - Use: WHERE (injury_status IS NULL OR injury_status = '')
  - Valid injury statuses: GTD, Questionable, Doubtful, OUT, Probable

**Communication Style:**
- Be conversational and insightful
- Provide data-driven reasoning for recommendations
- Show SQL queries when executed (users like transparency)
- Format lineup results clearly with positions, salaries, and projections
- Include strategic rationale: WHY you made certain selections

**Response Format for Lineups:**
When presenting lineups, use this format:
\`\`\`
Position | Player | Team | Salary | Proj
---------|---------|------|---------|------
PG       | Name   | LAL  | $8,500  | 45.2
...
TOTAL: $49,800 / $50,000 | Projected: 285.5 pts
\`\`\`

**Important Notes:**
- ALWAYS use tools to get actual data - never make up stats or player names
- When users ask to "lock" or "build around" players, extract their names and use the lineup_builder tool
- Show your work: explain SQL queries and optimization parameters
- If data is missing or unclear, ask clarifying questions
- Consider recency bias: recent performance (last 3-7 games) often matters more than season averages`;
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

            const stmt = db.prepare(query);
            const results = stmt.all();

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

              const stmt = db.prepare(query);
              const results = stmt.all(...params);

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
            const stmt = db.prepare('SELECT * FROM players WHERE slate_id = ?');
            const players = stmt.all(slateId);

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

            const stmt = db.prepare(`
              SELECT slate_id, name, start_time, created_at
              FROM slates
              ORDER BY created_at DESC
              LIMIT 1
            `);
            const slate = stmt.get();

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
  createSession(slateId = null, title = null) {
    try {
      const stmt = db.prepare(`
        INSERT INTO chat_sessions (slate_id, title)
        VALUES (?, ?)
      `);

      const result = stmt.run(slateId, title || 'New Chat');

      console.log(`✅ Created chat session ${result.lastInsertRowid}`);

      return {
        success: true,
        sessionId: result.lastInsertRowid,
      };
    } catch (error) {
      console.error('❌ Create Session Error:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Save message to database
   */
  saveMessage(sessionId, role, content, metadata = null) {
    try {
      const stmt = db.prepare(`
        INSERT INTO chat_messages (session_id, role, content, metadata)
        VALUES (?, ?, ?, ?)
      `);

      const result = stmt.run(
        sessionId,
        role,
        content,
        metadata ? JSON.stringify(metadata) : null
      );

      // Update session timestamp
      const updateStmt = db.prepare(`
        UPDATE chat_sessions
        SET updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `);
      updateStmt.run(sessionId);

      return {
        success: true,
        messageId: result.lastInsertRowid,
      };
    } catch (error) {
      console.error('❌ Save Message Error:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Get chat history for session
   */
  getChatHistory(sessionId, limit = 50) {
    try {
      const stmt = db.prepare(`
        SELECT id, role, content, metadata, created_at
        FROM chat_messages
        WHERE session_id = ?
        ORDER BY created_at ASC
        LIMIT ?
      `);

      const messages = stmt.all(sessionId, limit);

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
  getAllSessions(limit = 20) {
    try {
      const stmt = db.prepare(`
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
      `);

      const sessions = stmt.all(limit);

      return {
        success: true,
        sessions,
      };
    } catch (error) {
      console.error('❌ Get Sessions Error:', error);
      return { success: false, error: error.message, sessions: [] };
    }
  }

  /**
   * Delete chat session
   */
  deleteSession(sessionId) {
    try {
      const stmt = db.prepare('DELETE FROM chat_sessions WHERE id = ?');
      stmt.run(sessionId);

      console.log(`✅ Deleted chat session ${sessionId}`);

      return { success: true };
    } catch (error) {
      console.error('❌ Delete Session Error:', error);
      return { success: false, error: error.message };
    }
  }
}

export default new AIChatService();
