#!/usr/bin/env node
/**
 * Validation report for the opportunity rate projection
 * (services/opportunity/rateProjection.js), without lookahead.
 *
 * 1. Replay: 2025-26 regular-season games, each case built only from games
 *    before its date (services/opportunity/rateReplay.js).
 *    - minutes = actual: isolates the FPPM blend + pace factor vs plain
 *      season FPPM.
 *    - minutes = recent L5: full rate projection vs a posted-projection proxy
 *      (season points per game); does a large positive gap beat the proxy?
 * 2. Saved slates (slate_player_snapshots): getOpportunityMetrics in backtest
 *    mode with the real posted projection, minutes, Vegas and pre-lock outs.
 *    MAE of rate vs posted, both vs actual, and the top-20 gap hit rate
 *    (actual > posted).
 *
 * Usage: node scripts/rate-projection-report.js [--grid] [--sample=2]
 *   --grid      try a few blend / shrink / pace coefficients on the replay
 *   --sample=N  replay every Nth case (default 1 = all)
 */

import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../.env') });

const { default: db } = await import('../src/config/database.js');
const { replayRateCases, topGapHitRate, mae } = await import('../src/services/opportunity/rateReplay.js');
const { RATE_CONFIG } = await import('../src/services/opportunity/rateProjection.js');
const { getOpportunityMetrics } = await import('../src/services/opportunity/metricsService.js');
const { seasonForDate } = await import('../src/utils/season.js');

const args = process.argv.slice(2);
const sample = Number(args.find((a) => a.startsWith('--sample='))?.split('=')[1]) || 1;
const grid = args.includes('--grid');

const f2 = (x) => (x === null || x === undefined ? '  -  ' : x.toFixed(2));
const pct = (x) => (x === null || x === undefined ? '  -  ' : `${(100 * x).toFixed(1)}%`);

// ── 1. Replay ──────────────────────────────────────────────
const games = await db.all(
  `SELECT player_key, season, game_date, team, opponent, minutes, dk_fantasy_points AS fp
   FROM historical_games
   WHERE COALESCE(season_type, 'regular') = 'regular' AND minutes > 0 AND dk_fantasy_points IS NOT NULL
     AND season IN ('2024-25', '2025-26')`);
const teamGames = await db.all(
  `SELECT team, season, game_date, possessions FROM team_game_stats
   WHERE COALESCE(season_type, 'regular') = 'regular' AND season IN ('2024-25', '2025-26')`);
const window = { from: '2025-10-21', to: '2026-04-12', seasonOf: seasonForDate };
const thin = (cases) => cases.filter((_, i) => i % sample === 0);

function replay(config, minutes) {
  return thin(replayRateCases(games, teamGames, { ...window, minutes, config }));
}

console.log('\nREPLAY 2025-26 regular season (DK points, prior games only)');
const actualMin = replay(RATE_CONFIG, 'actual');
console.log(`  n=${actualMin.length}  minutes = actual (isolates FPPM)`);
console.log(`    MAE  season FPPM x min          ${f2(mae(actualMin, r => r.naive_fppm * r.minutes))}`);
console.log(`    MAE  blended FPPM x min         ${f2(mae(actualMin, r => r.fppm * r.minutes))}`);
console.log(`    MAE  blended FPPM x min x pace  ${f2(mae(actualMin, r => r.rate))}`);

const recent = replay(RATE_CONFIG, 'recent');
const hit = topGapHitRate(recent);
console.log(`  n=${recent.length}  minutes = recent L5 (prior only), posted proxy = season pts/game`);
console.log(`    MAE  rate vs actual ${f2(mae(recent, r => r.rate))}   proxy vs actual ${f2(mae(recent, r => r.posted))}   rate vs proxy ${f2(mae(recent, r => r.rate, r => r.posted))}`);
console.log(`    top-20 gap per night: ${hit.hits}/${hit.picks} beat the proxy = ${pct(hit.hitRate)} (all players ${pct(hit.baseRate)}), avg beat ${f2(hit.avgBeat)}`);

if (grid) {
  console.log('\n  GRID (minutes = actual, MAE vs actual)');
  for (const l10Weight of [0.3, 0.5, 0.7]) {
    for (const l10ShrinkMinutes of [75, 150, 300]) {
      for (const seasonPriorMinutes of [120, 240, 480]) {
        const cfg = { ...RATE_CONFIG, l10Weight, l10ShrinkMinutes, seasonPriorMinutes, paceElasticity: 0 };
        const rows = replay(cfg, 'actual');
        console.log(`    l10Weight ${l10Weight}  shrink ${String(l10ShrinkMinutes).padStart(3)}  prior ${String(seasonPriorMinutes).padStart(3)}  MAE ${f2(mae(rows, r => r.rate))}`);
      }
    }
  }
  for (const paceElasticity of [0, 0.25, 0.5, 1]) {
    const rows = replay({ ...RATE_CONFIG, paceElasticity }, 'actual');
    console.log(`    paceElasticity ${paceElasticity}  MAE ${f2(mae(rows, r => r.rate))}`);
  }
}

// ── 2. Saved slates ───────────────────────────────────────
const dates = (await db.all(`SELECT DISTINCT game_date FROM slate_player_snapshots WHERE site = 'draftkings' ORDER BY game_date`))
  .map(r => String(r.game_date).slice(0, 10));
const now = new Date();
const slateRows = [];
console.log('\nSAVED SLATES (backtest mode: posted projection / minutes / Vegas / pre-lock outs as of lock)');
for (const slateDate of dates) {
  let result;
  try {
    result = await getOpportunityMetrics({ slateDate, site: 'draftkings', refresh: true, now });
  } catch (error) {
    console.log(`  ${slateDate}: ${error.message}`);
    continue;
  }
  const rows = result.players
    .filter(p => p.rate_projection !== null && p.actual_points !== null && p.result_status === 'PLAYED')
    .map(p => ({ ...p, game_date: slateDate, rate: p.rate_projection, posted: Number(p.projected_points), actual: Number(p.actual_points), gap: p.rate_gap }));
  slateRows.push(...rows);
  const h = topGapHitRate(rows);
  console.log(`  ${slateDate}  n=${String(rows.length).padStart(3)}  MAE rate vs posted ${f2(mae(rows, r => r.rate, r => r.posted))}  rate vs actual ${f2(mae(rows, r => r.rate))}  posted vs actual ${f2(mae(rows, r => r.posted))}  top-20 gap beat posted ${h.hits}/${h.picks} (${pct(h.hitRate)}; all ${pct(h.baseRate)})`);
}
if (slateRows.length) {
  const h = topGapHitRate(slateRows);
  console.log(`  ALL         n=${String(slateRows.length).padStart(3)}  MAE rate vs posted ${f2(mae(slateRows, r => r.rate, r => r.posted))}  rate vs actual ${f2(mae(slateRows, r => r.rate))}  posted vs actual ${f2(mae(slateRows, r => r.posted))}  top-20 gap beat posted ${h.hits}/${h.picks} (${pct(h.hitRate)}; all ${pct(h.baseRate)})`);
}

db.close();
