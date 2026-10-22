import { useCallback, useEffect, useRef, useState } from 'react';
import { playerSettingsAPI } from '../../services/api';
import { isDefaultSettings, validateSettings } from './playerPool';

const errorMessage = (err) => err?.response?.data?.error || err?.message || 'Request failed';

/**
 * Saved per-slate player controls, keyed by players.player_id.
 * Updates apply optimistically; each player's writes are chained so a fast
 * lock -> unlock can't reach the server out of order. A failed save reloads
 * the slate's settings from the server.
 */
export default function usePlayerSettings(slateId) {
  const [settings, setSettings] = useState({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const settingsRef = useRef(settings);
  const queues = useRef({});

  const commit = (next) => {
    settingsRef.current = next;
    setSettings(next);
  };

  const reload = useCallback(async () => {
    if (!slateId) {
      commit({});
      return;
    }
    setLoading(true);
    try {
      const { data } = await playerSettingsAPI.getBySlateId(slateId);
      commit(Object.fromEntries((data || []).map((s) => [String(s.playerId), s])));
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [slateId]);

  useEffect(() => {
    reload();
  }, [reload]);

  /**
   * Merge `patch` into a player's controls. Returns a validation error string, if any.
   * `onError(message)` is called if the save fails (after which settings reload).
   */
  const update = useCallback(
    (playerId, patch, { onError } = {}) => {
      const key = String(playerId);
      const merged = { ...(settingsRef.current[key] || {}), ...patch };
      if (patch.lock) merged.exclude = false;
      if (patch.exclude) merged.lock = false;

      const invalid = validateSettings(merged);
      if (invalid) return invalid;

      const next = { ...settingsRef.current };
      if (isDefaultSettings(merged)) delete next[key];
      else next[key] = { ...merged, playerId: key };
      commit(next);

      const { playerId: _omit, ...body } = merged;
      queues.current[key] = (queues.current[key] || Promise.resolve())
        .then(() => playerSettingsAPI.save(slateId, key, body))
        .then(() => setError(null))
        .catch((err) => {
          const message = `Couldn't save: ${errorMessage(err)}`;
          setError(message);
          onError?.(message);
          return reload();
        });
      return null;
    },
    [slateId, reload],
  );

  const clearAll = useCallback(async () => {
    const previous = settingsRef.current;
    commit({});
    try {
      await playerSettingsAPI.clear(slateId);
    } catch (err) {
      commit(previous);
      setError(`Couldn't reset: ${errorMessage(err)}`);
    }
  }, [slateId]);

  return { settings, loading, error, update, clearAll, reload, dismissError: () => setError(null) };
}
