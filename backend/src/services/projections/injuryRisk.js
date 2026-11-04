/**
 * INJURY-TAG PLAY PROBABILITY (pure: no DB)
 *
 * How often a player with a given injury tag at the last sync actually plays,
 * estimated from saved slates (slate_player_snapshots x historical_games; no
 * box score with minutes on a night his team played = DNP).
 *
 *   tag rate   (played + PSEUDO.tag x fallback) / (n + PSEUDO.tag)
 *              shrinks the tag's raw rate toward FALLBACK_P_PLAY
 *   band rate  (played + PSEUDO.band x tag rate) / (n + PSEUDO.band)
 *              per salary band (< $5K / $5K+), shrunk toward the tag rate
 * GTD has no rows of its own on RotoWire (it posts QUES); it uses QUES's
 * numbers unless it has rows. Rates are clamped to [P_MIN, P_MAX].
 *
 * Trends backtest that motivated it (14 DK main slates 2026-10-20..11-02):
 * QUES DNP 32% (blend 23.1 -> actual 15.5), mostly cheap players
 * (<$5K 10/28 DNP, $5-8K 4/14, $8K+ 1/5); PROB 1 of 12 DNP.
 */

export const TAGS = Object.freeze(['QUES', 'PROB', 'DOUBT', 'GTD']);
/** Q-type tags: the optimizer's skipQuestionable drops these (PROB plays ~always). */
export const QUESTIONABLE_TAGS = Object.freeze(['QUES', 'DOUBT', 'GTD']);
export const FALLBACK_P_PLAY = Object.freeze({ QUES: 0.68, PROB: 0.92, DOUBT: 0.25, GTD: 0.68 });
export const PSEUDO = Object.freeze({ tag: 10, band: 10 });
export const BAND_SPLIT = 5000;
export const BANDS = Object.freeze(['lt5k', '5k+']);
export const P_MIN = 0.05;
export const P_MAX = 0.99;
/** injury_risk buckets by P(play): >= low -> 'low', >= medium -> 'medium', else 'high'. */
export const RISK_CUTS = Object.freeze({ low: 0.9, medium: 0.5 });

const OUT_RE = /^(O|OUT|OFS|IL|IR|INJ|NA|N\/A|SUSP|SUSPENDED|INACTIVE|NWT)$/;
const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const clamp = (x) => Math.min(P_MAX, Math.max(P_MIN, x));
const round = (x, d = 3) => (finite(x) ? Number(x.toFixed(d)) + 0 : null);

/**
 * Any injury status (RotoWire 'QUES', 'Questionable', 'GTD', FanDuel 'Q' / 'D',
 * JSON blobs) -> 'QUES' | 'PROB' | 'DOUBT' | 'GTD' | 'OUT' | null.
 */
export function normalizeTag(status) {
  if (status === null || status === undefined) return null;
  let s = status;
  if (typeof s === 'string' && /^\s*\{/.test(s)) {
    try { s = JSON.parse(s); } catch { /* plain text */ }
  }
  if (s && typeof s === 'object') s = s.status ?? s.injuryStatus ?? s.designation ?? '';
  const t = String(s).trim().toUpperCase();
  if (!t) return null;
  if (OUT_RE.test(t)) return 'OUT';
  if (/^(Q|QUES|QUESTIONABLE)$/.test(t)) return 'QUES';
  if (/^(GTD|GAME[ -]TIME( DECISION)?|DTD|DAY[ -]TO[ -]DAY)$/.test(t)) return 'GTD';
  if (/^(D|DOUBT|DOUBTFUL)$/.test(t)) return 'DOUBT';
  if (/^(P|PROB|PROBABLE)$/.test(t)) return 'PROB';
  return null;
}

export const salaryBand = (salary) => (Number(salary) > 0 && Number(salary) < BAND_SPLIT ? 'lt5k' : '5k+');

const rate = (played, n, prior, pseudo) => clamp((played + pseudo * prior) / (n + pseudo));

/**
 * rows: [{ tag (any status text or null), salary, played (bool) }], one per
 * player-night. Returns { pseudo, fallback, rows, untagged: { n, played, raw },
 * tags: { TAG: { n, played, raw, p_play, source, bands: { lt5k|5k+: { n, played, raw, p_play } } } } }.
 */
export function calibrateInjuryRisk(rows = [], { pseudo = PSEUDO, fallback = FALLBACK_P_PLAY } = {}) {
  const counts = new Map();
  const bump = (key, played) => {
    const c = counts.get(key) ?? { n: 0, played: 0 };
    c.n += 1; c.played += played ? 1 : 0;
    counts.set(key, c);
  };
  let used = 0;
  for (const r of rows) {
    const tag = normalizeTag(r.tag);
    if (tag === 'OUT') continue;
    used += 1;
    const key = tag ?? 'none';
    bump(key, r.played);
    if (tag) bump(`${tag}|${salaryBand(r.salary)}`, r.played);
  }
  const get = (k) => counts.get(k) ?? { n: 0, played: 0 };
  const raw = (c) => (c.n ? round(c.played / c.n) : null);

  const tags = {};
  for (const tag of TAGS) {
    // GTD without rows of its own borrows QUES's (RotoWire posts QUES)
    const own = get(tag);
    const borrow = tag === 'GTD' && own.n === 0 ? 'QUES' : null;
    const c = borrow ? get(borrow) : own;
    const prior = fallback[tag];
    const tagRate = rate(c.played, c.n, prior, pseudo.tag);
    const bands = {};
    for (const band of BANDS) {
      const b = get(`${borrow ?? tag}|${band}`);
      bands[band] = { n: b.n, played: b.played, raw: raw(b), p_play: round(rate(b.played, b.n, tagRate, pseudo.band)) };
    }
    tags[tag] = {
      n: c.n, played: c.played, raw: raw(c), p_play: round(tagRate),
      source: borrow ? `${borrow} (no ${tag} rows)` : (c.n ? 'slates' : 'fallback'),
      bands
    };
  }
  const none = get('none');
  return { pseudo: { ...pseudo }, fallback: { ...fallback }, rows: used, untagged: { ...none, raw: raw(none) }, tags };
}

/** The fallback-only table (no slate history). */
export const fallbackTable = () => calibrateInjuryRisk([]);

/**
 * P(play | tag, salary) from a table: { p, tag, band } or null when the
 * player is untagged / OUT / the tag is unknown.
 */
export function tagPlayProbability(table, status, salary) {
  const tag = normalizeTag(status);
  if (!tag || tag === 'OUT') return null;
  const entry = (table?.tags ?? {})[tag] ?? fallbackTable().tags[tag];
  if (!entry) return null;
  const band = salaryBand(salary);
  const p = entry.bands?.[band]?.p_play ?? entry.p_play ?? FALLBACK_P_PLAY[tag];
  return { p, tag, band };
}

/** 'none' (untagged) | 'low' | 'medium' | 'high' for a play probability. */
export function riskLevel(p) {
  if (!finite(p)) return 'none';
  if (p >= RISK_CUTS.low) return 'low';
  if (p >= RISK_CUTS.medium) return 'medium';
  return 'high';
}

const TAG_WORDS = { QUES: 'Questionable', PROB: 'Probable', DOUBT: 'Doubtful', GTD: 'Game-time decision' };
export const tagLabel = (tag) => TAG_WORDS[tag] ?? tag;

/** Plain-text table for the calibration script. */
export function formatTable(table) {
  const pctS = (x) => (finite(x) ? `${Math.round(x * 100)}%` : '  - ');
  const lines = [
    `Tag     n   played  raw    P(play)   <$5K n / raw / P     $5K+ n / raw / P     source`,
  ];
  for (const tag of TAGS) {
    const t = table.tags[tag];
    const b = (k) => `${String(t.bands[k].n).padStart(3)} / ${pctS(t.bands[k].raw).padStart(4)} / ${pctS(t.bands[k].p_play).padStart(4)}`;
    lines.push(`${tag.padEnd(6)} ${String(t.n).padStart(3)}  ${String(t.played).padStart(6)}  ${pctS(t.raw).padStart(4)}   ${pctS(t.p_play).padStart(5)}    ${b('lt5k')}    ${b('5k+')}    ${t.source}`);
  }
  const u = table.untagged;
  lines.push(`untagged ${u.n} player-nights, played ${pctS(u.raw)} (not adjusted: the projection already prices the base rate)`);
  return lines.join('\n');
}

export default {
  TAGS, QUESTIONABLE_TAGS, FALLBACK_P_PLAY, PSEUDO, BAND_SPLIT, RISK_CUTS,
  normalizeTag, salaryBand, calibrateInjuryRisk, fallbackTable, tagPlayProbability, riskLevel, tagLabel, formatTable
};
