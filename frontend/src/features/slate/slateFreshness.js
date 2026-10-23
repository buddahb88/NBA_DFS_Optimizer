// Slate freshness on the client: the slates API sends slate_date (the night a
// slate covers); compare it with today's US Eastern date, the DFS day.

const DAY_MS = 24 * 60 * 60 * 1000;

/** Today's date (YYYY-MM-DD) in America/New_York. */
export const easternToday = (now = new Date()) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);

/** { slateDate, today, isStale, daysOld }; a slate without a date is never stale. */
export function slateStaleness(slate, now = new Date()) {
  const today = easternToday(now);
  const slateDate = slate?.slate_date ?? null;
  if (!slateDate) return { slateDate: null, today, isStale: false, daysOld: null };
  return {
    slateDate,
    today,
    isStale: slateDate < today,
    daysOld: Math.round((Date.parse(today) - Date.parse(slateDate)) / DAY_MS),
  };
}

/** "2026-10-21" -> "Wed, Oct 21" */
export const formatSlateDate = (date) =>
  new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
