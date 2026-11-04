#!/usr/bin/env node

/**
 * PLAYER CARD VERDICT BACKTEST: the card's Cash / GPP verdicts on every saved
 * main slate (as of each date) vs actual DK points
 * (services/playerCard/verdictBacktest.js). Read-only on the database;
 * writes the JSON report to backend/.cache (gitignored).
 *
 *   npm run backtest:verdicts -- [--slate-dates 2026-10-21,...] [--source rotowire|ours|blend]
 *     [--out .cache/verdict-backtest.json] [--json]
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../.env') });

const { default: db } = await import('../src/config/database.js');
const { runVerdictBacktest, MODES, SALARY_TIERS } = await import('../src/services/playerCard/verdictBacktest.js');
const { VERDICTS } = await import('../src/services/playerCard/verdict.js');
const { parseSource, projectionSource: activeSource } = await import('../src/config/projectionSource.js');

const args = process.argv.slice(2);
const argValue = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : null;
};
const dates = argValue('--slate-dates')?.split(',').map(s => s.trim()).filter(Boolean) ?? null;
const source = parseSource(argValue('--source')) ?? activeSource();
const out = path.resolve(path.join(__dirname, '..'), argValue('--out') ?? '.cache/verdict-backtest.json');
const asJson = args.includes('--json');

const fmt = (v, d = 1) => (v === null || v === undefined ? '-' : Number(v).toFixed(d));
const pctf = (v) => (v === null || v === undefined ? '-' : `${(v * 100).toFixed(0)}%`);
const signed = (v, d = 1) => (v === null || v === undefined ? '-' : `${v > 0 ? '+' : ''}${Number(v).toFixed(d)}`);
const pad = (v, w) => String(v).padStart(w);

function printMode(title, m) {
  console.log(`  ${title}   corr(score, actual - proj) ${signed(m.corr_score_vs_projection_miss, 3)} · corr(score, actual) ${signed(m.corr_score_vs_actual, 3)} · corr(score, value) ${signed(m.corr_score_vs_value, 3)}`);
  console.log(`    ${'verdict'.padEnd(10)}${pad('n', 6)}${pad('avg $', 8)}${pad('actual', 8)}${pad('vs proj', 9)}${pad('value', 7)}${pad('5x', 6)}${pad('6x+', 6)}`);
  for (const [label, b] of [...VERDICTS.map(v => [v, m.buckets[v]]), ['all', m.all]]) {
    console.log(`    ${label.padEnd(10)}${pad(b.n, 6)}${pad(b.avg_salary ? `$${(b.avg_salary / 1000).toFixed(1)}K` : '-', 8)}${pad(fmt(b.avg_actual), 8)}${pad(signed(b.avg_vs_projection), 9)}${pad(fmt(b.avg_value, 2), 7)}${pad(pctf(b.hit5x), 6)}${pad(pctf(b.hit6x), 6)}`);
  }
}

try {
  const { report } = await runVerdictBacktest({
    dates,
    projectionSource: source,
    onSlate: asJson ? null : (s) => console.log(`  ${s.date} slate ${s.slateId}: ${s.players} players (${s.ms} ms)${s.warnings.length ? ` warnings: ${s.warnings.join('; ')}` : ''}`),
  });
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(report, null, 2));

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`\nPLAYER CARD VERDICT BACKTEST · ${report.slates.length} main slates · source ${source} · ${report.players} players`);
    console.log(`  excluded: ${Object.entries(report.excluded).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'} · DNP / no box score (scored 0): ${report.dnp}`);
    console.log('  vs proj = actual - blend projection; value = actual pts per $1K; 5x / 6x+ = share hitting 5x / 6x salary\n');
    console.log('ALL PLAYERS');
    for (const mode of MODES) printMode(mode.toUpperCase(), report.overall[mode]);
    for (const t of SALARY_TIERS) {
      console.log(`\n${t.label.toUpperCase()}`);
      for (const mode of MODES) printMode(mode.toUpperCase(), report.tiers[t.key][mode]);
    }
    console.log(`\nReport written to ${out}`);
  }
} finally {
  db.close?.();
}
process.exit(0);
