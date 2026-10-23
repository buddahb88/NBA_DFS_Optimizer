import { useEffect, useState } from 'react';
import { chatAPI } from '../../services/api';

// Shown when the slate data can't support enough generated prompts
export const FALLBACK_SUGGESTIONS = [
  { id: 'fallback-value', kind: 'value_play', label: 'Value plays', prompt: 'Show me the top value plays under $6,000 tonight' },
  { id: 'fallback-stack', kind: 'game_stack', label: 'Game stacks', prompt: 'Which games have the highest Vegas totals for stacking?' },
  { id: 'fallback-edge', kind: 'archetype_edge', label: 'Matchups', prompt: 'Who has the best archetype matchups tonight?' },
  { id: 'fallback-leverage', kind: 'leverage', label: 'Leverage', prompt: 'Find high-ceiling, low-ownership GPP plays' },
  { id: 'fallback-usage', kind: 'usage_bump', label: 'Usage bumps', prompt: 'Who gets a usage bump from tonight\'s injuries?' },
  { id: 'fallback-score', kind: 'score_lineup', label: 'Score a lineup', prompt: 'Score my lineup from last night' },
];

const MIN_SUGGESTIONS = 4;
const MAX_SUGGESTIONS = 6;

/** Top up generated suggestions with static ones (skipping kinds already covered) to MIN..MAX items. */
export function withFallback(generated = []) {
  const list = generated.slice(0, MAX_SUGGESTIONS);
  if (list.length >= MIN_SUGGESTIONS) return list;
  const kinds = new Set(list.map((s) => s.kind));
  for (const s of FALLBACK_SUGGESTIONS) {
    if (list.length >= MIN_SUGGESTIONS) break;
    if (!kinds.has(s.kind)) list.push(s);
  }
  return list;
}

/**
 * Starter prompts for an empty chat from GET /chat/suggestions.
 * Returns { suggestions, loading, isFallback, isStale }; static prompts fill in
 * on error or thin data, except for a stale slate, whose list (a sync prompt
 * plus slate-independent ones) is kept as is.
 */
export default function useChatSuggestions(slateId, { enabled = true } = {}) {
  const [state, setState] = useState({ suggestions: [], loading: true, isFallback: false, isStale: false });

  useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;
    setState((s) => ({ ...s, loading: true }));
    chatAPI
      .getSuggestions(slateId)
      .then((res) => {
        const generated = res.data?.success && Array.isArray(res.data.suggestions) ? res.data.suggestions : [];
        const isStale = Boolean(res.data?.success && res.data.isStale);
        if (cancelled) return;
        if (isStale) setState({ suggestions: generated.slice(0, MAX_SUGGESTIONS), loading: false, isFallback: false, isStale });
        else setState({ suggestions: withFallback(generated), loading: false, isFallback: generated.length === 0, isStale });
      })
      .catch((err) => {
        console.error('Failed to load chat suggestions:', err);
        if (!cancelled) setState({ suggestions: withFallback([]), loading: false, isFallback: true, isStale: false });
      });
    return () => {
      cancelled = true;
    };
  }, [slateId, enabled]);

  return state;
}
