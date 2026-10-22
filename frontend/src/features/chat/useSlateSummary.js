import { useEffect, useMemo, useState } from 'react';
import { playersAPI } from '../../services/api';
import { buildGames, summarizeSlate } from '../../pages/home/slateDashboard';

/** Slate players for the chat (cards resolve against them, @mention autocomplete), headshot lookup, games (with Vegas lines), game count and first lock. */
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
    const games = buildGames(players);
    const { gameCount, firstLock } = summarizeSlate(players, games);
    return { players, headshots, games, gameCount, firstLock, loading };
  }, [players, loading]);
}
