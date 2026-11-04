// Pure helpers for the player card (formatting, tones, team colours).

export const VERDICT_TONE = {
  'Core play': 'positive',
  Playable: 'info',
  Pivot: 'caution',
  Fade: 'negative',
};

export const SOURCE_LABELS = { rotowire: 'RotoWire', ours: 'Ours', blend: 'Blend' };

// Primary team colours (hex) for the header accent
export const TEAM_COLORS = {
  ATL: '#E03A3E', BOS: '#007A33', BKN: '#5A5A5A', CHA: '#1D8CAB', CHI: '#CE1141', CLE: '#860038',
  DAL: '#0064B1', DEN: '#0E2240', DET: '#C8102E', GSW: '#1D428A', HOU: '#CE1141', IND: '#002D62',
  LAC: '#C8102E', LAL: '#552583', MEM: '#5D76A9', MIA: '#98002E', MIL: '#00471B', MIN: '#236192',
  NOP: '#0C2340', NYK: '#F58426', OKC: '#007AC1', ORL: '#0077C0', PHI: '#006BB6', PHX: '#E56020',
  POR: '#E03A3E', SAC: '#5A2D81', SAS: '#8A8D8F', TOR: '#CE1141', UTA: '#002B5C', WAS: '#002B5C',
};
const ALIASES = { BRK: 'BKN', GS: 'GSW', NO: 'NOP', NY: 'NYK', SA: 'SAS', PHO: 'PHX', UTAH: 'UTA', WSH: 'WAS', CHO: 'CHA' };
export const teamColor = (team) => TEAM_COLORS[ALIASES[String(team || '').toUpperCase()] ?? String(team || '').toUpperCase()] ?? '#4D8DFF';

const isNum = (v) => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));

export const fmt = (v, digits = 1, suffix = '') => (isNum(v) ? `${Number(v).toFixed(digits)}${suffix}` : '–');
export const fmtSigned = (v, digits = 1, suffix = '') =>
  isNum(v) ? `${Number(v) > 0 ? '+' : ''}${Number(v).toFixed(digits)}${suffix}` : '–';
export const fmtPct = (v, digits = 0) => (isNum(v) ? `${(Number(v) * 100).toFixed(digits)}%` : '–');
export const fmtSalary = (v) => (isNum(v) ? `$${Number(v).toLocaleString('en-US')}` : '–');

export const deltaTone = (v, threshold = 0.5) =>
  !isNum(v) || Math.abs(v) < threshold ? 'neutral' : v > 0 ? 'positive' : 'negative';

/** "7:30 PM ET" from an ISO start time. */
export function gameTime(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' })} ET`;
}

/** Short date "10/28" from YYYY-MM-DD. */
export const shortDate = (d) => (d ? `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}` : '');

export const initials = (name) =>
  String(name || '?')
    .split(' ')
    .map((n) => n[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);

/** Injury code + tone for the header badge. */
export function injuryBadge(status) {
  if (!status) return null;
  const s = String(status).trim();
  if (/^(out|o|inactive|ofs|ir)/i.test(s)) return { label: s.toUpperCase().slice(0, 4), tone: 'negative' };
  if (/^(q|questionable|gtd|game time|d|doubtful|dtd)/i.test(s)) return { label: s.toUpperCase().slice(0, 4), tone: 'caution' };
  if (/^(p|probable)/i.test(s)) return { label: 'PROB', tone: 'info' };
  return { label: s.slice(0, 6).toUpperCase(), tone: 'neutral' };
}

/** The text the "Ask AI" button drops into the chat composer. */
export function askAiPrompt(card) {
  if (!card) return '';
  const p = card.player;
  const pr = card.projection;
  const v = card.verdict;
  const lines = [
    `Give me a deeper take on ${p.name} (${p.team} vs ${p.opponent}, ${p.position}, ${fmtSalary(p.salary)})${card.slate.isBacktest ? ` for the ${card.slate.slateDate} backtest slate` : ' tonight'}.`,
    `Card verdict: cash ${v.cash.verdict} (${v.cash.confidence}), GPP ${v.gpp.verdict} (${v.gpp.confidence}).`,
    `Projection ${fmt(pr.active)} (${SOURCE_LABELS[pr.source] ?? pr.source}); RotoWire ${fmt(pr.rotowire)}, ours ${fmt(pr.ours)}, blend ${fmt(pr.blend)}; ${fmt(pr.rostership)}% owned.`,
    v.reasonsFor.length ? `For: ${v.reasonsFor.join('; ')}.` : null,
    v.reasonsAgainst.length ? `Against: ${v.reasonsAgainst.join('; ')}.` : null,
    'Should I play him in cash and GPP, and what are the risks?',
  ];
  return lines.filter(Boolean).join('\n');
}

/** Position of x in [lo, hi] as a 0-100 percentage (clamped). */
export const pctAlong = (x, lo, hi) => (hi > lo && isNum(x) ? Math.max(0, Math.min(100, ((x - lo) / (hi - lo)) * 100)) : null);

export { isNum };
