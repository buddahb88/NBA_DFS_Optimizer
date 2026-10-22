import { useCallback, useEffect, useState } from 'react';
import { chatAPI } from '../../services/api';

/**
 * Chat session list + the active session. The page owns the messages; this
 * hook hands them back from selectSession.
 *
 *   sessions, loading, error, activeSessionId, setActiveSessionId
 *   refresh()                   reload the list
 *   selectSession(id)           -> messages[] (or null on failure); marks it active
 *   deleteSession(id)           -> { ok, wasActive }
 *   renameSession(id, title)    -> boolean
 */
export default function useChatSessions() {
  const [sessions, setSessions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [activeSessionId, setActiveSessionId] = useState(null);

  const refresh = useCallback(async () => {
    try {
      const res = await chatAPI.getSessions();
      if (res.data?.success) {
        setSessions(res.data.sessions || []);
        setError(null);
      } else {
        setError('Could not load conversations');
      }
    } catch (err) {
      console.error('Failed to load sessions:', err);
      setError('Could not load conversations');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const selectSession = useCallback(async (id) => {
    try {
      const res = await chatAPI.getSessionHistory(id);
      if (!res.data?.success) return null;
      setActiveSessionId(id);
      return res.data.messages || [];
    } catch (err) {
      console.error('Failed to load session history:', err);
      return null;
    }
  }, []);

  const deleteSession = useCallback(
    async (id) => {
      try {
        await chatAPI.deleteSession(id);
      } catch (err) {
        console.error('Failed to delete session:', err);
        return { ok: false, wasActive: false };
      }
      const wasActive = id === activeSessionId;
      setSessions((prev) => prev.filter((s) => s.id !== id));
      if (wasActive) setActiveSessionId(null);
      return { ok: true, wasActive };
    },
    [activeSessionId],
  );

  const renameSession = useCallback(async (id, title) => {
    try {
      const res = await chatAPI.renameSession(id, title);
      if (!res.data?.success) return false;
      const saved = res.data.session?.title ?? title;
      setSessions((prev) => prev.map((s) => (s.id === id ? { ...s, title: saved } : s)));
      return true;
    } catch (err) {
      console.error('Failed to rename session:', err);
      return false;
    }
  }, []);

  return { sessions, loading, error, activeSessionId, setActiveSessionId, refresh, selectSession, deleteSession, renameSession };
}
