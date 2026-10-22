/**
 * CLAUDE (AZURE AI FOUNDRY) SUPPORT
 *
 * The AI services talk to either Azure OpenAI or Claude on Azure AI Foundry,
 * chosen by AZURE_OPENAI_ENDPOINT: a Foundry Claude endpoint ends in
 * /anthropic/ (https://<resource>.services.ai.azure.com/anthropic/), and
 * AZURE_OPENAI_MODEL is then the Claude deployment name (e.g. claude-opus-5-5).
 *
 * runClaudeToolLoop() is the Messages API equivalent of the services' OpenAI
 * function-calling loops: it keeps calling Claude, runs every tool_use block it
 * returns, and sends all results back in one user message until Claude answers.
 */

import { AnthropicFoundry } from '@anthropic-ai/foundry-sdk';

const DEFAULT_MAX_TOKENS = 16000;
// Opus 5.5 defaults to medium effort; set it explicitly so it's visible here
const DEFAULT_EFFORT = 'medium';

export const isClaudeEndpoint = (endpoint = process.env.AZURE_OPENAI_ENDPOINT) =>
  /\/anthropic\/?$/i.test(endpoint || '');

export function createClaudeClient() {
  if (!process.env.AZURE_OPENAI_KEY || !process.env.AZURE_OPENAI_ENDPOINT) {
    throw new Error('AZURE_OPENAI_KEY and AZURE_OPENAI_ENDPOINT must be set');
  }
  return new AnthropicFoundry({
    apiKey: process.env.AZURE_OPENAI_KEY,
    baseURL: process.env.AZURE_OPENAI_ENDPOINT,
  });
}

export const claudeModel = () => process.env.AZURE_OPENAI_MODEL || 'claude-opus-5-5';

/** OpenAI-style function definition ({ name, description, parameters }) -> Claude tool */
export const toClaudeTool = ({ name, description, parameters }) => ({
  name,
  description: description || '',
  input_schema: parameters || { type: 'object', properties: {} },
});

/** Chat history rows -> Claude messages (user/assistant text only, must start with user) */
export function toClaudeHistory(history = []) {
  const messages = history
    .filter(m => (m.role === 'user' || m.role === 'assistant') && m.content)
    .map(m => ({ role: m.role, content: String(m.content) }));
  while (messages.length && messages[0].role !== 'user') messages.shift();
  return messages;
}

const textOf = (content) =>
  content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();

/**
 * Run Claude with tools until it gives a final answer.
 *
 * @param {object} opts
 * @param {AnthropicFoundry} opts.client
 * @param {string} opts.system
 * @param {Array} opts.messages - Claude messages ending with the user's turn
 * @param {Array} opts.tools - Claude tool definitions
 * @param {(name: string, input: object) => Promise<string>} opts.executeTool - returns the tool result text
 * @param {number} [opts.maxIterations=10] - max model calls that request tools
 * @param {(iteration: number) => void} [opts.onIteration]
 * @returns {Promise<{ text: string, iterations: number, stopReason: string, maxIterationsReached: boolean }>}
 */
export async function runClaudeToolLoop({
  client,
  system,
  messages,
  tools = [],
  executeTool,
  maxIterations = 10,
  maxTokens = DEFAULT_MAX_TOKENS,
  onIteration,
}) {
  const conversation = [...messages];

  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    onIteration?.(iteration);

    const response = await client.messages.create({
      model: claudeModel(),
      max_tokens: maxTokens,
      system,
      messages: conversation,
      ...(tools.length > 0 ? { tools } : {}),
      output_config: { effort: DEFAULT_EFFORT },
    });

    if (response.stop_reason === 'refusal') {
      const reason = response.stop_details?.explanation;
      return {
        text: textOf(response.content) || `I can't help with that request${reason ? `: ${reason}` : '.'}`,
        iterations: iteration,
        stopReason: 'refusal',
        maxIterationsReached: false,
      };
    }

    if (response.stop_reason !== 'tool_use') {
      return {
        text: textOf(response.content),
        iterations: iteration,
        stopReason: response.stop_reason,
        maxIterationsReached: false,
      };
    }

    // Keep the full content (thinking + tool_use blocks) so Claude sees its own turn
    conversation.push({ role: 'assistant', content: response.content });

    const toolResults = [];
    for (const block of response.content) {
      if (block.type !== 'tool_use') continue;
      try {
        const result = await executeTool(block.name, block.input || {});
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: String(result ?? '') });
      } catch (error) {
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: error.message, is_error: true });
      }
    }
    conversation.push({ role: 'user', content: toolResults });
  }

  return { text: '', iterations: maxIterations, stopReason: 'max_iterations', maxIterationsReached: true };
}
