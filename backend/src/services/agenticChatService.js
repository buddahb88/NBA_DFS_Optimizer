/**
 * AgenticChatService - Main orchestrator for Claude Code-style agentic AI
 *
 * Coordinates specialized sub-agents:
 * - OptimizerAgent: Lineup building and validation
 * - ResearchAgent: Database queries and player search
 * - AnalystAgent: Historical analysis and matchups
 *
 * Features:
 * - Real-time streaming with SSE
 * - Sub-agent delegation
 * - Configurable iteration limits
 * - Task completion detection
 */

import OpenAI from 'openai';
import OptimizerAgent from '../agents/OptimizerAgent.js';
import ResearchAgent from '../agents/ResearchAgent.js';
import AnalystAgent from '../agents/AnalystAgent.js';
import db from '../config/database.js';

const ORCHESTRATOR_SYSTEM_PROMPT = `You are an expert NBA DFS assistant with access to specialized agents.

Your role is to:
1. Understand the user's question or task
2. Decide which specialist agent(s) to delegate to
3. Synthesize results into a helpful response
4. Keep iterating until the task is FULLY complete

Available Agents:
- **optimizer**: Build and validate DFS lineups (use for: "build me a lineup", "optimize", "lock player X")
- **research**: Query database, search players, get slate info (use for: "who are the top...", "find players", "what's the slate")
- **analyst**: Historical analysis, matchups, trends (use for: "how does X perform against...", "usage bump", "history")

Decision Guidelines:
- For simple questions, use research agent to query data
- For lineup building, ALWAYS use optimizer agent
- For player analysis/trends, use analyst agent
- Complex tasks may need multiple agents in sequence

CRITICAL - NO HALLUCINATION RULES:
- ONLY use data returned from agent tool calls - NEVER make up player names, stats, games, or matchups
- If an agent returns "no data found" or empty results, tell the user NO DATA IS AVAILABLE
- NEVER claim a player is "playing tonight" unless you verified it via get_current_slate or sql_query
- NEVER invent statistics, salaries, projections, or game matchups
- If the database has no slate data, say: "No active slate data found. Please ensure a slate has been imported."
- When tool results are empty, DO NOT fill in with general knowledge - be honest about missing data
- Always distinguish between "data from our database" vs "general NBA knowledge"

IMPORTANT:
- Always delegate to an agent for data - never make up statistics
- Show your reasoning before delegating
- After receiving agent results, synthesize and explain findings
- If the task isn't complete, continue with more agent calls`;

class AgenticChatService {
  constructor() {
    this.client = null;
    this.deploymentName = null;
    this.initialized = false;

    // Initialize sub-agents
    this.agents = {
      optimizer: new OptimizerAgent(),
      research: new ResearchAgent(),
      analyst: new AnalystAgent()
    };

    // Orchestrator tools - primarily delegation
    this.orchestratorTools = this.createOrchestratorTools();
  }

  /**
   * Lazy initialization of OpenAI client
   */
  initializeClient() {
    if (this.initialized) return;

    console.log('🔧 Initializing Agentic Chat Service...');

    if (!process.env.AZURE_OPENAI_KEY || !process.env.AZURE_OPENAI_ENDPOINT) {
      throw new Error('Azure OpenAI credentials not configured');
    }

    const apiVersion = process.env.AZURE_OPENAI_API_VERSION || '2024-04-01-preview';
    this.client = new OpenAI({
      apiKey: process.env.AZURE_OPENAI_KEY,
      baseURL: `${process.env.AZURE_OPENAI_ENDPOINT}/openai/deployments/${process.env.AZURE_OPENAI_MODEL || 'gpt-4.1-mini'}`,
      defaultQuery: { 'api-version': apiVersion },
      defaultHeaders: { 'api-key': process.env.AZURE_OPENAI_KEY },
    });

    this.deploymentName = process.env.AZURE_OPENAI_MODEL || 'gpt-4.1-mini';
    this.initialized = true;

    console.log('✅ Agentic Chat Service initialized');
    console.log(`   Agents: ${Object.keys(this.agents).join(', ')}`);
  }

  /**
   * Create orchestrator-level tools (delegation + simple queries)
   */
  createOrchestratorTools() {
    return [
      {
        type: 'function',
        function: {
          name: 'delegate_to_agent',
          description: 'Delegate a task to a specialized agent. Use this to get data or perform actions.',
          parameters: {
            type: 'object',
            properties: {
              agent: {
                type: 'string',
                enum: ['optimizer', 'research', 'analyst'],
                description: 'Which agent to delegate to: optimizer (lineups), research (data queries), analyst (historical analysis)'
              },
              task: {
                type: 'string',
                description: 'Clear description of what the agent should do. Be specific about what data you need.'
              }
            },
            required: ['agent', 'task']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'get_current_slate',
          description: 'Quick helper to get the current active slate ID. Use before delegating lineup tasks.',
          parameters: {
            type: 'object',
            properties: {}
          }
        }
      }
    ];
  }

  /**
   * Execute orchestrator tool
   */
  async executeOrchestratorTool(name, args, context, callbacks) {
    if (name === 'delegate_to_agent') {
      return await this.delegateToAgent(args.agent, args.task, context, callbacks);
    }

    if (name === 'get_current_slate') {
      const slate = await db.get(`
        SELECT slate_id, name, start_time FROM slates
        ORDER BY created_at DESC LIMIT 1
      `);
      return JSON.stringify({
        success: !!slate,
        slate: slate || null,
        message: slate ? `Current slate: ${slate.slate_id} (${slate.name})` : 'No slates found'
      });
    }

    return JSON.stringify({ success: false, error: `Unknown tool: ${name}` });
  }

  /**
   * Delegate task to a sub-agent
   */
  async delegateToAgent(agentName, task, context, callbacks) {
    const agent = this.agents[agentName];
    if (!agent) {
      return JSON.stringify({ success: false, error: `Unknown agent: ${agentName}` });
    }

    console.log(`\n🚀 Delegating to ${agentName} agent: ${task.substring(0, 100)}...`);
    callbacks.onAgentSpawn?.(agentName, task);

    try {
      const result = await agent.execute(task, context, {
        onThinking: (text) => callbacks.onThinking?.(`[${agentName}] ${text}`),
        onToolCall: callbacks.onToolCall,
        onToolResult: callbacks.onToolResult,
        onIteration: callbacks.onIteration
      });

      callbacks.onAgentComplete?.(agentName, result);
      console.log(`✅ ${agentName} agent completed: ${result.success ? 'success' : 'failed'}`);

      return JSON.stringify(result);
    } catch (error) {
      console.error(`❌ ${agentName} agent error:`, error);
      callbacks.onAgentComplete?.(agentName, { success: false, error: error.message });
      return JSON.stringify({ success: false, error: error.message });
    }
  }

  /**
   * Main chat method with streaming support
   */
  async chat(message, sessionId, options = {}) {
    this.initializeClient();

    const {
      maxIterations = 10,
      slateId = null,
      chatHistory = [],
      onThinking,
      onToolCall,
      onToolResult,
      onAgentSpawn,
      onAgentComplete,
      onMessage,
      onIteration
    } = options;

    const callbacks = { onThinking, onToolCall, onToolResult, onAgentSpawn, onAgentComplete, onMessage, onIteration };
    const context = { slateId, chatHistory, sessionId };

    // Build messages array
    const messages = [
      { role: 'system', content: ORCHESTRATOR_SYSTEM_PROMPT }
    ];

    // Add recent chat history (last 10 messages for context)
    if (chatHistory.length > 0) {
      const recentHistory = chatHistory.slice(-10);
      for (const msg of recentHistory) {
        if (msg.role === 'user' || msg.role === 'assistant') {
          messages.push({ role: msg.role, content: msg.content });
        }
      }
    }

    // Add current message
    messages.push({ role: 'user', content: message });

    let iterations = 0;
    const allToolsUsed = [];
    const agentsUsed = [];

    console.log(`\n🤖 Starting agentic chat (max ${maxIterations} iterations)`);
    console.log(`📝 Message: ${message.substring(0, 100)}...`);

    onThinking?.('Analyzing your request...');

    while (iterations < maxIterations) {
      iterations++;
      onIteration?.(iterations, maxIterations);
      console.log(`\n🔄 Orchestrator iteration ${iterations}/${maxIterations}`);

      try {
        const response = await this.client.chat.completions.create({
          model: this.deploymentName,
          messages: messages,
          tools: this.orchestratorTools,
          tool_choice: 'auto',
          max_completion_tokens: 4096,
        });

        const choice = response.choices[0];
        const assistantMessage = choice.message;

        // Check for tool calls
        if (assistantMessage.tool_calls && assistantMessage.tool_calls.length > 0) {
          messages.push(assistantMessage);

          for (const toolCall of assistantMessage.tool_calls) {
            const toolName = toolCall.function.name;
            let toolArgs = {};

            try {
              toolArgs = JSON.parse(toolCall.function.arguments || '{}');
            } catch (e) {
              console.error('Failed to parse tool arguments:', toolCall.function.arguments);
            }

            // Stream thinking
            if (toolName === 'delegate_to_agent') {
              onThinking?.(`Delegating to ${toolArgs.agent} agent: ${toolArgs.task}`);
              if (!agentsUsed.includes(toolArgs.agent)) {
                agentsUsed.push(toolArgs.agent);
              }
            } else {
              onThinking?.(`Using ${toolName}...`);
            }

            onToolCall?.(toolName, toolArgs);

            // Execute tool
            const result = await this.executeOrchestratorTool(toolName, toolArgs, context, callbacks);
            allToolsUsed.push({ name: toolName, args: toolArgs });

            onToolResult?.(toolName, JSON.parse(result), true);

            // Add result to messages
            messages.push({
              role: 'tool',
              tool_call_id: toolCall.id,
              content: result
            });
          }

          continue;
        }

        // No tool calls - we have a final response
        const finalContent = assistantMessage.content || '';

        console.log(`✅ Completed in ${iterations} iteration(s)`);
        console.log(`   Tools used: ${allToolsUsed.length}, Agents: ${agentsUsed.join(', ') || 'none'}`);

        onMessage?.(finalContent, true);

        return {
          success: true,
          message: finalContent,
          toolsUsed: allToolsUsed,
          agentsUsed,
          iterations,
          sessionId
        };

      } catch (error) {
        console.error('❌ Orchestrator API Error:', error);

        if (error.status === 429) {
          console.log('⏳ Rate limited, waiting 5s...');
          await new Promise(resolve => setTimeout(resolve, 5000));
          continue;
        }

        return {
          success: false,
          error: error.message,
          toolsUsed: allToolsUsed,
          agentsUsed,
          iterations
        };
      }
    }

    // Max iterations reached
    console.log(`⚠️ Max iterations (${maxIterations}) reached`);

    const partialResponse = `I've gathered information through ${allToolsUsed.length} tool calls across ${agentsUsed.length} agent(s), but reached the iteration limit. Here's what I found so far - you may want to ask a more specific follow-up question.`;

    onMessage?.(partialResponse, true);

    return {
      success: true,
      message: partialResponse,
      toolsUsed: allToolsUsed,
      agentsUsed,
      iterations,
      maxIterationsReached: true
    };
  }

  /**
   * Create a new chat session
   */
  async createSession(slateId = null, title = null) {
    const sessionTitle = title || `Chat ${new Date().toLocaleString()}`;

    try {
      const result = await db.run(
        `INSERT INTO chat_sessions (title, slate_id, created_at, updated_at)
         VALUES (?, ?, datetime('now'), datetime('now'))`,
        sessionTitle, slateId
      );

      const sessionId = result.lastInsertRowid || result.insertId;
      console.log(`📝 Created session ${sessionId}: ${sessionTitle}`);

      return { success: true, sessionId, title: sessionTitle };
    } catch (error) {
      console.error('❌ Create Session Error:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Save a message to the database
   */
  async saveMessage(sessionId, role, content, metadata = null) {
    try {
      const metadataStr = metadata ? JSON.stringify(metadata) : null;

      await db.run(
        `INSERT INTO chat_messages (session_id, role, content, metadata, created_at)
         VALUES (?, ?, ?, ?, datetime('now'))`,
        sessionId, role, content, metadataStr
      );

      // Update session timestamp
      await db.run(
        `UPDATE chat_sessions SET updated_at = datetime('now') WHERE id = ?`,
        sessionId
      );

      return { success: true };
    } catch (error) {
      console.error('❌ Save Message Error:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Get chat history for a session
   */
  async getChatHistory(sessionId, limit = 50) {
    try {
      const messages = await db.all(
        `SELECT id, role, content, metadata, created_at
         FROM chat_messages
         WHERE session_id = ?
         ORDER BY created_at ASC
         LIMIT ?`,
        sessionId, limit
      );

      return {
        success: true,
        messages: messages.map(m => ({
          ...m,
          metadata: m.metadata ? JSON.parse(m.metadata) : null
        }))
      };
    } catch (error) {
      console.error('❌ Get History Error:', error);
      return { success: false, error: error.message, messages: [] };
    }
  }

  /**
   * Get all sessions
   */
  async getAllSessions(limit = 20) {
    try {
      const sessions = await db.all(`
        SELECT s.id, s.title, s.slate_id, s.created_at, s.updated_at,
               COUNT(m.id) as message_count
        FROM chat_sessions s
        LEFT JOIN chat_messages m ON s.id = m.session_id
        GROUP BY s.id
        ORDER BY s.updated_at DESC
        LIMIT ?
      `, limit);

      return { success: true, sessions };
    } catch (error) {
      console.error('❌ Get Sessions Error:', error);
      return { success: false, error: error.message, sessions: [] };
    }
  }

  /**
   * Delete a session
   */
  async deleteSession(sessionId) {
    try {
      await db.run('DELETE FROM chat_sessions WHERE id = ?', sessionId);
      return { success: true };
    } catch (error) {
      console.error('❌ Delete Session Error:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Get agent info for display
   */
  getAgentInfo() {
    return Object.entries(this.agents).map(([name, agent]) => ({
      name,
      ...agent.getInfo()
    }));
  }
}

// Export singleton instance
export default new AgenticChatService();
