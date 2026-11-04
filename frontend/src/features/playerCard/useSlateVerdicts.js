import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { playersAPI } from '../../services/api';

/**
 * Player-card verdicts for a whole slate (GET /players/:slateId/verdicts):
 * one request per slate + date, shared by every lineup card, portfolio row
 * and chat block on screen (module cache + in-flight dedupe). The backend
 * caches too; this cache is short so a projection source change or new box
 * scores show up soon. clearSlateVerdicts() refetches for mounted views.
 *
 * Returns { status: 'idle'|'loading'|'done'|'error', data, lookup(player) }
 * where lookup finds a player's entry by slate row id, then site player_id.
 */

const TTL_MS = 2 * 60 * 1000;
const CACHE_LIMIT = 20;
const cache = new Map(); // key -> { at, promise, data, error }
const listeners = new Set();
let version = 0;

export const verdictsKey = ({ slateId, slateDate }) => `${slateId}|${slateDate ?? ''}`;

const notify = () => {
  version += 1;
  listeners.forEach((l) => l());
};

/** Drop every cached slate's verdicts; mounted hooks refetch. */
export function clearSlateVerdicts() {
  cache.clear();
  notify();
}

/** The cached / in-flight request for a slate (starts one when needed). */
export function fetchSlateVerdicts({ slateId, slateDate = null }) {
  const key = verdictsKey({ slateId, slateDate });
  const hit = cache.get(key);
  if (hit && (hit.promise || (hit.data && Date.now() - hit.at < TTL_MS))) return hit;
  const entry = { at: Date.now(), promise: null, data: null, error: null };
  const params = slateDate ? { slateDate } : {};
  // Promise.resolve().then: a missing / throwing API becomes an error state, never a render crash
  entry.promise = Promise.resolve()
    .then(() => playersAPI.getVerdicts(slateId, params))
    .then(({ data }) => {
      entry.data = data;
    })
    .catch((err) => {
      entry.error = err?.response?.data?.error || err?.message || 'Failed to load verdicts';
    })
    .finally(() => {
      entry.promise = null;
      entry.at = Date.now();
      if (cache.get(key) === entry) notify();
    });
  cache.set(key, entry);
  while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
  return entry;
}

const subscribe = (l) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
const getVersion = () => version;

/** Index a verdicts payload: lookup(player) -> entry | null. */
export function verdictLookup(data) {
  const byId = data?.players ?? {};
  const byPlayerId = new Map();
  for (const e of Object.values(byId)) if (e?.player_id != null) byPlayerId.set(String(e.player_id), e);
  return (player) => {
    if (!player) return null;
    return (player.id != null ? byId[String(player.id)] : null)
      ?? (player.player_id != null ? byPlayerId.get(String(player.player_id)) : null)
      ?? null;
  };
}

const NONE = () => null;

export default function useSlateVerdicts({ slateId, slateDate = null, enabled = true } = {}) {
  const active = Boolean(enabled && slateId);
  const v = useSyncExternalStore(subscribe, getVersion, getVersion);
  const key = active ? verdictsKey({ slateId, slateDate }) : null;
  const [, setTick] = useState(0);

  useEffect(() => {
    if (!active) return;
    const hit = cache.get(key);
    // Start (or refresh a stale) request; the store notifies when it settles
    if (!hit || (!hit.promise && Date.now() - hit.at >= TTL_MS)) {
      fetchSlateVerdicts({ slateId, slateDate });
      setTick((t) => t + 1);
    }
  }, [active, key, slateId, slateDate, v]);

  const entry = key ? cache.get(key) : null;
  const data = entry?.data ?? null;
  const lookup = useMemo(() => (data ? verdictLookup(data) : NONE), [data]);
  const status = !active ? 'idle' : data ? 'done' : entry?.error ? 'error' : 'loading';
  const reload = useCallback(() => {
    if (key) cache.delete(key);
    notify();
  }, [key]);
  return { status, data, error: entry?.error ?? null, lookup, reload };
}
