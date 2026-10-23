import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { sitesAPI, slatesAPI } from '../services/api';
import { readStoredSelection, resolveSite, resolveSlateId, writeStoredSelection } from './slateSelection';
import { findBacktest, settingsKeyFor, slateRequestParams } from '../features/slate/backtest';

const SlateContext = createContext(null);

/**
 * App-wide DFS site + slate selection, driven by the top bar.
 * Sites come from GET /api/sites, slates from GET /api/slates?site=<site>.
 * The selection is persisted to localStorage.
 *
 * Exposes:
 *   site, siteConfig, sites   selected site key, its rules, all sites (array)
 *   slate, slateId, slates    selected slate row, its id, the site's slates
 *   setSite(key), setSlateId(id)
 *   refreshSlates(preferId?)  reload the site's slates, optionally selecting preferId
 *   loadingSlates, error
 *
 * Backtest mode (Lineup Studio, Archetypes Tonight, chat): rebuild a saved
 * past slate while the live one stays selected. Not persisted, so a reload
 * is always Live.
 *   backtests                 saved past slates of the site (GET /api/slates/backtests)
 *   backtest, isBacktest      the selected one ({ slateDate, slateId, site, players }) or null
 *   setBacktestDate(date|null)
 *   rangeMode, setRangeMode   'model' | 'original' floor / ceiling for a backtest
 *   workSlateId               the slate requests go to: the backtest's, else slateId
 *   slateParams               { slateDate, ranges } to add to slate requests in a backtest, else {}
 *   settingsKey               player-settings key (a backtest never uses the live slate's)
 */
export function SlateProvider({ children }) {
  const [stored] = useState(readStoredSelection);
  const [sitesByKey, setSitesByKey] = useState(null);
  const [site, setSiteState] = useState(stored.site || resolveSite(null));
  const [slates, setSlates] = useState([]);
  const [slateId, setSlateIdState] = useState(stored.slateId);
  const [loadingSlates, setLoadingSlates] = useState(true);
  const [error, setError] = useState(null);
  const requestRef = useRef(0);
  const [backtests, setBacktests] = useState([]);
  const [backtestDate, setBacktestDateState] = useState(null);
  const [rangeMode, setRangeMode] = useState('model');

  useEffect(() => {
    let cancelled = false;
    // .then() so a client without getBacktests (older mocks) just lists none
    Promise.resolve()
      .then(() => slatesAPI.getBacktests(site))
      .then((res) => !cancelled && setBacktests(Array.isArray(res?.data) ? res.data : []))
      .catch(() => !cancelled && setBacktests([]));
    return () => {
      cancelled = true;
    };
  }, [site]);

  useEffect(() => {
    let cancelled = false;
    sitesAPI
      .getAll()
      .then((res) => {
        if (cancelled) return;
        setSitesByKey(res.data);
        setSiteState((s) => resolveSite(res.data, s));
      })
      .catch((err) => {
        console.error('Error loading sites:', err);
        if (!cancelled) setError('Could not load DFS sites');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const refreshSlates = useCallback(
    async (preferId) => {
      // Drop responses from requests superseded by a later site switch/refresh
      const request = ++requestRef.current;
      setLoadingSlates(true);
      try {
        const res = await slatesAPI.getAll(site);
        if (request !== requestRef.current) return;
        setSlates(res.data);
        setSlateIdState((current) => resolveSlateId(res.data, preferId ?? current));
        setError(null);
      } catch (err) {
        if (request !== requestRef.current) return;
        console.error('Error loading slates:', err);
        setError('Could not load slates');
      } finally {
        if (request === requestRef.current) setLoadingSlates(false);
      }
    },
    [site],
  );

  useEffect(() => {
    refreshSlates();
  }, [refreshSlates]);

  useEffect(() => {
    writeStoredSelection({ site, slateId });
  }, [site, slateId]);

  const setSite = useCallback(
    (key) => {
      if (key === site) return;
      setSlates([]);
      setSlateIdState(null);
      setBacktestDateState(null);
      setSiteState(key);
    },
    [site],
  );

  const setSlateId = useCallback((id) => setSlateIdState(id == null ? null : String(id)), []);
  const setBacktestDate = useCallback((date) => setBacktestDateState(date || null), []);

  const value = useMemo(() => {
    const slate = slates.find((s) => String(s.slate_id) === slateId) || null;
    const liveSlateId = slate ? slateId : null;
    const backtest = findBacktest(backtests, backtestDate);
    return {
      backtests,
      backtest,
      isBacktest: !!backtest,
      setBacktestDate,
      rangeMode,
      setRangeMode,
      workSlateId: backtest ? backtest.slateId : liveSlateId,
      slateParams: slateRequestParams(backtest, rangeMode),
      settingsKey: settingsKeyFor(liveSlateId, backtest),
      site,
      siteConfig: sitesByKey?.[site] || null,
      sites: sitesByKey ? Object.values(sitesByKey) : [],
      slate,
      slateId: slate ? slateId : null,
      slates,
      setSite,
      setSlateId,
      refreshSlates,
      loadingSlates,
      error,
    };
  }, [site, sitesByKey, slates, slateId, setSite, setSlateId, refreshSlates, loadingSlates, error,
    backtests, backtestDate, setBacktestDate, rangeMode]);

  return <SlateContext.Provider value={value}>{children}</SlateContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components -- hook lives beside its provider
export function useSlate() {
  const ctx = useContext(SlateContext);
  if (!ctx) throw new Error('useSlate must be used inside <SlateProvider>');
  return ctx;
}
