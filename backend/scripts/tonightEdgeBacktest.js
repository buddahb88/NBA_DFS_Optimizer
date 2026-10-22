#!/usr/bin/env node

/**
 * TONIGHT EDGE BACKTEST
 *
 * Replays the Archetypes page Tonight list for every synced slate in
 * slate_player_snapshots and compares the top N by raw matchup delta with
 * the top N by adjusted edge (archetypeMatchupService): each player's actual
 * DK points vs his last-season (regular season) DK average.
 *
 * Defense resolves as /tonight does without a season (thin current season ->
 * last season). Minutes so far this season count only games before the slate
 * date. Players without a box score that night count as DNP (0 DK).
 *
 * Usage:
 *   node scripts/tonightEdgeBacktest.js [--date 2026-10-21] [--top 10] [--site draftkings]
 */

import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Load env before the database module reads DATABASE_TYPE
dotenv.config({ path: path.join(__dirname, '../.env') });

const { default: db } = await import('../src/config/database.js');
const { STAT_COLUMNS, buildTonight, getDefense, loadArchetypeLookup, previousSeason, weakTiers } =
  await import('../src/services/archetypeDefenseService.js');
const { loadEdgeContext } = await import('../src/services/archetypeMatchupService.js');

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const TOP = Number(arg('top') || 10);
const SITE = arg('site') || 'draftkings';
const n = (v) => Number(v) || 0;
const dateString = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : v);

const SLATES_SQL = `SELECT DISTINCT game_date, slate_id FROM slate_player_snapshots WHERE site = ? ORDER BY game_date`;
const SNAPSHOT_SQL = `SELECT player_key, player_name, team, opponent, position, salary, projected_points,
  projected_minutes, injury_status FROM slate_player_snapshots WHERE game_date = ? AND site = ? AND slate_id = ?`;
const ACTUALS_SQL = `SELECT player_key, SUM(dk_fantasy_points) AS dk, SUM(minutes) AS minutes
  FROM historical_games WHERE game_date = ? GROUP BY player_key`;
const AVERAGES_SQL = `SELECT player_key, AVG(dk_fantasy_points) AS dk FROM historical_games
  WHERE season = ? AND COALESCE(season_type, 'regular') = 'regular' AND minutes > 0 GROUP BY player_key`;

function summarize(label, list, actuals, averages, lastSeason) {
  const rows = list.slice(0, TOP).map(p => {
    const actual = actuals.get(p.player_id);
    const avg = averages.get(p.player_id);
    return {
      name: p.name, team: p.team, opp: p.opponent, raw: n(p.matchup_delta).toFixed(2), adj: n(p.adjusted_edge).toFixed(2),
      flags: p.flags.join(','), proj_min: p.projected_minutes, min: actual ? n(actual.minutes) : 'DNP',
      dk: actual ? n(actual.dk) : 0, [`avg_${lastSeason}`]: avg == null ? null : Number(avg.toFixed(1)),
      diff: avg == null ? null : Number(((actual ? n(actual.dk) : 0) - avg).toFixed(1)),
    };
  });
  const scored = rows.filter(r => r.diff !== null);
  const meanDiff = scored.reduce((s, r) => s + r.diff, 0) / (scored.length || 1);
  const meanDk = rows.reduce((s, r) => s + r.dk, 0) / (rows.length || 1);
  console.log(`\n${label}: top ${rows.length}, mean DK ${meanDk.toFixed(1)}, mean vs ${lastSeason} avg ${meanDiff >= 0 ? '+' : ''}${meanDiff.toFixed(1)} (${scored.length} with an average)`);
  console.table(rows);
  return { meanDk, meanDiff, scored: scored.length };
}

try {
  const only = arg('date');
  const slates = (await db.all(SLATES_SQL, SITE)).map(s => ({ ...s, game_date: dateString(s.game_date) }))
    .filter(s => !only || s.game_date === only);
  if (slates.length === 0) console.log('No slate_player_snapshots to replay.');

  const totals = { raw: [], adjusted: [] };
  for (const { game_date: date, slate_id: slateId } of slates) {
    const defense = await getDefense({ site: SITE, seasonFallback: true });
    const archetypeSeason = defense.fallback?.from ?? defense.season;
    const lastSeason = previousSeason(archetypeSeason);
    const [snapshot, archetypeOf, edgeContext, actualRows, averageRows] = await Promise.all([
      db.all(SNAPSHOT_SQL, date, SITE, slateId),
      loadArchetypeLookup(archetypeSeason),
      loadEdgeContext({ season: archetypeSeason, lastSeason, asOfDate: date }),
      db.all(ACTUALS_SQL, date),
      db.all(AVERAGES_SQL, lastSeason),
    ]);
    const players = snapshot.map(s => ({ ...s, player_id: s.player_key, name: s.player_name }));
    const { players: adjusted } = buildTonight(players, {
      tiers: weakTiers(defense.rows, 'fp'), column: STAT_COLUMNS.fp, grouping: 'archetype', archetypeOf, edgeContext,
    });
    // Pre-change Tonight order: matchup delta, then projection
    const raw = [...adjusted].sort((a, b) => b.matchup_delta - a.matchup_delta || n(b.projected_points) - n(a.projected_points));

    const actuals = new Map(actualRows.map(r => [r.player_key, r]));
    const averages = new Map(averageRows.map(r => [r.player_key, n(r.dk)]));
    console.log(`\n=== ${date} slate ${slateId}: ${snapshot.length} players, ${adjusted.length} on Tonight, defense ${defense.season}${defense.fallback ? ' (fallback)' : ''} ===`);
    totals.raw.push(summarize('RAW (matchup delta)', raw, actuals, averages, lastSeason));
    totals.adjusted.push(summarize('ADJUSTED (minutes x crowding)', adjusted, actuals, averages, lastSeason));
  }

  if (slates.length > 1) {
    for (const [k, list] of Object.entries(totals)) {
      const w = list.reduce((s, t) => s + t.scored, 0) || 1;
      console.log(`${k}: mean vs last-season avg ${(list.reduce((s, t) => s + t.meanDiff * t.scored, 0) / w).toFixed(1)} over ${slates.length} slates`);
    }
  }
} finally {
  db.close();
}
