import express from 'express';
import agenticChatService from '../services/agenticChatService.js';
import { StreamHandler, createStreamCallbacks } from '../services/streamHandler.js';
import { FEEDBACK_RATINGS, saveFeedback } from '../services/chatFeedbackService.js';

const router = express.Router();

/**
 * POST /api/chat/stream
 * Send a message with SSE streaming response (new agentic system)
 * Body: { message: string, sessionId?: number, slateId?: string, maxIterations?: number, mode?: 'cash' | 'gpp' }
 * mode is passed through to the chat service (not yet used to steer answers).
 */
router.post('/stream', async (req, res) => {
  const stream = new StreamHandler(res);

  try {
    const { message, sessionId, slateId, maxIterations = 10, mode } = req.body;

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
      mode,
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

const MAX_TITLE_LENGTH = 120;

/**
 * PATCH /api/chat/sessions/:sessionId
 * Rename a chat session
 * Body: { title: string }
 */
router.patch('/sessions/:sessionId', async (req, res) => {
  try {
    const { title } = req.body || {};
    const trimmed = typeof title === 'string' ? title.trim().slice(0, MAX_TITLE_LENGTH) : '';
    if (!trimmed) {
      return res.status(400).json({ success: false, error: 'Title is required' });
    }

    const result = await agenticChatService.renameSession(parseInt(req.params.sessionId), trimmed);
    if (result.notFound) return res.status(404).json({ success: false, error: result.error });
    if (!result.success) return res.status(500).json(result);
    res.json(result);
  } catch (error) {
    console.error('❌ Rename session error:', error);
    res.status(500).json({ success: false, error: error.message });
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

/**
 * POST /api/chat/feedback
 * Thumbs up/down on an assistant answer
 * Body: { rating: 'up' | 'down', sessionId?: number, messageId?: number, content?: string }
 */
router.post('/feedback', async (req, res) => {
  try {
    const { rating, sessionId, messageId, content } = req.body || {};
    if (!FEEDBACK_RATINGS.includes(rating)) {
      return res.status(400).json({ success: false, error: "rating must be 'up' or 'down'" });
    }
    res.json(await saveFeedback({ sessionId, messageId, rating, content }));
  } catch (error) {
    console.error('❌ Save feedback error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

export default router;
