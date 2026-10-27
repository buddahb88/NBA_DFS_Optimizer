import { useEffect, useState } from 'react';
import { opportunityAPI } from '../../services/api';

const errorMessage = (err) => err?.response?.data?.error || err?.message || 'Request failed';

/**
 * GET /opportunity/radar for the slate selector's slate (live, or a
 * backtest's saved night via slateDate) and mode. Only fetches while
 * `enabled` (the tab is open) and a slate is known; keeps the previous rows
 * while reloading. Returns { status: 'idle' | 'loading' | 'ready' | 'error', data, error }.
 */
export default function useOpportunityRadar({ slateId, slateDate = null, site, mode, enabled = true, reloadToken = 0 }) {
  const [state, setState] = useState({ status: 'idle', data: null, error: null });

  useEffect(() => {
    if (!enabled || !slateId) {
      setState({ status: 'idle', data: null, error: null });
      return undefined;
    }
    let cancelled = false;
    setState((s) => ({ status: 'loading', data: s.data, error: null }));
    const params = { slateId, site, mode, ...(slateDate ? { slateDate } : {}) };
    opportunityAPI.getRadar(params).then(
      (res) => !cancelled && setState({ status: 'ready', data: res.data, error: null }),
      (err) => !cancelled && setState({ status: 'error', data: null, error: errorMessage(err) }),
    );
    return () => {
      cancelled = true;
    };
  }, [slateId, slateDate, site, mode, enabled, reloadToken]);

  return state;
}
