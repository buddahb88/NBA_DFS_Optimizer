/**
 * CORRELATED SLATE SIMULATION ENGINE (pure, no DB access)
 *
 * Each player's score is lognormal (right-skewed, >= 0) with mean = projected_points
 * and stdev from variance.js. Correlation comes from a factor model on the
 * latent standard normal z that drives each player's lognormal draw:
 *
 *   z_i = a_g * G_game                 shared pace/total environment (both teams, +corr)
 *       + s_i * m * M_game             game script / margin (teammates +, opponents -)
 *       + b_t * C_i                    zero-sum usage competition among a team's top-usage players (-corr)
 *       + e_i * eps_i                  idiosyncratic noise, e_i = sqrt(1 - sum of squared loadings)
 *
 * Every component is unit variance and independent, so z_i ~ N(0,1) exactly and the
 * lognormal mean is preserved. a_g scales with the vegas total. The simulated margin
 * (vegas spread + 12 * M_game) also drives a blowout minutes adjustment: starters lose,
 * bench players gain, renormalized so each player's mean still matches the projection.
 */

import { createRng, randomSeed } from './rng.js';
import { derivePlayerSd } from './variance.js';

export const DEFAULTS = {
  iterations: 10000,
  leagueAvgTotal: 228,
  gameLoading: 0.3,           // a_g at a league-average total
  totalScaleMin: 0.85,
  totalScaleMax: 1.2,
  marginLoading: 0.15,        // m
  marginSd: 12,               // NBA final-margin stdev around the spread
  usagePairCorr: 0.2,         // competition-only correlation between any two top-usage teammates
  usageGroupMax: 3,
  blowoutThreshold: 10,       // margin beyond which rotations start to change
  starterMinutes: 30,
  benchMinutes: 22,
  starterCutPerPt: 0.015,
  starterCutFloor: 0.6,
  benchBoostPerPt: 0.025,
  benchBoostCap: 1.6,
  boomMultiple: 6             // DK boom = 6x salary/1000
};

const PERCENTILES = { p25: 0.25, p50: 0.5, p75: 0.75, p90: 0.9, p99: 0.99 };

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

export function playerKey(p) {
  return String(p.id ?? p.player_id ?? p.name);
}

function gameKeyFor(p) {
  const team = p.team || '';
  const opp = p.opponent || '';
  if (!team && !opp) return `__solo_${playerKey(p)}`;
  return [team, opp].sort().join('@');
}

/** Group players into games and derive per-game vegas environment. */
function buildGames(players, cfg) {
  const games = new Map();
  players.forEach((p, idx) => {
    const key = gameKeyFor(p);
    let g = games.get(key);
    if (!g) {
      const [refTeam] = key.split('@');
      g = { key, refTeam, totals: [], refSpreads: [], implied: new Map(), members: [] };
      games.set(key, g);
    }
    g.members.push(idx);
    const ou = num(p.vegas_over_under);
    if (ou && ou > 0) g.totals.push(ou);
    const spread = num(p.vegas_spread);
    if (spread !== null) g.refSpreads.push(p.team === g.refTeam ? spread : -spread);
    const implied = num(p.vegas_implied_total);
    if (implied && implied > 0 && p.team) g.implied.set(p.team, implied);
  });

  const median = (arr) => {
    if (!arr.length) return null;
    const s = [...arr].sort((x, y) => x - y);
    return s[Math.floor(s.length / 2)];
  };

  // Deterministic order regardless of input order quirks
  const ordered = [...games.values()].sort((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : 0));
  ordered.forEach((g, gi) => {
    g.index = gi;
    let total = median(g.totals);
    if (!total && g.implied.size === 2) total = [...g.implied.values()].reduce((s, v) => s + v, 0);
    g.total = total || cfg.leagueAvgTotal;
    let refSpread = median(g.refSpreads);
    if (refSpread === null && g.implied.size === 2) {
      const refImplied = g.implied.get(g.refTeam);
      const other = [...g.implied.entries()].find(([t]) => t !== g.refTeam)?.[1];
      if (refImplied && other) refSpread = other - refImplied;
    }
    g.refSpread = refSpread ?? 0;
    const scale = Math.min(cfg.totalScaleMax, Math.max(cfg.totalScaleMin, g.total / cfg.leagueAvgTotal));
    g.gameLoading = cfg.gameLoading * scale;
  });
  return ordered;
}

/** Top-usage players per team compete for the same possessions. */
function buildUsageGroups(players, cfg) {
  const byTeam = new Map();
  players.forEach((p, idx) => {
    if (!p.team) return;
    const minutes = num(p.projected_minutes);
    const salary = num(p.salary) || 0;
    const isRotationCore = minutes !== null ? minutes >= 24 : salary >= 6000;
    if (!isRotationCore) return;
    if (!byTeam.has(p.team)) byTeam.set(p.team, []);
    byTeam.get(p.team).push(idx);
  });

  const groups = [];
  for (const team of [...byTeam.keys()].sort()) {
    const idxs = byTeam.get(team);
    const usageOf = (i) => num(players[i].usage) ?? 0;
    const projOf = (i) => num(players[i].projected_points) ?? 0;
    idxs.sort((x, y) => usageOf(y) - usageOf(x) || projOf(y) - projOf(x) || x - y);
    const members = idxs.slice(0, cfg.usageGroupMax);
    if (members.length >= 2) {
      // C_i = (u_i - mean(u)) / sqrt(1 - 1/n) has pairwise corr -1/(n-1);
      // choose b^2 so the competition contribution to any pair is -usagePairCorr.
      const n = members.length;
      const loading = Math.sqrt(Math.min(0.5, cfg.usagePairCorr * (n - 1)));
      groups.push({ team, members, loading });
    }
  }
  return groups;
}

function playerRole(p, cfg) {
  const minutes = num(p.projected_minutes);
  const salary = num(p.salary) || 0;
  if (minutes !== null && minutes > 0) {
    if (minutes >= cfg.starterMinutes) return 'starter';
    if (minutes < cfg.benchMinutes) return 'bench';
    return 'core';
  }
  if (salary >= 7000) return 'starter';
  if (salary > 0 && salary < 4500) return 'bench';
  return 'core';
}

function sortedPercentile(sorted, q) {
  const pos = q * (sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.min(sorted.length - 1, lo + 1);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

const round2 = (v) => Math.round(v * 100) / 100;

/**
 * Run the simulation.
 * @param {object[]} players - slate player rows (projected_points, salary, team, opponent, vegas_*, usage, ...)
 * @param {object} opts - { iterations, seed, historicalStats: Map<name,{n,mean,sd}>, config }
 * @returns sims object: { iterations, seed, players, scores: Float32Array (player-major), index: Map<key,row> }
 */
export function runSimulation(players, opts = {}) {
  const cfg = { ...DEFAULTS, ...(opts.config || {}) };
  const iterations = Math.max(1, Math.floor(opts.iterations ?? cfg.iterations));
  const seed = opts.seed ?? randomSeed();
  const hist = opts.historicalStats || new Map();
  const N = iterations;
  const P = players.length;
  const rng = createRng(seed);

  const games = buildGames(players, cfg);
  const gameOf = new Int32Array(P);
  for (const g of games) for (const idx of g.members) gameOf[idx] = g.index;
  const usageGroups = buildUsageGroups(players, cfg);
  const usageLoading = new Float64Array(P);
  const usageRow = new Int32Array(P).fill(-1);

  // ---- Shared factors (generated first, in deterministic order) ----
  const G = new Float64Array(games.length * N);
  const M = new Float64Array(games.length * N);
  rng.fillNormal(G);
  rng.fillNormal(M);

  let usageCount = 0;
  for (const grp of usageGroups) usageCount += grp.members.length;
  const C = new Float64Array(usageCount * N);
  let row = 0;
  for (const grp of usageGroups) {
    const n = grp.members.length;
    const start = row;
    const u = C.subarray(start * N, (start + n) * N);
    rng.fillNormal(u);
    const norm = 1 / Math.sqrt(1 - 1 / n);
    for (let i = 0; i < N; i++) {
      let mean = 0;
      for (let k = 0; k < n; k++) mean += u[k * N + i];
      mean /= n;
      for (let k = 0; k < n; k++) u[k * N + i] = (u[k * N + i] - mean) * norm;
    }
    grp.members.forEach((idx, k) => {
      usageRow[idx] = start + k;
      usageLoading[idx] = grp.loading;
    });
    row += n;
  }

  // ---- Per-player draws ----
  const scores = new Float32Array(P * N);
  const mult = new Float64Array(N);
  const meta = new Array(P);

  for (let p = 0; p < P; p++) {
    const pl = players[p];
    const mean = num(pl.projected_points) || 0;
    const { sd, source } = derivePlayerSd(pl, hist.get(pl.name));
    meta[p] = { sd, sdSource: source };
    const out = scores.subarray(p * N, (p + 1) * N);
    if (mean <= 0) continue; // zeros

    const g = games[gameOf[p]];
    const a = g.gameLoading;
    const side = pl.team === g.refTeam ? 1 : -1;
    const m = cfg.marginLoading * side;
    const b = usageLoading[p];
    const e = Math.sqrt(Math.max(0, 1 - a * a - cfg.marginLoading ** 2 - b * b));
    const Goff = g.index * N;
    const Coff = usageRow[p] >= 0 ? usageRow[p] * N : -1;

    const cv = sd / mean;
    const sigma2 = Math.log(1 + cv * cv);
    const sigma = Math.sqrt(sigma2);
    const mu = Math.log(mean) - sigma2 / 2;

    // Blowout minutes adjustment (from simulated margin), normalized to mean 1
    const role = playerRole(pl, cfg);
    let useMult = false;
    if (role !== 'core') {
      let sum = 0;
      for (let i = 0; i < N; i++) {
        const margin = -g.refSpread + cfg.marginSd * M[Goff + i];
        const excess = Math.abs(margin) - cfg.blowoutThreshold;
        let f = 1;
        if (excess > 0) {
          f = role === 'starter'
            ? Math.max(cfg.starterCutFloor, 1 - cfg.starterCutPerPt * excess)
            : Math.min(cfg.benchBoostCap, 1 + cfg.benchBoostPerPt * excess);
        }
        mult[i] = f;
        sum += f;
      }
      const inv = N / sum;
      for (let i = 0; i < N; i++) mult[i] *= inv;
      useMult = true;
    }

    for (let i = 0; i < N; i++) {
      let z = a * G[Goff + i] + m * M[Goff + i] + e * rng.normal();
      if (Coff >= 0) z += b * C[Coff + i];
      let s = Math.exp(mu + sigma * z);
      if (useMult) s *= mult[i];
      out[i] = s;
    }
  }

  const index = new Map();
  players.forEach((pl, p) => {
    index.set(playerKey(pl), p);
    for (const alt of [pl.player_id, pl.name]) {
      if (alt != null && !index.has(String(alt))) index.set(String(alt), p);
    }
  });

  return { iterations: N, seed, players, meta, games, scores, index };
}

/** Raw sample row for a player (view into the shared buffer). */
export function playerSamples(sims, p) {
  return sims.scores.subarray(p * sims.iterations, (p + 1) * sims.iterations);
}

/** Per-player summary stats: mean, stdev, percentiles, boom rate. */
export function summarizePlayers(sims, cfgOverrides = {}) {
  const cfg = { ...DEFAULTS, ...cfgOverrides };
  const N = sims.iterations;
  const sorted = new Float32Array(N);
  return sims.players.map((pl, p) => {
    const row = playerSamples(sims, p);
    let sum = 0;
    let sumSq = 0;
    const salary = num(pl.salary) || 0;
    const boomLine = (cfg.boomMultiple * salary) / 1000;
    let booms = 0;
    for (let i = 0; i < N; i++) {
      const v = row[i];
      sum += v;
      sumSq += v * v;
      if (salary > 0 && v >= boomLine) booms++;
    }
    const mean = sum / N;
    const stdev = Math.sqrt(Math.max(0, sumSq / N - mean * mean));
    sorted.set(row);
    sorted.sort();
    const pct = {};
    for (const [k, q] of Object.entries(PERCENTILES)) pct[k] = round2(sortedPercentile(sorted, q));
    return {
      id: pl.id,
      player_id: pl.player_id,
      name: pl.name,
      team: pl.team,
      opponent: pl.opponent,
      position: pl.position,
      salary,
      projected_points: num(pl.projected_points) || 0,
      mean: round2(mean),
      stdev: round2(stdev),
      ...pct,
      boomLine: round2(boomLine),
      boomRate: Math.round((booms / N) * 10000) / 10000,
      sdSource: sims.meta[p].sdSource
    };
  });
}

/** Resolve a lineup (ids, player objects, or optimizer lineup objects) to sim rows. */
function resolveLineup(lineup, sims) {
  const entries = Array.isArray(lineup) ? lineup : lineup?.players || [];
  const rows = [];
  const missing = [];
  for (const entry of entries) {
    const pl = entry && typeof entry === 'object' && 'player' in entry ? entry.player : entry;
    if (pl == null) continue;
    const candidates = typeof pl === 'object' ? [pl.id, pl.player_id, pl.name] : [pl];
    let r;
    for (const c of candidates) {
      if (c != null && sims.index.has(String(c))) {
        r = sims.index.get(String(c));
        break;
      }
    }
    if (r === undefined) missing.push(typeof pl === 'object' ? pl.name ?? pl.id : pl);
    else rows.push(r);
  }
  return { rows, missing };
}

/**
 * Score lineups against a simulation: per-lineup distribution summary.
 * @returns {{mean, stdev, p50, p90, p99, players, missing}[]}
 */
export function scoreLineups(lineups, sims) {
  const N = sims.iterations;
  const totals = new Float64Array(N);
  const sorted = new Float64Array(N);
  return lineups.map((lineup) => {
    const { rows, missing } = resolveLineup(lineup, sims);
    totals.fill(0);
    for (const r of rows) {
      const off = r * N;
      for (let i = 0; i < N; i++) totals[i] += sims.scores[off + i];
    }
    let sum = 0;
    let sumSq = 0;
    for (let i = 0; i < N; i++) {
      sum += totals[i];
      sumSq += totals[i] * totals[i];
    }
    const mean = sum / N;
    sorted.set(totals);
    sorted.sort();
    return {
      mean: round2(mean),
      stdev: round2(Math.sqrt(Math.max(0, sumSq / N - mean * mean))),
      p50: round2(sortedPercentile(sorted, 0.5)),
      p90: round2(sortedPercentile(sorted, 0.9)),
      p99: round2(sortedPercentile(sorted, 0.99)),
      players: rows.length,
      missing
    };
  });
}
