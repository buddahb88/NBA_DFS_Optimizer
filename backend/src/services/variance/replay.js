/**
 * No-lookahead replay helpers for calibrating outcome ranges on past games.
 *
 * Each case sees only games strictly before its game date, the same way a live
 * slate only sees box scores from before tip-off.
 */

import { GAME_WINDOW, summarizeGameLog } from './outcomeDistribution.js';

const RECENT_MINUTES_GAMES = 5;

/**
 * Build replay cases from game rows ({ player_key, game_date, minutes, fp, ... }).
 * The naive projection is recent minutes (last 5 played) x prior-window FPPM.
 * @returns {{ player_key, game_date, actual, projection, minutes, priorGames }[]}
 *   priorGames are most recent first, at most `window` long.
 */
export function replayCases(games, { window = GAME_WINDOW, minPriorGames = 10, from = null, to = null } = {}) {
  const byPlayer = new Map();
  for (const g of games) {
    if (!(Number(g.minutes) > 0)) continue;
    let list = byPlayer.get(g.player_key);
    if (!list) byPlayer.set(g.player_key, (list = []));
    list.push(g);
  }

  const cases = [];
  for (const list of byPlayer.values()) {
    list.sort((a, b) => (a.game_date < b.game_date ? -1 : a.game_date > b.game_date ? 1 : 0));
    let firstSameDate = 0;
    for (let i = 0; i < list.length; i++) {
      const g = list[i];
      if (i > 0 && list[i - 1].game_date !== g.game_date) firstSameDate = i;
      if ((from && g.game_date < from) || (to && g.game_date > to)) continue;
      // Strictly earlier dates only
      const available = firstSameDate;
      if (available < minPriorGames) continue;
      const priorGames = list.slice(Math.max(0, available - window), available).reverse();
      const summary = summarizeGameLog(priorGames);
      const recent = priorGames.slice(0, RECENT_MINUTES_GAMES);
      const minutes = recent.reduce((s, p) => s + Number(p.minutes), 0) / recent.length;
      const fppm = summary.fppm ?? priorGames.reduce((s, p) => s + Number(p.fp), 0) / priorGames.reduce((s, p) => s + Number(p.minutes), 0);
      cases.push({ ...g, actual: Number(g.fp), projection: minutes * fppm, minutes, priorGames });
    }
  }
  return cases;
}

/** Share of actual scores below floor / above ceiling. */
export function coverage(rows) {
  const n = rows.length;
  const below = rows.filter((r) => r.actual < r.floor).length;
  const above = rows.filter((r) => r.actual > r.ceiling).length;
  const pct = (k) => (n ? Math.round((1000 * k) / n) / 10 : 0);
  return { n, below, above, belowPct: pct(below), abovePct: pct(above) };
}

/**
 * The pre-fix calculation, for comparison: projection +/- the population SD of the
 * rolling averages RotoWire supplies (last 3/5/7/season), 15% of projection when
 * fewer than three are available.
 */
export function legacyRange(projection, averages) {
  const vals = averages.filter((v) => v > 0);
  let sd = projection * 0.15;
  if (vals.length >= 3) {
    const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
    sd = Math.sqrt(vals.reduce((s, v) => s + (v - mean) ** 2, 0) / vals.length);
  }
  return { floor: Math.max(0, projection - sd), ceiling: projection + sd, stdDev: sd };
}
