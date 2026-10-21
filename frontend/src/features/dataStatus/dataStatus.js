// Pure helpers for the Data Status panel (GET /api/historical/data-status) and
// the Home page's game-log health. No React here.

export const DATA_STATUS_PATH = '/data-status';

const SOURCE_LABELS = {
  espn: 'ESPN (manual)',
  'espn-scheduled': 'ESPN (scheduled)',
  'nba-api': 'NBA Stats API',
  blob: 'Azure Blob (legacy)',
};

export const sourceLabel = (source) => SOURCE_LABELS[source] || source || '—';

export const RUN_TONES = { syncing: 'info', complete: 'positive', error: 'negative' };
export const RUN_LABELS = { syncing: 'Running', complete: 'Complete', error: 'Failed' };

/** Run status from a sync_runs row (the backend adds `status`; derive it if missing). */
export function runStatus(run) {
  if (!run) return null;
  if (run.status) return run.status;
  return !run.finished_at ? 'syncing' : run.error ? 'error' : 'complete';
}

/** "1m 05s" between a run's start and finish (or `now` while running). */
export function runDuration(run, now = new Date()) {
  if (!run?.started_at) return '—';
  const end = run.finished_at ? new Date(run.finished_at) : now;
  const secs = Math.max(0, Math.round((end - new Date(run.started_at)) / 1000));
  if (Number.isNaN(secs)) return '—';
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ${String(secs % 60).padStart(2, '0')}s`;
  return `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, '0')}m`;
}

/** Local "Oct 21, 6:30 PM" for an ISO / sqlite timestamp; sqlite's 'YYYY-MM-DD HH:MM:SS' is UTC. */
export function formatTimestamp(value) {
  if (!value) return '—';
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value) ? `${value.replace(' ', 'T')}Z` : value;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/** "2024-10-22 → 2025-06-22", or '—' when the season has no games. */
export function dateRange(earliest, latest) {
  if (!earliest && !latest) return '—';
  return earliest === latest ? earliest : `${earliest} → ${latest}`;
}

/** Whole days from a YYYY-MM-DD date to `now`'s local date. */
export function daysSince(date, now = new Date()) {
  if (!date) return null;
  const [y, m, d] = date.slice(0, 10).split('-').map(Number);
  const then = new Date(y, m - 1, d);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((today - then) / 86400000);
}

/**
 * Game-log health from GET /historical/status (Home's RefreshTile).
 * status: null while loading, { error } when the request failed. Returns
 * { state, label } where state is 'loading' | 'unknown' | 'missing' | 'stale'
 * | 'current'; unknown, missing and stale link to the Data Status panel.
 */
export function historyHealth(status) {
  if (!status) return { state: 'loading', label: 'Game logs: checking…' };
  if (status.error) return { state: 'unknown', label: 'Game logs: status unavailable' };
  if (!status.hasData) return { state: 'missing', label: 'Game logs: not synced' };
  const label = `Game logs through ${String(status.latestGame).slice(0, 10)}`;
  return { state: status.needsUpdate ? 'stale' : 'current', label };
}

/** The axios error's server message, else its own. */
export const errorMessage = (err) => err?.response?.data?.error || err?.message || 'Request failed';
