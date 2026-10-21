/**
 * Pure helpers for the Insights page: date-window params for the
 * /historical insight endpoints and display formatting. No React here.
 */

// Date windows offered in the filters bar. 'default' sends no window, so the
// backend ends on the latest game in the data (usage bumps / missing players
// then default to its last 30 days).
export const WINDOWS = [
  { value: 'default', label: 'Latest data', params: {} },
  { value: 'last30', label: 'Last 30 days', params: { lastNDays: 30 } },
  { value: 'last14', label: 'Last 14 days', params: { lastNDays: 14 } },
  { value: 'custom', label: 'Custom range (backtest)' },
];

export const DEFAULT_WINDOW = { mode: 'default', startDate: '', endDate: '' };

/** Filter state -> request params ({} | { lastNDays } | { startDate, endDate }). */
export function windowParams(window) {
  if (window?.mode === 'custom') {
    const params = {};
    if (window.startDate) params.startDate = window.startDate;
    if (window.endDate) params.endDate = window.endDate;
    return params;
  }
  return { ...(WINDOWS.find((w) => w.value === window?.mode)?.params ?? {}) };
}

/** Stable string for a window, for effect deps and caching. */
export function windowKey(window) {
  const p = windowParams(window);
  return [p.lastNDays ?? '', p.startDate ?? '', p.endDate ?? ''].join('|');
}

/** Error message for a custom range, or null when it is valid. */
export function validateRange(startDate, endDate) {
  if (!startDate || !endDate) return 'Pick both a start and an end date.';
  if (startDate > endDate) return 'Start date must be on or before the end date.';
  return null;
}

/** First 10 chars of a DB date (sqlite 'YYYY-MM-DD', azure ISO) for <input type="date">. */
export const toDateInput = (value) => (value ? String(value).slice(0, 10) : '');

function toNum(v) {
  const n = typeof v === 'string' ? parseFloat(v) : v;
  return Number.isFinite(n) ? n : null;
}

/** Fixed-digit number; 0 renders as 0, missing values as an em dash. */
export function fmt(v, digits = 1) {
  const n = toNum(v);
  return n == null ? '—' : n.toFixed(digits);
}

/** Signed number with an optional unit: +12.5%, -3%, 0%. */
export function signed(v, unit = '') {
  const n = toNum(v);
  if (n == null) return '—';
  return `${n > 0 ? '+' : ''}${n}${unit}`;
}

/** Salary in $K (11800 -> $11.8K); $0 stays visible. */
export function money(v) {
  const n = toNum(v);
  if (n == null) return '—';
  return n === 0 ? '$0' : `$${(n / 1000).toFixed(1)}K`;
}

/** False only when /historical/summary reports an empty historical_games table. */
export function hasHistory(summary) {
  return !summary || toNum(summary.totalGames) !== 0;
}
