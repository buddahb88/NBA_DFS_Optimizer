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
import { createClaudeClient, isClaudeEndpoint, runClaudeToolLoop, toClaudeHistory, toClaudeTool } from './llm/claude.js';
import OptimizerAgent from '../agents/OptimizerAgent.js';
import ResearchAgent from '../agents/ResearchAgent.js';
import AnalystAgent from '../agents/AnalystAgent.js';
import db from '../config/database.js';
import { getCurrentSlateInfo } from './slateFreshness.js';

const PROMPT_INTRO = `You are an expert NBA DFS assistant with access to specialized agents.

You plan and delegate. Your only tools are delegate_to_agent and get_current_slate; every data tool belongs to an agent.

Your role is to:
1. Understand the user's question or task
2. Decide which specialist agent(s) to delegate to
3. Synthesize results into a helpful response
4. Keep iterating until the task is FULLY complete

Available Agents:
- **optimizer**: Build and validate DFS lineups (use for: "build me a lineup", "optimize", "lock player X")
- **research**: Slate data and research tools (use for: "who are the top...", "best matchups tonight", "who's missing / usage bumps", "how did this lineup score on <date>", "how accurate were projections", "what's the slate")
- **analyst**: Player-level history and context (use for: "how does X perform against...", "X's role / usage / archetype", "X without teammate Y", "how does <team> defend <archetype>", trends)

In the task, name the tool to use when one fits (see TOOL OWNERSHIP); raw SQL is only a fallback.

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

STALE SLATE GUARD:
- Call get_current_slate before any "tonight" request (lineups, plays, matchups, stacks, injuries). It returns slateDate (the night the slate covers), today (ET) and isStale
- If isStale is true, STOP: do not build lineups or recommend plays for tonight. Tell the user the latest slate is from <slateDate>, not today, and ask them to sync tonight's slate (Home or Data Status page)
- Only use a stale slate when the user explicitly asks about that past date, and then say which date the answer covers
- Every answer built on slate data names the slate date it covers

IMPORTANT:
- Always delegate to an agent for data - never make up statistics
- Show your reasoning before delegating
- After receiving agent results, synthesize and explain findings
- If the task isn't complete, continue with more agent calls`;

// The orchestrator's own tools; everything else is an agent's
const ORCHESTRATOR_TOOL_NAMES = new Set(['delegate_to_agent', 'get_current_slate']);

/**
 * Map each agent tool name to the agent that owns it, from the agents' own
 * tool lists so it never drifts. Tools several agents share (the research
 * tools are also the analyst's) go to the first agent listing them.
 * @param {object} agents - { optimizer, research, analyst } agent instances
 * @returns {object} tool name -> agent name
 */
export function buildToolOwners(agents) {
  const owners = {};
  for (const [agentName, agent] of Object.entries(agents)) {
    for (const { name } of agent.tools) {
      if (!ORCHESTRATOR_TOOL_NAMES.has(name) && !owners[name]) owners[name] = agentName;
    }
  }
  return owners;
}

/** agent name -> tool names it owns */
function toolsByAgent(owners) {
  const byAgent = {};
  for (const [tool, agentName] of Object.entries(owners)) (byAgent[agentName] ||= []).push(tool);
  return byAgent;
}

export function buildOrchestratorPrompt(owners) {
  const ownership = Object.entries(toolsByAgent(owners))
    .map(([agentName, tools]) => `- ${agentName}: ${tools.join(', ')}`)
    .join('\n');
  return `${PROMPT_INTRO}

TOOL OWNERSHIP (delegate to the owner; the analyst can also use the research tools):
${ownership}
- When the user names a tool (e.g. "use get_usage_bumps"), delegate to the agent that owns it and name the tool in the task. Never call an agent's tool yourself`;
}

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

    this.toolOwners = buildToolOwners(this.agents);
    this.systemPrompt = buildOrchestratorPrompt(this.toolOwners);

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

    if (isClaudeEndpoint()) {
      this.claudeClient = createClaudeClient();
      this.initialized = true;
      console.log('✅ Agentic Chat Service initialized (Claude on Azure AI Foundry)');
      console.log(`   Agents: ${Object.keys(this.agents).join(', ')}`);
      return;
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
          description: 'Get the latest synced slate: ID, slateDate (night it covers), today (ET), isStale and a warning when it is not tonight\'s. Use before delegating any "tonight" or lineup task.',
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
      const slate = await getCurrentSlateInfo();
      if (!slate) {
        return JSON.stringify({ success: false, slate: null, message: 'No slates found' });
      }
      return JSON.stringify({
        success: true,
        slate,
        message: slate.isStale
          ? slate.warning
          : `Current slate: ${slate.slateId} (${slate.name}) for ${slate.slateDate ?? 'an unknown date'}`
      });
    }

    return JSON.stringify({
      success: false,
      error: `Unknown tool: ${name}. No agent owns it. Your tools are delegate_to_agent and get_current_slate; use delegate_to_agent with the agent that owns the tool you need (see toolOwners).`,
      toolOwners: toolsByAgent(this.toolOwners)
    });
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
        onUiBlock: callbacks.onUiBlock,
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
      onUiBlock,
      onAgentSpawn,
      onAgentComplete,
      onMessage,
      onIteration
    } = options;

    const callbacks = { onThinking, onToolCall, onToolResult, onUiBlock, onAgentSpawn, onAgentComplete, onMessage, onIteration };
    const context = { slateId, chatHistory, sessionId };

    // Build messages array
    const messages = [
      { role: 'system', content: this.systemPrompt }
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

    if (this.claudeClient) {
      return this.chatWithClaude(message, sessionId, { maxIterations, chatHistory, context, callbacks });
    }

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

            const result = await this.runToolCall(toolName, toolArgs, context, callbacks, allToolsUsed, agentsUsed);

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
   * Stream progress, execute one orchestrator tool call and record it
   */
  async runToolCall(toolName, toolArgs, context, callbacks, allToolsUsed, agentsUsed) {
    const { onThinking, onToolCall, onToolResult } = callbacks;

    const owner = this.toolOwners[toolName];
    if (owner) return this.routeToolCall(owner, toolName, toolArgs, callbacks, allToolsUsed, agentsUsed);

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

    const result = await this.executeOrchestratorTool(toolName, toolArgs, context, callbacks);
    allToolsUsed.push({ name: toolName, args: toolArgs });

    onToolResult?.(toolName, JSON.parse(result), true);
    return result;
  }

  /**
   * Hand a tool call the orchestrator made itself to the agent that owns it.
   * Runs the tool directly on that agent (no sub-agent model loop), so the
   * misroute costs no extra step, and streams it as an agent hand-off.
   */
  async routeToolCall(agentName, toolName, toolArgs, callbacks, allToolsUsed, agentsUsed) {
    const { onThinking, onToolCall, onToolResult, onUiBlock, onAgentSpawn, onAgentComplete } = callbacks;

    console.log(`\n↪️ Routing ${toolName} from orchestrator to ${agentName} agent`);
    onThinking?.(`${toolName} belongs to the ${agentName} agent - handing it off`);
    onAgentSpawn?.(agentName, `Routed from orchestrator: ${toolName}`);
    if (!agentsUsed.includes(agentName)) agentsUsed.push(agentName);

    const raw = await this.agents[agentName].executeTool(toolName, toolArgs, { onToolCall, onToolResult, onUiBlock });
    let result;
    try {
      result = JSON.parse(raw);
    } catch {
      result = raw;
    }
    const failed = result?.success === false;

    onAgentComplete?.(agentName, { success: !failed, error: failed ? result.error || result.message : undefined, routedTool: toolName });
    allToolsUsed.push({ name: toolName, args: toolArgs, agent: agentName, routed: true });

    return JSON.stringify({
      routedTo: agentName,
      tool: toolName,
      note: `${toolName} is a ${agentName} agent tool; it was run by that agent. Delegate to it directly next time.`,
      result
    });
  }

  /**
   * Same orchestration loop as chat(), against Claude on Azure AI Foundry
   */
  async chatWithClaude(message, sessionId, { maxIterations, chatHistory, context, callbacks }) {
    const allToolsUsed = [];
    const agentsUsed = [];

    try {
      const result = await runClaudeToolLoop({
        client: this.claudeClient,
        system: this.systemPrompt,
        messages: [...toClaudeHistory(chatHistory.slice(-10)), { role: 'user', content: message }],
        tools: this.orchestratorTools.map(t => toClaudeTool(t.function)),
        executeTool: (toolName, toolArgs) =>
          this.runToolCall(toolName, toolArgs, context, callbacks, allToolsUsed, agentsUsed),
        maxIterations,
        onIteration: (i) => {
          callbacks.onIteration?.(i, maxIterations);
          console.log(`\n🔄 Orchestrator iteration ${i}/${maxIterations}`);
        },
      });

      if (result.maxIterationsReached) {
        console.log(`⚠️ Max iterations (${maxIterations}) reached`);
        const partialResponse = `I've gathered information through ${allToolsUsed.length} tool calls across ${agentsUsed.length} agent(s), but reached the iteration limit. Here's what I found so far - you may want to ask a more specific follow-up question.`;
        callbacks.onMessage?.(partialResponse, true);
        return { success: true, message: partialResponse, toolsUsed: allToolsUsed, agentsUsed, iterations: maxIterations, maxIterationsReached: true };
      }

      console.log(`✅ Completed in ${result.iterations} iteration(s)`);
      console.log(`   Tools used: ${allToolsUsed.length}, Agents: ${agentsUsed.join(', ') || 'none'}`);
      callbacks.onMessage?.(result.text, true);
      return { success: true, message: result.text, toolsUsed: allToolsUsed, agentsUsed, iterations: result.iterations, sessionId };
    } catch (error) {
      console.error('❌ Orchestrator API Error:', error);
      return { success: false, error: error.message, toolsUsed: allToolsUsed, agentsUsed, iterations: 0 };
    }
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
   * Save a message to the database (uiBlocks: the assistant message's
   * streamed result blocks, chatTools/uiBlocks.js)
   */
  async saveMessage(sessionId, role, content, metadata = null, uiBlocks = null) {
    try {
      const metadataStr = metadata ? JSON.stringify(metadata) : null;
      const uiBlocksStr = uiBlocks?.length ? JSON.stringify(uiBlocks) : null;

      await db.run(
        `INSERT INTO chat_messages (session_id, role, content, metadata, ui_blocks, created_at)
         VALUES (?, ?, ?, ?, ?, datetime('now'))`,
        sessionId, role, content, metadataStr, uiBlocksStr
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
        `SELECT id, role, content, metadata, ui_blocks, created_at
         FROM chat_messages
         WHERE session_id = ?
         ORDER BY created_at ASC
         LIMIT ?`,
        sessionId, limit
      );

      return {
        success: true,
        messages: messages.map(({ ui_blocks, ...m }) => ({
          ...m,
          metadata: m.metadata ? JSON.parse(m.metadata) : null,
          uiBlocks: ui_blocks ? JSON.parse(ui_blocks) : []
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
   * Rename a session. Returns { success, session } or { success: false, notFound } when missing.
   */
  async renameSession(sessionId, title) {
    try {
      const result = await db.run(
        `UPDATE chat_sessions SET title = ?, updated_at = datetime('now') WHERE id = ?`,
        title, sessionId
      );
      if (!result.changes) return { success: false, notFound: true, error: 'Session not found' };

      const session = await db.get('SELECT id, title, slate_id, created_at, updated_at FROM chat_sessions WHERE id = ?', sessionId);
      return { success: true, session };
    } catch (error) {
      console.error('❌ Rename Session Error:', error);
      return { success: false, error: error.message };
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
const agenticChatService = new AgenticChatService();
export const ORCHESTRATOR_SYSTEM_PROMPT = agenticChatService.systemPrompt;
export default agenticChatService;
