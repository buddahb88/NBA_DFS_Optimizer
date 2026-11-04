/**
 * PLAYER CARD VERDICT
 *
 * Deterministic, explainable rules engine: the card's signals -> a CASH and a
 * GPP verdict ("Core play" / "Playable" / "Pivot" / "Fade"), a 0-100
 * confidence, reasons for / against and a 2-4 sentence blurb that cites the
 * numbers. Pure (no DB, no LLM).
 *
 * Every rule adds points to the cash and / or GPP score (both start at 50).
 * Weights follow what our backtests showed:
 *   - minutes / role / injury news matter most (largest weights)
 *   - fade flag "ours lower by 4+" hit ~66-70%: trusted, heavy weight
 *   - "ours higher" has no proven edge: noted, never scored
 *   - archetype DVP is a tiebreaker only (backtest: weight above 0.75 hurt),
 *     capped at +-MATCHUP_CAP so it can never drive a verdict on its own
 *   - top-salary studs have beaten projections ~5 pts lately: small bump
 */

export const VERDICTS = Object.freeze(['Core play', 'Playable', 'Pivot', 'Fade']);
export const THRESHOLDS = Object.freeze({ core: 66, playable: 54, pivot: 42 });
export const MATCHUP_CAP = 3;
export const FADE_HIT_DEFAULT = 0.66;
export const STUD_SALARY = 9500;
export const BLOWOUT_SPREAD = 10;
export const LEAGUE_IMPLIED = 114;

const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const f1 = (x) => Number(x).toFixed(1);
const signed = (x, d = 1) => `${x >= 0 ? '+' : ''}${Number(x).toFixed(d)}`;
const pct = (x) => `${Math.round(Number(x) * 100)}%`;

const OUT_RE = /^(out|o|inactive|ofs|suspended|injured reserve|ir)$/i;
const RISK_RE = /^(gtd|q|questionable|doubtful|d|game time decision|day-to-day|dtd)$/i;
export const isOut = (status) => OUT_RE.test(String(status ?? '').trim());
export const isRisky = (status) => RISK_RE.test(String(status ?? '').trim());

export function verdictFor(score) {
  if (score >= THRESHOLDS.core) return 'Core play';
  if (score >= THRESHOLDS.playable) return 'Playable';
  if (score >= THRESHOLDS.pivot) return 'Pivot';
  return 'Fade';
}

/**
 * Signals the engine reads (all optional; missing ones simply do not fire):
 *   name, salary, injuryStatus, pPlay
 *   projection (active), rotowire, ours, sourceLabel, p90 (ceiling), pBoom
 *   rostership (percent)
 *   fade: { points_diff, hit_rate, n } | null, oursDiff (ours - RotoWire)
 *   minutesL5, minutesSeason, minutesDelta (L5 - season), projectedMinutes, oursMinutes
 *   startedLast, starterChange ('to_starter' | 'to_bench' | null)
 *   teammatesOut: [names], teammateMinDelta, teammateGames
 *   hit5xRate, hit5xGames, stdDev, games (history sample)
 *   matchupDelta (FP over expectation), matchupRank, matchupTeams, matchupLabel, opponent
 *   impliedTotal, spread
 *   radarCash, radarGpp (0-100)
 *   trackBias (actual - projection), trackN
 */
export function buildVerdict(s = {}) {
  const rules = [];
  const notes = [];
  const add = (key, { cash = 0, gpp = 0, text, blurb = null, weight = null }) => {
    if (!cash && !gpp) return;
    rules.push({ key, cash: round1(cash), gpp: round1(gpp), text, blurb: blurb ?? text, weight: round1(weight ?? Math.max(Math.abs(cash), Math.abs(gpp))) });
  };

  const salary = num(s.salary);
  const projection = num(s.projection);
  const salaryK = salary > 0 ? salary / 1000 : null;
  const value = projection !== null && salaryK ? projection / salaryK : null;

  // Ruled out: nothing else matters
  if (isOut(s.injuryStatus)) {
    const text = `Listed ${s.injuryStatus} - not playing`;
    return finish({
      cash: 0, gpp: 0, rules: [{ key: 'injury_out', cash: -50, gpp: -50, text, blurb: text, weight: 50 }], notes,
      confidence: 95, s, value, forced: 'Fade'
    });
  }

  // --- Minutes / role / injury (largest weights) ---------------------------
  if (isRisky(s.injuryStatus)) {
    add('injury_risk', { cash: -12, gpp: -4, text: `Injury tag: ${s.injuryStatus} - minutes not guaranteed` });
  }
  const pPlay = num(s.pPlay);
  if (pPlay !== null && pPlay < 0.85) {
    add('p_play', { cash: -10 * (0.85 - pPlay) / 0.35 - 4, gpp: -3, text: `Our model gives him a ${pct(pPlay)} chance to play` });
  }
  const minDelta = num(s.minutesDelta);
  if (minDelta !== null && Math.abs(minDelta) >= 2 && num(s.minutesL5) !== null) {
    const pts = clamp(minDelta * 1.6, -10, 10);
    add('minutes_trend', {
      cash: pts, gpp: pts * 0.8,
      text: `Minutes ${minDelta > 0 ? 'up' : 'down'} ${f1(Math.abs(minDelta))} over L5 (${f1(s.minutesL5)} vs ${f1(s.minutesSeason)} season)`,
    });
  }
  const outs = Array.isArray(s.teammatesOut) ? s.teammatesOut.filter(Boolean) : [];
  const tmDelta = num(s.teammateMinDelta);
  if (outs.length && tmDelta !== null && Math.abs(tmDelta) >= 1.5) {
    const who = outs.length > 2 ? `${outs.slice(0, 2).join(', ')} +${outs.length - 2}` : outs.join(' and ');
    const sample = num(s.teammateGames) ? ` (${s.teammateGames} games without)` : '';
    const pts = clamp(tmDelta * 1.5, -8, 9);
    add('teammates_out', {
      cash: pts, gpp: pts,
      text: `${signed(tmDelta)} minutes when ${who} ${outs.length > 1 ? 'are' : 'is'} out${sample}`,
      blurb: `With ${who} out he has played ${signed(tmDelta)} minutes${sample}`,
    });
  }
  if (s.starterChange === 'to_starter') add('role', { cash: 5, gpp: 4, text: 'Moved into the starting lineup recently' });
  if (s.starterChange === 'to_bench') add('role', { cash: -6, gpp: -3, text: 'Moved to the bench recently' });

  // --- Projection source ----------------------------------------------------
  const fade = s.fade ?? null;
  if (fade && finite(num(fade.points_diff))) {
    const hit = num(fade.hit_rate) ?? FADE_HIT_DEFAULT;
    const trust = clamp((hit - 0.5) / (FADE_HIT_DEFAULT - 0.5), 0.5, 1.3);
    const record = num(fade.hit_rate) !== null ? `; that flag has hit ${pct(fade.hit_rate)}${fade.n ? ` of ${fade.n}` : ''}` : '';
    add('fade', {
      cash: -11 * trust, gpp: -9 * trust,
      text: `Our model is ${f1(Math.abs(fade.points_diff))} below RotoWire${record}`,
    });
  } else {
    const diff = num(s.oursDiff);
    if (diff !== null && diff >= 4) {
      notes.push(`Our model is ${f1(diff)} above RotoWire - "ours higher" has no proven edge, so it is not scored.`);
    }
  }

  // --- Value / ceiling / ownership --------------------------------------------
  if (value !== null) {
    const cashPts = clamp((value - 5) * 7, -14, 12);
    const gppPts = clamp((value - 5) * 3, -6, 6);
    if (Math.abs(cashPts) >= 2) {
      add('value', { cash: cashPts, gpp: gppPts, text: `${projection.toFixed(1)} projected = ${value.toFixed(2)}x value at $${salary.toLocaleString('en-US')}` });
    }
  }
  const p90 = num(s.p90);
  if (p90 !== null && salaryK) {
    const ceilX = p90 / salaryK;
    const pts = clamp((ceilX - 7) * 4, -8, 10);
    if (Math.abs(pts) >= 2) add('ceiling', { gpp: pts, text: `90th-percentile outcome ${p90.toFixed(1)} (${ceilX.toFixed(1)}x)` });
  }
  const own = num(s.rostership);
  if (own !== null && projection !== null) {
    let pts = 0;
    if (own < 8 && (value ?? 0) >= 4.8) pts = clamp((8 - own) * 1.2, 0, 8);
    else if (own >= 30) pts = -clamp((own - 30) * 0.35, 0, 7);
    if (pts) {
      add('ownership', {
        gpp: pts,
        text: pts > 0 ? `Only ${f1(own)}% projected owned - leverage` : `Chalky at ${f1(own)}% projected owned`,
      });
    }
  }
  const hit5 = num(s.hit5xRate);
  if (hit5 !== null && num(s.hit5xGames) >= 4) {
    const pts = clamp((hit5 - 0.45) * 22, -8, 8);
    if (Math.abs(pts) >= 2) {
      add('consistency', { cash: pts, gpp: pts * 0.3, text: `Hit 5x salary value in ${pct(hit5)} of his last ${s.hit5xGames} priced games` });
    }
  }

  // --- Environment --------------------------------------------------------------
  const implied = num(s.impliedTotal);
  if (implied !== null) {
    const pts = clamp((implied - LEAGUE_IMPLIED) * 0.5, -5, 5);
    if (Math.abs(pts) >= 1.5) add('implied', { cash: pts, gpp: pts, text: `Team implied for ${f1(implied)} points` });
  }
  const spread = num(s.spread);
  if (spread !== null && Math.abs(spread) >= BLOWOUT_SPREAD) {
    add('blowout', {
      cash: -5, gpp: -2,
      text: `${Math.abs(spread).toFixed(1)}-point spread - blowout risk to his minutes`,
    });
  }

  // --- Matchup: tiebreaker only ---------------------------------------------------
  const delta = num(s.matchupDelta);
  if (delta !== null && Math.abs(delta) >= 0.5) {
    const pts = clamp(delta * 0.75, -MATCHUP_CAP, MATCHUP_CAP);
    const rank = num(s.matchupRank);
    const teams = num(s.matchupTeams);
    const group = s.matchupLabel ? `${s.matchupLabel}s` : 'his archetype';
    let tier = `defense vs ${group}`;
    if (rank && teams) {
      if (rank <= 5) tier = `bottom-5 defense vs ${group}`;
      else if (rank > teams - 5) tier = `top-5 defense vs ${group}`;
      else tier = `mid-pack defense vs ${group} (#${rank} of ${teams} allowed)`;
    }
    add('matchup', {
      cash: pts, gpp: pts,
      text: `${s.opponent ? `${s.opponent}: ` : ''}${tier} (${signed(delta)} FP)`,
      blurb: `faces a ${tier} (${signed(delta)} FP)`,
    });
  }

  // --- Small priors ------------------------------------------------------------------
  if (salary !== null && salary >= STUD_SALARY) {
    add('stud', { cash: 3, gpp: 2, text: 'Top-salary studs have beaten projections by ~5 pts lately' });
  }
  const bias = num(s.trackBias);
  if (bias !== null && num(s.trackN) >= 5 && Math.abs(bias) >= 2) {
    const pts = clamp(bias * 0.5, -3, 3);
    add('track', {
      cash: pts, gpp: pts,
      text: `Has ${bias > 0 ? 'beaten' : 'missed'} his projection by ${f1(Math.abs(bias))} on average (${s.trackN} slates)`,
    });
  }
  const radarCash = num(s.radarCash);
  const radarGpp = num(s.radarGpp);
  if (radarCash !== null || radarGpp !== null) {
    const c = radarCash === null ? 0 : clamp((radarCash - 50) * 0.12, -4, 4);
    const g = radarGpp === null ? 0 : clamp((radarGpp - 50) * 0.12, -4, 4);
    if (Math.abs(c) >= 1.5 || Math.abs(g) >= 1.5) {
      add('radar', { cash: c, gpp: g, text: `Opportunity Radar ${radarCash ?? '-'} cash / ${radarGpp ?? '-'} GPP` });
    }
  }

  // Confidence: how decisive the score is, capped by how much data stands behind it
  const games = num(s.games) ?? 0;
  let cap = 92;
  if (games < 3) cap = 55;
  else if (games < 8) cap = 72;
  if (projection === null) cap = Math.min(cap, 45);

  const cash = 50 + rules.reduce((t, r) => t + r.cash, 0);
  const gpp = 50 + rules.reduce((t, r) => t + r.gpp, 0);
  return finish({ cash, gpp, rules, notes, cap, s, value });
}

const round1 = (x) => Math.round(x * 10) / 10 + 0;

function confidence(score, cap) {
  const decisive = Math.abs(score - 50);
  return Math.round(clamp(40 + decisive * 1.4, 35, cap));
}

function finish({ cash, gpp, rules, notes, cap = 92, s, value, confidence: fixed = null, forced = null }) {
  const cashScore = Math.round(clamp(cash, 0, 100));
  const gppScore = Math.round(clamp(gpp, 0, 100));
  const out = {
    cash: { verdict: forced ?? verdictFor(cashScore), score: cashScore, confidence: fixed ?? confidence(cashScore, cap) },
    gpp: { verdict: forced ?? verdictFor(gppScore), score: gppScore, confidence: fixed ?? confidence(gppScore, cap) },
    rules,
    reasonsFor: rules.filter(r => r.cash + r.gpp > 0).sort((a, b) => b.weight - a.weight).map(r => r.text),
    reasonsAgainst: rules.filter(r => r.cash + r.gpp < 0).sort((a, b) => b.weight - a.weight).map(r => r.text),
    notes,
  };
  out.blurb = buildBlurb(out, s, value);
  return out;
}

const SUMMARY = {
  'Core play': 'a core play',
  Playable: 'playable',
  Pivot: 'a pivot at best',
  Fade: 'a fade',
};

/** 2-4 sentences: the strongest drivers with their numbers, the source call, the verdicts. */
export function buildBlurb(v, s = {}, value = null) {
  const name = s.name ? String(s.name).split(' ').slice(-1)[0] : 'He';
  if (v.rules.some(r => r.key === 'injury_out')) {
    return `${s.name ?? 'He'} is listed ${s.injuryStatus} and will not play tonight. Fade in every format.`;
  }
  const sentences = [];
  const ordered = [...v.rules].filter(r => r.key !== 'fade' && r.weight >= 1.5).sort((a, b) => b.weight - a.weight);
  const pos = ordered.filter(r => r.cash + r.gpp > 0).slice(0, 2);
  const neg = ordered.filter(r => r.cash + r.gpp < 0).slice(0, 2);
  const lower = (t) => t.charAt(0).toLowerCase() + t.slice(1);
  if (pos.length) sentences.push(`${cap(pos.map((r, i) => (i ? lower(r.blurb) : r.blurb)).join(', and '))}.`);
  if (neg.length) sentences.push(`On the other side: ${neg.map(r => lower(r.blurb)).join('; ')}.`);
  const fade = v.rules.find(r => r.key === 'fade');
  if (fade) sentences.push(`${fade.text} - trust the fade.`);
  else if (v.notes.length) sentences.push(v.notes[0]);
  const own = num(s.rostership);
  const proj = num(s.projection);
  const tail = [
    proj !== null ? `${s.sourceLabel ?? 'Projection'} ${proj.toFixed(1)}` : null,
    own !== null ? `${f1(own)}% owned` : null,
    value !== null ? `${value.toFixed(2)}x` : null,
  ].filter(Boolean).join(', ');
  sentences.push(`${tail ? `${tail}: ` : ''}${SUMMARY[v.cash.verdict]} in cash, ${SUMMARY[v.gpp.verdict]} in GPPs.`);
  if (!pos.length && !neg.length && !fade) sentences.unshift(`Not much separates ${name} from his projection tonight.`);
  return sentences.slice(0, 4).join(' ');
}

const cap = (t) => t.charAt(0).toUpperCase() + t.slice(1);

export default { buildVerdict, buildBlurb, verdictFor, VERDICTS, THRESHOLDS, MATCHUP_CAP };
