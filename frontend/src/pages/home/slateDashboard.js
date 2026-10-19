/**
 * Pure data shaping for the slate dashboard (HomePage). Inputs are player rows
 * as returned by GET /players/:slateId (snake_case DB columns). No React here
 * so it can be unit tested with `node --test`.
 */

export const DK_POSITIONS = ['PG', 'SG', 'SF', 'PF', 'C'];
// Mirrors rotowireService.getBlowoutRisk: risk starts once a spread passes 10.
export const BLOWOUT_SPREAD = 10;
const MIN_MINUTES_FOR_VALUE = 15;

export function num(v) {
  const n = typeof v === 'string' ? parseFloat(v) : v;
  return Number.isFinite(n) ? n : null;
}

/** Non-zero number or null (RotoWire stores missing odds/ownership as 0). */
function nz(v) {
  const n = num(v);
  return n ? n : null;
}

export function parseRaw(player) {
  if (!player?.raw_data) return null;
  if (typeof player.raw_data === 'object') return player.raw_data;
  try {
    return JSON.parse(player.raw_data);
  } catch {
    return null;
  }
}

/**
 * DB timestamps: sqlite CURRENT_TIMESTAMP is UTC without a zone
 * ("2026-10-19 17:05:00"); azure returns ISO strings. Returns Date or null.
 */
export function parseTimestamp(value) {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const s = String(value);
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(s) ? `${s.replace(' ', 'T')}Z` : s;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Tip-off time from RotoWire raw data, when present. */
export function getGameStart(raw) {
  if (!raw) return null;
  const game = raw.game && typeof raw.game === 'object' ? raw.game : {};
  const candidates = [game.dateTime, game.startTime, game.gameTime, raw.gameTime, raw.game_time, raw.dateTime];
  for (const c of candidates) {
    if (!c) continue;
    const d = new Date(c);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return null;
}

/** True/false when RotoWire says whether the player's team is at home, else null. */
function getIsHome(raw) {
  if (!raw) return null;
  const v = raw.isHome ?? raw.home ?? raw.game?.isHome;
  if (typeof v === 'boolean') return v;
  if (v === 1 || v === '1' || v === 'true') return true;
  if (v === 0 || v === '0' || v === 'false') return false;
  return null;
}

/**
 * Normalize injury_status (string, or JSON-stringified object) into
 * { label, tone, note } or null when the player is healthy.
 */
export function parseInjury(status) {
  if (status == null) return null;
  let text = String(status).trim();
  let note = null;
  if (text.startsWith('{')) {
    try {
      const obj = JSON.parse(text);
      text = String(obj.status ?? obj.type ?? obj.designation ?? obj.short ?? '').trim();
      note = obj.note ?? obj.details ?? obj.description ?? obj.injury ?? null;
    } catch {
      // fall through with the raw text
    }
  }
  const key = text.toUpperCase();
  if (!key || ['NULL', 'ACTIVE', 'HEALTHY', 'NONE', '-'].includes(key)) return null;
  if (['O', 'OUT', 'INJ', 'OFS', 'SUSP'].includes(key)) return { label: 'OUT', tone: 'negative', note };
  if (['GTD', 'DTD', 'Q', 'QUES', 'QUESTIONABLE', 'D', 'DOUBTFUL'].includes(key)) {
    return { label: key.startsWith('D') && key !== 'DTD' ? 'DOUBT' : 'GTD', tone: 'caution', note };
  }
  if (['P', 'PROB', 'PROBABLE'].includes(key)) return { label: 'PROB', tone: 'info', note };
  return { label: text, tone: 'neutral', note };
}

export function positionsOf(player) {
  return String(player?.position || '')
    .split(/[,/]/)
    .map((p) => p.trim())
    .filter(Boolean);
}

/** Projected DK points per $1K. */
export function valuePerK(player) {
  const salary = num(player?.salary);
  const proj = num(player?.projected_points);
  if (!salary || proj == null) return null;
  return (proj / salary) * 1000;
}

export function gameKey(team, opponent) {
  return [team, opponent].filter(Boolean).sort().join('-');
}

/**
 * Group players into games. Returns cards sorted by Vegas total (desc), with
 * per-team implied totals, spread, pace and a blowout flag.
 * `teamStats` = response of GET /dashboard/team-stats ({ teams, leagueAvgPace }).
 */
export function buildGames(players, teamStats = null) {
  const games = new Map();

  for (const p of players || []) {
    if (!p.team || !p.opponent) continue;
    const key = gameKey(p.team, p.opponent);
    if (!games.has(key)) games.set(key, { key, teams: {}, total: null, start: null, playerCount: 0 });
    const g = games.get(key);
    g.playerCount += 1;

    const raw = parseRaw(p);
    const t = (g.teams[p.team] ??= { team: p.team, impliedTotal: null, spread: null, isHome: null, players: 0 });
    t.players += 1;
    t.impliedTotal ??= nz(p.vegas_implied_total);
    t.spread ??= nz(p.vegas_spread);
    t.isHome ??= getIsHome(raw);
    g.total ??= nz(p.vegas_over_under);

    const start = getGameStart(raw);
    if (start && (!g.start || start < g.start)) g.start = start;
  }

  const leagueAvgPace = num(teamStats?.leagueAvgPace);

  return [...games.values()]
    .map((g) => {
      let [a, b] = Object.values(g.teams);
      // A team with no slate players (e.g. everyone filtered out) still shows by name.
      if (!b) {
        const other = g.key.split('-').find((t) => t !== a.team);
        b = { team: other, impliedTotal: null, spread: a.spread != null ? -a.spread : null, isHome: null, players: 0 };
      }
      // Order away @ home when known, otherwise alphabetical (stable key order).
      if (a.isHome === true || b.isHome === false) [a, b] = [b, a];
      const hasHomeAway = a.isHome != null || b.isHome != null;

      // Fill one side's line from the other when only one is present.
      if (a.spread == null && b.spread != null) a.spread = -b.spread;
      if (b.spread == null && a.spread != null) b.spread = -a.spread;
      if (g.total != null) {
        if (a.impliedTotal == null && b.impliedTotal != null) a.impliedTotal = g.total - b.impliedTotal;
        if (b.impliedTotal == null && a.impliedTotal != null) b.impliedTotal = g.total - a.impliedTotal;
      }
      const total = g.total ?? (a.impliedTotal != null && b.impliedTotal != null ? a.impliedTotal + b.impliedTotal : null);

      const paces = [a, b].map((t) => num(teamStats?.teams?.[t.team]?.pace)).filter((p) => p != null);
      const pace = paces.length === 2 ? (paces[0] + paces[1]) / 2 : null;

      const absSpread = a.spread != null ? Math.abs(a.spread) : null;
      const favorite = a.spread != null && a.spread !== 0 ? (a.spread < 0 ? a.team : b.team) : null;

      return {
        key: g.key,
        away: a,
        home: b,
        hasHomeAway,
        start: g.start,
        total,
        spread: absSpread,
        favorite,
        pace,
        paceDelta: pace != null && leagueAvgPace != null ? pace - leagueAvgPace : null,
        blowout: absSpread != null && absSpread >= BLOWOUT_SPREAD,
        playerCount: g.playerCount,
      };
    })
    .sort((x, y) => (y.total ?? -Infinity) - (x.total ?? -Infinity) || x.key.localeCompare(y.key));
}

function isPlayable(p) {
  return parseInjury(p.injury_status)?.label !== 'OUT' && (num(p.projected_points) ?? 0) > 0;
}

/** Top `n` players by pts/$1K at each DK position (multi-eligible players can appear twice). */
export function topValuesByPosition(players, n = 3, positions = DK_POSITIONS) {
  const pool = (players || [])
    .filter((p) => isPlayable(p) && (num(p.projected_minutes) ?? 0) >= MIN_MINUTES_FOR_VALUE)
    .map((p) => ({ ...p, valuePerK: valuePerK(p) }))
    .filter((p) => p.valuePerK != null)
    .sort((a, b) => b.valuePerK - a.valuePerK);

  return Object.fromEntries(positions.map((pos) => [pos, pool.filter((p) => positionsOf(p).includes(pos)).slice(0, n)]));
}

/**
 * GPP leverage: leverage_score desc (boom% / (own% + 1), see rotowireService).
 * Players without an ownership projection are skipped: the backend treats
 * missing ownership as 1%, which would float them all to the top.
 */
export function topLeverage(players, n = 8) {
  return (players || [])
    .filter((p) => isPlayable(p) && (num(p.leverage_score) ?? 0) > 0 && (num(p.rostership) ?? 0) > 0)
    .sort((a, b) => num(b.leverage_score) - num(a.leverage_score))
    .slice(0, n);
}

/** Chalk: highest projected ownership. */
export function topChalk(players, n = 8) {
  return (players || [])
    .filter((p) => isPlayable(p) && (num(p.rostership) ?? 0) > 0)
    .sort((a, b) => num(b.rostership) - num(a.rostership))
    .slice(0, n);
}

function normName(name) {
  return String(name || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z ]/g, '')
    .replace(/\s+(jr|sr|ii|iii|iv)$/, '')
    .trim();
}

/**
 * Injury/news feed. Combines:
 *   - slate players carrying an injury tag (GTD/Q/PROB...)
 *   - high-usage players missing from the slate (missing-players report: likely OUT)
 * and attaches teammates whose historical DK output rises without that player
 * (usage-bumps endpoint, keyed by `missingPlayer`).
 */
export function buildInjuryFeed(players, missingReport = [], usageBumps = []) {
  const bumpsByMissing = new Map();
  for (const b of usageBumps || []) {
    const k = normName(b.missingPlayer);
    if (!bumpsByMissing.has(k)) bumpsByMissing.set(k, []);
    bumpsByMissing.get(k).push(b);
  }
  for (const list of bumpsByMissing.values()) list.sort((a, b) => (b.dkBump ?? 0) - (a.dkBump ?? 0));
  const beneficiariesFor = (name) => bumpsByMissing.get(normName(name)) ?? [];

  const items = [];
  const seen = new Set();

  for (const team of missingReport || []) {
    for (const m of team.missingPlayers || []) {
      const k = normName(m.name);
      if (seen.has(k)) continue;
      seen.add(k);
      items.push({
        id: `missing:${team.team}:${m.name}`,
        name: m.name,
        team: team.team,
        status: { label: 'OUT', tone: 'negative', note: 'Not in tonight’s player pool' },
        detail: m.avgDk != null ? `${Number(m.avgDk).toFixed(1)} DK pts · ${Number(m.avgMin ?? 0).toFixed(0)} min avg` : null,
        weight: num(m.avgDk) ?? 0,
        beneficiaries: beneficiariesFor(m.name),
      });
    }
  }

  for (const p of players || []) {
    const status = parseInjury(p.injury_status);
    if (!status) continue;
    const k = normName(p.name);
    if (seen.has(k)) continue;
    seen.add(k);
    const proj = num(p.projected_points);
    items.push({
      id: `slate:${p.player_id ?? p.id ?? p.name}`,
      name: p.name,
      team: p.team,
      status,
      detail: proj != null ? `${proj.toFixed(1)} proj · $${(num(p.salary) ?? 0).toLocaleString()}` : null,
      weight: proj ?? 0,
      beneficiaries: beneficiariesFor(p.name),
    });
  }

  const rank = { OUT: 0, DOUBT: 1, GTD: 2, PROB: 3 };
  return items.sort((a, b) => (rank[a.status.label] ?? 4) - (rank[b.status.label] ?? 4) || b.weight - a.weight);
}

/** Minimal player payload for the historical usage endpoints. */
export function toHistoryPayload(players) {
  return (players || []).map((p) => ({
    name: p.name,
    team: p.team,
    opponent: p.opponent,
    position: p.position,
    salary: p.salary,
    projected_points: p.projected_points,
    projected_minutes: p.projected_minutes,
  }));
}

export function summarizeSlate(players, games) {
  const totals = games.map((g) => g.total).filter((t) => t != null);
  const starts = games.map((g) => g.start).filter(Boolean);
  return {
    playerCount: (players || []).length,
    gameCount: games.length,
    avgTotal: totals.length ? totals.reduce((s, t) => s + t, 0) / totals.length : null,
    firstLock: starts.length ? new Date(Math.min(...starts.map((d) => d.getTime()))) : null,
  };
}

export function formatRelative(date, now = new Date()) {
  if (!date) return '—';
  const mins = Math.round((now.getTime() - date.getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 48) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

export function formatTipoff(date) {
  if (!date) return 'TBD';
  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export function formatSpread(spread) {
  if (spread == null) return '—';
  return spread > 0 ? `+${spread}` : `${spread}`;
}
