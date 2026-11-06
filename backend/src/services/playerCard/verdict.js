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
 *
 * Slate size (optional second argument, slateContext.js buildSlateContext):
 * the same player is not the same play on a 2-game and an 11-game slate.
 * With a slate context, ownership is scored relative to the slate's average
 * projected ownership and the value / stud / blowout / pivot rules come from
 * SLATE_RULES[sizeBucket]. Without one the engine behaves exactly as before
 * (LEGACY_RULES: absolute 8% / 30% ownership cut-offs).
 */

export const VERDICTS = Object.freeze(['Core play', 'Playable', 'Pivot', 'Fade']);
export const THRESHOLDS = Object.freeze({ core: 66, playable: 54, pivot: 42 });
export const MATCHUP_CAP = 3;
export const FADE_HIT_DEFAULT = 0.66;
export const STUD_SALARY = 9500;
export const BLOWOUT_SPREAD = 10;
export const LEAGUE_IMPLIED = 114;

/**
 * Per slate-size rules (the refit target). Ownership cut-offs are multiples
 * of the slate's average projected ownership: leverageRatio 0.6 on an 11-game
 * slate averaging 4% = under 2.4% owned; chalkRatio 2.5 on a 2-game slate
 * averaging 17% = 42%+. Medium equals the legacy absolute rules at an 8%
 * average. Round starting values, not fitted: see the by-slate-size section
 * of verdictBacktest.js.
 */
export const SLATE_RULES = Object.freeze({
  small: Object.freeze({
    maxGames: 3,
    valueBaseline: 4.5,          // value matters less: the studs are forced in
    ceilingBaseline: 7,
    leverageRatio: 0.8,
    chalkRatio: 2.5,
    studsExemptFromChalk: true,  // a stud at 40%+ is normal here, not chalk
    studsPerGame: 2,             // stud = $9.5K+ or a top-2-per-game salary
    stud: Object.freeze({ cash: 6, gpp: 5 }),
    blowout: Object.freeze({ cash: -8, gpp: -4 }), // whole lineup tied to 1-3 games
    fadeNeedsPivot: true,        // no similar-salary alternative: Fade -> Pivot
    pivotBand: 500,              // similar salary = within $500
    pivotShare: 0.9,             // ... projecting 90%+ of his points
  }),
  medium: Object.freeze({
    maxGames: 7,
    valueBaseline: 5,
    ceilingBaseline: 7,
    leverageRatio: 1,
    chalkRatio: 3.75,
    studsExemptFromChalk: false,
    studsPerGame: null,
    stud: Object.freeze({ cash: 3, gpp: 2 }),
    blowout: Object.freeze({ cash: -5, gpp: -2 }),
    fadeNeedsPivot: false,
  }),
  large: Object.freeze({
    maxGames: Infinity,
    valueBaseline: 5,
    ceilingBaseline: 7,
    leverageRatio: 0.6,          // low ownership is the norm: leverage has to be truly low
    chalkRatio: 3.75,
    studsExemptFromChalk: false,
    studsPerGame: null,
    stud: Object.freeze({ cash: 3, gpp: 2 }),
    blowout: Object.freeze({ cash: -5, gpp: -2 }),
    fadeNeedsPivot: false,
  }),
});

/** The rules without slate context (absolute ownership cut-offs). */
export const LEGACY_RULES = Object.freeze({
  valueBaseline: 5,
  ceilingBaseline: 7,
  leverageOwn: 8,
  chalkOwn: 30,
  studsExemptFromChalk: false,
  studsPerGame: null,
  stud: Object.freeze({ cash: 3, gpp: 2 }),
  blowout: Object.freeze({ cash: -5, gpp: -2 }),
  fadeNeedsPivot: false,
});

/** 'small' (<= 3 games), 'medium' (4-7), 'large' (8+); null without a game count. */
export function sizeBucketFor(gameCount) {
  const n = Number(gameCount);
  if (gameCount === null || gameCount === undefined || !Number.isFinite(n) || n <= 0) return null;
  if (n <= SLATE_RULES.small.maxGames) return 'small';
  if (n <= SLATE_RULES.medium.maxGames) return 'medium';
  return 'large';
}

/** "a 2-game slate" / "an 8-game slate" / "an 11-game slate". */
const withArticle = (label) => `${/^(8|11|18)\b/.test(String(label)) ? 'an' : 'a'} ${label}`;

const finite =(v) => typeof v === 'number' && Number.isFinite(v);
const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const f1 = (x) => Number(x).toFixed(1);
const signed = (x, d = 1) => `${x >= 0 ? '+' : ''}${Number(x).toFixed(d)}`;
const pct = (x) => `${Math.round(Number(x) * 100)}%`;

const TAG_WORDS = { QUES: 'Questionable', PROB: 'Probable', DOUBT: 'Doubtful', GTD: 'Game-time decision' };
const OUT_RE = /^(out|o|inactive|ofs|suspended|injured reserve|ir)$/i;
const RISK_RE = /^(gtd|q|ques|questionable|doubt|doubtful|d|game time decision|day-to-day|dtd)$/i;
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
 *   injuryTag, injuryPlayProb, injuryDiscount, projectionIfPlays - the source
 *     layer's injury-tag risk (projections/sourceLayer.js applyInjuryRisk):
 *     projection is then already the risk-adjusted one (P(play) x if-plays)
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
export function buildVerdict(s = {}, slate = null) {
  const sized = Boolean(slate && SLATE_RULES[slate.sizeBucket]);
  const R = sized ? SLATE_RULES[slate.sizeBucket] : LEGACY_RULES;
  const slateLabel = sized ? (slate.label ?? `${slate.gameCount}-game slate`) : null;
  const aSlate = slateLabel ? withArticle(slateLabel) : null;
  // The slate-agnostic call on the same signals: says whether slate size changed it
  const legacy = sized ? buildVerdict(s) : null;
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
      confidence: 95, s, value, forced: 'Fade', slate
    });
  }

  // --- Minutes / role / injury (largest weights) ---------------------------
  const injuryP = num(s.injuryPlayProb);
  if (injuryP !== null && injuryP < 1) {
    // A zero sinks a cash lineup: the penalty grows with the DNP chance; GPPs mostly price it via the projection
    const tagWord = TAG_WORDS[s.injuryTag] ?? s.injuryStatus ?? 'Tagged';
    const discount = num(s.injuryDiscount);
    const ifPlays = num(s.projectionIfPlays);
    const adj = discount !== null && discount < 1 && ifPlays !== null
      ? `; projection shown x${discount.toFixed(2)} (if he plays: ${ifPlays.toFixed(1)})` : '';
    add('injury_risk', {
      cash: -clamp(35 * (1 - injuryP), 2, 20),
      gpp: -clamp(10 * (1 - injuryP), 1, 6),
      text: `${tagWord}: plays ~${pct(injuryP)} of the time${adj}`,
      blurb: `the ${s.injuryTag ?? s.injuryStatus} tag means he plays only ~${pct(injuryP)} of the time`
    });
  } else if (isRisky(s.injuryStatus)) {
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
    const cashPts = clamp((value - R.valueBaseline) * 7, -14, 12);
    const gppPts = clamp((value - R.valueBaseline) * 3, -6, 6);
    if (Math.abs(cashPts) >= 2) {
      const bar = sized && R.valueBaseline !== LEGACY_RULES.valueBaseline ? ` (the bar is ${R.valueBaseline}x on ${aSlate})` : '';
      add('value', { cash: cashPts, gpp: gppPts, text: `${projection.toFixed(1)} projected = ${value.toFixed(2)}x value at $${salary.toLocaleString('en-US')}${bar}` });
    }
  }
  const p90 = num(s.p90);
  if (p90 !== null && salaryK) {
    const ceilX = p90 / salaryK;
    const pts = clamp((ceilX - R.ceilingBaseline) * 4, -8, 10);
    if (Math.abs(pts) >= 2) add('ceiling', { gpp: pts, text: `90th-percentile outcome ${p90.toFixed(1)} (${ceilX.toFixed(1)}x)` });
  }
  // A stud: $9.5K+, or on a small slate one of its top-2-per-game salaries (slate.studSalary)
  const studLine = R.studsPerGame && num(slate?.studSalary) !== null ? Math.min(STUD_SALARY, num(slate.studSalary)) : STUD_SALARY;
  const isStud = salary !== null && salary >= studLine;
  const own = num(s.rostership);
  const avgOwn = sized ? num(slate.ownership?.avg) : null;
  let studChalkExempt = false;
  if (own !== null && projection !== null && avgOwn > 0) {
    // Relative to the slate: own / the slate's average projected ownership
    const ratio = own / avgOwn;
    const avgText = `${f1(avgOwn)}%`;
    let pts = 0;
    if (ratio < R.leverageRatio && (value ?? 0) >= R.valueBaseline - 0.2) {
      pts = clamp(((R.leverageRatio - ratio) / R.leverageRatio) * 9.6, 0, 8);
    } else if (isStud && R.studsExemptFromChalk && (ratio >= R.chalkRatio || own >= LEGACY_RULES.chalkOwn)) {
      // Chalky by the slate's or the absolute line, but a stud on a small slate: say why it is not penalised
      studChalkExempt = true;
      notes.push(`${f1(own)}% owned is normal for a stud on ${aSlate} (slate average ${avgText}) - no chalk penalty.`);
    } else if (ratio >= R.chalkRatio) {
      pts = -clamp(((ratio - R.chalkRatio) / R.chalkRatio) * 10.5, 0, 7);
    }
    if (pts) {
      add('ownership', {
        gpp: pts,
        text: pts > 0
          ? `Only ${f1(own)}% projected owned on ${aSlate} (${ratio.toFixed(1)}x the ${avgText} average) - leverage`
          : `Chalky for ${aSlate}: ${f1(own)}% projected owned (${ratio.toFixed(1)}x the ${avgText} average)`,
      });
    }
  } else if (own !== null && projection !== null) {
    let pts = 0;
    if (own < LEGACY_RULES.leverageOwn && (value ?? 0) >= 4.8) pts = clamp((LEGACY_RULES.leverageOwn - own) * 1.2, 0, 8);
    else if (own >= LEGACY_RULES.chalkOwn) pts = -clamp((own - LEGACY_RULES.chalkOwn) * 0.35, 0, 7);
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
      cash: R.blowout.cash, gpp: R.blowout.gpp,
      text: `${Math.abs(spread).toFixed(1)}-point spread - blowout risk to his minutes${
        sized && R.blowout.cash !== LEGACY_RULES.blowout.cash ? `, and it weighs more on ${aSlate}` : ''}`,
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
  if (isStud) {
    add('stud', {
      cash: R.stud.cash, gpp: R.stud.gpp,
      text: sized && R.studsPerGame
        ? `Top-salary stud on ${aSlate}: studs are near must-plays with so few games`
        : 'Top-salary studs have beaten projections by ~5 pts lately',
    });
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

  let cash = 50 + rules.reduce((t, r) => t + r.cash, 0);
  let gpp = 50 + rules.reduce((t, r) => t + r.gpp, 0);

  // Small slates: a Fade needs somewhere to go. No similar-salary alternative -> Pivot.
  if (sized && R.fadeNeedsPivot && projection !== null && salary !== null && Array.isArray(slate.pool)) {
    const lift = (score) => {
      const rounded = Math.round(clamp(score, 0, 100));
      return rounded < THRESHOLDS.pivot ? THRESHOLDS.pivot - rounded : 0;
    };
    const cashLift = lift(cash);
    const gppLift = lift(gpp);
    if ((cashLift || gppLift) && !hasPivot(s, slate.pool, R, salary, projection)) {
      rules.push({
        key: 'no_pivot', cash: cashLift, gpp: gppLift, weight: 0,
        text: `No viable pivot within $${R.pivotBand} on ${aSlate} - a Pivot, not a Fade`,
        blurb: `there is no viable pivot within $${R.pivotBand} of his salary on ${aSlate}, so he is a pivot rather than a fade`,
      });
      cash += cashLift;
      gpp += gppLift;
    }
  }
  return finish({ cash, gpp, rules, notes, cap, s, value, slate: sized ? slate : null, studChalkExempt, legacy });
}

/** Another playable slate player (slate.pool: not OUT / tagged) within the salary band projecting pivotShare+ of his points. */
function hasPivot(s, pool, R, salary, projection) {
  const self = s.id === undefined || s.id === null ? null : String(s.id);
  return pool.some(o => (self === null ? o.name !== s.name : String(o.id) !== self)
    && Math.abs(o.salary - salary) <= R.pivotBand
    && o.projection >= projection * R.pivotShare);
}

const round1 = (x) => Math.round(x * 10) / 10 + 0;

function confidence(score, cap) {
  const decisive = Math.abs(score - 50);
  return Math.round(clamp(40 + decisive * 1.4, 35, cap));
}

function finish({
  cash, gpp, rules, notes, cap = 92, s, value, confidence: fixed = null, forced = null, slate = null, studChalkExempt = false, legacy = null,
}) {
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
  if (slate && SLATE_RULES[slate.sizeBucket]) {
    const label = slate.label ?? `${slate.gameCount}-game slate`;
    const changed = Boolean(legacy) && (legacy.cash.verdict !== out.cash.verdict || legacy.gpp.verdict !== out.gpp.verdict);
    // The slate-specific reason (its text names the slate) behind a changed call
    const slateReason = rules.find(r => r.key === 'no_pivot')?.text
      ?? [...rules].sort((a, b) => b.weight - a.weight).find(r => r.text.includes(label))?.text
      ?? (studChalkExempt ? notes.find(n => n.includes(label)) : null) ?? null;
    out.slate = {
      gameCount: slate.gameCount, sizeBucket: slate.sizeBucket, label,
      avgOwnership: num(slate.ownership?.avg), studChalkExempt,
      changed,
      legacy: legacy ? { cash: legacy.cash.verdict, gpp: legacy.gpp.verdict } : null,
      note: changed ? slateReason : null,
    };
  }
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
  const ordered = [...v.rules].filter(r => r.key !== 'fade' && r.key !== 'no_pivot' && r.weight >= 1.5).sort((a, b) => b.weight - a.weight);
  const pos = ordered.filter(r => r.cash + r.gpp > 0).slice(0, 2);
  const neg = ordered.filter(r => r.cash + r.gpp < 0).slice(0, 2);
  const lower = (t) => t.charAt(0).toLowerCase() + t.slice(1);
  if (pos.length) sentences.push(`${cap(pos.map((r, i) => (i ? lower(r.blurb) : r.blurb)).join(', and '))}.`);
  if (neg.length) sentences.push(`On the other side: ${neg.map(r => lower(r.blurb)).join('; ')}.`);
  const fade = v.rules.find(r => r.key === 'fade');
  const noPivot = v.rules.find(r => r.key === 'no_pivot');
  if (fade && noPivot) sentences.push(`${fade.text}, but ${noPivot.blurb}.`);
  else if (fade) sentences.push(`${fade.text} - trust the fade.`);
  else if (noPivot) sentences.push(`${cap(noPivot.blurb)}.`);
  else if (v.notes.length) sentences.push(v.notes[0]);
  const own = num(s.rostership);
  const proj = num(s.projection);
  const discount = num(s.injuryDiscount);
  const ifPlays = num(s.projectionIfPlays);
  const riskAdj = discount !== null && discount < 1 && ifPlays !== null
    ? ` (risk-adjusted x${discount.toFixed(2)} for the ${s.injuryTag ?? 'injury'} tag; ${ifPlays.toFixed(1)} if he plays)` : '';
  const tail = [
    proj !== null ? `${s.sourceLabel ?? 'Projection'} ${proj.toFixed(1)}${riskAdj}` : null,
    own !== null ? `${f1(own)}% owned${v.slate?.studChalkExempt ? ` (normal for a stud on ${withArticle(v.slate.label)})` : ''}` : null,
    value !== null ? `${value.toFixed(2)}x` : null,
  ].filter(Boolean).join(', ');
  const onSlate = v.slate?.changed ? ` on ${withArticle(v.slate.label)}` : '';
  sentences.push(`${tail ? `${tail}: ` : ''}${SUMMARY[v.cash.verdict]} in cash, ${SUMMARY[v.gpp.verdict]} in GPPs${onSlate}.`);
  if (!pos.length && !neg.length && !fade && !noPivot) sentences.unshift(`Not much separates ${name} from his projection tonight.`);
  return sentences.slice(0, 4).join(' ');
}

const cap = (t) => t.charAt(0).toUpperCase() + t.slice(1);

export default { buildVerdict, buildBlurb, verdictFor, sizeBucketFor, VERDICTS, THRESHOLDS, MATCHUP_CAP, SLATE_RULES, LEGACY_RULES };
