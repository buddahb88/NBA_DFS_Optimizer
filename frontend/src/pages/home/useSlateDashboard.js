import { useCallback, useEffect, useRef, useState } from 'react';
import api, { historicalAPI, playersAPI, slatesAPI } from '../../services/api';
import { toHistoryPayload } from './slateDashboard';

const errorMessage = (err) => err?.response?.data?.error || err?.message || 'Request failed';

/**
 * Loads everything the slate dashboard needs for the active slate. Core data
 * (slate + players) gates the page; team pace, historical status and the
 * injury/usage-bump lookups load afterwards and fail soft.
 */
export default function useSlateDashboard() {
  const [state, setState] = useState({
    status: 'loading', // loading | empty | ready | error
    error: null,
    slate: null,
    players: [],
    teamStats: null,
    historyStatus: null,
  });
  const [news, setNews] = useState({ loading: false, error: null, missing: [], bumps: [] });
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState(null);
  const requestId = useRef(0);

  const load = useCallback(async ({ quiet = false } = {}) => {
    const id = ++requestId.current;
    const current = () => id === requestId.current;
    if (!quiet) setState((s) => ({ ...s, status: 'loading', error: null }));

    try {
      const { data: slate } = await slatesAPI.getActiveSlate();
      if (!current()) return;
      if (!slate) {
        setState({ status: 'empty', error: null, slate: null, players: [], teamStats: null, historyStatus: null });
        setNews({ loading: false, error: null, missing: [], bumps: [] });
        return;
      }

      const { data: players } = await playersAPI.getBySlateId(slate.slate_id);
      if (!current()) return;
      setState((s) => ({ ...s, status: 'ready', error: null, slate, players: players || [] }));

      const teams = [...new Set((players || []).flatMap((p) => [p.team, p.opponent]).filter(Boolean))];
      const [teamStats, historyStatus] = await Promise.allSettled([
        api.get('/dashboard/team-stats', { params: { teams: teams.join(',') } }),
        historicalAPI.getStatus(),
      ]);
      if (!current()) return;
      setState((s) => ({
        ...s,
        teamStats: teamStats.status === 'fulfilled' ? teamStats.value.data : null,
        historyStatus: historyStatus.status === 'fulfilled' ? historyStatus.value.data : null,
      }));

      if (!players?.length) return;
      setNews((n) => ({ ...n, loading: true, error: null }));
      const payload = toHistoryPayload(players);
      const [missing, bumps] = await Promise.allSettled([
        historicalAPI.getMissingPlayers(payload),
        historicalAPI.getUsageBumps(payload),
      ]);
      if (!current()) return;
      setNews({
        loading: false,
        error: missing.status === 'rejected' && bumps.status === 'rejected' ? errorMessage(missing.reason) : null,
        missing: missing.status === 'fulfilled' ? missing.value.data.report || [] : [],
        bumps: bumps.status === 'fulfilled' ? bumps.value.data.usageBumps || [] : [],
      });
    } catch (err) {
      if (!current()) return;
      setState((s) => ({ ...s, status: 'error', error: errorMessage(err) }));
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  /** Re-import a slate from RotoWire (existing sync endpoint), then reload. */
  const syncSlate = useCallback(
    async ({ slateId, name }) => {
      setSyncing(true);
      setSyncError(null);
      try {
        await playersAPI.syncFromRotoWire(slateId, { name });
        await load({ quiet: true });
        return true;
      } catch (err) {
        setSyncError(errorMessage(err));
        return false;
      } finally {
        setSyncing(false);
      }
    },
    [load],
  );

  const refresh = useCallback(() => {
    const { slate } = state;
    if (!slate) return Promise.resolve(false);
    return syncSlate({ slateId: slate.slate_id, name: slate.name });
  }, [state, syncSlate]);

  return { ...state, news, syncing, syncError, reload: load, syncSlate, refresh };
}
