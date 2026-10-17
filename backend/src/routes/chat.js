import express from 'express';
import aiChatService from '../services/aiChatService.js';
import agenticChatService from '../services/agenticChatService.js';
import { StreamHandler, createStreamCallbacks } from '../services/streamHandler.js';

const router = express.Router();

/**
 * POST /api/chat/stream
 * Send a message with SSE streaming response (new agentic system)
 * Body: { message: string, sessionId?: number, slateId?: string, maxIterations?: number }
 */
router.post('/stream', async (req, res) => {
  const stream = new StreamHandler(res);

  try {
    const { message, sessionId, slateId, maxIterations = 10 } = req.body;

    if (!message || message.trim().length === 0) {
      return res.status(400).json({ error: 'Message is required', code: 'INVALID_MESSAGE' });
    }

    stream.setupSSE();
    console.log(`\n📨 [Stream] Received chat message for session ${sessionId || 'new'}`);

    // Create new session if not provided
    let activeSessionId = sessionId;
    if (!activeSessionId) {
      const sessionResult = await agenticChatService.createSession(slateId);
      if (!sessionResult.success) {
        stream.sendError(sessionResult.error, 'SESSION_ERROR');
        return;
      }
      activeSessionId = sessionResult.sessionId;
      stream.sendEvent('session_created', { sessionId: activeSessionId });
    }

    // Get chat history for context
    const historyResult = await agenticChatService.getChatHistory(activeSessionId);
    const chatHistory = historyResult.success ? historyResult.messages : [];

    // Save user message
    await agenticChatService.saveMessage(activeSessionId, 'user', message);

    // Create streaming callbacks
    const callbacks = createStreamCallbacks(stream);

    // Get AI response with streaming
    const response = await agenticChatService.chat(message, activeSessionId, {
      maxIterations: Math.min(Math.max(maxIterations, 5), 30), // Clamp between 5-30
      slateId,
      chatHistory,
      ...callbacks
    });

    if (!response.success) {
      stream.sendError(response.error, 'CHAT_ERROR');
      return;
    }

    // Save assistant message with metadata
    await agenticChatService.saveMessage(activeSessionId, 'assistant', response.message, {
      toolsUsed: response.toolsUsed,
      agentsUsed: response.agentsUsed,
      iterations: response.iterations
    });

    // Send completion
    stream.sendDone({
      sessionId: activeSessionId,
      toolsUsed: response.toolsUsed,
      agentsUsed: response.agentsUsed,
      iterations: response.iterations,
      maxIterationsReached: response.maxIterationsReached || false
    });

  } catch (error) {
    console.error('❌ Stream endpoint error:', error);
    stream.sendError(error.message, 'INTERNAL_ERROR');
  }
});

/**
 * GET /api/chat/agents
 * Get info about available agents
 */
router.get('/agents', (req, res) => {
  try {
    const agents = agenticChatService.getAgentInfo();
    res.json({ success: true, agents });
  } catch (error) {
    console.error('❌ Get agents error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/chat
 * Send a message to the AI assistant (legacy non-streaming)
 * Body: { message: string, sessionId?: number, slateId?: string }
 */
router.post('/', async (req, res) => {
  try {
    const { message, sessionId, slateId, useAgentic = false } = req.body;

    if (!message || message.trim().length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Message is required',
      });
    }

    console.log(`\n📨 Received chat message for session ${sessionId || 'new'}`);

    // Choose service based on flag
    const service = useAgentic ? agenticChatService : aiChatService;

    // Create new session if not provided
    let activeSessionId = sessionId;
    if (!activeSessionId) {
      const sessionResult = await service.createSession(slateId);
      if (!sessionResult.success) {
        return res.status(500).json(sessionResult);
      }
      activeSessionId = sessionResult.sessionId;
    }

    // Get chat history for context
    const historyResult = await service.getChatHistory(activeSessionId);
    const chatHistory = historyResult.success ? historyResult.messages : [];

    // Save user message
    await service.saveMessage(activeSessionId, 'user', message);

    // Get AI response
    let response;
    if (useAgentic) {
      response = await service.chat(message, activeSessionId, {
        slateId,
        chatHistory
      });
    } else {
      response = await service.chat(message, activeSessionId, chatHistory);
    }

    if (!response.success) {
      return res.status(500).json(response);
    }

    // Save assistant message
    await service.saveMessage(activeSessionId, 'assistant', response.message, {
      toolsUsed: response.toolsUsed,
      agentsUsed: response.agentsUsed,
    });

    res.json({
      success: true,
      sessionId: activeSessionId,
      message: response.message,
      toolsUsed: response.toolsUsed,
      agentsUsed: response.agentsUsed,
    });
  } catch (error) {
    console.error('❌ Chat endpoint error:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      message: 'An error occurred while processing your message',
    });
  }
});

/**
 * GET /api/chat/sessions
 * Get all chat sessions
 */
router.get('/sessions', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 20;
    const result = await agenticChatService.getAllSessions(limit);
    res.json(result);
  } catch (error) {
    console.error('❌ Get sessions error:', error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * GET /api/chat/sessions/:sessionId
 * Get chat history for a specific session
 */
router.get('/sessions/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const limit = parseInt(req.query.limit) || 50;

    const result = await agenticChatService.getChatHistory(parseInt(sessionId), limit);
    res.json(result);
  } catch (error) {
    console.error('❌ Get history error:', error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * POST /api/chat/sessions
 * Create a new chat session
 * Body: { slateId?: string, title?: string }
 */
router.post('/sessions', async (req, res) => {
  try {
    const { slateId, title } = req.body;
    const result = await agenticChatService.createSession(slateId, title);
    res.json(result);
  } catch (error) {
    console.error('❌ Create session error:', error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * DELETE /api/chat/sessions/:sessionId
 * Delete a chat session
 */
router.delete('/sessions/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const result = await agenticChatService.deleteSession(parseInt(sessionId));
    res.json(result);
  } catch (error) {
    console.error('❌ Delete session error:', error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

export default router;
