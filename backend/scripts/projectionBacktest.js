#!/usr/bin/env node

/**
 * PROJECTION ACCURACY BACKTEST
 *
 * Scores stored projections (players.projected_points/floor/ceiling) against
 * actual DK fantasy points in historical_games for the same player + date,
 * and compares against the raw RotoWire projection. Read-only.
 *
 * Usage:
 *   node scripts/projectionBacktest.js [--from YYYY-MM-DD] [--to YYYY-MM-DD]
 *                                      [--slate SLATE_ID] [--no-factors] [--json]
 *
 * Replay mode (re-projects every past date from box scores before it, and
 * compares the legacy model with the minutes x FPPM model):
 *   node scripts/projectionBacktest.js --replay [--from ...] [--to ...]
 *                                      [--site draftkings|fanduel|yahoo] [--no-legacy] [--json]
 *                                      [--dvp [--dvp-weights 0.25,0.5,1] [--dvp-cap 2]]
 *   --dvp also re-runs the legacy model with DVP off, the old points-allowed
 *   DVP and the archetype DVP at each weight, to compare the DVP signals.
 *
 * Model evaluation harness (services/modelEval; npm run backtest:model): every
 * registered projector, point-in-time features, replay by season (train /
 * validation / holdout) and the saved main slates head to head with RotoWire:
 *   node scripts/projectionBacktest.js --model [--mode replay|slate|both]
 *     [--projectors season_avg,legacy,...] [--seasons 2025-26,2026-27] [--from ...] [--to ...]
 *     [--slate-dates 2026-10-21,...] [--baseline legacy] [--slate-baseline rotowire_raw]
 *     [--iterations 1000] [--compare rates_v1:minutes_v2,...] [--no-cache] [--out report.json] [--rows] [--json] [--list]
 *   The JSON report goes to backend/.cache/model-eval/reports/ (gitignored) unless --out.
 *
 * Works with SQLite (default) or Azure SQL (DATABASE_TYPE=azuresql in backend/.env).
 */

import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Load env before the database module reads DATABASE_TYPE
dotenv.config({ path: path.join(__dirname, '../.env') });

const { runProjectionBacktest } = await import('../src/services/projectionBacktestService.js');
const { runReplayBacktest } = await import('../src/services/projectionReplayBacktest.js');
const { default: db } = await import('../src/config/database.js');
const modelEval = await import('../src/services/modelEval/modelEvalService.js');
const { listProjectors } = await import('../src/services/modelEval/projectors.js');

const args = process.argv.slice(2);
const argValue = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : null;
};

const options = {
  from: argValue('--from'),
  to: argValue('--to'),
  slateId: argValue('--slate'),
  includeFactors: !args.includes('--no-factors')
};
const asJson = args.includes('--json');

const fmt = (v, d = 2) => (v === null || v === undefined ? '-' : Number(v).toFixed(d));
const pad = (v, w) => String(v).padStart(w);

function printMetricTable(title, rows) {
  console.log(`\n${title}`);
  console.log(`${'group'.padEnd(10)}${pad('n', 6)}${pad('MAE', 8)}${pad('RMSE', 8)}${pad('bias', 8)}${pad('R^2', 8)}${pad('<floor%', 9)}${pad('>ceil%', 8)}${pad('RW MAE', 8)}${pad('gain', 8)}`);
  for (const r of rows) {
    console.log(
      `${String(r.group).padEnd(10)}${pad(r.n, 6)}${pad(fmt(r.mae), 8)}${pad(fmt(r.rmse), 8)}${pad(fmt(r.bias), 8)}${pad(fmt(r.r2, 3), 8)}` +
      `${pad(fmt(r.calibration.pctBelowFloor, 1), 9)}${pad(fmt(r.calibration.pctAboveCeiling, 1), 8)}` +
      `${pad(fmt(r.rotowire?.mae), 8)}${pad(fmt(r.rotowire?.maeImprovement, 3), 8)}`
    );
  }
}

function dvpVariants() {
  const weights = (argValue('--dvp-weights') || '0.25,0.5,0.75,1').split(',').map(Number);
  const cap = argValue('--dvp-cap') !== null ? Number(argValue('--dvp-cap')) : undefined;
  return [
    { label: 'dvp off', mode: 'off' },
    { label: 'dvp legacy (pts allowed)', mode: 'legacy' },
    ...weights.map(weight => ({ label: `dvp archetype w=${weight}`, mode: 'archetype', weight, cap }))
  ];
}

function printReplay(report) {
  const row = (label, m) => console.log(
    `${label.padEnd(26)}${pad(m?.n ?? 0, 7)}${pad(fmt(m?.mae), 8)}${pad(fmt(m?.rmse), 8)}${pad(fmt(m?.bias), 8)}${pad(fmt(m?.r2, 3), 8)}${pad(fmt(m?.correlation, 3), 8)}`
  );
  const header = () => console.log(`${''.padEnd(26)}${pad('n', 7)}${pad('MAE', 8)}${pad('RMSE', 8)}${pad('bias', 8)}${pad('R^2', 8)}${pad('corr', 8)}`);
  const { sample } = report;
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log(`  PROJECTION REPLAY BACKTEST (${report.site})`);
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`Player-games: ${sample.playerGames} across ${sample.dates} date(s)` +
    (sample.dateRange ? ` [${sample.dateRange.from} → ${sample.dateRange.to}]` : '') +
    `, ${sample.injuryAffected} with a teammate OUT`);
  if (!sample.playerGames) return;

  console.log('\nFANTASY POINTS');
  header();
  if (report.points.legacy) row('legacy (before)', report.points.legacy);
  row('minutes x FPPM', report.points.minutesModel);
  row('minutes x FPPM, no injury', report.points.minutesModelNoInjury);
  for (const b of report.blends) row(`blend w=${b.weight}`, b);

  if (report.dvpVariants?.length) {
    console.log('\nLEGACY MODEL BY DVP SIGNAL (adj = rows with a non-zero DVP, |adj| = mean size)');
    console.log(`${''.padEnd(26)}${pad('n', 7)}${pad('MAE', 8)}${pad('RMSE', 8)}${pad('bias', 8)}${pad('adj', 8)}${pad('|adj|', 8)}`);
    for (const v of report.dvpVariants) {
      console.log(`${v.label.padEnd(26)}${pad(v.n, 7)}${pad(fmt(v.mae, 3), 8)}${pad(fmt(v.rmse, 3), 8)}${pad(fmt(v.bias, 3), 8)}${pad(v.adjusted, 8)}${pad(fmt(v.meanAbsAdjustment), 8)}`);
    }
  }

  console.log('\nTEAMMATE OUT ROWS ONLY');
  header();
  if (report.injuryAffected.legacy) row('legacy', report.injuryAffected.legacy);
  row('minutes x FPPM', report.injuryAffected.minutesModel);
  row('minutes x FPPM, no injury', report.injuryAffected.minutesModelNoInjury);

  console.log('\nMINUTES');
  header();
  row('season average', report.minutes.seasonAverage);
  row('model, no injury', report.minutes.modelNoInjury);
  row('model', report.minutes.model);
  row('teammate OUT: no injury', report.minutes.injuryAffected.modelNoInjury);
  row('teammate OUT: model', report.minutes.injuryAffected.model);

  console.log('\nINSIGHTS');
  for (const line of report.insights) console.log(`  • ${line}`);
  console.log('');
}

const list = (flag) => (argValue(flag) ? argValue(flag).split(',').map(x => x.trim()).filter(Boolean) : undefined);

function printBoard(title, summary, baseline) {
  console.log(`\n${title}: ${summary.common} common rows of ${summary.rows}` +
    ` (coverage ${Object.entries(summary.coverage).map(([k, v]) => `${k} ${v}`).join(', ')})`);
  console.log(`${'projector'.padEnd(34)}${pad('MAE', 7)}${pad('RMSE', 7)}${pad('bias', 7)}${pad('R^2', 7)}${pad('corr', 7)}${pad('minMAE', 8)}${pad('<p10%', 7)}${pad('>p90%', 7)}   vs ${baseline ?? '-'} (95% CI)`);
  for (const r of summary.leaderboard) {
    const p = summary.paired.find(x => x.projector === r.projector);
    const vs = p ? `${fmt(p.diff, 3)} [${fmt(p.ci[0], 3)}, ${fmt(p.ci[1], 3)}]` : r.projector === baseline ? '(baseline)' : '';
    console.log(`${r.projector.padEnd(34)}${pad(fmt(r.mae), 7)}${pad(fmt(r.rmse), 7)}${pad(fmt(r.bias), 7)}${pad(fmt(r.r2, 3), 7)}${pad(fmt(r.correlation, 3), 7)}` +
      `${pad(fmt(r.minutes?.mae), 8)}${pad(fmt(r.coverage.belowP10, 1), 7)}${pad(fmt(r.coverage.aboveP90, 1), 7)}   ${vs}`);
  }
}

function printExtraPaired(summary, baseline) {
  for (const p of summary.paired.filter(x => x.vs !== baseline)) {
    console.log(`  DK ${p.projector.padEnd(32)} vs ${p.vs}: ${fmt(p.diff, 3)} [${fmt(p.ci[0], 3)}, ${fmt(p.ci[1], 3)}]`);
  }
}

function printCalibration(summary) {
  for (const r of summary.leaderboard) {
    const parts = [['boom', r.boom], ['DD', r.doubleDouble], ['TD', r.tripleDouble]].filter(([, c]) => c && c.predicted > 0);
    if (!parts.length) continue;
    console.log(`  ${r.projector.padEnd(32)} ${parts.map(([k, c]) => `${k} pred ${fmt(c.predicted, 0)} / act ${c.observed} (Brier ${fmt(c.brier, 4)})`).join(', ')}`);
    if (r.boom?.buckets?.length) console.log(`    boom reliability: ${r.boom.buckets.map(b => `${b.bucket}: ${fmt(b.predicted, 3)}->${fmt(b.observed, 3)} (${b.n})`).join('  ')}`);
  }
}

function printRateQuality(analysis) {
  for (const [name, a] of Object.entries(analysis ?? {})) {
    const q = a.rateQuality;
    if (!q?.n) continue;
    console.log(`  RATE QUALITY at actual minutes (${name}, ${q.n} played rows)`);
    for (const r of q.leaderboard) console.log(`    ${r.projector.padEnd(8)} MAE ${fmt(r.mae, 3)}  bias ${fmt(r.bias, 3)}  per-minute ${fmt(r.perMinuteError, 4)}`);
    for (const p of q.paired) console.log(`    ${p.projector} vs ${p.vs}: ${fmt(p.diff, 3)} [${fmt(p.ci[0], 3)}, ${fmt(p.ci[1], 3)}]`);
    console.log(`    per-stat MAE (rates / naive): ${Object.entries(q.stats).map(([s, v]) => `${s} ${fmt(v.rates, 3)}/${fmt(v.naive, 3)}`).join('  ')}`);
    console.log(`    <p10 ${fmt(q.coverage.belowP10, 1)}%  >p90 ${fmt(q.coverage.aboveP90, 1)}%  DD ${q.doubles.ddPredicted}/${q.doubles.ddActual}  TD ${q.doubles.tdPredicted}/${q.doubles.tdActual} (pred/actual)`);
  }
}

function printMinutesPaired(summary) {
  if (!summary.pairedMinutes?.length) return;
  for (const p of summary.pairedMinutes) {
    console.log(`  minutes ${p.projector.padEnd(32)} vs ${p.vs}: ${fmt(p.diff, 3)} [${fmt(p.ci[0], 3)}, ${fmt(p.ci[1], 3)}]`);
  }
}

function printModelEval(report, file) {
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log(`  MODEL EVALUATION (${report.site}, data ${report.signature})`);
  console.log('═══════════════════════════════════════════════════════════════');
  for (const seg of report.replay?.segments ?? []) {
    printBoard(`REPLAY ${seg.season} [${seg.role}] ${seg.dates} dates, played`, seg.played, report.replay.baseline);
    printExtraPaired(seg.played, report.replay.baseline);
    printMinutesPaired(seg.played);
    printBoard(`REPLAY ${seg.season} [${seg.role}] incl. DNP`, seg.withDnp, report.replay.baseline);
    printExtraPaired(seg.withDnp, report.replay.baseline);
    printMinutesPaired(seg.withDnp);
    printCalibration(seg.withDnp);
    printRateQuality(seg.analysis);
  }
  if (report.slate) {
    const s = report.slate;
    console.log(`\nSLATES: ${s.slates.map(x => `${x.date} (${x.played}/${x.players})`).join(', ')}`);
    printBoard('SLATES incl. DNP (0 pts)', s.withDnp, s.baseline);
    printExtraPaired(s.withDnp, s.baseline);
    printMinutesPaired(s.withDnp);
    printBoard('SLATES played only', s.played, s.baseline);
    printExtraPaired(s.played, s.baseline);
    printMinutesPaired(s.played);
    printCalibration(s.withDnp);
    printRateQuality(s.analysis);
    console.log(`\nTOP-${s.valueHit.top} VALUE HIT RATE (>= ${s.valueHit.multiple}x; base rate ${fmt(s.valueHit.baseRate, 3)})`);
    for (const v of s.valueHit.projectors) console.log(`${v.projector.padEnd(34)}${pad(`${v.hits}/${v.picks}`, 9)}${pad(fmt(v.rate, 3), 8)}  avg ${fmt(v.avgActualValue)}x`);
  }
  const t = report.timings;
  console.log(`\nTIMINGS: load ${t.loadMs ?? 0} ms, index ${t.indexMs ?? 0} ms, replay ${t.replay?.totalMs ?? 0} ms, slates ${(t.slateLoadMs ?? 0) + (t.slate?.totalMs ?? 0)} ms, total ${t.totalMs} ms`);
  for (const [name, v] of Object.entries(t.replay?.perProjectorMs ?? {})) console.log(`  replay ${name.padEnd(34)}${pad(v, 8)} ms${t.cache?.[name] ? `  (cache reused ${t.cache[name].reused}, added ${t.cache[name].added})` : ''}`);
  if (file) console.log(`\nReport: ${file}`);
  console.log('');
}

try {
  if (args.includes('--list')) {
    for (const p of listProjectors()) console.log(`${p.name.padEnd(34)}${p.modes.join('/').padEnd(14)}${p.description}`);
    process.exit(0);
  }

  if (args.includes('--model')) {
    const report = await modelEval.runModelEval({
      mode: argValue('--mode') || 'both',
      site: argValue('--site') || undefined,
      projectors: list('--projectors'),
      seasons: list('--seasons'),
      from: options.from || undefined,
      to: options.to || undefined,
      slateDates: list('--slate-dates'),
      replayBaseline: argValue('--baseline') || undefined,
      slateBaseline: argValue('--slate-baseline') || undefined,
      iterations: argValue('--iterations') ? Number(argValue('--iterations')) : undefined,
      comparisons: list('--compare')?.map(pair => pair.split(':')),
      cache: !args.includes('--no-cache'),
      includeRows: args.includes('--rows'),
      onProgress: (m) => process.stderr.write(`  ${m}\n`)
    });
    const file = modelEval.writeReport(report, argValue('--out'));
    if (asJson) console.log(JSON.stringify(report, null, 2));
    else printModelEval(report, file);
    process.exit(0);
  }

  if (args.includes('--replay')) {
    const report = await runReplayBacktest({
      from: options.from,
      to: options.to,
      site: argValue('--site') || 'draftkings',
      legacy: !args.includes('--no-legacy'),
      dvpVariants: args.includes('--dvp') ? dvpVariants() : []
    });
    if (asJson) console.log(JSON.stringify(report, null, 2));
    else printReplay(report);
    process.exit(0);
  }

  const report = await runProjectionBacktest(options);

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    const { sample, overall } = report;
    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log('  PROJECTION ACCURACY BACKTEST');
    console.log('═══════════════════════════════════════════════════════════════');
    console.log(`Player-games scored: ${sample.playerGames} across ${sample.dates} date(s), ${sample.slates} slate(s)` +
      (sample.dateRange ? ` [${sample.dateRange.from} → ${sample.dateRange.to}]` : ''));
    console.log(`Unmatched projections (no box score / DNP): ${sample.unmatchedProjections}, skipped (no date or 0 proj): ${sample.skippedProjections}`);
    console.log(`Rows with raw RotoWire projection: ${sample.withRawRotowire}, of which adjusted by us: ${sample.adjustedFromRaw}`);

    if (sample.playerGames > 0) {
      printMetricTable('OVERALL', [{ group: 'all', ...overall }]);
      if (report.adjustedOnly) printMetricTable('ADJUSTED ROWS ONLY (projection ≠ RotoWire)', [{ group: 'adjusted', ...report.adjustedOnly }]);
      console.log(`Correlation: ${fmt(overall.correlation, 3)}  mean proj ${fmt(overall.meanProjected)} vs actual ${fmt(overall.meanActual)}  avg floor-ceiling width ${fmt(overall.calibration.avgRangeWidth)}`);
      printMetricTable('BY SALARY TIER', report.bySalaryTier);
      printMetricTable('BY POSITION (multi-eligible players count in each)', report.byPosition);

      if (report.factors.length) {
        console.log('\nFACTOR ATTRIBUTION (marginal value of each factor added to raw RotoWire)');
        console.log(`${'factor'.padEnd(10)}${pad('n', 6)}${pad('meanAdj', 9)}${pad('MAE raw', 9)}${pad('MAE +f', 9)}${pad('gain', 8)}${pad('corr', 8)}${pad('scale', 8)}  verdict`);
        for (const f of report.factors) {
          console.log(`${f.factor.padEnd(10)}${pad(f.n, 6)}${pad(fmt(f.meanAdjustment), 9)}${pad(fmt(f.maeRaw), 9)}${pad(fmt(f.maeWithFactor), 9)}` +
            `${pad(fmt(f.maeImprovement, 3), 8)}${pad(fmt(f.correlationWithResidual, 3), 8)}${pad(fmt(f.optimalScale), 8)}  ${f.verdict}`);
        }
        console.log('(gain > 0 = factor lowers MAE; scale ≈ 1 well-weighted, 0–1 overweighted, < 0 wrong direction)');
      }
    }

    console.log('\nINSIGHTS');
    for (const line of report.insights) console.log(`  • ${line}`);
    console.log('');
  }
} catch (error) {
  console.error('❌ Backtest failed:', error.message);
  process.exitCode = 1;
} finally {
  db.close();
}
