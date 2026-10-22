// @player mentions: autocomplete from the slate's players, sent as plain names.

const fold = (s) =>
  String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();

/**
 * Approximate history-table player_key (backend utils/playerKey.js) without its alias table:
 * no accents, punctuation or Jr./Sr./II-V suffixes.
 */
export function mentionKey(name) {
  return fold(name)
    .replace(/['’`.]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((t) => t && !['jr', 'sr', 'ii', 'iii', 'iv', 'v'].includes(t))
    .join(' ');
}

/** The "@query" being typed just before the caret, or null. Queries may contain spaces ("@luka don"). */
export function findMentionQuery(text, caret = text.length) {
  const m = /(?:^|\s)@([^@\n]{0,30})$/.exec(text.slice(0, caret));
  if (!m) return null;
  return { start: caret - m[1].length - 1, query: m[1] };
}

/** Slate players whose name matches the query; names starting with it (or with a word starting with it) first. */
export function filterPlayers(players, query, limit = 8) {
  const q = fold(query).trim();
  const seen = new Set();
  const scored = [];
  for (const p of players || []) {
    if (!p?.name || seen.has(p.name)) continue;
    const name = fold(p.name);
    let score;
    if (!q || name.startsWith(q)) score = 0;
    else if (name.split(/\s+/).some((w) => w.startsWith(q))) score = 1;
    else if (name.includes(q)) score = 2;
    else continue;
    seen.add(p.name);
    scored.push({ p, score });
  }
  scored.sort((a, b) => a.score - b.score || (Number(b.p.salary) || 0) - (Number(a.p.salary) || 0));
  return scored.slice(0, limit).map((s) => s.p);
}

/** Replace the "@query" at `match` with the player's plain name. */
export function insertMention(text, match, name) {
  const end = match.start + 1 + match.query.length;
  const after = text.slice(end);
  const insert = after.startsWith(' ') ? name : `${name} `;
  const next = text.slice(0, match.start) + insert + after;
  return { text: next, caret: match.start + insert.length };
}

export function toMention(player) {
  return {
    name: player.name,
    team: player.team || null,
    salary: player.salary ?? null,
    headshot: player.headshot || null,
    player_key: player.player_key || mentionKey(player.name),
  };
}

/** Mentions whose name is still in the text (deleting the name drops the chip). */
export function activeMentions(mentions, text) {
  return (mentions || []).filter((m) => text.includes(m.name));
}

/** "PG,G,UTIL" -> "PG": drop the flex slots when a specific position is listed. */
export function formatPositions(position) {
  const all = String(position || '').split(/[,/]/).map((p) => p.trim()).filter(Boolean);
  const specific = all.filter((p) => !['G', 'F', 'UTIL'].includes(p));
  return (specific.length ? specific : all).join('/');
}

export function formatSalary(salary) {
  const n = Number(salary);
  return Number.isFinite(n) && n > 0 ? `$${(n / 1000).toFixed(1)}K` : '';
}
