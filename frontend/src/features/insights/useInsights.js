import { useCallback, useEffect, useRef, useState } from 'react';
import { historicalAPI, playersAPI } from '../../services/api';
import { toHistoryPayload } from '../../pages/home/slateDashboard';
import { windowParams } from './insights';

const errorMessage = (err) => err?.response?.data?.error || err?.message || 'Request failed';

const IDLE = { status: 'idle', data: null, error: null };
// Keep the previous rows while reloading so cards don't flash empty
const loading = (prev) => ({ status: 'loading', data: prev?.data ?? null, error: null });
const ready = (data) => ({ status: 'ready', data, error: null });
const failed = (err) => ({ status: 'error', data: null, error: errorMessage(err) });

// Tonight's-slate cards: one POST each with the trimmed slate payload
const SLATE_REQUESTS = [
  { key: 'slate', empty: null, call: (players, p) => historicalAPI.getSlateInsights(players, p), pick: (d) => d?.insights ?? null },
  { key: 'usageBumps', empty: [], call: (players, p) => historicalAPI.getUsageBumps(players, 8, 25, p), pick: (d) => d?.usageBumps ?? [] },
  { key: 'missing', empty: [], call: (players, p) => historicalAPI.getMissingPlayers(players, 5, 20, p), pick: (d) => d?.report ?? [] },
];

// League-wide cards (Trends tab)
const LEAGUE_REQUESTS = [
  { key: 'hotStreaks', call: (p) => historicalAPI.getHotStreaks(15, 5, p), pick: (d) => d?.hotStreaks ?? [] },
  { key: 'coldStreaks', call: (p) => historicalAPI.getColdStreaks(15, 5, p), pick: (d) => d?.coldStreaks ?? [] },
  { key: 'consistencyLeaders', call: (p) => historicalAPI.getConsistencyLeaders(15, 8, p), pick: (d) => d?.leaders ?? [] },
  { key: 'boomBustPlayers', call: (p) => historicalAPI.getBoomBustPlayers(15, 8, p), pick: (d) => d?.players ?? [] },
];

const allSections = (requests, value) => Object.fromEntries(requests.map((r) => [r.key, value]));

/**
 * Data for the Insights page. Every card loads (and fails) on its own:
 *   summary      GET /historical/summary for the window
 *   slate cards  players for slateId, then slate-insights / usage-bumps /
 *                missing-players in parallel
 *   league       the four league-wide cards, only once `leagueEnabled` is set,
 *                cached per site + window
 * Each section is { status: 'idle' | 'loading' | 'ready' | 'error', data, error }.
 * `site` is the DFS site key used for fantasy points; `dateWindow` is the filters'
 * date window (see insights.js).
 */
export default function useInsights({ slateId, site, dateWindow, leagueEnabled = false }) {
  const [summary, setSummary] = useState(IDLE);
  const [slateCards, setSlateCards] = useState(() => allSections(SLATE_REQUESTS, IDLE));
  const [playerCount, setPlayerCount] = useState(null);
  const [league, setLeague] = useState(() => allSections(LEAGUE_REQUESTS, IDLE));
  const [reloadToken, setReloadToken] = useState(0);
  const leagueLoadedFor = useRef(null);

  // Serialized so a new-but-equal window object doesn't refetch
  const windowJson = JSON.stringify(windowParams(dateWindow));

  useEffect(() => {
    let cancelled = false;
    setSummary(loading);
    historicalAPI.getSummary(JSON.parse(windowJson)).then(
      (res) => !cancelled && setSummary(ready(res.data?.summary ?? null)),
      (err) => !cancelled && setSummary(failed(err)),
    );
    return () => {
      cancelled = true;
    };
  }, [windowJson, reloadToken]);

  useEffect(() => {
    let cancelled = false;
    if (!slateId) {
      setSlateCards(allSections(SLATE_REQUESTS, IDLE));
      setPlayerCount(null);
      return undefined;
    }
    const setCard = (key, value) => !cancelled && setSlateCards((s) => ({ ...s, [key]: value }));
    setSlateCards((s) => Object.fromEntries(SLATE_REQUESTS.map((r) => [r.key, loading(s[r.key])])));

    playersAPI.getBySlateId(slateId).then(
      (res) => {
        if (cancelled) return;
        const players = res.data || [];
        setPlayerCount(players.length);
        if (!players.length) {
          setSlateCards(Object.fromEntries(SLATE_REQUESTS.map((r) => [r.key, ready(r.empty)])));
          return;
        }
        const payload = toHistoryPayload(players);
        // slateId lets the backend fall back to the slate's site
        const params = { ...JSON.parse(windowJson), site, slateId };
        for (const r of SLATE_REQUESTS) {
          r.call(payload, params).then(
            (cardRes) => setCard(r.key, ready(r.pick(cardRes.data))),
            (err) => setCard(r.key, failed(err)),
          );
        }
      },
      (err) => {
        if (cancelled) return;
        setPlayerCount(null);
        setSlateCards(allSections(SLATE_REQUESTS, failed(err)));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [slateId, site, windowJson, reloadToken]);

  useEffect(() => {
    const cacheKey = `${site}|${windowJson}|${reloadToken}`;
    if (!leagueEnabled || leagueLoadedFor.current === cacheKey) return undefined;
    leagueLoadedFor.current = cacheKey;

    let cancelled = false;
    let pending = LEAGUE_REQUESTS.length;
    const params = { ...JSON.parse(windowJson), site };
    const setCard = (key, value) => {
      pending -= 1;
      if (!cancelled) setLeague((s) => ({ ...s, [key]: value }));
    };
    setLeague((s) => Object.fromEntries(LEAGUE_REQUESTS.map((r) => [r.key, loading(s[r.key])])));
    for (const r of LEAGUE_REQUESTS) {
      r.call(params).then(
        (res) => setCard(r.key, ready(r.pick(res.data))),
        (err) => setCard(r.key, failed(err)),
      );
    }
    return () => {
      cancelled = true;
      // Interrupted (tab closed, filters changed): fetch again next time
      if (pending > 0) leagueLoadedFor.current = null;
    };
  }, [leagueEnabled, site, windowJson, reloadToken]);

  const reload = useCallback(() => setReloadToken((t) => t + 1), []);

  return { summary, ...slateCards, playerCount, league, reload };
}
