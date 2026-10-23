#!/usr/bin/env node
/**
 * Calibration report for player floor / ceiling (services/variance).
 *
 * 1. Replay: every 2025-26 regular-season game, each player's range built only
 *    from his games before that date (naive projection = recent minutes x FPPM).
 * 2. Slates: slate_player_snapshots joined to actual DK points, using the real
 *    pre-game projection / minutes / salary.
 * For both, reports the share of actual scores below the floor and above the
 * ceiling (target ~15% each) for the new model and the old one.
 *
 * Usage: node scripts/calibrate-outcome-ranges.js [--grid] [--sample=4]
 *   --grid      also try a few spread multipliers on the replay
 *   --sample=N  replay every Nth case (default 3; 1 = all)
 */

import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../.env') });

const { default: db } = await import('../src/config/database.js');
const dist = await import('../src/services/variance/outcomeDistribution.js');
const { replayCases, coverage, legacyRange } = await import('../src/services/variance/replay.js');
const { loadGameLogs } = await import('../src/services/variance/outcomeRangeService.js');

const args = process.argv.slice(2);
const sample = Number(args.find((a) => a.startsWith('--sample='))?.split('=')[1]) || 3;
const grid = args.includes('--grid');

const fmt = (c) => `n=${String(c.n).padStart(5)}  below floor ${String(c.belowPct).padStart(5)}%  above ceiling ${String(c.abovePct).padStart(5)}%`;
const avg = (xs) => (xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : 0);

function newRange(c, position) {
  const profile = dist.shrinkProfile(dist.summarizeGameLog(c.priorGames), dist.priorFor(dist.positionGroup(position), c.minutes));
  return dist.computeOutcomeRange({ projection: c.projection, minutes: c.minutes, salary: 0, profile });
}

// RotoWire's rolling averages as of the game: last 3/5/7 and season-to-date
function legacyAverages(c) {
  const fp = c.priorGames.map((g) => g.fp);
  const season = c.priorGames.filter((g) => g.season === c.season).map((g) => g.fp);
  return [avg(fp.slice(0, 3)), avg(fp.slice(0, 5)), avg(fp.slice(0, 7)), avg(season)];
}

// ── 1. Replay ──────────────────────────────────────────────
const games = await db.all(
  `SELECT player_key, game_date, season, position, minutes, dk_fantasy_points AS fp
   FROM historical_games
   WHERE season_type = 'regular' AND minutes > 0 AND dk_fantasy_points IS NOT NULL
     AND season IN ('2024-25', '2025-26')`
);
const all = replayCases(games, { from: '2025-10-21', to: '2026-04-12', minPriorGames: 10 });
const cases = all.filter((_, i) => i % sample === 0);
console.log(`\nREPLAY 2025-26 regular season (no lookahead, every ${sample}${sample === 1 ? '' : 'rd/th'} case of ${all.length})`);

const scored = cases.map((c) => ({ ...c, ...newRange(c, c.position) }));
const legacy = cases.map((c) => ({ actual: c.actual, ...legacyRange(c.projection, legacyAverages(c)) }));
console.log(`  old: ${fmt(coverage(legacy))}`);
console.log(`  new: ${fmt(coverage(scored))}`);
console.log(`  avg range width old ${avg(legacy.map((r) => r.ceiling - r.floor)).toFixed(1)} / new ${avg(scored.map((r) => r.ceiling - r.floor)).toFixed(1)} (avg proj ${avg(cases.map((c) => c.projection)).toFixed(1)})`);
for (const [label, lo, hi] of [['<18 min', 0, 18], ['18-26', 18, 26], ['26-32', 26, 32], ['32+', 32, 99]]) {
  console.log(`  new ${label.padEnd(7)} ${fmt(coverage(scored.filter((c) => c.minutes >= lo && c.minutes < hi)))}`);
}
for (const [label, lo, hi] of [['<15 prior', 0, 15], ['15-29', 15, 30], ['30', 30, 99]]) {
  console.log(`  new ${label.padEnd(9)} ${fmt(coverage(scored.filter((c) => c.priorGames.length >= lo && c.priorGames.length < hi)))}`);
}

if (grid) {
  const base = { ...dist.CALIBRATION };
  const sub = cases.filter((_, i) => i % 3 === 0);
  for (const k of [1, 1.1, 1.2, 1.3]) {
    for (const m of [1, 1.2, 1.4]) {
      dist.CALIBRATION.kappaScale = k;
      dist.CALIBRATION.minutesScale = m;
      console.log(`  grid kappa x${k} minutes x${m}: ${fmt(coverage(sub.map((c) => ({ actual: c.actual, ...newRange(c, c.position) }))))}`);
    }
  }
  Object.assign(dist.CALIBRATION, base);
}

// ── 2. Real slates ─────────────────────────────────────────
const snaps = await db.all(
  `SELECT s.game_date, s.player_key, s.player_name, s.position, s.salary, s.projected_points, s.projected_minutes,
          s.floor, s.ceiling, s.vegas_spread, h.dk_fantasy_points AS actual
   FROM slate_player_snapshots s
   JOIN historical_games h ON h.player_key = s.player_key AND h.game_date = s.game_date
   WHERE s.site = 'draftkings' AND s.projected_points > 0 AND h.minutes > 0
   ORDER BY s.game_date, s.projected_points DESC`
);
const blowout = (spread) => Math.max(0, Math.abs(Number(spread) || 0) - 10) * 0.1;
const slateRows = [];
for (const date of [...new Set(snaps.map((s) => s.game_date))]) {
  const day = snaps.filter((s) => s.game_date === date);
  const logs = await loadGameLogs(day.map((s) => s.player_key), { site: 'draftkings', beforeDate: date });
  for (const s of day) {
    const prior = (logs.get(s.player_key) || []).slice(0, dist.GAME_WINDOW);
    const profile = dist.shrinkProfile(dist.summarizeGameLog(prior), dist.priorFor(dist.positionGroup(s.position), s.projected_minutes));
    const r = dist.computeOutcomeRange({
      projection: s.projected_points, minutes: s.projected_minutes, salary: s.salary, profile, blowoutRisk: blowout(s.vegas_spread)
    });
    slateRows.push({ ...s, oldFloor: s.floor, oldCeiling: s.ceiling, ...r });
  }
}
console.log(`\nSLATES ${[...new Set(snaps.map((s) => s.game_date))].join(', ')} (DraftKings snapshots vs actual DK points)`);
console.log(`  old: ${fmt(coverage(slateRows.map((r) => ({ actual: r.actual, floor: r.oldFloor, ceiling: r.oldCeiling }))))}`);
console.log(`  new: ${fmt(coverage(slateRows))}`);
const value = slateRows.map((r) => dist.boomBustThresholds(r.salary));
console.log(`  bust (< 5x): predicted avg ${avg(slateRows.map((r) => r.bustProbability)).toFixed(1)}%, actual ${(100 * avg(slateRows.map((r, i) => (r.actual < value[i].value ? 1 : 0)))).toFixed(1)}%`);
console.log(`  boom (>= 5x+10): predicted avg ${avg(slateRows.map((r) => r.boomProbability)).toFixed(1)}%, actual ${(100 * avg(slateRows.map((r, i) => (r.actual >= value[i].boom ? 1 : 0)))).toFixed(1)}%`);

console.log('\n  examples (proj | old floor-ceiling | new floor-ceiling | actual)');
for (const name of ['Cedric Coward', 'Kelly Oubre', "Royce O'Neale"]) {
  const r = slateRows.find((x) => x.player_name.startsWith(name));
  if (r) {
    console.log(`  ${r.player_name.padEnd(16)} ${r.game_date} ${r.projected_points.toFixed(2).padStart(6)} | ${r.oldFloor.toFixed(1)}-${r.oldCeiling.toFixed(1)} | ${r.floor.toFixed(1)}-${r.ceiling.toFixed(1)} sd ${r.stdDev.toFixed(1)} bust ${r.bustProbability.toFixed(0)}% boom ${r.boomProbability.toFixed(0)}% | ${r.actual}`);
  }
}

db.close?.();
