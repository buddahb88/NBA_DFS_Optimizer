/**
 * NBA SEASON UTILITIES
 *
 * Single source of truth for season labels ('2026-27') and boundaries.
 * A season rolls over on October 1st: Sept 30 belongs to the prior season.
 */

// Actual opening nights; seasons not listed fall back to October 1st,
// which is safe for backfills (no games before opening night).
const KNOWN_START_DATES = {
  '2024-25': '2024-10-22',
  '2025-26': '2025-10-21',
  '2026-27': '2026-10-20',
};

const SEASON_RE = /^(\d{4})-(\d{2})$/;
const DATE_RE = /^(\d{4})-(\d{2})-\d{2}/;

function formatSeason(startYear) {
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;
}

function seasonStartYear(season) {
  const match = SEASON_RE.exec(season || '');
  if (!match) throw new Error(`Invalid season: ${season}`);
  return Number(match[1]);
}

/**
 * Season label for a date. Strings are read as calendar dates (no timezone
 * shift); Date objects use local date parts.
 */
export function seasonForDate(date) {
  let year;
  let month;
  if (date instanceof Date) {
    if (Number.isNaN(date.getTime())) throw new Error('Invalid date');
    year = date.getFullYear();
    month = date.getMonth() + 1;
  } else {
    const match = DATE_RE.exec(typeof date === 'string' ? date : '');
    if (!match) throw new Error(`Invalid date: ${date}`);
    year = Number(match[1]);
    month = Number(match[2]);
  }
  return formatSeason(month >= 10 ? year : year - 1);
}

export function getCurrentSeason(now = new Date()) {
  return seasonForDate(now);
}

export function seasonStartDate(season) {
  return KNOWN_START_DATES[season] || `${seasonStartYear(season)}-10-01`;
}

/** Calendar year the season ends in (e.g. 2025 for '2024-25'). */
export function seasonEndYear(season) {
  return seasonStartYear(season) + 1;
}

/** All seasons from `from` through the current one, newest first. */
export function listSeasons(from = '2024-25', now = new Date()) {
  const first = seasonStartYear(from);
  const current = seasonStartYear(getCurrentSeason(now));
  const seasons = [];
  for (let year = current; year >= first; year--) seasons.push(formatSeason(year));
  return seasons;
}

/** Payload for GET /api/historical/seasons. */
export function getSeasonsInfo(now = new Date()) {
  const current = getCurrentSeason(now);
  return {
    current,
    currentStartDate: seasonStartDate(current),
    seasons: listSeasons(undefined, now).map(value => ({
      value,
      startDate: seasonStartDate(value),
      current: value === current,
    })),
  };
}
