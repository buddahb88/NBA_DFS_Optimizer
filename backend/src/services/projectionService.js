/**
 * PROJECTION SERVICE
 *
 * Calculates adjusted projections using RotoWire as baseline + our own adjustments.
 * This is where we "bake in" matchup, pace, rest, and Vegas factors.
 *
 * Formula:
 *   Adjusted Projection = RotoWire Baseline
 *                         + Defense Adjustment (opponent def eff)
 *                         + DVP Adjustment (position-specific defense)
 *                         + Pace Adjustment (game pace expectation)
 *                         + Rest Adjustment (B2B penalty, extra rest boost)
 *                         + Vegas Adjustment (implied total correlation)
 */

import teamDefenseModel from '../models/teamDefenseModel.js';
import teamDefenseVsPositionModel from '../models/teamDefenseVsPositionModel.js';
import { normalizeForRankings, normalizeForVsPosition } from '../utils/teamMapping.js';

class ProjectionService {
  constructor() {
    this.defenseRankings = null;
    this.positionDefenseData = null;

    // League averages (2024-25 season baselines)
    this.LEAGUE_AVG_DEF_EFF = 113.0;
    this.LEAGUE_AVG_PACE = 100.0;
    this.LEAGUE_AVG_IMPLIED_TOTAL = 113.0;
    this.LEAGUE_AVG_DVP_RANK = 75; // Middle of 1-150 scale
  }

  /**
   * Load defense rankings into memory
   */
  loadDefenseRankings() {
    if (!this.defenseRankings) {
      const rankings = teamDefenseModel.getAll();
      this.defenseRankings = {};
      for (const team of rankings) {
        this.defenseRankings[team.team] = team;
      }
      console.log(`📊 Loaded defense rankings for ${Object.keys(this.defenseRankings).length} teams`);
    }
    return this.defenseRankings;
  }

  /**
   * Load position defense data into memory
   */
  loadPositionDefenseData() {
    if (!this.positionDefenseData) {
      const allData = teamDefenseVsPositionModel.getAll();
      this.positionDefenseData = {};
      for (const data of allData) {
        const key = `${data.team}_${data.position}`;
        this.positionDefenseData[key] = data;
      }
      console.log(`📊 Loaded position defense data: ${Object.keys(this.positionDefenseData).length} entries`);
    }
    return this.positionDefenseData;
  }

  /**
   * Get primary position from multi-position string
   */
  getPrimaryPosition(positionString) {
    if (!positionString) return null;
    return positionString.split(',').map(p => p.trim())[0];
  }

  /**
   * MAIN METHOD: Calculate adjusted projection for a player
   *
   * @param {Object} player - Player data with RotoWire projection and matchup info
   * @returns {Object} - Adjusted projection with breakdown of factors
   */
  calculateAdjustedProjection(player) {
    const {
      name,
      rotowire_projection,  // Base projection from RotoWire
      projected_points,     // Fallback if rotowire_projection not set
      opponent,
      team,
      position,
      rest_days,
      vegas_implied_total,
      vegas_over_under,
      vegas_spread,
      projected_minutes,
      dvp_pts_allowed,      // Pre-joined: opponent's DVP for this position
      opp_def_eff           // Pre-joined: opponent's defensive efficiency
    } = player;

    // Use RotoWire projection as baseline (or existing projected_points)
    const baseline = rotowire_projection || projected_points || 0;

    if (baseline <= 0) {
      return {
        adjusted_projection: 0,
        baseline: 0,
        adjustments: {},
        total_adjustment: 0
      };
    }

    // Load defense data
    this.loadDefenseRankings();
    this.loadPositionDefenseData();

    // Calculate each adjustment
    const adjustments = {};

    // 1. DEFENSE EFFICIENCY ADJUSTMENT
    // Higher def_eff = worse defense = positive adjustment
    adjustments.defense = this.getDefenseAdjustment(opponent, opp_def_eff);

    // 2. DVP (DEFENSE VS POSITION) ADJUSTMENT
    // Higher DVP pts allowed = easier matchup = positive adjustment
    adjustments.dvp = this.getDvpAdjustment(opponent, position, dvp_pts_allowed);

    // 3. PACE ADJUSTMENT
    // Faster pace = more possessions = positive adjustment
    adjustments.pace = this.getPaceAdjustment(opponent, team);

    // 4. REST ADJUSTMENT
    // B2B = negative, extra rest = positive
    adjustments.rest = this.getRestAdjustment(rest_days);

    // 5. VEGAS ADJUSTMENT
    // Higher implied total = more expected scoring
    adjustments.vegas = this.getVegasAdjustment(vegas_implied_total, vegas_over_under);

    // 6. BLOWOUT RISK ADJUSTMENT
    // Big spreads = potential for early pulls or garbage time
    adjustments.blowout = this.getBlowoutAdjustment(vegas_spread);

    // Sum all adjustments
    const total_adjustment = Object.values(adjustments).reduce((sum, adj) => sum + adj, 0);

    // Apply adjustments to baseline
    // Cap total adjustment at ±20% of baseline to prevent extreme swings
    const maxAdjustment = baseline * 0.20;
    const cappedAdjustment = Math.max(-maxAdjustment, Math.min(maxAdjustment, total_adjustment));

    const adjusted_projection = Math.max(0, baseline + cappedAdjustment);

    return {
      adjusted_projection: Math.round(adjusted_projection * 10) / 10,
      baseline: Math.round(baseline * 10) / 10,
      adjustments,
      total_adjustment: Math.round(cappedAdjustment * 10) / 10,
      uncapped_adjustment: Math.round(total_adjustment * 10) / 10
    };
  }

  /**
   * Defense Efficiency Adjustment
   * Opponent's overall defensive efficiency
   */
  getDefenseAdjustment(opponent, preJoinedDefEff) {
    // Use pre-joined data if available
    if (preJoinedDefEff && preJoinedDefEff > 0) {
      const diff = preJoinedDefEff - this.LEAGUE_AVG_DEF_EFF;
      // 0.25 FP per def eff point (capped contribution)
      return diff * 0.25;
    }

    // Fallback: lookup from rankings
    const normalizedTeam = normalizeForRankings(opponent);
    const rankings = this.loadDefenseRankings();
    const oppDefense = rankings[normalizedTeam];

    if (!oppDefense || !oppDefense.def_eff) {
      return 0;
    }

    const diff = oppDefense.def_eff - this.LEAGUE_AVG_DEF_EFF;
    return diff * 0.25;
  }

  /**
   * DVP (Defense vs Position) Adjustment
   * How many fantasy points the opponent allows to this position
   */
  getDvpAdjustment(opponent, position, preJoinedDvp) {
    const primaryPosition = this.getPrimaryPosition(position);
    if (!primaryPosition) return 0;

    // Use pre-joined data if available
    if (preJoinedDvp && preJoinedDvp > 0) {
      // DVP pts allowed: league average is ~40-45 for most positions
      // Higher = worse defense at position = positive adjustment
      const leagueAvgDvp = 42;
      const diff = preJoinedDvp - leagueAvgDvp;
      // 0.15 FP per DVP point above average
      return diff * 0.15;
    }

    // Fallback: lookup from position defense data
    const normalizedTeam = normalizeForVsPosition(opponent);
    const positionData = this.loadPositionDefenseData();
    const key = `${normalizedTeam}_${primaryPosition}`;
    const defenseVsPos = positionData[key];

    if (!defenseVsPos) return 0;

    // Use rank-based adjustment
    const rankDiff = defenseVsPos.rank - this.LEAGUE_AVG_DVP_RANK;
    // 0.03 FP per rank (higher rank = worse defense = positive)
    return rankDiff * 0.03;
  }

  /**
   * Pace Adjustment
   * Combined pace of both teams affects fantasy opportunity
   */
  getPaceAdjustment(opponent, playerTeam) {
    const rankings = this.loadDefenseRankings();

    const normalizedOpp = normalizeForRankings(opponent);
    const normalizedTeam = normalizeForRankings(playerTeam);

    const oppStats = rankings[normalizedOpp];
    const teamStats = rankings[normalizedTeam];

    let paceAdjustment = 0;

    // Opponent pace
    if (oppStats && oppStats.pace) {
      const oppPaceDiff = oppStats.pace - this.LEAGUE_AVG_PACE;
      paceAdjustment += oppPaceDiff * 0.15;
    }

    // Player's own team pace (bidirectional)
    if (teamStats && teamStats.pace) {
      const teamPaceDiff = teamStats.pace - this.LEAGUE_AVG_PACE;
      paceAdjustment += teamPaceDiff * 0.10;
    }

    return paceAdjustment;
  }

  /**
   * Rest Days Adjustment
   * B2B = fatigue, extra rest = fresh legs
   */
  getRestAdjustment(restDays) {
    if (restDays === null || restDays === undefined || restDays < 0) {
      return 0;
    }

    if (restDays === 0) {
      return -2.0; // Back-to-back: significant fatigue
    } else if (restDays === 1) {
      return 0; // Normal rest: baseline
    } else if (restDays === 2) {
      return 0.75; // Extra day: slight boost
    } else if (restDays >= 3) {
      return 0.5; // Extended rest: diminishing returns (rust factor)
    }

    return 0;
  }

  /**
   * Vegas Adjustment
   * Implied team total and game total correlate with fantasy production
   */
  getVegasAdjustment(impliedTotal, overUnder) {
    let adjustment = 0;

    // Implied team total
    if (impliedTotal && impliedTotal > 0) {
      const diff = impliedTotal - this.LEAGUE_AVG_IMPLIED_TOTAL;
      // 0.12 FP per point of implied total
      adjustment += diff * 0.12;
    }

    // Game total (over/under) - secondary factor
    if (overUnder && overUnder > 0) {
      const gameAvg = 226; // League average game total
      const diff = overUnder - gameAvg;
      // 0.04 FP per point of O/U (less weight than implied)
      adjustment += diff * 0.04;
    }

    return adjustment;
  }

  /**
   * Blowout Risk Adjustment
   * Large spreads indicate potential for reduced playing time
   */
  getBlowoutAdjustment(vegasSpread) {
    if (!vegasSpread || vegasSpread === 0) {
      return 0;
    }

    const absSpread = Math.abs(vegasSpread);

    // Only adjust for spreads > 8 points
    if (absSpread <= 8) {
      return 0;
    }

    // Magnitude of blowout risk
    const blowoutMagnitude = absSpread - 8;

    // Big favorites (negative spread): Risk of early pulls
    if (vegasSpread < -8) {
      return -blowoutMagnitude * 0.15;
    }

    // Big underdogs (positive spread): Garbage time uncertainty
    if (vegasSpread > 8) {
      return -blowoutMagnitude * 0.10;
    }

    return 0;
  }

  /**
   * Batch calculate projections for all players in a slate
   */
  calculateSlateProjections(players) {
    console.log(`\n🧮 Calculating adjusted projections for ${players.length} players...`);

    const results = [];
    let totalAdjustment = 0;
    let adjustedUp = 0;
    let adjustedDown = 0;

    for (const player of players) {
      const result = this.calculateAdjustedProjection(player);

      results.push({
        ...player,
        ...result
      });

      totalAdjustment += result.total_adjustment;
      if (result.total_adjustment > 0.5) adjustedUp++;
      if (result.total_adjustment < -0.5) adjustedDown++;
    }

    console.log(`✅ Projection adjustments complete:`);
    console.log(`   📈 Adjusted UP: ${adjustedUp} players`);
    console.log(`   📉 Adjusted DOWN: ${adjustedDown} players`);
    console.log(`   📊 Avg adjustment: ${(totalAdjustment / players.length).toFixed(2)} FP`);

    return results;
  }

  /**
   * Get adjustment breakdown for display
   */
  getAdjustmentExplanation(adjustments) {
    const explanations = [];

    if (adjustments.defense !== 0) {
      explanations.push(`Defense: ${adjustments.defense > 0 ? '+' : ''}${adjustments.defense.toFixed(1)}`);
    }
    if (adjustments.dvp !== 0) {
      explanations.push(`DVP: ${adjustments.dvp > 0 ? '+' : ''}${adjustments.dvp.toFixed(1)}`);
    }
    if (adjustments.pace !== 0) {
      explanations.push(`Pace: ${adjustments.pace > 0 ? '+' : ''}${adjustments.pace.toFixed(1)}`);
    }
    if (adjustments.rest !== 0) {
      explanations.push(`Rest: ${adjustments.rest > 0 ? '+' : ''}${adjustments.rest.toFixed(1)}`);
    }
    if (adjustments.vegas !== 0) {
      explanations.push(`Vegas: ${adjustments.vegas > 0 ? '+' : ''}${adjustments.vegas.toFixed(1)}`);
    }
    if (adjustments.blowout !== 0) {
      explanations.push(`Blowout: ${adjustments.blowout > 0 ? '+' : ''}${adjustments.blowout.toFixed(1)}`);
    }

    return explanations.join(' | ');
  }
}

export default new ProjectionService();
