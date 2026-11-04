import { useCallback, useEffect, useRef, useState } from 'react';
import { playerSettingsAPI } from '../../services/api';

const EMPTY = { lock: false, exclude: false, maxExposure: null };

/**
 * Lock / exclude / max exposure from the card. With `external` (the opening
 * page's controls) the page's state is driven through external.onUpdate;
 * otherwise the card reads and saves the slate's player settings itself
 * (settingsKey from the card, keyed by player_id). Returns
 * { state, available, exposure, saving, error, set(patch) }.
 */
export default function useCardControls(card, external) {
  const settingsKey = card?.slate?.settingsKey ?? null;
  const playerId = card?.player?.player_id != null ? String(card.player.player_id) : null;
  const [state, setState] = useState(() => (external ? { ...EMPTY, ...pick(external) } : EMPTY));
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  // The full saved row, so a save keeps the other controls (min exposure, override)
  const savedRow = useRef({});

  // Own mode: load the saved controls for this player
  useEffect(() => {
    if (external || !settingsKey || !playerId) return undefined;
    let cancelled = false;
    playerSettingsAPI
      .getBySlateId(settingsKey)
      .then(({ data }) => {
        if (cancelled) return;
        const row = (Array.isArray(data) ? data : []).find((s) => String(s.playerId) === playerId);
        if (row) {
          const { playerId: _omit, ...rest } = row;
          savedRow.current = rest;
        }
        setState(row ? { ...EMPTY, ...pick(row) } : EMPTY);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [external, settingsKey, playerId]);

  const set = useCallback(
    (patch) => {
      const next = { ...state, ...patch };
      // Locking a player includes him; excluding unlocks him
      if (patch.lock) next.exclude = false;
      if (patch.exclude) next.lock = false;
      setState(next);
      setError(null);
      const changed = Object.fromEntries(Object.entries(next).filter(([k, v]) => state[k] !== v));
      if (!Object.keys(changed).length) return;
      if (external?.onUpdate) {
        const message = external.onUpdate(changed);
        if (typeof message === 'string' && message) {
          setError(message);
          setState(state);
        }
        return;
      }
      if (!settingsKey || !playerId) return;
      setSaving(true);
      playerSettingsAPI
        .save(settingsKey, playerId, { ...savedRow.current, ...next })
        .then(() => {
          savedRow.current = { ...savedRow.current, ...next };
        })
        .catch((err) => {
          setError(err.response?.data?.error || err.message);
          setState(state);
        })
        .finally(() => setSaving(false));
    },
    [state, external, settingsKey, playerId],
  );

  return {
    state,
    available: Boolean(external?.onUpdate || (settingsKey && playerId)),
    exposure: external ? external.exposure !== false : true,
    saving,
    error,
    set,
  };
}

const pick = (s) => ({ lock: !!s.lock, exclude: !!s.exclude, maxExposure: s.maxExposure ?? null });
