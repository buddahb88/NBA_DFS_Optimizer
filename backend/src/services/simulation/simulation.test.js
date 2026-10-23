import { test } from 'vitest';
import assert from 'node:assert/strict';
import { runSimulation, summarizePlayers, scoreLineups, playerSamples } from './engine.js';
import { derivePlayerSd, summarize, normalizeName } from './variance.js';
import { createRng } from './rng.js';

/** Synthetic slate: `games` games, `perTeam` players per team. */
function makeSlate({ games = 4, perTeam = 19 } = {}) {
  const players = [];
  let id = 1;
  for (let g = 0; g < games; g++) {
    const home = `H${g}`;
    const away = `A${g}`;
    for (const [team, opp, spread] of [[home, away, -6], [away, home, 6]]) {
      for (let k = 0; k < perTeam; k++) {
        const salary = Math.max(3000, 11000 - k * 450);
        players.push({
          id: id++,
          player_id: `dk${id}`,
          name: `${team}-P${k}`,
          team,
          opponent: opp,
          position: 'PG',
          salary,
          projected_points: salary / 200,
          projected_minutes: Math.max(8, 36 - k * 1.6),
          usage: Math.max(10, 32 - k * 1.5),
          vegas_over_under: 230,
          vegas_spread: spread,
          floor: salary / 300,
          ceiling: salary / 120
        });
      }
    }
  }
  return players;
}

function corr(x, y) {
  const n = x.length;
  let mx = 0, my = 0;
  for (let i = 0; i < n; i++) { mx += x[i]; my += y[i]; }
  mx /= n; my /= n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i] - mx, dy = y[i] - my;
    sxy += dx * dy; sxx += dx * dx; syy += dy * dy;
  }
  return sxy / Math.sqrt(sxx * syy);
}

const idx = (players, name) => players.findIndex((p) => p.name === name);

test('rng is deterministic per seed', () => {
  const a = createRng(42), b = createRng(42), c = createRng(43);
  const ra = Array.from({ length: 5 }, a.normal);
  assert.deepEqual(ra, Array.from({ length: 5 }, b.normal));
  assert.notDeepEqual(ra, Array.from({ length: 5 }, c.normal));
});

test('same seed reproduces identical samples; different seed differs', () => {
  const players = makeSlate({ games: 2, perTeam: 8 });
  const s1 = runSimulation(players, { iterations: 2000, seed: 123 });
  const s2 = runSimulation(players, { iterations: 2000, seed: 123 });
  const s3 = runSimulation(players, { iterations: 2000, seed: 124 });
  assert.deepEqual(s1.scores, s2.scores);
  assert.notDeepEqual(s1.scores, s3.scores);
  assert.deepEqual(summarizePlayers(s1), summarizePlayers(s2));
});

test('distributions: non-negative, right-skewed, mean ≈ projection', () => {
  const players = makeSlate({ games: 1, perTeam: 10 });
  const sims = runSimulation(players, { iterations: 20000, seed: 7 });
  const summary = summarizePlayers(sims);
  for (let p = 0; p < players.length; p++) {
    const row = playerSamples(sims, p);
    assert.ok(row.every((v) => v >= 0));
    const s = summary[p];
    assert.ok(Math.abs(s.mean - s.projected_points) / s.projected_points < 0.03, `${s.name} mean ${s.mean} vs ${s.projected_points}`);
    assert.ok(s.mean > s.p50, 'right skew: mean above median');
    assert.ok(s.p25 <= s.p50 && s.p50 <= s.p75 && s.p75 <= s.p90 && s.p90 <= s.p99);
    assert.ok(s.boomRate >= 0 && s.boomRate <= 1);
  }
});

test('correlation signs: opponents +, cross-game ~0, top-usage teammates -', () => {
  const players = makeSlate({ games: 2, perTeam: 10 });
  const sims = runSimulation(players, { iterations: 20000, seed: 99 });
  const row = (name) => playerSamples(sims, idx(players, name));

  // Same game, opposing role players: shared pace/total environment dominates
  const opp = corr(row('H0-P4'), row('A0-P4'));
  assert.ok(opp > 0.02, `opponent corr ${opp}`);

  // Different games: independent
  const cross = corr(row('H0-P4'), row('H1-P4'));
  assert.ok(Math.abs(cross) < 0.03, `cross-game corr ${cross}`);

  // Top-two usage teammates compete for possessions
  const mates = corr(row('H0-P0'), row('H0-P1'));
  assert.ok(mates < 0, `high-usage teammate corr ${mates}`);

  // Non-competing teammates still share game environment
  const role = corr(row('H0-P4'), row('H0-P5'));
  assert.ok(role > 0.02, `role teammate corr ${role}`);
});

test('higher vegas total strengthens game-level correlation', () => {
  const lo = makeSlate({ games: 1, perTeam: 8 }).map((p) => ({ ...p, vegas_over_under: 205 }));
  const hi = makeSlate({ games: 1, perTeam: 8 }).map((p) => ({ ...p, vegas_over_under: 250 }));
  const c = (players) => {
    const sims = runSimulation(players, { iterations: 30000, seed: 5 });
    return corr(playerSamples(sims, idx(players, 'H0-P4')), playerSamples(sims, idx(players, 'A0-P4')));
  };
  assert.ok(c(hi) > c(lo));
});

test('scoreLineups: mean is sum of player means; accepts optimizer lineup shape', () => {
  const players = makeSlate({ games: 2, perTeam: 8 });
  const sims = runSimulation(players, { iterations: 5000, seed: 1 });
  const summary = summarizePlayers(sims);
  const picks = [0, 3, 9, 12, 17, 20, 25, 30];
  const byIds = picks.map((i) => players[i].id);
  const optimizerShape = { players: picks.map((i) => ({ position: 'UTIL', player: players[i] })) };
  const [a, b] = scoreLineups([byIds, optimizerShape], sims);
  assert.deepEqual(a, b);
  const expected = picks.reduce((s, i) => s + summary[i].mean, 0);
  assert.ok(Math.abs(a.mean - expected) < 0.1);
  assert.equal(a.players, 8);
  assert.deepEqual(a.missing, []);
  assert.ok(a.p99 >= a.p90 && a.p90 >= a.p50 && a.stdev > 0);

  const [c] = scoreLineups([[players[0].id, 'nope']], sims);
  assert.deepEqual(c.missing, ['nope']);
});

test('stdev derivation: historical CV, then range, then default', () => {
  const p = { projected_points: 40, floor: 20, ceiling: 60 };
  const hist = summarize([30, 40, 50, 20, 60, 35, 45, 40, 30, 50]);
  const h = derivePlayerSd(p, hist);
  assert.equal(h.source, 'historical');
  assert.ok(Math.abs(h.sd - (hist.sd / hist.mean) * 40) < 1e-9);
  assert.deepEqual(derivePlayerSd(p, summarize([30, 40])), { sd: 16, source: 'range' });
  assert.equal(derivePlayerSd({ projected_points: 40 }).source, 'default');
});

test('stdev derivation: stored std_dev (game-log outcome distribution) comes first', () => {
  const hist = summarize([30, 40, 50, 20, 60, 35, 45, 40, 30, 50]);
  const p = { projected_points: 40, floor: 28, ceiling: 53, std_dev: 12 };
  assert.deepEqual(derivePlayerSd(p, hist), { sd: 12, source: 'distribution' });
  // Clamped to the same CV bounds as the other sources
  assert.equal(derivePlayerSd({ projected_points: 40, std_dev: 100 }, hist).sd, 40 * 0.9);
  // Missing / zero std_dev falls through to the historical CV
  assert.equal(derivePlayerSd({ ...p, std_dev: 0 }, hist).source, 'historical');
});

test('performance: 10k iterations x 150+ players under 2s', () => {
  const players = makeSlate({ games: 4, perTeam: 19 }); // 152 players
  const start = performance.now();
  const sims = runSimulation(players, { iterations: 10000, seed: 2024 });
  summarizePlayers(sims);
  const ms = performance.now() - start;
  assert.ok(ms < 2000, `took ${ms.toFixed(0)}ms`);
});

test('normalizeName matches accented / suffixed spellings', () => {
  assert.equal(normalizeName('Luka Dončić'), normalizeName('Luka Doncic'));
  assert.equal(normalizeName('Jaren Jackson Jr.'), normalizeName('Jaren Jackson'));
  assert.equal(normalizeName("De'Aaron Fox"), normalizeName('DeAaron Fox'));
  assert.notEqual(normalizeName('Jalen Williams'), normalizeName('Jaylin Williams'));
});
