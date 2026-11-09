// Formatting helpers for the Model Log page (backend services/pickLogService.js)

export const BACKFILL_SUFFIX = '_backfill';

export const isBackfill = (source) => String(source || '').endsWith(BACKFILL_SUFFIX);

const SOURCE_LABELS = {
  max_projection: 'Max projection',
  gpp_sim_win: 'GPP sim winner',
  gpp_sim_win_chalkcap: 'GPP sim winner (chalk cap)',
};

/** Human label for a source; backfill sources keep their base label plus "(backfill)". */
export function sourceLabel(source) {
  const base = isBackfill(source) ? source.slice(0, -BACKFILL_SUFFIX.length) : source;
  const label = SOURCE_LABELS[base] ?? base;
  return isBackfill(source) ? `${label} (backfill)` : label;
}

export const fmtPts = (v) => (v === null || v === undefined || !Number.isFinite(Number(v)) ? '—' : Number(v).toFixed(1));
export const fmtPct = (v) => (v === null || v === undefined || !Number.isFinite(Number(v)) ? '—' : `${Math.round(Number(v))}%`);
export const fmtSalary = (v) => (v === null || v === undefined ? '—' : `$${(Number(v) / 1000).toFixed(1)}K`);

/** Pick status: 'scored' | 'pending' (not scored yet). */
export const pickStatus = (pick) => (pick.scoredAt ? 'scored' : 'pending');

/**
 * Against the night's entered contest numbers: 'cashed' | 'missed' | null
 * when no cash line is entered or the pick is not scored.
 */
export function cashResult(pick, contest) {
  const line = contest?.cashLine;
  if (line === null || line === undefined || pick.actualPoints === null || pick.actualPoints === undefined) return null;
  return pick.actualPoints >= line ? 'cashed' : 'missed';
}

/** "Fri Nov 7" from YYYY-MM-DD (no timezone shift). */
export function nightLabel(date) {
  if (!date) return '';
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
}

/** Text of an axios / fetch error. */
export const errorMessage = (err) => err?.response?.data?.error || err?.message || 'Request failed';

/** Number from a form field: null when blank, NaN when not a number. */
export function parseScore(text) {
  const t = String(text ?? '').trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? n : NaN;
}
