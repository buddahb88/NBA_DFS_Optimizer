#!/usr/bin/env node

/**
 * MINUTES CORRECTION + MINUTES UPSIDE BACKTEST (Q2): factors toward RotoWire's
 * minutes fit leave-one-slate-out, own_mean_mincorr vs own_mean, and how the
 * minutes upside score ranks minutes spikes / 6x games on the saved main
 * slates (services/modelEval/minutesCorrectionBacktest.js). Read-only on the database.
 *
 *   npm run backtest:minutes-correction -- [--slate-dates 2026-10-21,...] [--iterations 1000]
 *     [--no-cache] [--out report.json] [--json]
 *     [--write-params]   also write src/services/modelEval/minutesCorrectionParams.json
 *                        (live: true only when the corrected model won both LOO MAEs)
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../.env') });

const { default: db } = await import('../src/config/database.js');
const q2 = await import('../src/services/modelEval/minutesCorrectionBacktest.js');
const { writeCorrectionParams } = await import('../src/services/modelEval/minutesCorrection.js');
const { DEFAULT_CACHE_DIR } = await import('../src/services/modelEval/modelEvalService.js');

const args = process.argv.slice(2);
const argValue = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : null;
};
const fmt = (v, d = 2) => (v === null || v === undefined ? '-' : Number(v).toFixed(d));
const pad = (v, w) => String(v).padStart(w);
const ci = (p) => (p?.diff !== null && p?.diff !== undefined ? `${fmt(p.diff, 3)} [${fmt(p.ci[0], 3)}, ${fmt(p.ci[1], 3)}]` : '-');

function print(report, file) {
  const L = report.leaderboard;
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log(`  MINUTES CORRECTION + UPSIDE (data ${report.signature})`);
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`Slates (${report.slates.length}): ${report.slates.map(s => s.date).join(', ')}`);

  const c = report.correction.full;
  console.log(`\nFACTORS toward RotoWire (fit on every slate, ${report.correction.samples} played rows; global ${fmt(c.global)}; fold range)`);
  for (const [b, v] of Object.entries(c.buckets)) {
    const bands = Object.entries(v.bands).map(([k, x]) => {
      const st = report.correction.stability.cells[`${b}|${k}`];
      return `${k} ${fmt(x.f)} (n ${x.n}, raw ${fmt(x.raw)}, ${fmt(st?.min)}-${fmt(st?.max)})`;
    }).join('   ');
    console.log(`  ${b.padEnd(15)} ${fmt(v.f)} (n ${pad(v.n, 4)})   ${bands}`);
  }

  for (const [title, board] of [['incl. DNP', L.withDnp], ['played', L.played]]) {
    console.log(`\nLEAVE-ONE-SLATE-OUT ${title} (${L.common} common rows)`);
    console.log(`${'projector'.padEnd(22)}${pad('n', 6)}${pad('MAE', 8)}${pad('bias', 8)}${pad('minMAE', 8)}`);
    for (const b of board) console.log(`${b.projector.padEnd(22)}${pad(b.n, 6)}${pad(fmt(b.mae, 3), 8)}${pad(fmt(b.bias), 8)}${pad(fmt(b.minutesMae), 8)}`);
  }
  const P = L.paired;
  console.log('\nown_mean_mincorr - own_mean (MAE diff, 95% CI)      rows                          slates');
  console.log(`  DK incl. DNP       ${ci(P.withDnp.rows).padEnd(30)}${ci(P.withDnp.slates)}`);
  console.log(`  DK played          ${ci(P.played.rows).padEnd(30)}${ci(P.played.slates)}`);
  console.log(`  minutes played     ${ci(P.minutesPlayed.rows).padEnd(30)}${ci(P.minutesPlayed.slates)}`);

  const names = ['own_mean', 'own_mean_mincorr', 'rotowire_adjusted'];
  for (const [title, list] of [['SALARY BAND', report.breakdowns.salaryBand], ['GAP BUCKET (RotoWire - ours)', report.breakdowns.gapBucket], ['GAP BUCKET, < $5K', report.breakdowns.cheapGapBucket], ['PER SLATE', report.breakdowns.slate]]) {
    console.log(`\n${title}: MAE incl. DNP / minutes MAE`);
    console.log(`${'key'.padEnd(16)}${pad('n', 6)}${names.map(n => pad(n.replace('rotowire_', 'rw_'), 22)).join('')}`);
    for (const g of list) {
      console.log(`${String(g.key).padEnd(16)}${pad(g.n, 6)}${names.map(n => pad(g.mae[n] === undefined ? '-' : `${fmt(g.mae[n], 3)} / ${fmt(g.minutesMae[n])}`, 22)).join('')}`);
    }
  }
  console.log(`\nVERDICT: ${report.wins ? 'own_mean_mincorr WINS both LOO MAEs -> live default' : 'own_mean_mincorr does NOT win both LOO MAEs -> stays off live'}`);

  for (const [title, u] of [['ALL PLAYERS', report.upside.all], ['UNDER $5K', report.upside.cheap]]) {
    console.log(`\nMINUTES UPSIDE - ${title} (n ${u.n}; spikes ${u.spikes} = ${fmt(u.base.spike, 3)}, 6x ${u.sixX} = ${fmt(u.base.sixX, 3)})`);
    console.log(`  AUC spike: score ${fmt(u.auc.spike.score, 3)}  gap alone ${fmt(u.auc.spike.gap, 3)}     AUC 6x: score ${fmt(u.auc.sixX.score, 3)}  gap alone ${fmt(u.auc.sixX.gap, 3)}`);
    console.log(`  top decile (n ${u.topDecile.n}): spike ${fmt(u.topDecile.spike, 3)}  6x ${fmt(u.topDecile.sixX, 3)}`);
    console.log(`  score >= ${u.high.threshold} (n ${u.high.n}): spike ${fmt(u.high.spike, 3)}  6x ${fmt(u.high.sixX, 3)}   recall: spikes ${fmt(u.recall.spike, 3)}  6x ${fmt(u.recall.sixX, 3)}`);
    for (const b of u.buckets) console.log(`  score ${b.bucket.padEnd(6)} n ${pad(b.n, 5)}  spike ${fmt(b.spike, 3)}  6x ${fmt(b.sixX, 3)}`);
  }
  console.log(`\nTIMINGS: base ${report.timings.baseMs} ms, eval ${report.timings.evalMs} ms, total ${report.timings.totalMs} ms`);
  if (file) console.log(`Report: ${file}`);
}

try {
  const report = await q2.runMinutesCorrectionBacktest({
    slateDates: argValue('--slate-dates')?.split(',') ?? null,
    iterations: argValue('--iterations') ? Number(argValue('--iterations')) : undefined,
    cache: !args.includes('--no-cache'),
    onProgress: (m) => process.stderr.write(`  ${m}\n`)
  });
  const file = argValue('--out') ?? path.join(DEFAULT_CACHE_DIR, 'reports', `minutes-correction-${report.generatedAt.replace(/[:.]/g, '-')}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(report, null, 2));
  if (args.includes('--write-params')) console.error(`Params: ${writeCorrectionParams(q2.paramsArtifact(report))}`);
  if (args.includes('--json')) console.log(JSON.stringify(report, null, 2));
  else print(report, file);
} catch (error) {
  console.error('❌ Minutes correction backtest failed:', error.stack ?? error.message);
  process.exitCode = 1;
} finally {
  db.close();
}
