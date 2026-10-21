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

try {
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
