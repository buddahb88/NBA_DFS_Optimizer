import { useEffect, useMemo, useState } from 'react';
import { playersAPI } from '../../services/api';
import { buildGames, summarizeSlate } from '../../pages/home/slateDashboard';

/** Slate players for the chat: headshot lookup plus game count and first lock for the context bar. */
export default function useSlateSummary(slateId) {
  const [players, setPlayers] = useState([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setPlayers([]);
    if (!slateId) return undefined;
    setLoading(true);
    playersAPI
      .getBySlateId(slateId)
      .then((res) => {
        if (!cancelled) setPlayers(Array.isArray(res.data) ? res.data : []);
      })
      .catch((err) => console.error('Failed to load slate players:', err))
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [slateId]);

  return useMemo(() => {
    const headshots = {};
    for (const p of players) if (p.headshot) headshots[p.name] = p.headshot;
    const { gameCount, firstLock } = summarizeSlate(players, buildGames(players));
    return { headshots, gameCount, firstLock, loading };
  }, [players, loading]);
}
