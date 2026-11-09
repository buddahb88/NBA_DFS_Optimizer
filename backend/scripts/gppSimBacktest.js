#!/usr/bin/env node

/**
 * GPP SIM BACKTEST: the GPP sim's win-rate pick vs the max-projection lineup on the saved DK
 * main slates, at the last sync (sync) and re-run at lock (lock: players who did not play
 * removed, as a perfect final news check). Read-only on the database. Reproduces the
 * 10/20-11/7 scratch harness (mc_bt3.mjs / mc_stable.mjs) with the production code path
 * (gppSimInputs.js + gppSim.js).
 *
 * Scoring: each pick's actual DK points, ranked against a "truth" field of 14,000
 * ownership-weighted lineups from players who played, under the same slate-size field rules
 * (salary floor, projection >= frac x max projection), scored with actual points.
 * pct = % of that field scoring above the lineup (lower is better); cash = top 20%.
 *
 *   npm run backtest:gpp-sim -- [--from 2026-10-20] [--to 2026-11-07] [--dates d1,d2]
 *     [--modes sync,lock] [--chalk-cap] [--cheap-floor] [--reps 1] [--contest-size 14000]
 *     [--eval-nights 6000] [--field-size 6000] [--truth-size 14000] [--out results.jsonl] [--json]
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../.env') });

const { default: db } = await import('../src/config/database.js');
const { loadGppSimInputs } = await import('../src/services/portfolio/gppSimInputs.js');
const { runGppSim, prepareSimPlayers } = await import('../src/services/portfolio/gppSim.js');
const { fieldRulesFor, generateRuleField } = await import('../src/services/portfolio/fieldGenerator.js');
const { createSolverContext, solveLineup, ROSTER_SIZE } = await import('../src/services/portfolio/lineupSolver.js');
const { createRng } = await import('../src/services/simulation/rng.js');
const { easternDate } = await import('../src/services/slateSnapshotService.js');

const args = process.argv.slice(2);
const argValue = (flag, d = null) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d;
};
const has = (flag) => args.includes(flag);

const CASH_PCT = 20;
const TOP1_PCT = 1;
const modes = argValue('--modes', 'sync,lock').split(',').map((m) => m.trim()).filter(Boolean);
const reps = Math.max(1, Number(argValue('--reps', 1)) || 1);
const truthSize = Number(argValue('--truth-size', 14000));
const simOptions = {
  mode: 'single',
  contestSize: Number(argValue('--contest-size', 14000)),
  chalkCap: has('--chalk-cap'),
  cheapMinutesFloor: has('--cheap-floor'),
  evalNights: Number(argValue('--eval-nights', 6000)),
  fieldSize: Number(argValue('--field-size', 6000))
};
const outFile = argValue('--out');

const yesterday = (() => {
  const d = new Date(`${easternDate(new Date())}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
})();
const dates = argValue('--dates')?.split(',').map((d) => d.trim());
const slates = (await db.all(
  "SELECT game_date AS date, slate_id AS slateId FROM slate_catalog WHERE site = 'draftkings' AND is_main = 1 AND game_date >= ? AND game_date <= ? ORDER BY game_date",
  argValue('--from', '2026-10-20'), argValue('--to', yesterday)
)).filter((s) => !dates || dates.includes(s.date));
if (!slates.length) {
  console.error('No saved DK main slates in range');
  process.exit(1);
}

/** Actual DK points of a sim lineup (player ids) from the inputs' actuals. */
const actualOf = (actuals, lineup) => lineup.players.reduce((s, x) => s + (actuals.get(x.player.id)?.actualPoints ?? 0), 0);

/** Truth field scores (descending) for a slate: rule field over players who played, scored with actual points. */
function truthField(inputs, seed) {
  const played = inputs.players.map((p) => ({ ...p, out: p.out || inputs.actuals.get(p.id)?.resultStatus !== 'PLAYED' }));
  const sim = prepareSimPlayers(played);
  const ctx = createSolverContext(sim.players);
  const rng = createRng(`${seed}:truth`);
  const max = solveLineup(ctx, sim.proj, { rng, kicks: 8 });
  const rules = fieldRulesFor(sim.G);
  const field = generateRuleField(ctx, { own: sim.own, proj: sim.proj, size: truthSize, rng, minSalary: rules.minSalary, minProjection: rules.frac * max.value });
  const act = sim.players.map((p) => inputs.actuals.get(p.id)?.actualPoints ?? 0);
  const scores = new Float64Array(field.count);
  for (let f = 0; f < field.count; f++) {
    let s = 0;
    for (let k = 0; k < ROSTER_SIZE; k++) s += act[field.lineups[f * ROSTER_SIZE + k]];
    scores[f] = s;
  }
  return Array.from(scores).sort((a, b) => b - a);
}

const pctOf = (truth, v) => (100 * (truth.filter((x) => x > v).length + 1)) / truth.length;
const names = (lineup) => lineup.players.map((s) => s.player.name);

const rows = [];
if (outFile) fs.writeFileSync(outFile, '');
for (const { date, slateId } of slates) {
  const t0 = Date.now();
  const row = { date, slateId };
  let truth = null;
  for (const mode of modes) {
    const inputs = await loadGppSimInputs({ slateId, slateDate: date }, { atLock: mode === 'lock' });
    if (!inputs.actuals || inputs.actuals.size === 0) {
      row.skipped = 'no actuals';
      break;
    }
    truth ??= truthField(inputs, `bt:${date}`);
    row.games ??= prepareSimPlayers(inputs.players).G;
    row.truthTop1 ??= truth[Math.floor(truth.length * 0.01)];
    row.ruledOut ??= {};
    row.ruledOut[mode] = inputs.players.filter((p) => p.out).length;
    const picks = [];
    for (let r = 0; r < reps; r++) {
      const res = runGppSim(inputs.players, { ...simOptions, seed: `bt:${date}:${r}` });
      picks.push(res);
    }
    const score = (lineup) => {
      const act = actualOf(inputs.actuals, lineup);
      return { act: Math.round(act * 100) / 100, pct: Math.round(pctOf(truth, act) * 100) / 100, proj: lineup.projectedPoints, own: lineup.metrics.totalOwnership, win: lineup.metrics.winRate, names: names(lineup) };
    };
    const win = picks.map((p) => score(p.lineups[0]));
    const maxP = score(picks[0].maxProjection);
    const keys = new Set(picks.map((p) => p.lineups[0].players.map((s) => s.player.id).sort().join(',')));
    row[mode] = {
      win: { ...win[0], act: win.reduce((s, w) => s + w.act, 0) / reps, pct: win.reduce((s, w) => s + w.pct, 0) / reps, reps: win.map((w) => w.act) },
      maxProj: maxP,
      stable: keys.size === 1,
      candidates: picks[0].candidateCount
    };
  }
  row.secs = Math.round((Date.now() - t0) / 1000);
  rows.push(row);
  if (outFile) fs.appendFileSync(outFile, `${JSON.stringify(row)}\n`);
  if (!has('--json')) {
    const f = (x) => `${x.act.toFixed(1)} (top ${x.pct.toFixed(1)}%)`;
    console.log(`${date} ${String(row.games ?? '?').padStart(2)}g ${String(row.secs).padStart(3)}s | top1% ${row.truthTop1?.toFixed(1) ?? '-'} | ${modes.filter((m) => row[m]).map((m) => `${m.toUpperCase()} win ${f(row[m].win)} maxProj ${f(row[m].maxProj)}${row.ruledOut[m] ? ` [${row.ruledOut[m]} out]` : ''}`).join(' | ')}${row.skipped ? ` skipped: ${row.skipped}` : ''}`);
  }
}

// ---- Summary ----
const scored = rows.filter((r) => !r.skipped);
const summary = [];
for (const mode of modes) {
  for (const pick of ['win', 'maxProj']) {
    const xs = scored.map((r) => r[mode]?.[pick]).filter(Boolean);
    if (!xs.length) continue;
    const pcts = xs.map((x) => x.pct).sort((a, b) => a - b);
    summary.push({
      strategy: `${mode} / ${pick === 'win' ? 'win-rate pick' : 'max projection'}`,
      slates: xs.length,
      avgActual: Math.round((xs.reduce((s, x) => s + x.act, 0) / xs.length) * 10) / 10,
      avgPct: Math.round((xs.reduce((s, x) => s + x.pct, 0) / xs.length) * 10) / 10,
      medianPct: Math.round(pcts[Math.floor(pcts.length / 2)] * 10) / 10,
      cashes: xs.filter((x) => x.pct <= CASH_PCT).length,
      top1: xs.filter((x) => x.pct <= TOP1_PCT).length,
      ...(pick === 'win' && reps > 1 ? { stable: scored.filter((r) => r[mode]?.stable).length } : {})
    });
  }
}
if (has('--json')) {
  console.log(JSON.stringify({ options: { ...simOptions, reps, truthSize, modes }, summary, rows }, null, 2));
} else {
  console.log(`\nGPP sim backtest: ${scored.length} slates, contest ${simOptions.contestSize.toLocaleString()}, chalkCap ${simOptions.chalkCap}, cheapMinutesFloor ${simOptions.cheapMinutesFloor}, reps ${reps}`);
  console.log(`cash = top ${CASH_PCT}% of the truth field, top1 = top ${TOP1_PCT}%`);
  console.table(summary);
}
process.exit(0);
