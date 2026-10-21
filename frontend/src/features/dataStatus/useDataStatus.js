import { useCallback, useEffect, useState } from 'react';
import { historicalAPI } from '../../services/api';
import { errorMessage } from './dataStatus';

export const POLL_MS = 3000;

/**
 * Data Status panel state.
 *   report   GET /historical/data-status: { status: 'loading' | 'ready' | 'error', data, error }
 *   syncing  a sync (ours, scheduled or another tab's) is running; polls
 *            GET /historical/sync/status every POLL_MS until it finishes,
 *            then reloads the report
 *   progress latest sync/status progress while syncing
 *   notice   { tone: 'positive' | 'negative' | 'info', text } outcome of the last
 *            action or sync; every failure lands here, nothing is swallowed
 *   pending  'sync' or a season while its start request is in flight
 */
export default function useDataStatus() {
  const [report, setReport] = useState({ status: 'loading', data: null, error: null });
  const [syncing, setSyncing] = useState(false);
  const [progress, setProgress] = useState(null);
  const [notice, setNotice] = useState(null);
  const [pending, setPending] = useState(null);

  const load = useCallback(async () => {
    setReport((r) => ({ ...r, status: 'loading', error: null }));
    try {
      const { data } = await historicalAPI.getDataStatus();
      setReport({ status: 'ready', data, error: null });
      if (data?.sync?.isSyncing) setSyncing(true);
    } catch (err) {
      setReport({ status: 'error', data: null, error: errorMessage(err) });
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!syncing) return undefined;
    let cancelled = false;
    const poll = async () => {
      try {
        const { data } = await historicalAPI.getSyncStatus();
        if (cancelled) return;
        setProgress(data?.progress ?? null);
        if (data?.isSyncing) return;
        setSyncing(false);
        const p = data?.progress;
        if (p?.status === 'error') setNotice({ tone: 'negative', text: `Sync failed: ${p.error}` });
        else if (p) setNotice({ tone: 'positive', text: p.message });
        load();
      } catch (err) {
        if (!cancelled) setNotice({ tone: 'negative', text: `Couldn’t check sync progress: ${errorMessage(err)}` });
      }
    };
    const timer = setInterval(poll, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [syncing, load]);

  const start = useCallback(async (key, request) => {
    setPending(key);
    setNotice(null);
    try {
      const { data } = await request();
      if (data?.upToDate) {
        setNotice({ tone: 'info', text: 'Game logs are already up to date: nothing to sync.' });
        load();
      } else {
        setProgress(null);
        setSyncing(true);
      }
    } catch (err) {
      if (err?.response?.status === 409) {
        // Another sync holds the lock; follow it instead
        setNotice({ tone: 'info', text: err.response.data?.progress?.message || 'A sync is already running.' });
        setSyncing(true);
      } else {
        setNotice({ tone: 'negative', text: `Couldn’t start the sync: ${errorMessage(err)}` });
      }
    } finally {
      setPending(null);
    }
  }, [load]);

  const syncNow = useCallback(() => start('sync', () => historicalAPI.startIncrementalSync()), [start]);
  const backfill = useCallback((season) => start(season, () => historicalAPI.backfillSeason(season)), [start]);

  return { report, syncing, progress, notice, pending, reload: load, syncNow, backfill, dismissNotice: () => setNotice(null) };
}
