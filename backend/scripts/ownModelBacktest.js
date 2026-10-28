#!/usr/bin/env node

/**
 * OWN MODEL x ROTOWIRE BACKTEST (M4): blends fit leave-one-slate-out,
 * disagreement hit rates and the lineup-level backtest on the saved main
 * slates (services/modelEval/ownModelBacktest.js). Read-only on the database.
 *
 *   npm run backtest:own-model -- [--slate-dates 2026-10-21,...] [--no-lineups] [--no-gpp]
 *     [--field-size 5000] [--gpp-seeds 1] [--iterations 1000] [--replay] [--no-cache] [--out report.json]
 *     [--write-weights]   also write src/services/modelEval/ownModelWeights.json (the live service's blend)
 *     [--json]
 */

import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../.env') });

const { default: db } = await import('../src/config/database.js');
const m4 = await import('../src/services/modelEval/ownModelBacktest.js');

const args = process.argv.slice(2);
const argValue = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : null;
};
const fmt = (v, d = 2) => (v === null || v === undefined ? '-' : Number(v).toFixed(d));
const pad = (v, w) => String(v).padStart(w);
const ci = (p) => (p ? `${fmt(p.diff, 3)} [${fmt(p.ci[0], 3)}, ${fmt(p.ci[1], 3)}]` : '-');

function printBoard(title, board, paired, bySlate) {
  console.log(`\n${title}`);
  console.log(`${'projector'.padEnd(34)}${pad('n', 6)}${pad('MAE', 8)}${pad('bias', 8)}${pad('minMAE', 8)}  ${'vs rotowire_adjusted (rows)'.padEnd(30)}by slate`);
  for (const b of board) {
    const p = paired.find(x => x.projector === b.projector);
    const s = bySlate.find(x => x.projector === b.projector);
    console.log(`${b.projector.padEnd(34)}${pad(b.n, 6)}${pad(fmt(b.mae, 3), 8)}${pad(fmt(b.bias), 8)}${pad(fmt(b.minutes?.mae), 8)}  ${ci(p).padEnd(30)}${ci(s)}`);
  }
}

function print(report, file) {
  const L = report.leaderboard;
  const chosen = report.blend.chosen;
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log(`  OWN MODEL x ROTOWIRE (data ${report.signature})`);
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`Slates: ${report.slates.map(s => `${s.date} (${s.played}/${s.players})`).join(', ')}`);
  printBoard(`LEAVE-ONE-SLATE-OUT incl. DNP (${L.common} rows)`, L.withDnp, L.paired.withDnp, L.pairedBySlate.withDnp);
  printBoard('LEAVE-ONE-SLATE-OUT played', L.played, L.paired.played, L.pairedBySlate.played);

  const shown = ['rotowire_raw', 'rotowire_adjusted', 'rates_v1', 'own_mean', chosen].filter(Boolean);
  console.log('\nPER SLATE MAE incl. DNP');
  console.log(`${'date'.padEnd(12)}${pad('n', 5)}${shown.map(n => pad(n.replace('rotowire_', 'rw_').slice(0, 22), 24)).join('')}`);
  for (const s of L.perSlate) console.log(`${s.date.padEnd(12)}${pad(s.rows, 5)}${shown.map(n => pad(fmt(s.mae[n], 3), 24)).join('')}`);

  console.log(`\nBLEND WEIGHTS (w on RotoWire, fit on all slates; fold range)  chosen: ${chosen}`);
  for (const [name, w] of Object.entries(report.blend.weights)) {
    const st = report.blend.stability[name];
    const segs = Object.entries(w.segments).map(([k, v]) => `${k}=${fmt(v.w)} (n ${v.n}, ${fmt(st.segments[k]?.min)}-${fmt(st.segments[k]?.max)})`).join('  ');
    console.log(`${name.padEnd(30)} global ${fmt(w.global)} (${fmt(st.global.min)}-${fmt(st.global.max)})  ${segs}`);
  }

  console.log('\nCALIBRATION incl. DNP');
  for (const [n, c] of Object.entries(L.calibration)) {
    console.log(`${n.padEnd(34)}<p10 ${fmt(c.coverage?.belowP10, 1)}%  >p90 ${fmt(c.coverage?.aboveP90, 1)}%  width ${fmt(c.coverage?.avgWidth, 1)}` +
      (c.boom ? `  boom predicted ${fmt(c.boom.predicted, 1)} vs actual ${c.boom.observed} (Brier ${fmt(c.boom.brier, 4)})` : ''));
  }
  console.log('\nTOP-20 VALUE HIT RATE (5x)');
  for (const v of L.valueHit) console.log(`${v.projector.padEnd(34)}${pad(`${v.hits}/${v.picks}`, 9)}${pad(fmt(v.rate, 3), 8)}  avg ${fmt(v.avgActualValue)}x`);

  for (const field of ['points', 'minutes']) {
    const d = report.disagreement[field];
    console.log(`\nDISAGREEMENT (${field}, ours - RotoWire adjusted; ${d.n} rows incl. DNP): hit = actual on our side of RotoWire`);
    console.log(`base rate: actual above RotoWire ${fmt(d.base?.actualAbove, 3)}, below ${fmt(d.base?.actualBelow, 3)}`);
    console.log(`${'call'.padEnd(26)}${pad('n', 6)}${pad('hit', 8)}${pad('closer', 8)}${pad('gap', 8)}${pad('act-RW', 8)}`);
    for (const c of d.cumulative) console.log(`${c.call.padEnd(26)}${pad(c.n, 6)}${pad(fmt(c.hitRate, 3), 8)}${pad(fmt(c.closerRate, 3), 8)}${pad(fmt(c.meanGap), 8)}${pad(fmt(c.meanEdge), 8)}`);
  }
  console.log(`\nDISAGREEMENT BY SEGMENT (|points gap| >= ${report.disagreement.points.segmentGap}): hit rate higher / lower (n)`);
  for (const [scheme, segs] of Object.entries(report.disagreement.points.bySegment)) {
    console.log(`  ${scheme}: ${Object.entries(segs).map(([k, v]) => `${k} ${fmt(v.higher.hitRate)} (${v.higher.n}) / ${fmt(v.lower.hitRate)} (${v.lower.n})`).join('   ')}`);
  }

  if (report.lineups) {
    const { sources, slates, totals } = report.lineups;
    const short = (n) => n.replace('rotowire_', 'rw_').replace('blend_', 'b_').slice(0, 18);
    console.log('\nLINEUPS - CASH: max-projection lineup actual (field percentile)');
    console.log(`${'date'.padEnd(12)}${pad('optimal', 8)}${pad('fld p50', 8)}${sources.map(s => pad(short(s), 20)).join('')}`);
    for (const s of slates) {
      console.log(`${s.date.padEnd(12)}${pad(fmt(s.optimal, 1), 8)}${pad(fmt(s.fieldMedian, 1), 8)}${sources.map(n => pad(s.cash[n] ? `${fmt(s.cash[n].actual, 1)} (${fmt(s.cash[n].fieldPercentile, 0)})` : '-', 20)).join('')}`);
    }
    console.log(`${'TOTAL'.padEnd(28)}${sources.map(n => pad(fmt(totals[n].cashActual, 1), 20)).join('')}`);
    console.log(`${'avg % optimal'.padEnd(28)}${sources.map(n => pad(fmt(totals[n].cashPctOfOptimal, 1), 20)).join('')}`);
    console.log(`${'avg field pct'.padEnd(28)}${sources.map(n => pad(fmt(totals[n].cashFieldPercentile, 1), 20)).join('')}`);
    console.log(`${'slates best'.padEnd(28)}${sources.map(n => pad(totals[n].cashWins, 20)).join('')}`);
    if (report.lineups.gppSettings) {
      console.log(`\nLINEUPS - GPP 20-max portfolio: best / avg actual (best field pct), mean of ${slates[0]?.gpp[sources[0]]?.seeds ?? 1} seed(s)`);
      console.log(`${'date'.padEnd(12)}${pad('fld p90', 16)}${sources.map(s => pad(short(s), 22)).join('')}`);
      for (const s of slates) {
        console.log(`${s.date.padEnd(12)}${pad(fmt(s.fieldP90, 1), 16)}${sources.map(n => {
          const g = s.gpp[n];
          return pad(g?.lineups?.length ? `${fmt(g.best, 1)}/${fmt(g.avg, 1)} (${fmt(g.bestFieldPercentile, 0)})${g.filtersRelaxed ? '*' : ''}` : '-', 22);
        }).join('')}`);
      }
      console.log(`${'TOTAL best/avg'.padEnd(28)}${sources.map(n => pad(`${fmt(totals[n].gppBest, 1)}/${fmt(totals[n].gppAvg, 1)}`, 22)).join('')}`);
      console.log(`${'avg field pct best/avg'.padEnd(28)}${sources.map(n => pad(`${fmt(totals[n].gppBestFieldPercentile, 1)}/${fmt(totals[n].gppAvgFieldPercentile, 1)}`, 22)).join('')}`);
      console.log('(* pool filters relaxed: the preset left fewer than 20 players)');
    }
  }
  if (report.replayMean) {
    console.log('\nREPLAY: rates_v1 median point vs mixture mean (MAE / bias)');
    for (const s of report.replayMean) {
      console.log(`${s.season} [${s.role}]`.padEnd(24) + `incl. DNP median ${fmt(s.median.withDnp.mae, 3)} / ${fmt(s.median.withDnp.bias)}  mean ${fmt(s.mean.withDnp.mae, 3)} / ${fmt(s.mean.withDnp.bias)}` +
        `   played median ${fmt(s.median.played.mae, 3)} / ${fmt(s.median.played.bias)}  mean ${fmt(s.mean.played.mae, 3)} / ${fmt(s.mean.played.bias)}`);
    }
  }
  const t = report.timings;
  console.log(`\nTIMINGS: eval ${t.evalMs} ms, blends ${t.blendMs} ms, lineups ${t.lineupsMs ?? 0} ms, replay ${t.replayMs ?? 0} ms, total ${t.totalMs} ms`);
  if (file) console.log(`Report: ${file}`);
}

try {
  const report = await m4.runOwnModelBacktest({
    slateDates: argValue('--slate-dates')?.split(',') ?? null,
    lineups: !args.includes('--no-lineups'),
    gpp: !args.includes('--no-gpp'),
    gppSeeds: argValue('--gpp-seeds') ? Number(argValue('--gpp-seeds')) : undefined,
    fieldSize: argValue('--field-size') ? Number(argValue('--field-size')) : undefined,
    iterations: argValue('--iterations') ? Number(argValue('--iterations')) : undefined,
    replay: args.includes('--replay'),
    cache: !args.includes('--no-cache'),
    onProgress: (m) => process.stderr.write(`  ${m}\n`)
  });
  const file = m4.writeOwnModelReport(report, argValue('--out'));
  if (args.includes('--write-weights')) console.error(`Weights: ${m4.writeWeights(report)}`);
  if (args.includes('--json')) console.log(JSON.stringify(report, null, 2));
  else print(report, file);
} catch (error) {
  console.error('❌ Own model backtest failed:', error.stack ?? error.message);
  process.exitCode = 1;
} finally {
  db.close();
}
