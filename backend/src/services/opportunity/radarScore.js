/**
 * OPPORTUNITY RADAR SCORE
 *
 * Pure math for the Opportunity Score (0-100) of one metrics row
 * (metricsService rows: O1 trends / role / hit rates, O2 teammate fields,
 * O3 rate projection) plus the slate's floor / ceiling / ownership.
 *
 * Components (0..1, 0.5 = neutral; ramps and weights in radarConfig.js):
 *   projMinutes  tonight's projected minutes (slate)
 *   minutes      L3 / L5 minutes vs season (+ moving into the lineup)
 *   usage        usage L5 vs season
 *   vacated      play-share rise without tonight's outs (O2; null with no outs)
 *   gap          rate projection vs posted (O3)
 *   hitRate      5x (cash) / 6x (GPP) hit rate at tonight's salary, L10
 *   stability    minutes SD, games under 20 minutes, starts
 *   floor        slate floor per $1K
 *   environment  implied total, blowout and back-to-back penalties
 *   upside       slate ceiling per $1K
 *   leverage     value (rate projection, else posted) vs ownership
 * Short samples shrink a component toward 0.5. A missing component counts
 * as 0.5; coverage = the share of weight that had data.
 */

import RADAR_CONFIG from './radarConfig.js';

const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const clamp01 = (x) => Math.max(0, Math.min(1, x));
const ramp = (v, from, to) => (v === null ? null : clamp01((v - from) / (to - from)));
const shrink = (s, factor) => (s === null ? null : 0.5 + (s - 0.5) * clamp01(factor));
const perK = (points, salary) => (points === null || !(salary > 0) ? null : points / (salary / 1000));
const round = (x, digits) => (x === null || !Number.isFinite(x) ? null : Number(x.toFixed(digits)) + 0);

function minutesComponent(p, s, sampleGames) {
  const l3 = num(p.min_delta_l3);
  const l5 = num(p.min_delta_l5);
  if (l3 === null && l5 === null) return null;
  const delta = l3 !== null && l5 !== null ? s.l3Weight * l3 + (1 - s.l3Weight) * l5 : (l3 ?? l5);
  const bonus = p.starter_change === 'into' ? s.intoLineupBonus : 0;
  return clamp01(shrink(ramp(delta, s.from, s.to), (num(p.games_l3) ?? 0) / sampleGames) + bonus);
}

function vacatedComponent(p, s) {
  const delta = num(p.teammate_play_share_delta);
  if (delta === null || (p.teammate_sample !== 'confirmed' && p.teammate_sample !== 'thin')) return null;
  return shrink(ramp(delta, s.from, s.to), p.teammate_sample === 'thin' ? s.thinWeight : 1);
}

function stabilityComponent(p, s) {
  const sd = num(p.min_sd_l10);
  if (sd === null) return null;
  const games = num(p.games_l10) ?? 0;
  const games5 = num(p.games_l5) ?? 0;
  const under20 = games > 0 && num(p.under20_l10) !== null ? 1 - num(p.under20_l10) / games : 0.5;
  const starts = games5 > 0 && num(p.starts_l5) !== null ? num(p.starts_l5) / games5 : 0.5;
  return s.sdWeight * ramp(sd, s.sdFrom, s.sdTo) + s.under20Weight * under20 + s.startsWeight * starts;
}

function environmentComponent(p, s) {
  const implied = num(p.implied_total);
  if (implied === null) return null;
  return clamp01(ramp(implied, s.from, s.to) - (p.blowout ? s.blowoutPenalty : 0) - (p.back_to_back ? s.backToBackPenalty : 0));
}

function leverageComponent(p, s) {
  const salary = num(p.salary);
  const value = num(p.rate_value) ?? perK(num(p.projected_points), salary);
  const own = num(p.rostership);
  if (value === null || own === null) return null;
  return Math.sqrt(ramp(value, s.valueFrom, s.valueTo) * ramp(own, s.ownFrom, s.ownTo));
}

/** Components for one row and mode ('cash' | 'gpp'): { name: 0..1 | null }. */
export function componentScores(p, mode = 'cash', config = RADAR_CONFIG) {
  const s = config.scales ?? RADAR_CONFIG.scales;
  const salary = num(p.salary);
  const hitKey = `hit${mode === 'gpp' ? s.hitRate.gppMultiple : s.hitRate.cashMultiple}x_l10`;
  const hit = num(p[hitKey]);
  return {
    projMinutes: ramp(num(p.projected_minutes), s.projMinutes.from, s.projMinutes.to),
    minutes: minutesComponent(p, s.minutes, s.sampleGames),
    usage: shrink(ramp(num(p.usg_delta), s.usage.from, s.usage.to), (num(p.games_l5) ?? 0) / s.sampleGames),
    vacated: vacatedComponent(p, s.vacated),
    gap: ramp(num(p.rate_gap_pct), s.gap.from, s.gap.to),
    hitRate: shrink(hit, (num(p.value_games_l10) ?? 0) / s.hitRate.fullGames),
    stability: stabilityComponent(p, s.stability),
    floor: ramp(perK(num(p.floor), salary), s.floor.from, s.floor.to),
    environment: environmentComponent(p, s.environment),
    upside: ramp(perK(num(p.ceiling), salary), s.upside.from, s.upside.to),
    leverage: leverageComponent(p, s.leverage)
  };
}

/**
 * Opportunity Score for one row: { score (0-100, 1 decimal), components
 * (rounded), coverage (0..1) }. config.weights[mode] replaces the default
 * weights entirely.
 */
export function opportunityScore(p, mode = 'cash', config = RADAR_CONFIG) {
  const weights = config.weights?.[mode] ?? RADAR_CONFIG.weights[mode];
  const components = componentScores(p, mode, config);
  let total = 0;
  let sum = 0;
  let covered = 0;
  for (const [name, w] of Object.entries(weights)) {
    const c = components[name];
    total += w;
    sum += w * (c ?? 0.5);
    if (c !== null && c !== undefined) covered += w;
  }
  return {
    score: total > 0 ? round(100 * sum / total, 1) : null,
    components: Object.fromEntries(Object.entries(components).map(([k, v]) => [k, round(v, 3)])),
    coverage: total > 0 ? round(covered / total, 3) : null
  };
}

const signed = (x, digits = 1) => `${x >= 0 ? '+' : ''}${x.toFixed(digits)}`;
const lastName = (name) => String(name ?? '').trim().split(/\s+/).filter(w => !/^(jr\.?|sr\.?|ii|iii|iv)$/i.test(w)).pop() ?? '';
const shortDate = (date) => {
  const [, m, d] = String(date).split('-');
  return `${Number(m)}/${Number(d)}`;
};

/**
 * Short human-readable reason line, e.g. "+6.2 min L3, starter since 10/21,
 * absorbs ~30% of Harris usage (OUT)": opportunity first, then cautions,
 * at most reasons.maxParts parts. '' when nothing stands out.
 */
export function reasonLine(p, config = RADAR_CONFIG) {
  const r = config.reasons ?? RADAR_CONFIG.reasons;
  const parts = [];
  const minDelta = num(p.min_delta_l3);
  if (minDelta !== null && Math.abs(minDelta) >= r.minutesDelta) parts.push(`${signed(minDelta)} min L3`);
  const streak = num(p.starter_streak);
  // Early in a season the streak may date from last season: not news
  if (p.starter_since && !p.season_fallback && streak !== null && streak <= r.starterStreakMax) parts.push(`starter since ${shortDate(p.starter_since)}`);
  const absorbed = num(p.teammate_absorbed_pct);
  if (absorbed !== null && absorbed >= r.absorbedPct && (p.teammate_sample === 'confirmed' || p.teammate_sample === 'thin')
    && p.teammate_out_names?.length) {
    const who = p.teammate_out_names.map(lastName).join(' + ');
    parts.push(`absorbs ~${Math.round(100 * absorbed)}% of ${who} usage (OUT${p.teammate_sample === 'thin' ? ', thin sample' : ''})`);
  }
  const usg = num(p.usg_delta);
  if (usg !== null && Math.abs(usg) >= r.usageDelta) parts.push(`usage ${signed(100 * usg)} pts L5`);
  const gap = num(p.rate_gap);
  if (gap !== null && Math.abs(gap) >= r.rateGap) parts.push(`rate proj ${signed(gap)} vs posted`);
  const hit = num(p.hit5x_l10);
  const games = num(p.value_games_l10);
  if (hit !== null && games > 0 && hit >= r.hitRate) parts.push(`hit 5x in ${Math.round(hit * games)}/${games}`);
  if (p.shooting_flag === 'bounce_back') parts.push('TS% bounce-back due');
  if (p.salary_lag === true) parts.push('salary lagging production');
  const implied = num(p.implied_total);
  if (implied !== null && implied >= r.impliedTotal) parts.push(`team total ${implied.toFixed(1)}`);
  if (p.blowout) parts.push(num(p.spread) === null ? 'blowout risk' : `blowout risk (spread ${signed(num(p.spread))})`);
  if (p.back_to_back) parts.push('back-to-back');
  return parts.slice(0, r.maxParts).join(', ');
}

/**
 * Backtest check: do the top-decile scores beat `multiple` x salary more
 * often than the slate? Rows carry score, salary, actualPoints and
 * resultStatus; pending results are left out, DNP / inactive score 0 (a miss).
 * Returns { players, multiple, top: { players, hits, hitRate, minScore },
 * slate: { players, hits, hitRate }, lift }.
 */
export function decileValidation(rows, { multiple = 5, scoreKey = 'score' } = {}) {
  const scored = rows.filter(p => num(p.actualPoints) !== null && num(p.salary) > 0 && num(p[scoreKey]) !== null);
  const hits = (list) => list.filter(p => num(p.actualPoints) >= multiple * num(p.salary) / 1000).length;
  const rate = (h, n) => (n > 0 ? round(h / n, 3) : null);
  const top = [...scored].sort((a, b) => num(b[scoreKey]) - num(a[scoreKey])).slice(0, Math.ceil(scored.length / 10));
  const topHits = hits(top);
  const slateHits = hits(scored);
  const topRate = rate(topHits, top.length);
  const slateRate = rate(slateHits, scored.length);
  return {
    players: scored.length,
    multiple,
    top: { players: top.length, hits: topHits, hitRate: topRate, minScore: top.length ? num(top[top.length - 1][scoreKey]) : null },
    slate: { players: scored.length, hits: slateHits, hitRate: slateRate },
    lift: topRate !== null && slateRate > 0 ? round(topRate / slateRate, 2) : null
  };
}

export default { componentScores, opportunityScore, reasonLine, decileValidation };
