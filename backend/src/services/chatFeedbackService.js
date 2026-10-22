import db from '../config/database.js';

export const FEEDBACK_RATINGS = ['up', 'down'];
const MAX_EXCERPT_LENGTH = 2000;

const toId = (value) => (Number.isInteger(value) ? value : null);

/**
 * Store a thumbs up/down on an assistant answer.
 * sessionId/messageId are optional: answers streamed in this page view have no
 * message id yet, so the excerpt is kept to identify them.
 */
export async function saveFeedback({ sessionId, messageId, rating, content }) {
  const excerpt = typeof content === 'string' ? content.slice(0, MAX_EXCERPT_LENGTH) : null;
  const result = await db.run(
    `INSERT INTO chat_feedback (session_id, message_id, rating, message_excerpt)
     VALUES (?, ?, ?, ?)`,
    toId(sessionId), toId(messageId), rating, excerpt
  );
  return { success: true, id: result.lastInsertRowid != null ? Number(result.lastInsertRowid) : null };
}

export default { saveFeedback };
