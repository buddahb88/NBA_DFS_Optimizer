import express from 'express';
import aiChatService from '../services/aiChatService.js';

const router = express.Router();

/**
 * POST /api/chat
 * Send a message to the AI assistant
 * Body: { message: string, sessionId?: number, slateId?: string }
 */
router.post('/', async (req, res) => {
  try {
    const { message, sessionId, slateId } = req.body;

    if (!message || message.trim().length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Message is required',
      });
    }

    console.log(`\n📨 Received chat message for session ${sessionId || 'new'}`);

    // Create new session if not provided
    let activeSessionId = sessionId;
    if (!activeSessionId) {
      const sessionResult = aiChatService.createSession(slateId);
      if (!sessionResult.success) {
        return res.status(500).json(sessionResult);
      }
      activeSessionId = sessionResult.sessionId;
    }

    // Get chat history for context
    const historyResult = aiChatService.getChatHistory(activeSessionId);
    const chatHistory = historyResult.success ? historyResult.messages : [];

    // Save user message
    aiChatService.saveMessage(activeSessionId, 'user', message);

    // Get AI response
    const response = await aiChatService.chat(message, activeSessionId, chatHistory);

    if (!response.success) {
      return res.status(500).json(response);
    }

    // Save assistant message
    aiChatService.saveMessage(activeSessionId, 'assistant', response.message, {
      toolsUsed: response.toolsUsed,
    });

    res.json({
      success: true,
      sessionId: activeSessionId,
      message: response.message,
      toolsUsed: response.toolsUsed,
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
    const result = aiChatService.getAllSessions(limit);
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

    const result = aiChatService.getChatHistory(parseInt(sessionId), limit);
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
    const result = aiChatService.createSession(slateId, title);
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
    const result = aiChatService.deleteSession(parseInt(sessionId));
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
