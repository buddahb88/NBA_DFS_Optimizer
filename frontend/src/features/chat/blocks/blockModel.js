// Pure helpers for chat ui_block rendering.
//
// Blocks follow the backend schema (backend/src/services/chatTools/uiBlocks.js,
// version 1): { version, type, id, tool?, title?, note?, ...payload } with
// snake_case payloads. The stream sends `event: ui_block` with
// { messageId, block }; live and saved assistant messages carry them as
// message.uiBlocks.

const ENVELOPE = new Set(['version', 'id', 'tool', 'type', 'title', 'note']);

/** Backend block (or { block } event payload) -> { id, type, title, note, data }, or null. */
export function normalizeBlock(raw, index = 0) {
  const b = raw && typeof raw === 'object' && raw.block && typeof raw.block === 'object' ? raw.block : raw;
  if (!b || typeof b !== 'object' || typeof b.type !== 'string' || !b.type) return null;
  const data = Object.fromEntries(Object.entries(b).filter(([k]) => !ENVELOPE.has(k)));
  return { id: b.id != null ? String(b.id) : `${b.type}-${index}`, type: b.type, title: b.title, note: b.note, data };
}

export const normalizeBlocks = (list) => (Array.isArray(list) ? list : []).map((b, i) => normalizeBlock(b, i)).filter(Boolean);

/** Blocks on a live or saved assistant message (message.uiBlocks). */
export const blocksFromMessage = (message) => normalizeBlocks(message?.uiBlocks);

// ── Players ─────────────────────────────────────────────────────────────────

const SUFFIX = /\s+(jr|sr|ii|iii|iv|v)$/;

/** Accent/punctuation/suffix-free name, like the backend player_key. */
export function nameKey(name) {
  return String(name ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/-/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(SUFFIX, '');
}

/** Slate player for a block reference ({ id?, playerId?, name? }), or null. */
export function resolveSlatePlayer(slatePlayers, ref) {
  if (!ref || !slatePlayers?.length) return null;
  if (ref.id != null) {
    const hit = slatePlayers.find((p) => String(p.id) === String(ref.id));
    if (hit) return hit;
  }
  const pid = ref.playerId ?? ref.player_id;
  if (pid != null) {
    const hit = slatePlayers.find((p) => String(p.player_id) === String(pid));
    if (hit) return hit;
  }
  const key = nameKey(ref.name);
  if (!key) return null;
  return slatePlayers.find((p) => nameKey(p.name) === key) ?? null;
}

const BASE_POSITIONS = ['PG', 'SG', 'SF', 'PF', 'C'];

/** "PG,G,UTIL" / "SF/PF" -> "PG" / "SF/PF" (site flex slots dropped). */
export function displayPosition(position) {
  if (!position) return null;
  const parts = String(position).split(/[,/]/).map((p) => p.trim().toUpperCase());
  const base = BASE_POSITIONS.filter((p) => parts.includes(p));
  return base.length ? base.join('/') : String(position);
}

const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const first = (...values) => values.find((v) => v !== undefined && v !== null);

export function valuePer1k(points, salary) {
  const p = num(points);
  const s = num(salary);
  if (p === null || !s) return null;
  return Math.round((p / (s / 1000)) * 100) / 100;
}

export const TONE_TEXT = { positive: 'text-positive', negative: 'text-negative', neutral: 'text-fg' };

// Same cut-off the backend uses for "values mostly shrunk to 0"
export const LOW_SAMPLE_GAMES = 10;

/** /archetypes deep link that opens the defense cell drill-down. */
export function drilldownPath({ season, grouping = 'archetype', team, group }) {
  if (!team || !group) return null;
  const params = new URLSearchParams({ grouping, team, group });
  if (season) params.set('season', season);
  return `/archetypes?${params}`;
}

/** Text tone for an edge in fantasy points. */
export const edgeTone = (edge) => (edge == null ? 'neutral' : edge >= 1.5 ? 'positive' : edge <= -1.5 ? 'negative' : 'neutral');

const signed = (v, digits = 1) => (v > 0 ? `+${v.toFixed(digits)}` : v.toFixed(digits));
const pct = (v) => (v == null ? null : `${Math.round(v * 100)}%`);

/** Card fields for a block player row (uiBlocks.js playerRow / playerRef). */
function baseCard(r) {
  const stats = r.stats ?? null;
  return {
    name: r.name ?? '',
    playerKey: r.player_key ?? null,
    team: r.team ?? null,
    opponent: r.opponent ?? null,
    position: displayPosition(r.position),
    salary: num(r.salary),
    projection: num(r.projection),
    headshot: r.headshot ?? null,
    archetype: r.archetype ?? null,
    archetypeLabel: first(r.archetype_label, r.archetype ? r.archetype.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) : null),
    matchupEdge: num(r.matchup_edge),
    adjustedEdge: num(r.adjusted_edge),
    minutes: num(first(r.projected_minutes, stats?.minutes_pg)),
    lastSeasonMinutes: num(r.last_season_minutes),
    ownership: num(r.ownership),
    flags: Array.isArray(r.flags) ? r.flags : [],
    injuryStatus: r.injury_status ?? null,
    note: statsNote(stats),
  };
}

// One line of role numbers for profile / missing-player rows
function statsNote(stats) {
  if (!stats) return null;
  const parts = [
    stats.usg_pct != null && `USG ${pct(stats.usg_pct)}`,
    stats.dk_avg != null && `${stats.dk_avg} DK avg`,
    stats.avg_dk != null && `${stats.avg_dk} DK avg`,
    stats.avg_minutes != null && `${stats.avg_minutes} min`,
    stats.games != null && `${stats.games} games`,
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : null;
}

const CARD_MAPPERS = {
  player_list: (r) => baseCard(r),
  usage_bumps: (b) => {
    const gain = b.avg_without != null && b.avg_with != null ? b.avg_without - b.avg_with : null;
    return {
      ...baseCard(b.player ?? {}),
      projection: num(first(b.bumped_projection, b.player?.projection)),
      minutes: num(b.minutes_without),
      lastSeasonMinutes: num(b.minutes_with),
      minutesLabel: 'without / with',
      note: `${gain != null ? `${signed(gain)} FP` : 'Bump'} without ${b.missing_player}${b.confidence ? ` (${b.confidence} confidence)` : ''}`,
    };
  },
  streaks: (r) => {
    const card = baseCard(r);
    let note = null;
    if (r.last3_avg != null) note = `Last 3: ${r.last3_avg} vs ${r.season_avg} season`;
    else if (r.consistency_score != null) note = `Consistency ${r.consistency_score} · ${r.season_avg} avg (${r.floor}-${r.ceiling})`;
    else if (r.boom_rate != null) note = `Boom ${r.boom_rate}% · bust ${r.bust_rate}% · ${r.season_avg} avg`;
    return { ...card, note };
  },
};

/** Block data -> uniform card players. */
export function cardPlayers(type, data) {
  const rows = type === 'usage_bumps' ? data?.bumps : data?.players;
  const map = CARD_MAPPERS[type] ?? CARD_MAPPERS.player_list;
  return (Array.isArray(rows) ? rows : []).filter(Boolean).map(map);
}

const HEALTHY = new Set(['', 'active', 'healthy', 'available']);

/** Flag badges: [{ key, label, tone, tip }]. */
export function playerFlags(p) {
  const minutesTip = p.minutes != null && p.lastSeasonMinutes != null
    ? `${p.minutes} min vs ${p.lastSeasonMinutes} last season (${signed(p.minutes - p.lastSeasonMinutes)}).`
    : 'Minutes are trending away from last season.';
  const out = [];
  for (const flag of p.flags ?? []) {
    if (flag === 'role_down') out.push({ key: flag, label: 'Role ↓', tone: 'negative', tip: `Smaller role: ${minutesTip}` });
    else if (flag === 'role_up') out.push({ key: flag, label: 'Role ↑', tone: 'positive', tip: `Bigger role: ${minutesTip}` });
    else if (flag === 'new_team') out.push({ key: flag, label: 'New team', tone: 'info', tip: 'On a new team this season; role is uncertain.' });
    else if (flag === 'crowded') out.push({ key: flag, label: 'Crowded', tone: 'caution', tip: 'Teammates share this archetype matchup.' });
    else if (flag === 'no_history') out.push({ key: flag, label: 'No history', tone: 'neutral', tip: 'No last-season profile to compare against.' });
    else if (flag === 'missing') out.push({ key: flag, label: 'Missing', tone: 'negative', tip: 'A regular who is not on this slate.' });
  }
  const status = String(p.injuryStatus ?? '').trim();
  if (!HEALTHY.has(status.toLowerCase())) {
    const serious = /^(o|out|d|doubtful|q|questionable|gtd)$/i.test(status);
    out.push({ key: 'injury', label: status, tone: serious ? 'negative' : 'caution', tip: `Injury status: ${status}` });
  }
  return out;
}

// ── Lineups ─────────────────────────────────────────────────────────────────

/**
 * Lineup block slots -> [{ slot, player, onSlate }], each player the slate row when
 * it resolves (so saves carry the DB id) or a stand-in built from the block.
 */
export function lineupEntries(data, slatePlayers) {
  const slots = Array.isArray(data?.slots) ? data.slots : [];
  return slots.filter(Boolean).map(({ slot, player: ref }) => {
    const hit = ref ? resolveSlatePlayer(slatePlayers, ref) : null;
    const player = hit ?? {
      name: ref?.name ?? '',
      team: ref?.team ?? null,
      salary: num(ref?.salary),
      projected_points: num(ref?.projection),
      rostership: num(ref?.ownership),
    };
    return { slot: slot ?? '', player, onSlate: !!hit };
  });
}

/** Router state for /optimizer?mode=manual: what the manual builder needs to refill the slots. */
export function optimizerHandoff(entries) {
  return {
    slots: entries.map(({ slot, player }) => ({ slot, id: player.id ?? null, playerId: player.player_id ?? null, name: player.name })),
  };
}
