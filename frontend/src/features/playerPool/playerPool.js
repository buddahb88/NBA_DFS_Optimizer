// Pure helpers for the Player Pool page: derived stats, filters, quick views,
// colour tones and the optimizer payload. No React here so it is easy to test.

export const POSITIONS = ['PG', 'SG', 'SF', 'PF', 'C'];

// ── Player fields ───────────────────────────────────────────────────────────

export const positionsOf = (p) =>
  String(p.position || '')
    .split(/[/,]/)
    .map((s) => s.trim())
    .filter(Boolean);

/** Stable "AAA vs BBB" key so both teams of a game map to the same filter value. */
export const gameKey = (p) => {
  if (!p.team || !p.opponent) return null;
  return [p.team, p.opponent].sort().join(' vs ');
};

// RotoWire injury_status is a short code, a word, or occasionally a JSON object.
const INJURY_CODES = {
  O: 'OUT', OUT: 'OUT', INJ: 'OUT', IR: 'OUT', SUSP: 'OUT',
  D: 'D', DOUBTFUL: 'D',
  Q: 'Q', QUESTIONABLE: 'Q',
  GTD: 'GTD', 'GAME TIME DECISION': 'GTD', 'DAY-TO-DAY': 'GTD', DTD: 'GTD',
  P: 'P', PROBABLE: 'P',
};
const HEALTHY = new Set(['', 'ACTIVE', 'HEALTHY', 'NONE', 'NULL', 'FALSE', '0']);

/** Normalized injury code (OUT | D | Q | GTD | P | raw upper-cased) or null when healthy. */
export function injuryCode(status) {
  if (status == null) return null;
  let raw = status;
  if (typeof raw === 'string' && raw.trim().startsWith('{')) {
    try {
      const obj = JSON.parse(raw);
      raw = obj.status ?? obj.injury ?? obj.designation ?? '';
    } catch {
      /* keep the raw string */
    }
  } else if (typeof raw === 'object') {
    raw = raw.status ?? raw.injury ?? '';
  }
  const key = String(raw).trim().toUpperCase();
  if (HEALTHY.has(key)) return null;
  return INJURY_CODES[key] ?? key;
}

/** Statuses hidden by "Hide injured" (probable players are expected to play). */
export const isInjured = (p) => {
  const code = injuryCode(p.injury_status);
  return code != null && code !== 'P';
};

export const injuryTone = (code) =>
  code === 'OUT' ? 'negative' : code === 'P' ? 'info' : code ? 'caution' : 'neutral';

// ── Projection with per-player override ─────────────────────────────────────

const num = (v) => (v === null || v === undefined || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);

/**
 * Merge a player row with its saved controls. With a projection override the
 * floor/ceiling scale by the same ratio (matches the optimizer contract).
 */
export function withSettings(p, s) {
  const base = num(p.projected_points) ?? 0;
  const override = num(s?.projectionOverride);
  const proj = override ?? base;
  const ratio = override != null && base > 0 ? override / base : 1;
  const scale = (v) => (num(v) == null ? null : num(v) * ratio);
  return {
    ...p,
    proj,
    baseProj: base,
    overridden: override != null,
    floorAdj: scale(p.floor),
    ceilingAdj: scale(p.ceiling),
    valueAdj: p.salary > 0 ? (proj / p.salary) * 1000 : null,
    settings: s ?? null,
  };
}

// ── Filters ─────────────────────────────────────────────────────────────────

export const DEFAULT_FILTERS = {
  search: '',
  positions: [],
  game: '',
  salaryMin: '',
  salaryMax: '',
  hideInjured: false,
};

export function applyFilters(rows, f) {
  const q = f.search.trim().toLowerCase();
  const lo = num(f.salaryMin);
  const hi = num(f.salaryMax);
  return rows.filter((p) => {
    if (q && !`${p.name} ${p.team ?? ''} ${p.opponent ?? ''}`.toLowerCase().includes(q)) return false;
    if (f.positions.length && !positionsOf(p).some((pos) => f.positions.includes(pos))) return false;
    if (f.game) {
      // game filter value is either "AAA vs BBB" (a game) or "team:AAA"
      if (f.game.startsWith('team:') ? p.team !== f.game.slice(5) : gameKey(p) !== f.game) return false;
    }
    if (lo != null && p.salary < lo) return false;
    if (hi != null && p.salary > hi) return false;
    if (f.hideInjured && isInjured(p)) return false;
    return true;
  });
}

// ── Slate-relative colour tones ─────────────────────────────────────────────
// Value and leverage scales differ by site (DK vs FD salaries), so tones use
// slate percentiles instead of fixed cut-offs.

export function quantile(values, q) {
  const xs = values.filter((v) => v != null && Number.isFinite(v)).sort((a, b) => a - b);
  if (!xs.length) return null;
  const pos = (xs.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return xs[lo] + (xs[hi] - xs[lo]) * (pos - lo);
}

export function slateStats(rows) {
  const pick = (key) => rows.map((r) => num(r[key]));
  const values = pick('valueAdj');
  const leverage = pick('leverage_score');
  const boom = pick('boom_probability');
  const minutes = pick('projected_minutes');
  return {
    value: { lo: quantile(values, 0.2), mid: quantile(values, 0.5), p60: quantile(values, 0.6), hi: quantile(values, 0.8) },
    leverage: { lo: quantile(leverage, 0.2), mid: quantile(leverage, 0.5), hi: quantile(leverage, 0.8) },
    boom: { mid: quantile(boom, 0.5) },
    minutes: { mid: quantile(minutes, 0.5) },
  };
}

/** 'positive' | 'negative' | null for a value against {lo, hi} percentiles. */
export function bandTone(v, band) {
  if (v == null || !band || band.lo == null) return null;
  if (v >= band.hi) return 'positive';
  if (v <= band.lo) return 'negative';
  return null;
}

// Ownership is absolute (% of field): chalk is a caution in GPP, low owned is an edge.
export const OWNERSHIP_CHALK = 25;
export const OWNERSHIP_LOW = 5;
export function ownershipTone(own) {
  if (own == null) return null;
  if (own >= OWNERSHIP_CHALK) return 'caution';
  if (own <= OWNERSHIP_LOW) return 'info';
  return null;
}

// ── Quick views ─────────────────────────────────────────────────────────────

export const QUICK_VIEWS = [
  {
    value: 'all',
    label: 'All',
    description: 'Every player, by projection',
    sort: [{ id: 'proj', desc: true }],
    filter: () => true,
  },
  {
    value: 'cash',
    label: 'Cash core',
    description: 'Healthy, minutes-secure, above-median value; sorted by floor',
    sort: [{ id: 'floor', desc: true }],
    filter: (p, s) =>
      !isInjured(p) &&
      (num(p.projected_minutes) ?? 0) >= Math.max(24, s.minutes.mid ?? 0) &&
      (s.value.mid == null || (p.valueAdj ?? 0) >= s.value.mid),
  },
  {
    value: 'gpp',
    label: 'GPP leverage',
    description: `Under ${OWNERSHIP_CHALK}% owned with above-median boom; sorted by leverage`,
    sort: [{ id: 'leverage', desc: true }],
    filter: (p, s) =>
      injuryCode(p.injury_status) !== 'OUT' &&
      (num(p.rostership) == null || num(p.rostership) < OWNERSHIP_CHALK) &&
      (s.boom.mid == null || num(p.boom_probability) == null || num(p.boom_probability) >= s.boom.mid),
  },
  {
    value: 'value',
    label: 'Value',
    description: 'Top-40% pts/$1K with real minutes; sorted by value',
    sort: [{ id: 'value', desc: true }],
    filter: (p, s) =>
      !isInjured(p) &&
      (num(p.projected_minutes) ?? 0) >= 18 &&
      (s.value.p60 == null || (p.valueAdj ?? 0) >= s.value.p60),
  },
];

export const getQuickView = (value) => QUICK_VIEWS.find((v) => v.value === value) ?? QUICK_VIEWS[0];

/** `stats` should come from the whole pool so views don't shift as other filters change. */
export function applyQuickView(rows, viewValue, stats = slateStats(rows)) {
  const view = getQuickView(viewValue);
  return rows.filter((p) => view.filter(p, stats));
}

// ── Optimizer payload ───────────────────────────────────────────────────────

/**
 * Saved controls -> `players` array for POST /api/optimizer/generate, per the
 * contract at the top of backend/src/services/optimizer/constraints/exposure.js.
 * Settings are keyed by the stable players.player_id; the optimizer wants the
 * row id (players.id), so players not in the current pool are dropped.
 */
export function toOptimizerPlayers(players, settingsByPlayerId) {
  const out = [];
  for (const p of players) {
    const s = settingsByPlayerId?.[String(p.player_id)];
    if (!s) continue;
    const entry = { id: p.id };
    if (s.lock) entry.lock = true;
    if (s.exclude) entry.exclude = true;
    if (num(s.minExposure) != null) entry.minExposure = num(s.minExposure);
    if (num(s.maxExposure) != null) entry.maxExposure = num(s.maxExposure);
    if (num(s.projectionOverride) != null) entry.projectionOverride = num(s.projectionOverride);
    if (Object.keys(entry).length > 1) out.push(entry);
  }
  return out;
}

/** Client-side mirror of the backend validation; returns an error string or null. */
export function validateSettings(s) {
  if (!s) return null;
  if (s.lock && s.exclude) return 'Cannot lock and exclude';
  const min = num(s.minExposure);
  const max = num(s.maxExposure);
  for (const [label, v] of [['Min', min], ['Max', max]]) {
    if (v != null && (v < 0 || v > 100)) return `${label} exposure must be 0-100`;
  }
  if (min != null && max != null && min > max) return 'Min exposure is above max';
  const o = num(s.projectionOverride);
  if (o != null && (o < 0 || o > 200)) return 'Override must be 0-200';
  return null;
}

export const isDefaultSettings = (s) =>
  !s || (!s.lock && !s.exclude && num(s.minExposure) == null && num(s.maxExposure) == null && num(s.projectionOverride) == null);
