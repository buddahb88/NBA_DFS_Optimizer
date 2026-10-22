import { useCallback, useMemo, useState } from 'react';
import { nameKey } from './blocks/blockModel';

const DRAFT = 'draft';
const NONE = [];

/**
 * Players pinned to the context drawer, per chat session (in memory).
 * An unsaved chat pins under a draft key; adoptDraft(id) moves those pins to
 * the session the backend creates, clearDraft() drops them for a new chat.
 */
export default function useChatPins(sessionId) {
  const [bySession, setBySession] = useState({});
  const key = sessionId ?? DRAFT;
  const pinned = bySession[key] ?? NONE;

  const isPinned = useCallback((player) => pinned.some((p) => nameKey(p.name) === nameKey(player?.name)), [pinned]);

  /** Returns true when the player is now pinned. */
  const togglePin = useCallback(
    (player) => {
      const k = nameKey(player?.name);
      const list = bySession[key] ?? [];
      const has = list.some((p) => nameKey(p.name) === k);
      setBySession((prev) => {
        const current = prev[key] ?? [];
        return { ...prev, [key]: has ? current.filter((p) => nameKey(p.name) !== k) : [...current, player] };
      });
      return !has;
    },
    [bySession, key],
  );

  const adoptDraft = useCallback((id) => {
    if (id == null) return;
    setBySession((prev) => {
      if (!prev[DRAFT]?.length) return prev;
      const { [DRAFT]: draft, ...rest } = prev;
      return { ...rest, [id]: [...(rest[id] ?? []), ...draft] };
    });
  }, []);

  const clearDraft = useCallback(() => {
    setBySession((prev) => {
      if (!(DRAFT in prev)) return prev;
      const { [DRAFT]: _omit, ...rest } = prev;
      return rest;
    });
  }, []);

  return useMemo(() => ({ pinned, isPinned, togglePin, adoptDraft, clearDraft }), [pinned, isPinned, togglePin, adoptDraft, clearDraft]);
}
