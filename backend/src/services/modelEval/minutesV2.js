/**
 * MINUTES MODEL V2 (model evaluation harness projector "minutes_v2")
 *
 * Our minutes model, built and judged in the harness. Per player:
 *   minutes          point estimate for MAE: the median of the mixture "DNP with
 *                    probability shading x (1 - p_play), else the conditional
 *                    minutes distribution" (shading 0.7: between the conditional
 *                    median and the full mixture median)
 *   expected_minutes p_play x conditional minutes
 *   p_play           probability of playing (logistic)
 *   minutes_p10/p90  quantiles of the full mixture
 *   dk_points        minutes x FPPM (minutesModel.projectFppm: season FPPM shrunk
 *                    to the league, recent form, matchup, Vegas); p10 / p90 likewise
 *
 * Steps (features are point-in-time: featureStore.asOf / the day's context):
 *   1. Conditional minutes (if he plays): least-absolute-deviation regression on
 *      recency-weighted minutes (this season's games decayed by halfLife, last
 *      season's regular-season average counting as priorSeasonGames games: early
 *      in a season the blend leans on last season's role and moves to this
 *      season's as games come in), a short-memory average, role
 *      (start-conditional minutes, recent starts vs earlier: promotions /
 *      demotions), back-to-back, home, blowout risk (|expected margin| x starter
 *      / bench), playoffs, returning from missed games, team change, small
 *      samples. On slates with under 10 games the DK salary is a prior.
 *   2. p_play: logistic regression on the same history (appearance rate over
 *      the team's last 10 games, listed DNPs, games missed, role, sample size).
 *   3. Team minutes: the team's candidates (today's players plus anyone who
 *      played in its last 3 games this season and is not OUT or on another
 *      team) should total ~241 expected minutes. normalization x the gap is
 *      handed out by minutes variance (rookies and new roles absorb most) and,
 *      with OUT teammates, partly by measured with/without splits (an OUT
 *      regular leaves a gap; a returning one shrinks the others).
 *   4. Ranges: empirical quantiles of standardized residuals (player minutes
 *      volatility, shrunk to a prior) and of DK residuals.
 *
 * Expected margin (blowouts): view.expectedMargin - -spread on slates, the
 * as-of net rating gap x pace / 100 plus home court in replay.
 *
 * fit() estimates the coefficients, the team target and normalization share,
 * and the residual quantiles on the training window only (2024-25). Knobs
 * 2024-25 cannot identify (it has no prior season: priorSeasonGames) and the
 * shading / split weight were selected on 2025-26 validation (DEFAULT_PARAMS;
 * shading by the mean of played and incl.-DNP minutes MAE); the 2026-27
 * holdout and the slates were not used for any choice.
 */

import { buildOpponentFactors, computeWithWithoutSplit, projectFppm, resolveConfig } from '../minutesModel.js';
import { contextPlayer } from './evaluate.js';
import { quantile } from './metrics.js';

export const DEFAULT_PARAMS = Object.freeze({
  halfLife: 6,              // games
  shortHalfLife: 1.5,
  priorSeasonGames: 3,      // last season's regular-season average counts as this many recent games
  candidateGames: 3,        // team games a non-listed player must have played in to count toward the team total
  teamMinutes: 241.3,       // overwritten by fit() (average team minutes incl. overtime)
  normalization: 0.5,       // share of the team gap handed out (fit)
  headroomCap: 42,
  maxMinutes: 46,
  sigmaPrior: 5,            // minutes sd prior and its weight in games
  sigmaPriorGames: 5,
  sigmaNoHistory: 9,        // minutes sd of a player with no games (rookies take most of a team gap)
  normWeight: 'variance',   // team gap handed out by 'variance' (Gaussian conditioning) or 'minutes' (expected minutes x headroom)
  splitWeight: 0.5,         // with an OUT teammate: share of the gap handed out by measured with/without minutes splits
  splitGames: 60,           // team games searched for splits
  splitMinGames: 3,
  splitShrinkGames: 3,
  dkNoisePerMinute: 0.5,    // FP variance per minute (fppm^2 units) in the DK range
  shading: 0.7,             // point = median of the mixture with DNP mass shading x (1 - p_play); 0 = conditional median
  salaryPriorGames: 2,      // slates: weight of the salary prior vs games played
  rookieFppmShare: 0.8
});

const n = (v) => Number(v) || 0;
const addDays = (date, days) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const sigmoid = (z) => 1 / (1 + Math.exp(-z));
const QUANTILE_LEVELS = Array.from({ length: 99 }, (_, i) => (i + 1) / 100);

function decayedMean(games, halfLife, weightOf = () => 1) {
  let total = 0, weights = 0;
  games.forEach((g, i) => {
    const w = 0.5 ** (i / halfLife) * weightOf(g);
    total += w * n(g.minutes);
    weights += w;
  });
  return weights > 0 ? total / weights : null;
}

/**
 * Point-in-time features of one player on the view's date.
 * player: { key, team, isB2B, isHome, seasonType }; context: { margin, salary }.
 */
export function playerFeatures(view, player, { margin = 0, salary = null } = {}, params = DEFAULT_PARAMS) {
  const hist = view.playerGames(player.key); // played, current + prior season, most recent first
  const cur = hist.filter(g => g.season === view.season);
  // Last season enters as its regular-season average with the weight of priorSeasonGames
  // recent games, not through its last games (rest, tanking, playoffs)
  const priorRegular = hist.filter(g => g.season !== view.season && g.season_type === 'regular');
  const priorAvg = priorRegular.length ? priorRegular.reduce((s, g) => s + n(g.minutes), 0) / priorRegular.length : null;
  const priorWeight = priorAvg === null ? 0 : params.priorSeasonGames * Math.min(1, priorRegular.length / 10);
  let ewmL = null;
  {
    let total = priorWeight * (priorAvg ?? 0), weights = priorWeight;
    cur.forEach((g, i) => {
      const w = 0.5 ** (i / params.halfLife);
      total += w * n(g.minutes);
      weights += w;
    });
    if (weights > 0) ewmL = total / weights;
    else if (hist.length) ewmL = decayedMean(hist, params.halfLife); // playoffs-only history
  }
  const ewmS = cur.length ? decayedMean(cur, params.shortHalfLife) : ewmL;
  const seasonWeight = (g) => (g.season === view.season ? 1 : 0.35);

  const roleGames = cur.length >= 3 ? cur : hist;
  const st3 = roleGames.length ? roleGames.slice(0, 3).reduce((s, g) => s + n(g.is_starter), 0) / Math.min(3, roleGames.length) : 0;
  const older = roleGames.slice(3, 15);
  const stOlder = older.length ? older.reduce((s, g) => s + n(g.is_starter), 0) / older.length : st3;
  const started = hist.filter(g => n(g.is_starter) === 1);
  const bench = hist.filter(g => n(g.is_starter) !== 1);
  const startMin = started.length >= 2 ? decayedMean(started, params.halfLife, seasonWeight) : null;
  const benchMin = bench.length >= 2 ? decayedMean(bench, params.halfLife, seasonWeight) : null;
  const lastStarted = hist.length ? n(hist[0].is_starter) === 1 : false;
  const roleEst = (lastStarted ? startMin : benchMin) ?? ewmL;

  // Team games this season since his last game (missed: injury, rest, DNP)
  const teamGames = view.teamGames(player.team);
  const last = hist[0];
  let missed = 0;
  for (const g of teamGames) {
    if (last && g.game_date <= last.game_date) break;
    missed++;
  }
  // Appearances / listed DNPs over the team's last 10 games (this season, else last)
  const recentTeam = (teamGames.length ? teamGames : view.teamGames(player.team, { seasons: 'current+prior' })).slice(0, 10);
  const recentDates = new Set(recentTeam.map(g => g.game_date));
  const appeared = hist.filter(g => recentDates.has(g.game_date) && g.team === player.team).length;
  const appear10 = recentTeam.length ? appeared / recentTeam.length : 0;
  const statuses = view.playerStatuses(player.key).filter(s => recentDates.has(s.game_date));
  const dnp10 = recentTeam.length ? statuses.filter(s => String(s.status).toUpperCase() === 'DNP').length / recentTeam.length : 0;
  const lastTeamDate = recentTeam[0]?.game_date ?? null;
  const lastDnp = lastTeamDate !== null && statuses.some(s => s.game_date === lastTeamDate && String(s.status).toUpperCase() === 'DNP') ? 1 : 0;

  const vol = hist.slice(0, 10).map(g => n(g.minutes));
  const volMean = vol.length ? vol.reduce((s, v) => s + v, 0) / vol.length : 0;
  const volVar = vol.length > 1 ? vol.reduce((s, v) => s + (v - volMean) ** 2, 0) / (vol.length - 1) : 0;

  return {
    games: hist.length,
    gamesCur: cur.length,
    noHistory: hist.length === 0 ? 1 : 0,
    lowSample: hist.length > 0 && hist.length < 5 ? 1 : 0,
    ewmL: ewmL ?? 0,
    ewmS: ewmS ?? 0,
    roleEst: roleEst ?? 0,
    st3,
    roleShift: st3 - stOlder,
    missed: Math.min(missed, 10),
    returning: missed >= 2 && hist.length > 0 ? 1 : 0,
    teamChanged: last && last.team !== player.team ? 1 : 0,
    appear10,
    dnp10,
    lastDnp,
    b2b: player.isB2B ? 1 : 0,
    home: player.isHome ? 1 : 0,
    playoffs: player.seasonType === 'playoffs' ? 1 : 0,
    absMargin: Math.abs(n(margin)),
    salary: Number.isFinite(salary) && salary > 0 ? salary : null,
    volVar,
    volGames: vol.length
  };
}

/** Conditional-minutes regressors. */
export function condVector(f) {
  const m = f.ewmL;
  return [
    1, m, f.ewmS, f.roleEst, f.st3, f.roleShift,
    f.b2b, f.b2b * f.st3, f.home,
    f.absMargin * f.st3, f.absMargin * (1 - f.st3),
    f.playoffs, f.playoffs * m,
    f.returning, f.returning * m, f.teamChanged, f.teamChanged * m,
    f.noHistory, f.lowSample, f.lowSample * m
  ];
}

/** p_play regressors. */
export function playVector(f) {
  return [
    1, f.ewmL / 10, (f.ewmL / 10) ** 2, f.appear10, f.dnp10, f.lastDnp,
    f.returning, Math.log1p(f.missed), f.noHistory, f.lowSample, f.st3, f.teamChanged, f.playoffs
  ];
}

// Hand-set coefficients for an unfitted projector (tests, quick runs); fit() replaces them
const FALLBACK_COND = (() => {
  const c = new Array(condVector(zeroFeatures()).length).fill(0);
  c[1] = 0.6; c[2] = 0.2; c[3] = 0.2; c[17] = 12; // ewmL, ewmS, roleEst, noHistory
  return c;
})();
const FALLBACK_PLAY = (() => {
  const c = new Array(playVector(zeroFeatures()).length).fill(0);
  c[0] = -1; c[1] = 1.5; c[3] = 2.5; c[4] = -2; c[8] = 1.5;
  return c;
})();

function zeroFeatures() {
  return { ewmL: 0, ewmS: 0, roleEst: 0, st3: 0, roleShift: 0, b2b: 0, home: 0, absMargin: 0, playoffs: 0, returning: 0, teamChanged: 0, noHistory: 0, lowSample: 0, appear10: 0, dnp10: 0, lastDnp: 0, missed: 0 };
}

const dot = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0);

/** Solve A x = b (Gaussian elimination with partial pivoting); A is modified. */
function solve(A, b) {
  const k = b.length;
  for (let i = 0; i < k; i++) {
    let p = i;
    for (let r = i + 1; r < k; r++) if (Math.abs(A[r][i]) > Math.abs(A[p][i])) p = r;
    [A[i], A[p]] = [A[p], A[i]];
    [b[i], b[p]] = [b[p], b[i]];
    const piv = A[i][i] || 1e-12;
    for (let r = i + 1; r < k; r++) {
      const f = A[r][i] / piv;
      if (!f) continue;
      for (let c = i; c < k; c++) A[r][c] -= f * A[i][c];
      b[r] -= f * b[i];
    }
  }
  const x = new Array(k).fill(0);
  for (let i = k - 1; i >= 0; i--) {
    let s = b[i];
    for (let c = i + 1; c < k; c++) s -= A[i][c] * x[c];
    x[i] = s / (A[i][i] || 1e-12);
  }
  return x;
}

export function weightedLeastSquares(X, y, w, ridge = 1e-3) {
  const k = X[0].length;
  const A = Array.from({ length: k }, () => new Array(k).fill(0));
  const b = new Array(k).fill(0);
  for (let i = 0; i < X.length; i++) {
    const xi = X[i];
    const wi = w[i];
    for (let r = 0; r < k; r++) {
      if (!xi[r]) continue;
      const v = wi * xi[r];
      b[r] += v * y[i];
      for (let c = 0; c < k; c++) A[r][c] += v * xi[c];
    }
  }
  for (let r = 1; r < k; r++) A[r][r] += ridge * X.length;
  return solve(A, b);
}

/** Least-absolute-deviation regression (IRLS). */
export function fitLad(X, y, { iterations = 40, eps = 0.25 } = {}) {
  let beta = weightedLeastSquares(X, y, X.map(() => 1));
  for (let it = 0; it < iterations; it++) {
    const w = X.map((x, i) => 1 / Math.max(eps, Math.abs(y[i] - dot(x, beta))));
    beta = weightedLeastSquares(X, y, w);
  }
  return beta;
}

/** Logistic regression (Newton / IRLS, light L2). */
export function fitLogistic(X, y, { iterations = 25, l2 = 1e-4 } = {}) {
  const k = X[0].length;
  let beta = new Array(k).fill(0);
  for (let it = 0; it < iterations; it++) {
    const A = Array.from({ length: k }, () => new Array(k).fill(0));
    const g = new Array(k).fill(0);
    for (let i = 0; i < X.length; i++) {
      const x = X[i];
      const p = sigmoid(dot(x, beta));
      const w = Math.max(1e-6, p * (1 - p));
      for (let r = 0; r < k; r++) {
        if (!x[r]) continue;
        g[r] += (y[i] - p) * x[r];
        for (let c = 0; c < k; c++) A[r][c] += w * x[r] * x[c];
      }
    }
    for (let r = 0; r < k; r++) { A[r][r] += l2 * X.length; g[r] -= l2 * X.length * beta[r]; }
    const step = solve(A, g);
    beta = beta.map((b, i) => b + step[i]);
    if (Math.max(...step.map(Math.abs)) < 1e-6) break;
  }
  return beta;
}

/** Inverse CDF from stored quantiles (levels QUANTILE_LEVELS), linear in between, clamped at the ends. */
function fromQuantiles(qs, tau) {
  if (!qs) return 0;
  const pos = tau * 100 - 1;
  if (pos <= 0) return qs[0];
  if (pos >= qs.length - 1) return qs[qs.length - 1];
  const lo = Math.floor(pos);
  return qs[lo] + (qs[lo + 1] - qs[lo]) * (pos - lo);
}

const DEFAULT_Z = QUANTILE_LEVELS.map(t => {
  // standard normal quantile (Acklam-free approximation good enough for a fallback)
  const a = Math.sqrt(-2 * Math.log(t < 0.5 ? t : 1 - t));
  const z = a - (2.515517 + 0.802853 * a + 0.010328 * a * a) / (1 + 1.432788 * a + 0.189269 * a * a + 0.001308 * a ** 3);
  return t < 0.5 ? -z : z;
});

/** Mixture quantile: DNP (0) with probability q = 1 - pPlay, else center + sigma x z(tau') (z: fitted standardized residual quantiles, normal by default). */
export function mixtureQuantile(tau, pPlay, center, sigma, zq = null) {
  const q = 1 - pPlay;
  if (tau <= q) return 0;
  return Math.max(0, center + sigma * fromQuantiles(zq ?? DEFAULT_Z, (tau - q) / (1 - q)));
}

/**
 * The team's candidates for minutes on the date: today's players (not OUT)
 * plus anyone who played in its last `candidateGames` games, is not listed
 * OUT, and is not with another team (latest game elsewhere or today's
 * player elsewhere).
 */
export function teamCandidates(view, team, todays, outKeys, elsewhere, params = DEFAULT_PARAMS) {
  const keys = new Map(todays.filter(p => !p.out && !outKeys.has(p.key)).map(p => [p.key, p]));
  // This season's games only: last season's roster includes players who have left
  const recent = view.teamGames(team).slice(0, params.candidateGames).map(g => g.game_id);
  const rows = recent.length ? view.teamPlayerRows(team, { games: recent.length }).filter(r => recent.includes(r.game_id)) : [];
  for (const r of rows) {
    if (keys.has(r.player_key) || outKeys.has(r.player_key) || elsewhere.has(r.player_key) || !(n(r.minutes) > 0)) continue;
    const latest = view.playerGames(r.player_key, { seasons: 'all' })[0];
    if (latest && latest.team !== team) continue;
    keys.set(r.player_key, { key: r.player_key, name: r.player_name, team, isB2B: false, isHome: false, seasonType: 'regular', extra: true });
  }
  return [...keys.values()];
}

/**
 * Hand normalization x (team target - expected minutes) to the candidates.
 * normWeight 'variance': in proportion to each player's minutes variance (the
 * Gaussian conditional mean given the team total: uncertain players - rookies,
 * new roles - absorb most of a gap); 'minutes': expected minutes x headroom.
 * Entries: { cond, pPlay, sigma }. Returns adjusted conditional minutes.
 */
export function normalizeTeam(entries, params) {
  const s = entries.reduce((t, e) => t + e.pPlay * e.cond, 0);
  const gap = params.normalization * (params.teamMinutes - s);
  const headroom = (e) => Math.max(0, params.headroomCap - e.cond) / params.headroomCap;
  let weights = entries.map(e => (params.normWeight === 'minutes'
    ? e.cond * Math.max(0, params.headroomCap - e.cond)
    : e.sigma ** 2 * (gap > 0 ? headroom(e) : Math.min(1, e.cond / 10))));
  // A gap with OUT teammates goes partly where the splits say his minutes went
  const splitTotal = entries.reduce((t, e) => t + e.pPlay * (e.splitGain ?? 0), 0);
  if (gap > 0 && splitTotal > 0 && params.splitWeight > 0) {
    const base = entries.reduce((t, e, i) => t + e.pPlay * weights[i], 0);
    const c = params.splitWeight * Math.min(1, entries[0]?.splitConfidence ?? 1);
    weights = weights.map((w, i) => (base > 0 ? (1 - c) * w / base : 0) + c * (entries[i].splitGain ?? 0) * headroom(entries[i]) / splitTotal);
  }
  // sum of p_play x adjustment equals the gap
  const total = entries.reduce((t, e, i) => t + e.pPlay * weights[i], 0);
  if (!(total > 0) || !gap) return entries.map(e => e.cond);
  return entries.map((e, i) => clamp(e.cond + (gap * weights[i]) / total, 0, params.maxMinutes));
}

/**
 * Minutes each candidate gained in past team games without the OUT players
 * (minutesModel.computeWithWithoutSplit over the team's last splitGames games,
 * shrunk by games without), and the confidence (games without / 8, max 1).
 */
export function splitGains(view, team, candidates, outList, params = DEFAULT_PARAMS) {
  const gains = new Map(candidates.map(p => [p.key, 0]));
  const relevant = outList.filter(o => n(o.expectedMinutes) >= 12);
  if (!relevant.length) return { gains, confidence: 0 };
  const logs = view.teamPlayerRows(team, { games: params.splitGames })
    .map(r => ({ key: r.player_key, date: r.game_date, gameId: r.game_id, minutes: n(r.minutes), fp: n(r.fp) }));
  const gameIds = new Set(logs.map(g => g.gameId));
  let confidence = 0;
  for (const o of relevant) {
    const withIds = new Set(logs.filter(g => g.key === o.key && g.minutes > 0).map(g => g.gameId));
    if (!withIds.size) continue;
    confidence = Math.max(confidence, Math.min(1, (gameIds.size - withIds.size) / 8));
    for (const p of candidates) {
      const split = computeWithWithoutSplit(logs, o.key, p.key, g => g.key);
      if (!split?.with || !split?.without || split.with.games < params.splitMinGames) continue;
      const k = split.without.games;
      gains.set(p.key, gains.get(p.key) + Math.max(0, (split.without.minutes - split.with.minutes) * k / (k + params.splitShrinkGames)));
    }
  }
  return { gains, confidence };
}

/** Minutes sd: the player's recent volatility shrunk to the prior (wide with no games). */
export function minutesSigma(f, params) {
  if (f.noHistory) return params.sigmaNoHistory;
  return Math.sqrt((f.volGames * f.volVar + params.sigmaPriorGames * params.sigmaPrior ** 2) / (f.volGames + params.sigmaPriorGames));
}

/**
 * Projections for every player of a date / slate.
 * dateCtx: harness dateCtx; model: { params, cond, play, zMinutes, zDk }.
 * Returns Map(`${key}|${team}` -> prediction (with features for fitting)).
 */
export function projectDate(dateCtx, model) {
  const { view, day, players, featureCache = null } = dateCtx;
  const params = model.params;
  const fppmConfig = resolveConfig();
  const factors = dateCtx.opponentFactors ?? buildOpponentFactors(view.minutesLogs(), fppmConfig);
  const fppmCache = dateCtx.fppmCache ?? null;
  const byTeam = new Map();
  for (const p of players) {
    if (!byTeam.has(p.team)) byTeam.set(p.team, []);
    byTeam.get(p.team).push(p);
  }
  const results = new Map();
  for (const [team, todays] of byTeam) {
    const teamDay = day.teams.get(team);
    const outKeys = new Set((teamDay?.out ?? []).map(o => o.key));
    const elsewhere = new Set(players.filter(p => p.team !== team).map(p => p.key));
    const first = todays[0];
    const spread = first.slate?.spread;
    const margin = view.expectedMargin(team, first.opponent, first.isHome, Number.isFinite(spread) ? spread : null);
    const cands = teamCandidates(view, team, todays, outKeys, elsewhere, params);
    const entries = cands.map(p => {
      const ctx = { ...p, isB2B: p.extra ? first.isB2B : p.isB2B, isHome: first.isHome, seasonType: p.extra ? first.seasonType : p.seasonType };
      const fk = `${p.key}|${team}`;
      let f = featureCache?.get(fk);
      if (!f) {
        f = playerFeatures(view, ctx, { margin, salary: p.slate?.salary ?? null }, params);
        featureCache?.set(fk, f);
      }
      let cond = clamp(dot(condVector(f), model.cond), 0, params.maxMinutes);
      if (f.salary && f.games < 10) {
        const w = f.games / (f.games + params.salaryPriorGames);
        cond = w * cond + (1 - w) * salaryMinutes(f.salary);
      }
      const pPlay = clamp(sigmoid(dot(playVector(f), model.play)), 0.01, 0.995);
      return { p, f, cond, pPlay, sigma: minutesSigma(f, params) };
    });
    if (params.splitWeight > 0 && teamDay?.out?.length) {
      const { gains, confidence } = splitGains(view, team, cands, teamDay.out, params);
      for (const e of entries) {
        e.splitGain = gains.get(e.p.key) ?? 0;
        e.splitConfidence = confidence;
      }
    }
    const adjusted = normalizeTeam(entries, params);
    entries.forEach((e, i) => {
      if (e.p.extra) return;
      e.raw = e.cond;
      e.cond = adjusted[i];
    });
    for (const e of entries) {
      if (e.p.extra) continue;
      const sigma = e.sigma;
      const zm = model.zMinutes ?? DEFAULT_Z;
      const minutesAt = (tau) => mixtureQuantile(tau, e.pPlay, e.cond, sigma, zm);
      const minutes = mixtureQuantile(0.5, 1 - params.shading * (1 - e.pPlay), e.cond, sigma, zm);
      let fppm = fppmCache?.get(e.p.key);
      if (fppm === undefined) {
        fppm = fppmFor(view, e.p.key, e.p.opponent, e.p.slate?.impliedTotal ?? null, factors, fppmConfig, params);
        fppmCache?.set(e.p.key, fppm);
      }
      const dkSigma = fppm * Math.sqrt(sigma ** 2 + params.dkNoisePerMinute * Math.max(e.cond, 1));
      const zd = model.zDk ?? DEFAULT_Z;
      const dkAt = (tau) => mixtureQuantile(tau, e.pPlay, e.cond * fppm, dkSigma, zd);
      results.set(`${e.p.key}|${team}`, {
        dk_points: minutes * fppm,
        minutes,
        expected_minutes: e.pPlay * e.cond,
        conditional_minutes: e.cond,
        p_play: e.pPlay,
        minutes_p10: minutesAt(0.1),
        minutes_p90: minutesAt(0.9),
        p10: dkAt(0.1),
        p90: dkAt(0.9),
        fppm,
        features: e.f,
        rawConditional: e.raw,
        sigma,
        dkSigma
      });
    }
  }
  return results;
}

/** DK salary -> minutes prior (hand-set: $3K ~ 10 min, +4 min per $1K, capped). */
export function salaryMinutes(salary) {
  return clamp(10 + 4 * (salary - 3000) / 1000, 6, 38);
}

function fppmFor(view, key, opponent, impliedTotal, factors, config, params) {
  const games = view.playerGames(key, { seasons: 'all' }).map(g => ({ minutes: n(g.minutes), fp: n(g.fp) }));
  const f = projectFppm(games, { opponent, impliedTotal, opponentFactors: factors }, config);
  return f?.fppm ?? factors.leagueFppm * params.rookieFppmShare;
}

/** Strip fitting-only fields from a prediction. */
export function publicPrediction(pred) {
  if (!pred) return null;
  const { features, rawConditional, sigma, dkSigma, ...rest } = pred;
  return rest;
}

/**
 * Fit on the training store (rows before the validation season): coefficients,
 * team target and normalization, residual quantiles. Returns a model.
 */
export function fitMinutesV2(store, { seasons = null, params = DEFAULT_PARAMS, dates = null, onDate = null } = {}) {
  const base = { params: { ...params }, cond: FALLBACK_COND, play: FALLBACK_PLAY, zMinutes: null, zDk: null };
  const trainDates = (dates ?? store.dates).filter(d => !seasons || seasons.includes(store.asOf(d).season));
  const fppmConfig = resolveConfig();
  // Per date: harness-shaped context (features / FPPM cached across passes) and outcomes
  const days = [];
  const firstDate = store.dates[0];
  let teamMinutes = 0, teamGames = 0;
  for (const date of trainDates) {
    const view = store.asOf(date);
    const day = store.gameDay(date);
    if (!day.players.length) continue;
    days.push({
      view,
      day: { teams: day.teams },
      players: day.players.map(p => ({ ...contextPlayer(p, view, day), slate: null })),
      outcomes: new Map(day.players.map(p => [`${p.key}|${p.team}`, p])),
      opponentFactors: buildOpponentFactors(view.minutesLogs(), fppmConfig),
      featureCache: new Map(),
      fppmCache: new Map(),
      dataStart: firstDate !== undefined && date < addDays(firstDate, 30)
    });
    // Team minutes incl. overtime (complete box scores only)
    const sums = new Map();
    for (const p of day.players) sums.set(p.team, (sums.get(p.team) ?? 0) + n(p.actual.minutes));
    for (const v of sums.values()) if (v >= 235) { teamMinutes += v; teamGames++; }
    onDate?.(date);
  }
  const each = (model, fn) => {
    for (const d of days) {
      for (const [k, pred] of projectDate(d, model)) {
        const o = d.outcomes.get(k);
        if (o) fn(pred, o, d);
      }
    }
  };

  const condX = [], condY = [], playX = [], playY = [];
  each(base, (pred, o, d) => {
    // Everyone is new in the first weeks of the first season on file: not what a
    // player without history looks like later (rookies, call-ups)
    if (pred.features.noHistory && d.dataStart) return;
    playX.push(playVector(pred.features));
    playY.push(o.played ? 1 : 0);
    if (o.played) {
      condX.push(condVector(pred.features));
      condY.push(o.actual.minutes);
    }
  });
  if (condX.length < 50) return base;
  base.cond = fitLad(condX, condY);
  base.play = fitLogistic(playX, playY);
  if (teamGames) base.params.teamMinutes = teamMinutes / teamGames;

  // Normalization share: grid on the training rows, conditional minutes MAE of played rows
  let best = null;
  for (const share of [0, 0.25, 0.5, 0.75, 1]) {
    const model = { ...base, params: { ...base.params, normalization: share } };
    let err = 0, cnt = 0;
    each(model, (pred, o) => {
      if (!o.played) return;
      err += Math.abs(pred.conditional_minutes - o.actual.minutes);
      cnt++;
    });
    if (!best || err / cnt < best.mae) best = { share, mae: err / cnt };
  }
  base.params.normalization = best.share;

  // Residual quantiles (played rows): minutes standardized by sigma, DK by dkSigma
  const zm = [], zd = [];
  each(base, (pred, o) => {
    if (!o.played) return;
    const z1 = (o.actual.minutes - pred.conditional_minutes) / pred.sigma;
    const z2 = (o.actual.dk - pred.conditional_minutes * pred.fppm) / pred.dkSigma;
    // A zero FPPM gives a zero DK sigma: no residual to learn from (and NaN breaks the sort)
    if (Number.isFinite(z1)) zm.push(z1);
    if (Number.isFinite(z2)) zd.push(z2);
  });
  zm.sort((a, b) => a - b);
  zd.sort((a, b) => a - b);
  base.zMinutes = QUANTILE_LEVELS.map(t => quantile(zm, t));
  base.zDk = QUANTILE_LEVELS.map(t => quantile(zd, t));
  base.fitInfo = { dates: days.length, condRows: condX.length, playRows: playX.length, normalization: best, teamMinutes: base.params.teamMinutes };
  return base;
}

/** Harness projector. options.params override DEFAULT_PARAMS; options.model skips fit. */
export function createMinutesV2Projector({ params = {}, model = null } = {}) {
  const resolved = { ...DEFAULT_PARAMS, ...params };
  let fitted = model ?? { params: resolved, cond: FALLBACK_COND, play: FALLBACK_PLAY, zMinutes: null, zDk: null };
  const memoKey = `minutes_v2|${JSON.stringify(resolved)}`;
  return {
    fit({ store, seasons }) {
      if (model) return;
      fitted = fitMinutesV2(store, { seasons, params: resolved });
    },
    prepareDate(dateCtx) {
      if (dateCtx.shared.has(memoKey)) return;
      dateCtx.shared.set(memoKey, projectDate(dateCtx, fitted));
    },
    project({ player, shared }) {
      if (player.out) return { dk_points: 0, minutes: 0, expected_minutes: 0, p_play: 0, minutes_p10: 0, minutes_p90: 0, p10: 0, p90: 0 };
      return publicPrediction(shared.get(memoKey)?.get(`${player.key}|${player.team}`) ?? null);
    },
    model: () => fitted
  };
}

export default { createMinutesV2Projector, fitMinutesV2, projectDate, playerFeatures, DEFAULT_PARAMS };
