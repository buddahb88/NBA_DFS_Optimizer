/**
 * BaseAgent - Foundation class for all specialized AI agents
 *
 * Provides:
 * - Tool execution loop with streaming callbacks
 * - OpenAI API integration with modern tools format
 * - Configurable iteration limits
 * - Error handling and recovery
 */

import OpenAI from 'openai';

export default class BaseAgent {
  constructor(config) {
    this.name = config.name;
    this.description = config.description;
    this.systemPrompt = config.systemPrompt;
    this.tools = config.tools || [];
    this.maxIterations = config.maxIterations || 5;
    this.client = null;
    this.deploymentName = null;
  }

  /**
   * Initialize OpenAI client (lazy loading)
   */
  initializeClient() {
    if (this.client) return;

    const apiVersion = process.env.AZURE_OPENAI_API_VERSION || '2024-04-01-preview';
    this.client = new OpenAI({
      apiKey: process.env.AZURE_OPENAI_KEY,
      baseURL: `${process.env.AZURE_OPENAI_ENDPOINT}/openai/deployments/${process.env.AZURE_OPENAI_MODEL || 'gpt-4.1-mini'}`,
      defaultQuery: { 'api-version': apiVersion },
      defaultHeaders: { 'api-key': process.env.AZURE_OPENAI_KEY },
    });
    this.deploymentName = process.env.AZURE_OPENAI_MODEL || 'gpt-4.1-mini';
  }

  /**
   * Convert tool definitions to OpenAI format
   * @returns {Array} OpenAI tools format
   */
  getOpenAITools() {
    return this.tools.map(tool => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters || { type: 'object', properties: {} },
      }
    }));
  }

  /**
   * Execute a tool by name
   * @param {string} name - Tool name
   * @param {object} args - Tool arguments
   * @param {object} callbacks - Streaming callbacks
   * @returns {Promise<string>} Tool result as JSON string
   */
  async executeTool(name, args, callbacks = {}) {
    const tool = this.tools.find(t => t.name === name);
    if (!tool) {
      const error = `Tool "${name}" not found in ${this.name} agent`;
      console.error(`❌ ${error}`);
      return JSON.stringify({ success: false, error });
    }

    try {
      callbacks.onToolCall?.(name, args);
      console.log(`🔧 [${this.name}] Executing tool: ${name}`);

      const result = await tool.execute(args);

      callbacks.onToolResult?.(name, result, true);
      console.log(`✅ [${this.name}] Tool ${name} completed`);

      return typeof result === 'string' ? result : JSON.stringify(result);
    } catch (error) {
      console.error(`❌ [${this.name}] Tool ${name} error:`, error);
      const errorResult = { success: false, error: error.message };
      callbacks.onToolResult?.(name, errorResult, false);
      return JSON.stringify(errorResult);
    }
  }

  /**
   * Main execution loop - runs until task complete or max iterations
   * @param {string} task - Task description
   * @param {object} context - Additional context (slateId, chatHistory, etc.)
   * @param {object} callbacks - Streaming callbacks
   * @returns {Promise<object>} Execution result
   */
  async execute(task, context = {}, callbacks = {}) {
    this.initializeClient();

    const { onThinking, onToolCall, onToolResult, onMessage, onIteration } = callbacks;

    // Build initial messages
    const messages = [
      { role: 'system', content: this.buildSystemPrompt(context) },
      { role: 'user', content: task }
    ];

    // Add context from previous conversation if provided
    if (context.chatHistory?.length > 0) {
      const historyMessages = context.chatHistory.map(msg => ({
        role: msg.role,
        content: msg.content
      }));
      messages.splice(1, 0, ...historyMessages);
    }

    let iterations = 0;
    const toolsUsed = [];
    const openAITools = this.getOpenAITools();

    console.log(`\n🤖 [${this.name}] Starting execution (max ${this.maxIterations} iterations)`);
    console.log(`📝 Task: ${task.substring(0, 100)}...`);

    while (iterations < this.maxIterations) {
      iterations++;
      onIteration?.(iterations, this.maxIterations);
      console.log(`\n🔄 [${this.name}] Iteration ${iterations}/${this.maxIterations}`);

      try {
        // Call OpenAI API
        const response = await this.client.chat.completions.create({
          model: this.deploymentName,
          messages: messages,
          tools: openAITools.length > 0 ? openAITools : undefined,
          tool_choice: openAITools.length > 0 ? 'auto' : undefined,
          max_completion_tokens: 4096,
        });

        const choice = response.choices[0];
        const assistantMessage = choice.message;

        // Check for tool calls (modern format)
        if (assistantMessage.tool_calls && assistantMessage.tool_calls.length > 0) {
          // Add assistant message with tool calls to history
          messages.push(assistantMessage);

          // Execute each tool call
          for (const toolCall of assistantMessage.tool_calls) {
            const toolName = toolCall.function.name;
            let toolArgs = {};

            try {
              toolArgs = JSON.parse(toolCall.function.arguments || '{}');
            } catch (e) {
              console.error(`❌ Failed to parse tool arguments:`, toolCall.function.arguments);
            }

            // Stream thinking about tool use
            onThinking?.(`Using ${toolName} tool...`);

            // Execute tool
            const result = await this.executeTool(toolName, toolArgs, { onToolCall, onToolResult });
            toolsUsed.push({ name: toolName, args: toolArgs, result });

            // Add tool result to messages
            messages.push({
              role: 'tool',
              tool_call_id: toolCall.id,
              content: result
            });
          }

          // Continue loop to get next response
          continue;
        }

        // No tool calls - we have a final response
        const finalContent = assistantMessage.content || '';

        console.log(`✅ [${this.name}] Completed in ${iterations} iteration(s)`);
        onMessage?.(finalContent, true);

        return {
          success: true,
          message: finalContent,
          toolsUsed,
          iterations,
          agent: this.name
        };

      } catch (error) {
        console.error(`❌ [${this.name}] API Error:`, error);

        // Check for recoverable errors
        if (error.status === 429) {
          // Rate limited - wait and retry
          console.log(`⏳ [${this.name}] Rate limited, waiting 5s...`);
          await new Promise(resolve => setTimeout(resolve, 5000));
          continue;
        }

        return {
          success: false,
          error: error.message,
          toolsUsed,
          iterations,
          agent: this.name
        };
      }
    }

    // Max iterations reached
    console.log(`⚠️ [${this.name}] Max iterations (${this.maxIterations}) reached`);

    return {
      success: true,
      message: `I've gathered information but reached the iteration limit. Here's what I found so far based on ${toolsUsed.length} tool calls.`,
      toolsUsed,
      iterations,
      maxIterationsReached: true,
      agent: this.name
    };
  }

  /**
   * Build the system prompt with context
   * @param {object} context - Additional context
   * @returns {string} Complete system prompt
   */
  buildSystemPrompt(context = {}) {
    let prompt = this.systemPrompt;

    if (context.slateId) {
      prompt += `\n\nCurrent Slate ID: ${context.slateId}`;
    }

    if (context.additionalContext) {
      prompt += `\n\nAdditional Context:\n${context.additionalContext}`;
    }

    return prompt;
  }

  /**
   * Get agent info for display
   * @returns {object} Agent metadata
   */
  getInfo() {
    return {
      name: this.name,
      description: this.description,
      maxIterations: this.maxIterations,
      toolCount: this.tools.length,
      tools: this.tools.map(t => t.name)
    };
  }
}
