// Pure helpers for the Late Swap tab (kept separate so they're easy to test)

export const REASON_TONES = {
  locked: 'neutral',
  out: 'negative',
  questionable: 'caution',
  upgrade: 'positive',
  moved: 'info',
  filled: 'accent',
};

export const FLAG_TONES = {
  LOCKED_OUT: 'negative',
  NO_SOLUTION: 'negative',
  UNKNOWN_PLAYER: 'negative',
  QUESTIONABLE: 'caution',
  EXPOSURE_RELAXED: 'caution',
  UNIQUENESS_RELAXED: 'caution',
  SEARCH_LIMIT: 'caution',
  REOPTIMIZED: 'info',
};

export const FLAG_LABELS = {
  LOCKED_OUT: 'Locked OUT',
  NO_SOLUTION: 'No swap',
  UNKNOWN_PLAYER: 'Unknown player',
  QUESTIONABLE: 'GTD kept',
  EXPOSURE_RELAXED: 'Exposure relaxed',
  UNIQUENESS_RELAXED: 'Duplicate',
  SEARCH_LIMIT: 'Approximate',
  REOPTIMIZED: 'Re-optimized',
};

/** Entries shown for a filter: 'all' | 'changed' | 'flagged' */
export function filterEntries(entries = [], filter = 'all') {
  if (filter === 'changed') return entries.filter((e) => e.status === 'changed');
  if (filter === 'flagged') return entries.filter((e) => e.flags.length > 0);
  return entries;
}

/** Comma/newline separated text -> trimmed non-empty list */
export function splitList(text) {
  return String(text ?? '')
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** "DKEntries.csv" -> "DKEntries-lateswap.csv" */
export function outputFileName(inputName) {
  const base = String(inputName || 'entries').replace(/\.csv$/i, '');
  return `${base}-lateswap.csv`;
}

/** datetime-local value ("2026-10-17T20:15") -> ISO string, or undefined when empty/invalid */
export function localInputToIso(value) {
  if (!value) return undefined;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

/** Request body from the form state */
export function buildRequest({ slateId, csv, mode, maxExposure, swapQuestionable, unique, outPlayers, lockedTeams, now }) {
  const body = { slateId, csv, mode, swapQuestionable, unique };
  const exp = Number(maxExposure);
  if (maxExposure !== '' && Number.isFinite(exp)) body.maxExposure = exp;
  const out = splitList(outPlayers);
  if (out.length) body.outPlayers = out;
  const teams = splitList(lockedTeams).map((t) => t.toUpperCase());
  if (teams.length) body.lockedTeams = teams;
  const iso = localInputToIso(now);
  if (iso) body.now = iso;
  return body;
}

export function downloadText(text, fileName) {
  const blob = new Blob([text], { type: 'text/csv' });
  const url = window.URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  window.URL.revokeObjectURL(url);
}
