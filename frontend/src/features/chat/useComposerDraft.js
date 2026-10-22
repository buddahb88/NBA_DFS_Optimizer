import { useCallback, useEffect, useState } from 'react';

const EMPTY = { text: '', mentions: [] };

export const draftKey = (sessionId) => `nba-dfs:chat-draft:${sessionId ?? 'new'}`;

function readDraft(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return EMPTY;
    const parsed = JSON.parse(raw);
    return { text: typeof parsed.text === 'string' ? parsed.text : '', mentions: Array.isArray(parsed.mentions) ? parsed.mentions : [] };
  } catch {
    return EMPTY;
  }
}

function writeDraft(key, draft) {
  try {
    if (draft.text) localStorage.setItem(key, JSON.stringify(draft));
    else localStorage.removeItem(key);
  } catch {
    // storage unavailable; the draft just won't survive a reload
  }
}

/** Composer text + mentions, persisted per chat session ('new' before the first message). */
export default function useComposerDraft(sessionId) {
  const key = draftKey(sessionId);
  const [state, setState] = useState(() => ({ key, draft: readDraft(key) }));

  // Switching sessions loads that session's draft
  let current = state;
  if (state.key !== key) {
    current = { key, draft: readDraft(key) };
    setState(current);
  }

  useEffect(() => {
    writeDraft(state.key, state.draft);
  }, [state]);

  const setDraft = useCallback((update) => {
    setState((s) => ({ ...s, draft: { ...s.draft, ...(typeof update === 'function' ? update(s.draft) : update) } }));
  }, []);

  return [current.draft, setDraft];
}
