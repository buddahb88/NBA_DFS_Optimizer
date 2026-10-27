#!/usr/bin/env node
/**
 * Validation report for the Opportunity Radar score
 * (services/opportunity/radarService.js) on saved slates, without lookahead:
 * per date and mode, do the top-decile Opportunity Scores beat 5x salary
 * more often than the slate? Also prints each mode's top 10 with reasons.
 *
 * Usage: node scripts/opportunity-radar-report.js [YYYY-MM-DD ...] [--site=draftkings] [--top=10]
 *   dates default to 2026-10-20 and 2026-10-21
 */

import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../.env') });

const { default: db } = await import('../src/config/database.js');
const { getOpportunityRadar } = await import('../src/services/opportunity/radarService.js');
const { RADAR_MODES } = await import('../src/services/opportunity/radarConfig.js');

const args = process.argv.slice(2);
const site = args.find((a) => a.startsWith('--site='))?.split('=')[1] || 'draftkings';
const topN = Number(args.find((a) => a.startsWith('--top='))?.split('=')[1]) || 10;
const dates = args.filter((a) => /^\d{4}-\d{2}-\d{2}$/.test(a));
if (dates.length === 0) dates.push('2026-10-20', '2026-10-21');

const pct = (x) => (x === null || x === undefined ? '  -  ' : `${(100 * x).toFixed(1)}%`);
const f1 = (x) => (x === null || x === undefined ? '-' : Number(x).toFixed(1));

const totals = Object.fromEntries(RADAR_MODES.map((m) => [m, { topPlayers: 0, topHits: 0, players: 0, hits: 0 }]));

for (const date of dates) {
  for (const mode of RADAR_MODES) {
    const { players, validation, source } = await getOpportunityRadar({ slateDate: date, site, mode });
    const v = validation[mode];
    const t = totals[mode];
    t.topPlayers += v.top.players; t.topHits += v.top.hits; t.players += v.players; t.hits += v.slate.hits;

    console.log(`\n=== ${date} ${site} slate ${source.slateId} - ${mode.toUpperCase()} ===`);
    console.log(`Top decile (score >= ${f1(v.top.minScore)}): ${v.top.hits}/${v.top.players} hit 5x = ${pct(v.top.hitRate)}`
      + ` | slate ${v.slate.hits}/${v.slate.players} = ${pct(v.slate.hitRate)} | lift ${v.lift ?? '-'}`);
    console.log('Score  Player                    Sal    Proj  Act   5x?  Reason');
    for (const p of players.slice(0, topN)) {
      const hit = p.actualPoints !== null && p.actualPoints >= 5 * p.salary / 1000;
      console.log(`${f1(p.score).padStart(5)}  ${String(p.name).padEnd(24).slice(0, 24)}  ${String(p.salary).padStart(5)}  `
        + `${f1(p.projected_points).padStart(4)}  ${f1(p.actualPoints).padStart(4)}  ${hit ? 'yes' : ' no'}  ${p.reason}`);
    }
  }
}

console.log('\n=== Pooled ===');
for (const mode of RADAR_MODES) {
  const t = totals[mode];
  const top = t.topPlayers ? t.topHits / t.topPlayers : null;
  const slate = t.players ? t.hits / t.players : null;
  console.log(`${mode.toUpperCase().padEnd(4)}  top decile ${t.topHits}/${t.topPlayers} = ${pct(top)} | slate ${t.hits}/${t.players} = ${pct(slate)}`
    + ` | lift ${top !== null && slate ? (top / slate).toFixed(2) : '-'}`);
}

await db.close?.();
process.exit(0);
