#!/usr/bin/env node

/**
 * BLEND CALIBRATION BACKTEST: point factors, PIT map and boom Platt for the
 * own-model blend, fit leave-one-date-out on the saved DK slates with results
 * (services/modelEval/blendCalibrationBacktest.js). Read-only on the database.
 *
 *   npm run backtest:blend-calibration -- [--from 2026-10-20] [--to 2026-11-07]
 *     [--samples samples.json]   reuse / save the samples (skips the service runs when the file exists)
 *     [--out report.json] [--json]
 *     [--write-params]           also write src/services/modelEval/blendCalibrationParams.json
 *                                (live: true only when the calibration won out of sample)
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../.env') });

const bt = await import('../src/services/modelEval/blendCalibrationBacktest.js');
const { writeCalibrationParams } = await import('../src/services/modelEval/blendCalibration.js');

const args = process.argv.slice(2);
const argValue = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : null;
};
const fmt = (v, d = 2) => (v === null || v === undefined || !Number.isFinite(Number(v)) ? '-' : Number(v).toFixed(d));
const pct = (v, d = 1) => (v === null || v === undefined ? '-' : `${(100 * v).toFixed(d)}%`);
const pad = (v, w) => String(v).padStart(w);

function printPoint(title, b, a) {
  console.log(`\n${title}`);
  console.log(`${''.padEnd(10)}${pad('n', 6)}   ${'MAE before/after'.padEnd(18)}${'RMSE before/after'.padEnd(20)}bias before/after`);
  const line = (k, x, y) => console.log(`${k.padEnd(10)}${pad(x.n, 6)}   ${`${fmt(x.mae, 3)} / ${fmt(y.mae, 3)}`.padEnd(18)}${`${fmt(x.rmse, 3)} / ${fmt(y.rmse, 3)}`.padEnd(20)}${fmt(x.bias)} / ${fmt(y.bias)}`);
  line('all', b.all, a.all);
  for (const k of Object.keys(b.byMinutes)) line(`${k} min`, b.byMinutes[k], a.byMinutes[k]);
  for (const k of Object.keys(b.bySalary)) line(k, b.bySalary[k], a.bySalary[k]);
}

function printCoverage(b, a) {
  console.log('\nCOVERAGE (target 10% / 10%)            before      after');
  console.log(`  actual <= p10                       ${pad(pct(b.belowP10), 7)}    ${pad(pct(a.belowP10), 7)}`);
  console.log(`  actual <  p10 (strict)              ${pad(pct(b.strictlyBelowP10), 7)}    ${pad(pct(a.strictlyBelowP10), 7)}`);
  console.log(`  below p10, DNP ties split           ${pad(pct(b.tieAwareBelowP10), 7)}    ${pad(pct(a.tieAwareBelowP10), 7)}`);
  console.log(`  actual >= p90                       ${pad(pct(b.aboveP90), 7)}    ${pad(pct(a.aboveP90), 7)}`);
  console.log(`  mean p90 - p10                      ${pad(fmt(b.meanWidth, 1), 7)}    ${pad(fmt(a.meanWidth, 1), 7)}`);
  for (const [title, key] of [['by minutes band', 'byMinutes'], ['by salary tier', 'bySalary']]) {
    console.log(`  ${title} (<=p10 / >=p90)`);
    for (const k of Object.keys(b[key])) console.log(`    ${k.padEnd(8)} n ${pad(b[key][k].n, 5)}   ${pct(b[key][k].belowP10)} / ${pct(b[key][k].aboveP90)}  ->  ${pct(a[key][k].belowP10)} / ${pct(a[key][k].aboveP90)}`);
  }
}

function printBoom(b, a) {
  console.log(`\nBOOM (actual >= 6x salary)  Brier ${fmt(b.brier, 4)} -> ${fmt(a.brier, 4)}   mean predicted ${pct(b.predicted)} -> ${pct(a.predicted)} (actual ${pct(b.actual)})`);
  console.log(`  ${'p_boom'.padEnd(10)}${'before: n  pred  actual'.padEnd(28)}after: n  pred  actual`);
  b.buckets.forEach((x, i) => {
    const y = a.buckets[i];
    console.log(`  ${x.range.padEnd(10)}${`${pad(x.n, 7)} ${pad(pct(x.predicted), 6)} ${pad(pct(x.actual), 6)}`.padEnd(28)}${pad(y.n, 7)} ${pad(pct(y.predicted), 6)} ${pad(pct(y.actual), 6)}`);
  });
}

function print(report, slates, artifact) {
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  BLEND CALIBRATION (leave-one-date-out)');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`Rows ${report.rows} (main ${report.mainRows}), ${report.dates} dates, ${slates.length} slates (${slates.filter(s => !s.main).length} side)`);
  printPoint('POINT (actual - projection; DNP = 0)', report.before.point, report.after.point);
  printCoverage(report.before.coverage, report.after.coverage);
  printBoom(report.before.boom, report.after.boom);
  printPoint('MAIN SLATES ONLY - POINT', report.mainBefore.point, report.mainAfter.point);
  console.log(`  main coverage <=p10 / >=p90: ${pct(report.mainBefore.coverage.belowP10)} / ${pct(report.mainBefore.coverage.aboveP90)} -> ${pct(report.mainAfter.coverage.belowP10)} / ${pct(report.mainAfter.coverage.aboveP90)}; Brier ${fmt(report.mainBefore.boom.brier, 4)} -> ${fmt(report.mainAfter.boom.brier, 4)}`);
  console.log('\nHINDSIGHT-OPTIMAL PLAYERS WITH ACTUAL >= p90 (main slates)');
  for (const [k, v] of Object.entries(report.optimal.before)) console.log(`  ${k.padEnd(6)} n ${pad(v.n, 4)}   ${pct(v.aboveP90)} -> ${pct(report.optimal.after[k].aboveP90)}`);
  const f = report.full;
  console.log(`\nFIT ON EVERY ROW: global ${fmt(f.point.global, 3)}  minutes ${JSON.stringify(f.point.minutes)}  salary ${JSON.stringify(f.point.salary)}`);
  console.log(`  PIT map H at 0.05 / 0.10 / 0.50 / 0.90 / 0.95: ${[1, 2, 10, 18, 19].map(i => fmt(f.pit.H[i], 3)).join(' / ')}`);
  console.log(`  boom Platt a ${fmt(f.boom.a, 3)} b ${fmt(f.boom.b, 3)}`);
  const st = report.stability;
  console.log(`  fold ranges: global ${fmt(st.global.min, 3)}-${fmt(st.global.max, 3)}, H(0.1) ${fmt(st.h10.min, 3)}-${fmt(st.h10.max, 3)}, H(0.9) ${fmt(st.h90.min, 3)}-${fmt(st.h90.max, 3)}, Platt b ${fmt(st.boomB.min, 3)}-${fmt(st.boomB.max, 3)}`);
  console.log(`\nlive: ${artifact.live}`);
}

const samplesFile = argValue('--samples');
let samples, slates;
if (samplesFile && fs.existsSync(samplesFile)) {
  ({ samples, slates } = JSON.parse(fs.readFileSync(samplesFile, 'utf8')));
} else {
  ({ samples, slates } = await bt.buildSamples({ from: argValue('--from'), to: argValue('--to'), log: args.includes('--json') ? () => {} : console.log }));
  if (samplesFile) fs.writeFileSync(samplesFile, JSON.stringify({ samples, slates }));
}
const report = bt.runCalibration(samples);
const artifact = bt.paramsArtifact(report, { slates });
if (args.includes('--json')) console.log(JSON.stringify({ report, artifact }, null, 2));
else print(report, slates, artifact);
const out = argValue('--out');
if (out) fs.writeFileSync(out, JSON.stringify({ report, artifact }, null, 2));
if (args.includes('--write-params')) console.log(`\nWrote ${writeCalibrationParams(artifact)}`);
process.exit(0);
