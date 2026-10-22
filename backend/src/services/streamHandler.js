/**
 * StreamHandler - Server-Sent Events (SSE) utilities for real-time AI streaming
 *
 * Event Types:
 * - thinking: AI reasoning/planning step
 * - tool_call: Tool invocation starting
 * - tool_result: Tool execution complete
 * - ui_block: Typed result block for the assistant message ({ messageId, block },
 *   see chatTools/uiBlocks.js), in tool order, once per tool call
 * - agent_spawn: Sub-agent starting work
 * - agent_complete: Sub-agent finished
 * - message: Final response chunk
 * - done: Stream complete
 * - error: Error occurred
 */

import { randomUUID } from 'crypto';

export class StreamHandler {
  constructor(res) {
    this.res = res;
    this.isOpen = false;
    // One stream = one assistant message; its blocks are persisted with it
    this.messageId = randomUUID();
    this.uiBlocks = [];
    this.uiBlockCalls = new Set();
    this.uiBlockCount = 0;
  }

  /**
   * Initialize SSE connection
   */
  setupSSE() {
    this.res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'X-Accel-Buffering': 'no', // Disable nginx buffering
    });
    this.isOpen = true;

    // Send initial connection event
    this.sendEvent('connected', { timestamp: new Date().toISOString() });

    // Handle client disconnect
    this.res.on('close', () => {
      this.isOpen = false;
    });
  }

  /**
   * Send an SSE event
   * @param {string} type - Event type
   * @param {object} data - Event data
   */
  sendEvent(type, data) {
    if (!this.isOpen) return;

    try {
      const eventStr = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
      this.res.write(eventStr);
    } catch (error) {
      console.error('Error sending SSE event:', error);
    }
  }

  /**
   * Send thinking/reasoning event
   * @param {string} text - Reasoning text
   */
  sendThinking(text) {
    this.sendEvent('thinking', {
      text,
      timestamp: new Date().toISOString()
    });
  }

  /**
   * Send tool call start event
   * @param {string} tool - Tool name
   * @param {object} args - Tool arguments
   */
  sendToolCall(tool, args) {
    this.sendEvent('tool_call', {
      tool,
      args,
      timestamp: new Date().toISOString()
    });
  }

  /**
   * Send tool result event
   * @param {string} tool - Tool name
   * @param {object} result - Tool result
   * @param {boolean} success - Whether tool succeeded
   */
  sendToolResult(tool, result, success = true) {
    this.sendEvent('tool_result', {
      tool,
      result,
      success,
      timestamp: new Date().toISOString()
    });
  }

  /**
   * Send a tool call's ui blocks (once per tool call) and keep them for
   * persistence. Each block gets id `<toolCallId>:<n>`.
   * @param {Array} blocks - Validated blocks (chatTools/uiBlocks.js)
   * @param {object} source - { tool, toolCallId }
   */
  sendUiBlocks(blocks, { tool, toolCallId } = {}) {
    const callId = toolCallId || `${tool || 'tool'}-${++this.uiBlockCount}`;
    if (this.uiBlockCalls.has(callId)) return;
    this.uiBlockCalls.add(callId);

    blocks.forEach((block, i) => {
      const withId = { ...block, id: `${callId}:${i}`, tool };
      this.uiBlocks.push(withId);
      this.sendEvent('ui_block', { messageId: this.messageId, block: withId });
    });
  }

  /**
   * Send agent spawn event
   * @param {string} agent - Agent name
   * @param {string} task - Task description
   */
  sendAgentSpawn(agent, task) {
    this.sendEvent('agent_spawn', {
      agent,
      task,
      timestamp: new Date().toISOString()
    });
  }

  /**
   * Send agent complete event
   * @param {string} agent - Agent name
   * @param {object} result - Agent result summary
   */
  sendAgentComplete(agent, result = null) {
    this.sendEvent('agent_complete', {
      agent,
      result,
      timestamp: new Date().toISOString()
    });
  }

  /**
   * Send message chunk event
   * @param {string} text - Message text chunk
   * @param {boolean} isComplete - Whether this is the final chunk
   */
  sendMessage(text, isComplete = false) {
    this.sendEvent('message', {
      text,
      isComplete,
      timestamp: new Date().toISOString()
    });
  }

  /**
   * Send iteration update
   * @param {number} current - Current iteration
   * @param {number} max - Max iterations
   */
  sendIteration(current, max) {
    this.sendEvent('iteration', {
      current,
      max,
      timestamp: new Date().toISOString()
    });
  }

  /**
   * Send done event and close stream
   * @param {object} metadata - Final metadata (toolsUsed, etc.)
   */
  sendDone(metadata = {}) {
    this.sendEvent('done', {
      ...metadata,
      timestamp: new Date().toISOString()
    });
    this.close();
  }

  /**
   * Send error event and close stream
   * @param {string} message - Error message
   * @param {string} code - Error code (optional)
   */
  sendError(message, code = null) {
    this.sendEvent('error', {
      message,
      code,
      timestamp: new Date().toISOString()
    });
    this.close();
  }

  /**
   * Close the SSE connection
   */
  close() {
    if (this.isOpen) {
      this.isOpen = false;
      this.res.end();
    }
  }
}

/**
 * Create callback functions for agent execution
 * @param {StreamHandler} stream - Stream handler instance
 * @returns {object} Callback functions
 */
export function createStreamCallbacks(stream) {
  return {
    onThinking: (text) => stream.sendThinking(text),
    onToolCall: (tool, args) => stream.sendToolCall(tool, args),
    onToolResult: (tool, result, success) => stream.sendToolResult(tool, result, success),
    onUiBlock: (blocks, source) => stream.sendUiBlocks(blocks, source),
    onAgentSpawn: (agent, task) => stream.sendAgentSpawn(agent, task),
    onAgentComplete: (agent, result) => stream.sendAgentComplete(agent, result),
    onMessage: (text, isComplete) => stream.sendMessage(text, isComplete),
    onIteration: (current, max) => stream.sendIteration(current, max),
  };
}

export default StreamHandler;
