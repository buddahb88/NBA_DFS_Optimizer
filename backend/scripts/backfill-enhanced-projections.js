#!/usr/bin/env node

/**
 * BACKFILL ENHANCED PROJECTIONS
 *
 * This script recalculates projections for all players in the database
 * using the enhanced projection engine that blends:
 * - Historical season averages
 * - Last 3 games momentum
 * - Matchup-specific history
 * - Usage bump detection
 * - Player-specific B2B and home/away adjustments
 *
 * Usage:
 *   node scripts/backfill-enhanced-projections.js [--slate-date YYYY-MM-DD] [--update-db]
 *
 * Options:
 *   --slate-date   Date to use for backtesting (only uses historical data before this date)
 *   --update-db    Actually update the database (default: dry run)
 *   --verbose      Show detailed player breakdowns
 */

import db from '../src/config/database.js';
import projectionService from '../src/services/projectionService.js';

// Parse command line arguments
const args = process.argv.slice(2);
const slateDate = args.find((a, i) => args[i - 1] === '--slate-date') || null;
const updateDb = args.includes('--update-db');
const verbose = args.includes('--verbose');

console.log(`
═══════════════════════════════════════════════════════════════
  ENHANCED PROJECTION BACKFILL
═══════════════════════════════════════════════════════════════
`);

if (slateDate) {
  console.log(`📅 Backtest Mode: Using historical data before ${slateDate}`);
}
console.log(`💾 Update Database: ${updateDb ? 'YES' : 'NO (dry run)'}`);
console.log(`📝 Verbose: ${verbose ? 'YES' : 'NO'}`);
console.log('');

// Get all slates
const slates = db.prepare(`
  SELECT DISTINCT slate_id, name, created_at
  FROM slates
  ORDER BY created_at DESC
`).all();

if (slates.length === 0) {
  console.log('❌ No slates found in database');
  process.exit(1);
}

console.log(`📋 Found ${slates.length} slate(s) in database\n`);

// Process each slate
for (const slate of slates) {
  console.log(`\n════════════════════════════════════════════════════════`);
  console.log(`  Processing Slate: ${slate.name} (${slate.slate_id})`);
  console.log(`════════════════════════════════════════════════════════`);

  // Get all players for this slate
  const players = db.prepare(`
    SELECT
      p.*,
      tdr.def_eff as opp_def_eff,
      tdvp.pts_allowed as dvp_pts_allowed
    FROM players p
    LEFT JOIN team_defense_rankings tdr ON p.opponent = tdr.team
    LEFT JOIN team_defense_vs_position tdvp ON p.opponent = tdvp.team
      AND SUBSTR(p.position, 1, 2) = tdvp.position
    WHERE p.slate_id = ?
  `).all(slate.slate_id);

  if (players.length === 0) {
    console.log(`  ⚠️  No players found for this slate`);
    continue;
  }

  console.log(`  📊 Found ${players.length} players`);

  // Clear cache for fresh calculations
  projectionService.clearCache();

  // Calculate enhanced projections
  const results = projectionService.calculateSlateEnhancedProjections(players, slateDate);

  // Calculate stats
  const enhanced = results.filter(r => r.enhanced);
  const fallback = results.filter(r => !r.enhanced);

  const totalRotowire = enhanced.reduce((sum, r) => sum + (r.rotowire_baseline || 0), 0);
  const totalEnhanced = enhanced.reduce((sum, r) => sum + r.enhanced_projection, 0);
  const avgChange = enhanced.length > 0 ? (totalEnhanced - totalRotowire) / enhanced.length : 0;

  const usageBumps = results.filter(r => r.usageBump?.hasUsageBump);
  const hotStreaks = results.filter(r => r.historical?.streakPct > 10);
  const coldStreaks = results.filter(r => r.historical?.streakPct < -10);

  console.log(`\n  📈 Results Summary:`);
  console.log(`     Enhanced: ${enhanced.length} players`);
  console.log(`     Fallback (no history): ${fallback.length} players`);
  console.log(`     Avg RotoWire: ${enhanced.length > 0 ? (totalRotowire / enhanced.length).toFixed(1) : 'N/A'}`);
  console.log(`     Avg Enhanced: ${enhanced.length > 0 ? (totalEnhanced / enhanced.length).toFixed(1) : 'N/A'}`);
  console.log(`     Avg Change: ${avgChange > 0 ? '+' : ''}${avgChange.toFixed(1)} FP`);
  console.log(`\n  🎯 Insights Found:`);
  console.log(`     Usage Bumps: ${usageBumps.length}`);
  console.log(`     Hot Streaks: ${hotStreaks.length}`);
  console.log(`     Cold Streaks: ${coldStreaks.length}`);

  // Show top changes
  const topUp = results
    .filter(r => r.enhanced)
    .sort((a, b) => (b.enhanced_projection - (b.rotowire_baseline || 0)) - (a.enhanced_projection - (a.rotowire_baseline || 0)))
    .slice(0, 5);

  const topDown = results
    .filter(r => r.enhanced)
    .sort((a, b) => (a.enhanced_projection - (a.rotowire_baseline || 0)) - (b.enhanced_projection - (b.rotowire_baseline || 0)))
    .slice(0, 5);

  console.log(`\n  📈 Top 5 Projection Increases:`);
  for (const p of topUp) {
    const change = p.enhanced_projection - (p.rotowire_baseline || 0);
    if (change > 0) {
      console.log(`     ${p.name} (${p.team}): ${(p.rotowire_baseline || 0).toFixed(1)} → ${p.enhanced_projection.toFixed(1)} (+${change.toFixed(1)})`);
      if (verbose) {
        console.log(`        Season: ${p.historical?.seasonAvg?.toFixed(1)} | L3: ${p.historical?.last3Avg?.toFixed(1)} | Streak: ${p.historical?.streakPct?.toFixed(1)}%`);
        if (p.usageBump?.hasUsageBump) {
          console.log(`        Usage Bump: +${p.usageBump.bump.toFixed(1)}% (${p.usageBump.missingPlayers[0]?.missingPlayer} OUT)`);
        }
      }
    }
  }

  console.log(`\n  📉 Top 5 Projection Decreases:`);
  for (const p of topDown) {
    const change = p.enhanced_projection - (p.rotowire_baseline || 0);
    if (change < 0) {
      console.log(`     ${p.name} (${p.team}): ${(p.rotowire_baseline || 0).toFixed(1)} → ${p.enhanced_projection.toFixed(1)} (${change.toFixed(1)})`);
      if (verbose) {
        console.log(`        Season: ${p.historical?.seasonAvg?.toFixed(1)} | L3: ${p.historical?.last3Avg?.toFixed(1)} | Streak: ${p.historical?.streakPct?.toFixed(1)}%`);
      }
    }
  }

  // Show usage bumps
  if (usageBumps.length > 0) {
    console.log(`\n  🔥 Usage Bump Opportunities:`);
    for (const p of usageBumps.slice(0, 5)) {
      const bump = p.usageBump.missingPlayers[0];
      console.log(`     ${p.name} (${p.team}): +${bump.pctBump}% when ${bump.missingPlayer} is OUT`);
    }
  }

  // Update database if requested
  if (updateDb) {
    console.log(`\n  💾 Updating database...`);

    const updateStmt = db.prepare(`
      UPDATE players
      SET projected_points = ?,
          floor = ?,
          ceiling = ?
      WHERE slate_id = ? AND player_id = ?
    `);

    const updateMany = db.transaction((projections) => {
      let updated = 0;
      for (const p of projections) {
        if (p.enhanced) {
          updateStmt.run(
            p.enhanced_projection,
            p.historical?.floor || p.enhanced_projection * 0.7,
            p.historical?.ceiling || p.enhanced_projection * 1.3,
            slate.slate_id,
            p.player_id
          );
          updated++;
        }
      }
      return updated;
    });

    const updatedCount = updateMany(results);
    console.log(`  ✅ Updated ${updatedCount} player projections`);
  }
}

console.log(`
═══════════════════════════════════════════════════════════════
  BACKFILL COMPLETE
═══════════════════════════════════════════════════════════════
`);

if (!updateDb) {
  console.log(`💡 This was a dry run. To update the database, run with --update-db`);
}

// Close database
db.close();
