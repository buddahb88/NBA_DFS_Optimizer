import { useState, useCallback, useRef, useReducer } from 'react';
import { createTimeline, timelineReducer } from '../features/chat/timelineSteps';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001/api';

/**
 * Hook for consuming SSE stream from the agentic chat endpoint
 *
 * @returns {object} Stream state and controls
 */
export function useAgentStream() {
  const [isStreaming, setIsStreaming] = useState(false);
  const [reasoning, setReasoning] = useState([]);
  const [toolCalls, setToolCalls] = useState([]);
  const [activeAgent, setActiveAgent] = useState(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState(null);
  const [sessionId, setSessionId] = useState(null);
  const [iterations, setIterations] = useState({ current: 0, max: 10 });
  const [metadata, setMetadata] = useState(null);
  // Ordered agent/tool steps with start/end timestamps (see features/chat/timelineSteps.js)
  const [timeline, dispatchTimeline] = useReducer(timelineReducer, undefined, createTimeline);
  // Typed result blocks for the streamed message (backend chatTools/uiBlocks.js)
  const [uiBlocks, setUiBlocks] = useState([]);
  const [stopped, setStopped] = useState(false);

  const abortControllerRef = useRef(null);

  /**
   * Start a streaming chat request
   */
  const startStream = useCallback(async (userMessage, options = {}) => {
    const {
      sessionId: existingSessionId,
      slateId,
      maxIterations = 10,
      mode,
      mentions
    } = options;

    // Reset state
    setIsStreaming(true);
    setReasoning([]);
    setToolCalls([]);
    setActiveAgent(null);
    setMessage('');
    setError(null);
    setMetadata(null);
    setUiBlocks([]);
    setStopped(false);
    setSessionId(existingSessionId ?? null);
    setIterations({ current: 0, max: maxIterations });
    dispatchTimeline({ type: 'start', now: Date.now() });

    // Create abort controller for cancellation
    abortControllerRef.current = new AbortController();

    try {
      const response = await fetch(`${API_URL}/chat/stream`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          message: userMessage,
          sessionId: existingSessionId,
          slateId,
          maxIterations,
          mode,
          ...(mentions?.length ? { mentions } : {})
        }),
        signal: abortControllerRef.current.signal
      });

      if (!response.ok) {
        throw new Error(`HTTP error: ${response.status}`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();

        if (done) {
          break;
        }

        buffer += decoder.decode(value, { stream: true });

        // Process complete events in buffer
        const events = buffer.split('\n\n');
        buffer = events.pop() || ''; // Keep incomplete event in buffer

        for (const eventStr of events) {
          if (!eventStr.trim()) continue;

          const lines = eventStr.split('\n');
          let eventType = '';
          let eventData = '';

          for (const line of lines) {
            if (line.startsWith('event: ')) {
              eventType = line.slice(7);
            } else if (line.startsWith('data: ')) {
              eventData = line.slice(6);
            }
          }

          if (eventType && eventData) {
            try {
              const data = JSON.parse(eventData);
              handleEvent(eventType, data);
            } catch {
              console.error('Failed to parse event data:', eventData);
            }
          }
        }
      }
    } catch (err) {
      if (err.name === 'AbortError') {
        // Stopped by the user: keep the partial text so the caller can mark it as stopped
        setStopped(true);
      } else {
        console.error('Stream error:', err);
        setError(err.message);
      }
    } finally {
      dispatchTimeline({ type: 'end', now: Date.now() });
      setIsStreaming(false);
      abortControllerRef.current = null;
    }
  }, []);

  /**
   * Handle incoming SSE event
   */
  const handleEvent = useCallback((type, data) => {
    dispatchTimeline({ type: 'event', event: type, data, now: Date.now() });
    switch (type) {
      case 'connected':
        console.log('SSE connected:', data.timestamp);
        break;

      case 'session_created':
        setSessionId(data.sessionId);
        break;

      case 'thinking':
        setReasoning(prev => [...prev, {
          text: data.text,
          timestamp: data.timestamp
        }]);
        break;

      case 'tool_call':
        setToolCalls(prev => [...prev, {
          tool: data.tool,
          args: data.args,
          status: 'running',
          timestamp: data.timestamp
        }]);
        break;

      case 'tool_result':
        setToolCalls(prev => prev.map(tc =>
          tc.tool === data.tool && tc.status === 'running'
            ? { ...tc, result: data.result, success: data.success, status: 'done' }
            : tc
        ));
        break;

      case 'ui_block':
        if (!data.block) break;
        setUiBlocks(prev => (prev.some(b => b.id && b.id === data.block.id) ? prev : [...prev, data.block]));
        break;

      case 'agent_spawn':
        setActiveAgent({ name: data.agent, task: data.task });
        setReasoning(prev => [...prev, {
          text: `Delegating to ${data.agent} agent: ${data.task}`,
          timestamp: data.timestamp,
          isAgentSpawn: true
        }]);
        break;

      case 'agent_complete':
        setActiveAgent(null);
        break;

      case 'iteration':
        setIterations({ current: data.current, max: data.max });
        break;

      case 'message':
        if (data.isComplete) {
          setMessage(data.text);
        } else {
          setMessage(prev => prev + data.text);
        }
        break;

      case 'done':
        setMetadata({
          sessionId: data.sessionId,
          messageId: data.messageId,
          toolsUsed: data.toolsUsed,
          agentsUsed: data.agentsUsed,
          iterations: data.iterations,
          maxIterationsReached: data.maxIterationsReached
        });
        if (data.sessionId) {
          setSessionId(data.sessionId);
        }
        break;

      case 'error':
        setError(data.message);
        break;

      default:
        console.log('Unknown event type:', type, data);
    }
  }, []);

  /**
   * Cancel the current stream
   */
  const cancelStream = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
  }, []);

  /**
   * Reset all state
   */
  const reset = useCallback(() => {
    setIsStreaming(false);
    setReasoning([]);
    setToolCalls([]);
    setActiveAgent(null);
    setMessage('');
    setError(null);
    setMetadata(null);
    setUiBlocks([]);
    setStopped(false);
    setIterations({ current: 0, max: 10 });
    dispatchTimeline({ type: 'reset' });
  }, []);

  return {
    // State
    isStreaming,
    reasoning,
    toolCalls,
    activeAgent,
    message,
    error,
    sessionId,
    iterations,
    metadata,
    timeline,
    uiBlocks,
    stopped,

    // Actions
    startStream,
    cancelStream,
    reset,

    // Setters for external control
    setSessionId
  };
}

export default useAgentStream;
