/**
 * Pure helpers for the chat session rail: date buckets and title search.
 * Session rows come from GET /chat/sessions ({ id, title, created_at, updated_at, message_count }).
 */
import { parseTimestamp } from '../../pages/home/slateDashboard';

export const UNTITLED_SESSION = 'Untitled chat';

const GROUPS = [
  { key: 'today', label: 'Today' },
  { key: 'yesterday', label: 'Yesterday' },
  { key: 'week', label: 'Previous 7 days' },
  { key: 'older', label: 'Older' },
];

/** Last activity of a session as a Date, or null. */
export function sessionDate(session) {
  return parseTimestamp(session?.updated_at) ?? parseTimestamp(session?.created_at);
}

function startOfDay(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

function bucketFor(date, now) {
  if (!date) return 'older';
  const days = Math.round((startOfDay(now) - startOfDay(date)) / 86400000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days <= 7) return 'week';
  return 'older';
}

/**
 * Group sessions by last activity in local time. Returns only non-empty
 * groups, in display order: [{ key, label, sessions }], newest first within each.
 */
export function groupSessionsByDate(sessions, now = new Date()) {
  const buckets = Object.fromEntries(GROUPS.map((g) => [g.key, []]));
  for (const session of sessions || []) {
    const date = sessionDate(session);
    buckets[bucketFor(date, now)].push({ session, time: date?.getTime() ?? -Infinity });
  }
  return GROUPS.filter((g) => buckets[g.key].length).map((g) => ({
    ...g,
    sessions: buckets[g.key].sort((a, b) => b.time - a.time).map((e) => e.session),
  }));
}

/** Case-insensitive title search. */
export function filterSessions(sessions, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return sessions || [];
  return (sessions || []).filter((s) => (s.title || UNTITLED_SESSION).toLowerCase().includes(q));
}
