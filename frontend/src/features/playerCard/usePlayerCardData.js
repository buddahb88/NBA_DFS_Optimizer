import { useEffect, useState } from 'react';
import { playersAPI } from '../../services/api';

// Cards per slate + date + player, kept for the session (the backend also caches)
const cache = new Map();
const CACHE_LIMIT = 100;
const TTL_MS = 2 * 60 * 1000;

export const cardKey = ({ slateId, slateDate, playerId }) => `${slateId}|${slateDate ?? ''}|${playerId}`;

export function clearPlayerCardCache() {
  cache.clear();
}

/** { status: 'idle'|'loading'|'done'|'error', card, error } for a card target; reload() refetches. */
export default function usePlayerCardData(target) {
  const key = target?.slateId && target?.playerId != null ? cardKey(target) : null;
  const [state, setState] = useState({ key: null, status: 'idle', card: null, error: null });
  const [version, setVersion] = useState(0);

  useEffect(() => {
    if (!key) return undefined;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < TTL_MS && version === 0) {
      setState({ key, status: 'done', card: hit.card, error: null });
      return undefined;
    }
    let cancelled = false;
    setState({ key, status: 'loading', card: null, error: null });
    const params = target.slateDate ? { slateDate: target.slateDate } : {};
    playersAPI
      .getCard(target.slateId, target.playerId, params)
      .then(({ data }) => {
        if (cancelled) return;
        cache.set(key, { at: Date.now(), card: data });
        while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
        setState({ key, status: 'done', card: data, error: null });
      })
      .catch((err) => {
        if (!cancelled) setState({ key, status: 'error', card: null, error: err.response?.data?.error || err.message });
      });
    return () => {
      cancelled = true;
    };
    // target fields are all in key
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, version]);

  const current = state.key === key ? state : { key, status: key ? 'loading' : 'idle', card: null, error: null };
  return { ...current, reload: () => setVersion((v) => v + 1) };
}
