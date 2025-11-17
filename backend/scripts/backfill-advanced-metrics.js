import db from '../src/config/database.js';
import teamDefenseModel from '../src/models/teamDefenseModel.js';
import teamDefenseVsPositionModel from '../src/models/teamDefenseVsPositionModel.js';
import { normalizeForRankings, normalizeForVsPosition } from '../src/utils/teamMapping.js';

/**
 * Backfill Advanced Projection Metrics
 *
 * This script recalculates all advanced projection metrics for an existing slate
 * without needing to fetch new data from RotoWire.
 *
 * Features added:
 * - Floor/Ceiling projections
 * - Volatility analysis
 * - Boom/Bust probabilities
 * - Weighted FPPM
 * - Leverage scoring
 * - Blowout risk assessment
 */

class AdvancedMetricsBackfill {
  constructor() {
    this.defenseRankings = null;
    this.positionDefenseData = null;
  }

  // Load defense data (same as rotowireService)
  loadDefenseRankings() {
    if (!this.defenseRankings) {
      const rankings = teamDefenseModel.getAll();
      this.defenseRankings = {};
      for (const team of rankings) {
        this.defenseRankings[team.team] = team;
      }
    }
    return this.defenseRankings;
  }

  loadPositionDefenseData() {
    if (!this.positionDefenseData) {
      const allData = teamDefenseVsPositionModel.getAll();
      this.positionDefenseData = {};
      for (const data of allData) {
        const key = `${data.team}_${data.position}`;
        this.positionDefenseData[key] = data;
      }
    }
    return this.positionDefenseData;
  }

  getPrimaryPosition(positionString) {
    if (!positionString) return null;
    const positions = positionString.split(',').map(p => p.trim());
    return positions[0];
  }

  // ═══════════════════════════════════════════════════════════════
  // ADVANCED CALCULATION METHODS (from rotowireService.js)
  // ═══════════════════════════════════════════════════════════════

  calculateWeightedFPPM(fptsLast3, minutesLast3, fptsLast5, minutesLast5, fptsSeason, seasonMinutes) {
    if (!seasonMinutes || seasonMinutes === 0) return 0;

    const fppmLast3 = (minutesLast3 && minutesLast3 > 0) ? fptsLast3 / minutesLast3 : 0;
    const fppmLast5 = (minutesLast5 && minutesLast5 > 0) ? fptsLast5 / minutesLast5 : 0;
    const fppmSeason = fptsSeason / seasonMinutes;

    let weightedFPPM = 0;
    let totalWeight = 0;

    if (fppmLast3 > 0) {
      weightedFPPM += fppmLast3 * 0.40;
      totalWeight += 0.40;
    }
    if (fppmLast5 > 0) {
      weightedFPPM += fppmLast5 * 0.30;
      totalWeight += 0.30;
    }
    if (fppmSeason > 0) {
      weightedFPPM += fppmSeason * 0.30;
      totalWeight += 0.30;
    }

    if (totalWeight > 0) {
      weightedFPPM = weightedFPPM / totalWeight;
    }

    return weightedFPPM;
  }

  calculatePlayerVariance(recentGames) {
    if (!recentGames || recentGames.length < 3) {
      return { stdDev: 0, floor: 0, ceiling: 0, volatility: 0 };
    }

    const mean = recentGames.reduce((sum, val) => sum + val, 0) / recentGames.length;
    const squaredDiffs = recentGames.map(val => Math.pow(val - mean, 2));
    const variance = squaredDiffs.reduce((sum, val) => sum + val, 0) / recentGames.length;
    const stdDev = Math.sqrt(variance);

    const floor = mean - stdDev;
    const ceiling = mean + stdDev;
    const volatility = mean > 0 ? stdDev / mean : 0;

    return {
      stdDev,
      floor: Math.max(0, floor),
      ceiling,
      volatility
    };
  }

  getBlowoutRisk(vegasSpread, vegasTotal) {
    if (!vegasSpread || vegasSpread === 0) {
      return { projectionAdjustment: 0, floorImpact: 0, ceilingImpact: 0, risk: 0 };
    }

    const absSpread = Math.abs(vegasSpread);

    if (absSpread <= 10) {
      return { projectionAdjustment: 0, floorImpact: 0, ceilingImpact: 0, risk: 0 };
    }

    const blowoutMagnitude = absSpread - 10;

    if (vegasSpread < -10) {
      return {
        projectionAdjustment: -blowoutMagnitude * 0.3,
        floorImpact: -blowoutMagnitude * 0.5,
        ceilingImpact: -blowoutMagnitude * 0.2,
        risk: blowoutMagnitude * 0.1
      };
    }

    if (vegasSpread > 10) {
      return {
        projectionAdjustment: -blowoutMagnitude * 0.2,
        floorImpact: -blowoutMagnitude * 0.4,
        ceilingImpact: blowoutMagnitude * 0.3,
        risk: blowoutMagnitude * 0.1
      };
    }

    return { projectionAdjustment: 0, floorImpact: 0, ceilingImpact: 0, risk: 0 };
  }

  calculateBoomBustProbabilities(projection, stdDev, salary) {
    if (!projection || !salary || stdDev === 0) {
      return { boomProb: 0, bustProb: 0 };
    }

    const valueThreshold = (salary / 1000) * 5;
    const boomThreshold = valueThreshold + 10;

    const zScoreBoom = (boomThreshold - projection) / stdDev;
    const zScoreBust = (valueThreshold - projection) / stdDev;

    const normalCDF = (z) => {
      const t = 1 / (1 + 0.2316419 * Math.abs(z));
      const d = 0.3989423 * Math.exp(-z * z / 2);
      const prob = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
      return z > 0 ? 1 - prob : prob;
    };

    const boomProb = 1 - normalCDF(zScoreBoom);
    const bustProb = normalCDF(zScoreBust);

    return {
      boomProb: Math.max(0, Math.min(1, boomProb)) * 100,
      bustProb: Math.max(0, Math.min(1, bustProb)) * 100
    };
  }

  getEnhancedPositionDefenseAdjustment(opponentTeam, playerPosition) {
    const primaryPosition = this.getPrimaryPosition(playerPosition);
    if (!primaryPosition) return 0;

    const normalizedTeam = normalizeForVsPosition(opponentTeam);
    const positionData = this.loadPositionDefenseData();
    const key = `${normalizedTeam}_${primaryPosition}`;
    const defenseVsPos = positionData[key];

    if (!defenseVsPos) return 0;

    let totalAdjustment = 0;

    const rank = defenseVsPos.rank;
    const avgRank = 75;
    const rankDiff = rank - avgRank;
    totalAdjustment += rankDiff * 0.04;

    const ptsAllowed = defenseVsPos.pts_allowed || 0;
    const fgPctAllowed = defenseVsPos.fg_pct_allowed || 0;
    const tpmAllowed = defenseVsPos.tpm_allowed || 0;
    const rebAllowed = defenseVsPos.reb_allowed || 0;
    const astAllowed = defenseVsPos.ast_allowed || 0;
    const stlAllowed = defenseVsPos.stl_allowed || 0;
    const blkAllowed = defenseVsPos.blk_allowed || 0;

    if (primaryPosition === 'PG' || primaryPosition === 'SG') {
      if (astAllowed > 5.0) totalAdjustment += 0.5;
      if (stlAllowed > 1.0) totalAdjustment += 0.3;
      if (tpmAllowed > 2.5) totalAdjustment += 0.4;
    } else if (primaryPosition === 'SF') {
      if (ptsAllowed > 20) totalAdjustment += 0.4;
      if (rebAllowed > 6.0) totalAdjustment += 0.3;
      if (tpmAllowed > 2.0) totalAdjustment += 0.3;
    } else if (primaryPosition === 'PF' || primaryPosition === 'C') {
      if (rebAllowed > 10.0) totalAdjustment += 0.6;
      if (blkAllowed > 1.2) totalAdjustment += 0.4;
      if (fgPctAllowed > 0.50) totalAdjustment += 0.3;
    }

    return totalAdjustment;
  }

  getImprovedPaceAdjustment(opponentTeam, playerTeam) {
    const leagueAvgPace = 100.0;
    const rankings = this.loadDefenseRankings();

    const normalizedOpp = normalizeForRankings(opponentTeam);
    const normalizedPlayer = normalizeForRankings(playerTeam);

    const oppStats = rankings[normalizedOpp];
    const playerStats = rankings[normalizedPlayer];

    if (!oppStats || !oppStats.pace || !playerStats || !playerStats.pace) {
      return 0;
    }

    const oppDeviation = oppStats.pace - leagueAvgPace;
    const playerDeviation = playerStats.pace - leagueAvgPace;

    const projectedPace = leagueAvgPace + oppDeviation + playerDeviation;
    const paceDiff = projectedPace - leagueAvgPace;

    return paceDiff * 0.25;
  }

  getTeamTendencyAdjustment(playerTeam) {
    const rankings = this.loadDefenseRankings();
    const normalizedTeam = normalizeForRankings(playerTeam);
    const teamStats = rankings[normalizedTeam];

    if (!teamStats) return 0;

    let tendencyAdj = 0;

    if (teamStats.ast_ratio && teamStats.ast_ratio > 17.0) {
      tendencyAdj += 0.3;
    }

    if (teamStats.to_ratio && teamStats.to_ratio > 15.0) {
      tendencyAdj -= 0.2;
    }

    if (teamStats.rebr && teamStats.rebr > 52.0) {
      tendencyAdj += 0.4;
    }

    if (teamStats.off_eff && teamStats.off_eff > 115.0) {
      tendencyAdj += 0.5;
    }

    if (teamStats.ts_pct && teamStats.ts_pct > 0.58) {
      tendencyAdj += 0.3;
    }

    return tendencyAdj;
  }

  calculateLeverageScore(boomProbability, ownership) {
    if (!ownership || ownership === 0) {
      ownership = 1;
    }

    const leverage = (boomProbability * 100) / (ownership + 1);
    return leverage;
  }

  // ═══════════════════════════════════════════════════════════════
  // BACKFILL MAIN LOGIC
  // ═══════════════════════════════════════════════════════════════

  async backfillSlate(slateId = null) {
    console.log('\n🔄 Starting Advanced Metrics Backfill...\n');

    // Get slate
    let slate;
    if (slateId) {
      slate = db.prepare('SELECT * FROM slates WHERE slate_id = ?').get(slateId);
    } else {
      slate = db.prepare('SELECT * FROM slates ORDER BY created_at DESC LIMIT 1').get();
    }

    if (!slate) {
      console.error('❌ No slate found!');
      return;
    }

    console.log(`📋 Processing slate: ${slate.name} (${slate.slate_id})`);

    // Get all players for this slate
    const players = db.prepare('SELECT * FROM players WHERE slate_id = ?').all(slate.slate_id);

    if (players.length === 0) {
      console.error('❌ No players found for this slate!');
      return;
    }

    console.log(`👥 Found ${players.length} players to process\n`);

    // Prepare update statement
    const updateStmt = db.prepare(`
      UPDATE players
      SET
        floor = ?,
        ceiling = ?,
        volatility = ?,
        boom_probability = ?,
        bust_probability = ?,
        fppm = ?,
        leverage_score = ?,
        blowout_risk = ?,
        std_dev = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `);

    let successCount = 0;
    let errorCount = 0;

    // Process each player
    for (const player of players) {
      try {
        // Skip players with no projection
        if (!player.projected_points || player.projected_points <= 0) {
          continue;
        }

        // Calculate variance metrics
        const recentGames = [];
        if (player.fpts_last3 > 0) recentGames.push(player.fpts_last3);
        if (player.fpts_last5 > 0) recentGames.push(player.fpts_last5);
        if (player.fpts_last7 > 0) recentGames.push(player.fpts_last7);

        const varianceData = this.calculatePlayerVariance(recentGames);
        const stdDev = varianceData.stdDev;
        const volatility = varianceData.volatility;

        // Calculate weighted FPPM
        const seasonMinutes = player.projected_minutes || 30;
        const minutesLast3 = seasonMinutes * 0.9;
        const minutesLast5 = seasonMinutes * 0.95;
        const fppm = this.calculateWeightedFPPM(
          player.fpts_last3, minutesLast3,
          player.fpts_last5, minutesLast5,
          player.fpts_last7, seasonMinutes
        );

        // Calculate blowout risk
        const blowoutData = this.getBlowoutRisk(player.vegas_spread, player.vegas_over_under);
        const blowoutRisk = blowoutData.risk;

        // Calculate floor & ceiling with blowout impact
        const floor = Math.max(0, player.projected_points - stdDev + blowoutData.floorImpact);
        const ceiling = player.projected_points + stdDev + blowoutData.ceilingImpact;

        // Calculate boom/bust probabilities
        const probabilities = this.calculateBoomBustProbabilities(player.projected_points, stdDev, player.salary);
        const boomProbability = probabilities.boomProb;
        const bustProbability = probabilities.bustProb;

        // Calculate GPP leverage score
        const leverageScore = this.calculateLeverageScore(boomProbability, player.rostership || 0);

        // Update database
        updateStmt.run(
          floor,
          ceiling,
          volatility,
          boomProbability,
          bustProbability,
          fppm,
          leverageScore,
          blowoutRisk,
          stdDev,
          player.id
        );

        successCount++;

        // Log significant metrics
        if (boomProbability >= 25 || leverageScore >= 3.0) {
          console.log(`✨ ${player.name} (${player.position}): Proj=${player.projected_points.toFixed(1)} | Range=${floor.toFixed(0)}-${ceiling.toFixed(0)} | Boom=${boomProbability.toFixed(0)}% | Lev=${leverageScore.toFixed(1)}`);
        }

      } catch (error) {
        errorCount++;
        console.error(`❌ Error processing ${player.name}:`, error.message);
      }
    }

    console.log('\n' + '='.repeat(60));
    console.log(`✅ Backfill Complete!`);
    console.log(`   Successfully updated: ${successCount} players`);
    if (errorCount > 0) {
      console.log(`   ⚠️  Errors: ${errorCount} players`);
    }
    console.log('='.repeat(60) + '\n');

    // Show top GPP plays by leverage
    console.log('🎯 Top 10 GPP Leverage Plays:\n');
    const topLeverage = db.prepare(`
      SELECT name, position, salary, projected_points, floor, ceiling,
             boom_probability, leverage_score, rostership
      FROM players
      WHERE slate_id = ? AND leverage_score > 0
      ORDER BY leverage_score DESC
      LIMIT 10
    `).all(slate.slate_id);

    topLeverage.forEach((p, i) => {
      console.log(`${i + 1}. ${p.name} (${p.position}) - $${p.salary.toLocaleString()}`);
      console.log(`   Proj: ${p.projected_points.toFixed(1)} | Range: ${p.floor.toFixed(0)}-${p.ceiling.toFixed(0)}`);
      console.log(`   Boom: ${p.boom_probability.toFixed(0)}% | Own: ${p.rostership.toFixed(1)}% | Leverage: ${p.leverage_score.toFixed(1)}`);
      console.log('');
    });

    console.log('🏆 Highest Ceiling Plays:\n');
    const topCeiling = db.prepare(`
      SELECT name, position, salary, projected_points, ceiling, boom_probability
      FROM players
      WHERE slate_id = ? AND ceiling > 0
      ORDER BY ceiling DESC
      LIMIT 5
    `).all(slate.slate_id);

    topCeiling.forEach((p, i) => {
      console.log(`${i + 1}. ${p.name} (${p.position}) - Ceiling: ${p.ceiling.toFixed(1)} FP | Boom: ${p.boom_probability.toFixed(0)}%`);
    });

    console.log('\n💎 Safest Cash Game Plays (High Floor, Low Volatility):\n');
    const topFloor = db.prepare(`
      SELECT name, position, salary, projected_points, floor, volatility
      FROM players
      WHERE slate_id = ? AND floor > 0 AND volatility < 0.25
      ORDER BY floor DESC
      LIMIT 5
    `).all(slate.slate_id);

    topFloor.forEach((p, i) => {
      console.log(`${i + 1}. ${p.name} (${p.position}) - Floor: ${p.floor.toFixed(1)} FP | Vol: ${(p.volatility * 100).toFixed(0)}%`);
    });

    console.log('\n✅ Refresh your frontend to see the new metrics!\n');
  }
}

// Run backfill
const backfill = new AdvancedMetricsBackfill();

// Check for command line argument
const slateId = process.argv[2];

backfill.backfillSlate(slateId)
  .then(() => {
    console.log('✅ Script complete!');
    process.exit(0);
  })
  .catch((error) => {
    console.error('❌ Script failed:', error);
    process.exit(1);
  });
