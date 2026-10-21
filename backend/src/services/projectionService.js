/**
 * PROJECTION SERVICE
 *
 * Calculates adjusted projections using RotoWire as baseline + our own adjustments.
 * This is where we "bake in" matchup, pace, rest, and Vegas factors.
 *
 * MINUTES MODEL: slate projections also project minutes x FPPM (with injury
 * redistribution and manual overrides) and blend it in; see minutesModel.js.
 *
 * ENHANCED: Now includes historical data blending:
 *   - Season average from historical box scores
 *   - Last 3 games momentum (hot/cold streaks)
 *   - Matchup-specific history (player vs opponent)
 *   - Usage bump when key teammates are OUT
 *   - Home/away performance splits
 *   - B2B historical impact (player-specific)
 *
 * Formula:
 *   Historical Blend = (Season Avg × 0.35) + (L3 Avg × 0.25) + (Matchup Avg × 0.15) + (RotoWire × 0.25)
 *   Adjusted Projection = Historical Blend
 *                         + Defense Adjustment (opponent def eff)
 *                         + DVP Adjustment (position-specific defense)
 *                         + Pace Adjustment (game pace expectation)
 *                         + Rest Adjustment (B2B penalty, extra rest boost)
 *                         + Vegas Adjustment (implied total correlation)
 *                         + Usage Bump Adjustment (teammate OUT boost)
 *                         + Hot/Cold Streak Adjustment (momentum)
 *                         + Home/Away Adjustment (venue splits)
 */

import teamDefenseModel from '../models/teamDefenseModel.js';
import teamDefenseVsPositionModel from '../models/teamDefenseVsPositionModel.js';
import { normalizeForRankings, normalizeForVsPosition } from '../utils/teamMapping.js';
import db from '../config/database.js';
import { fantasyPointsColumn } from './scoring.js';
import { applyMinutesModel } from './minutesProjectionService.js';

const DATABASE_TYPE = process.env.DATABASE_TYPE || 'sqlite';

class ProjectionService {
  constructor() {
    this.defenseRankings = null;
    this.positionDefenseData = null;
    this.historicalCache = {}; // Cache for historical lookups

    // League averages (2024-25 season baselines)
    this.LEAGUE_AVG_DEF_EFF = 113.0;
    this.LEAGUE_AVG_PACE = 100.0;
    this.LEAGUE_AVG_IMPLIED_TOTAL = 113.0;
    this.LEAGUE_AVG_DVP_RANK = 75.5; // Middle of overall 1-150 scale (30 teams x 5 positions)
    this.LEAGUE_AVG_DVP_PTS = 23; // Real points allowed per position (Hashtag per-position avgs ~21.8-24.0, Oct 2026)
    this.DVP_PTS_MIN = 10;
    this.DVP_PTS_MAX = 35;

    // Historical blending weights
    this.BLEND_WEIGHTS = {
      seasonAvg: 0.35,     // Historical season average
      last3Avg: 0.25,      // Last 3 games (momentum)
      matchupAvg: 0.15,    // History vs this opponent
      rotowire: 0.25       // RotoWire expert projection
    };

    // Adjustment caps
    this.MAX_HISTORICAL_ADJUSTMENT = 0.25; // 25% max adjustment from historical factors
    this.MAX_SITUATIONAL_ADJUSTMENT = 0.20; // 20% max from situational factors
  }

  /**
   * Normalize name for matching (removes diacritics)
   */
  normalizeName(name) {
    if (!name) return '';
    return name
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .trim();
  }

  /**
   * Get historical stats for a player
   * @param {string} playerName - Player's name
   * @param {string} slateDate - Date of the slate (to filter out future games for backtesting)
   * @param {string} site - DFS site whose fantasy points to use (default draftkings)
   */
  async getPlayerHistoricalStats(playerName, slateDate = null, site = 'draftkings') {
    const pointsCol = fantasyPointsColumn(site);
    const normalizedName = this.normalizeName(playerName);
    const cacheKey = `${normalizedName}_${slateDate || 'current'}_${pointsCol}`;

    if (this.historicalCache[cacheKey]) {
      return this.historicalCache[cacheKey];
    }

    let seasonStats, last3, last5;

    if (DATABASE_TYPE === 'azuresql') {
      // Build date filter for backtesting
      let dateFilter = '';
      const params = { playerName: `%${playerName}%` };
      if (slateDate) {
        dateFilter = 'AND game_date < @slateDate';
        params.slateDate = slateDate;
      }

      // Get season stats
      seasonStats = await db.get(`
        SELECT
          COUNT(*) as games,
          AVG(${pointsCol}) as avg_dk,
          AVG(minutes) as avg_min,
          MIN(${pointsCol}) as floor,
          MAX(${pointsCol}) as ceiling,
          AVG(CASE WHEN is_home = 1 THEN ${pointsCol} END) as home_avg,
          AVG(CASE WHEN is_home = 0 THEN ${pointsCol} END) as away_avg,
          AVG(CASE WHEN is_back_to_back = 1 THEN ${pointsCol} END) as b2b_avg,
          AVG(CASE WHEN is_back_to_back = 0 THEN ${pointsCol} END) as rested_avg
        FROM historical_games
        WHERE player_name LIKE @playerName ${dateFilter}
      `, params);

      // Get last 3 games
      last3 = await db.get(`
        SELECT AVG(${pointsCol}) as avg_dk, COUNT(*) as games
        FROM (
          SELECT TOP 3 ${pointsCol}
          FROM historical_games
          WHERE player_name LIKE @playerName ${dateFilter}
          ORDER BY game_date DESC
        ) sub
      `, params);

      // Get last 5 games for trend calculation
      last5 = await db.get(`
        SELECT AVG(${pointsCol}) as avg_dk, COUNT(*) as games
        FROM (
          SELECT TOP 5 ${pointsCol}
          FROM historical_games
          WHERE player_name LIKE @playerName ${dateFilter}
          ORDER BY game_date DESC
        ) sub
      `, params);
    } else {
      // SQLite
      let dateFilter = '';
      const params = [`%${playerName}%`];
      if (slateDate) {
        dateFilter = 'AND game_date < ?';
        params.push(slateDate);
      }

      // Get season stats
      seasonStats = await db.get(`
        SELECT
          COUNT(*) as games,
          AVG(${pointsCol}) as avg_dk,
          AVG(minutes) as avg_min,
          MIN(${pointsCol}) as floor,
          MAX(${pointsCol}) as ceiling,
          AVG(CASE WHEN is_home = 1 THEN ${pointsCol} END) as home_avg,
          AVG(CASE WHEN is_home = 0 THEN ${pointsCol} END) as away_avg,
          AVG(CASE WHEN is_back_to_back = 1 THEN ${pointsCol} END) as b2b_avg,
          AVG(CASE WHEN is_back_to_back = 0 THEN ${pointsCol} END) as rested_avg
        FROM historical_games
        WHERE player_name LIKE ? ${dateFilter}
      `, ...params);

      // Get last 3 games
      last3 = await db.get(`
        SELECT AVG(${pointsCol}) as avg_dk, COUNT(*) as games
        FROM (
          SELECT ${pointsCol}
          FROM historical_games
          WHERE player_name LIKE ? ${dateFilter}
          ORDER BY game_date DESC
          LIMIT 3
        )
      `, ...params);

      // Get last 5 games for trend calculation
      last5 = await db.get(`
        SELECT AVG(${pointsCol}) as avg_dk, COUNT(*) as games
        FROM (
          SELECT ${pointsCol}
          FROM historical_games
          WHERE player_name LIKE ? ${dateFilter}
          ORDER BY game_date DESC
          LIMIT 5
        )
      `, ...params);
    }

    const result = {
      seasonAvg: seasonStats?.avg_dk || 0,
      seasonGames: seasonStats?.games || 0,
      floor: seasonStats?.floor || 0,
      ceiling: seasonStats?.ceiling || 0,
      avgMinutes: seasonStats?.avg_min || 0,
      homeAvg: seasonStats?.home_avg || 0,
      awayAvg: seasonStats?.away_avg || 0,
      b2bAvg: seasonStats?.b2b_avg || 0,
      restedAvg: seasonStats?.rested_avg || 0,
      last3Avg: last3?.avg_dk || 0,
      last3Games: last3?.games || 0,
      last5Avg: last5?.avg_dk || 0,
      last5Games: last5?.games || 0
    };

    // Calculate hot/cold streak
    if (result.seasonAvg > 0 && result.last3Avg > 0) {
      result.streakPct = ((result.last3Avg - result.seasonAvg) / result.seasonAvg) * 100;
    } else {
      result.streakPct = 0;
    }

    this.historicalCache[cacheKey] = result;
    return result;
  }

  /**
   * Get matchup-specific history (player vs opponent)
   */
  async getMatchupHistory(playerName, opponent, slateDate = null, site = 'draftkings') {
    const pointsCol = fantasyPointsColumn(site);
    let matchup;

    if (DATABASE_TYPE === 'azuresql') {
      let dateFilter = '';
      const params = { playerName: `%${playerName}%`, opponent };
      if (slateDate) {
        dateFilter = 'AND game_date < @slateDate';
        params.slateDate = slateDate;
      }

      matchup = await db.get(`
        SELECT
          COUNT(*) as games,
          AVG(${pointsCol}) as avg_dk,
          AVG(minutes) as avg_min,
          MAX(${pointsCol}) as best,
          MIN(${pointsCol}) as worst
        FROM historical_games
        WHERE player_name LIKE @playerName AND opponent = @opponent ${dateFilter}
      `, params);
    } else {
      let dateFilter = '';
      const params = [`%${playerName}%`, opponent];
      if (slateDate) {
        dateFilter = 'AND game_date < ?';
        params.push(slateDate);
      }

      matchup = await db.get(`
        SELECT
          COUNT(*) as games,
          AVG(${pointsCol}) as avg_dk,
          AVG(minutes) as avg_min,
          MAX(${pointsCol}) as best,
          MIN(${pointsCol}) as worst
        FROM historical_games
        WHERE player_name LIKE ? AND opponent = ? ${dateFilter}
      `, ...params);
    }

    return {
      games: matchup?.games || 0,
      avgDk: matchup?.avg_dk || 0,
      avgMin: matchup?.avg_min || 0,
      best: matchup?.best || 0,
      worst: matchup?.worst || 0
    };
  }

  /**
   * Detect if there's a usage bump opportunity for this player
   * Checks if any high-usage teammates are missing from the slate
   */
  async detectUsageBump(playerName, team, slateRoster, slateDate = null, site = 'draftkings') {
    const pointsCol = fantasyPointsColumn(site);
    // Get historical regular players for this team
    let historicalRoster;

    if (DATABASE_TYPE === 'azuresql') {
      let dateFilter = '';
      const params = { team };
      if (slateDate) {
        dateFilter = 'AND game_date < @slateDate';
        params.slateDate = slateDate;
      }

      historicalRoster = await db.all(`
        SELECT
          player_name,
          COUNT(*) as games,
          AVG(${pointsCol}) as avg_dk,
          AVG(minutes) as avg_min
        FROM historical_games
        WHERE team = @team ${dateFilter}
          AND game_date >= DATEADD(day, -30, GETDATE())
        GROUP BY player_name
        HAVING COUNT(*) >= 3 AND AVG(${pointsCol}) >= 25
        ORDER BY avg_dk DESC
      `, params);
    } else {
      let dateFilter = '';
      const params = [team];
      if (slateDate) {
        dateFilter = 'AND game_date < ?';
        params.push(slateDate);
      }

      historicalRoster = await db.all(`
        SELECT
          player_name,
          COUNT(*) as games,
          AVG(${pointsCol}) as avg_dk,
          AVG(minutes) as avg_min
        FROM historical_games
        WHERE team = ? ${dateFilter}
          AND game_date >= date('now', '-30 days')
        GROUP BY player_name
        HAVING games >= 3 AND avg_dk >= 25
        ORDER BY avg_dk DESC
      `, ...params);
    }

    // Find missing high-usage players
    const missingPlayers = historicalRoster.filter(histPlayer => {
      const histNameNorm = this.normalizeName(histPlayer.player_name);
      const histLastName = histNameNorm.split(' ').pop();

      const isOnSlate = slateRoster.some(slateName => {
        const slateNameNorm = this.normalizeName(slateName);
        const slateLastName = slateNameNorm.split(' ').pop();
        return histNameNorm === slateNameNorm ||
               histLastName === slateLastName ||
               histNameNorm.includes(slateLastName) ||
               slateNameNorm.includes(histLastName);
      });
      return !isOnSlate;
    });

    if (missingPlayers.length === 0) {
      return { hasUsageBump: false, bump: 0, missingPlayers: [] };
    }

    // Calculate usage bump for this player when missing players are out
    let totalBump = 0;
    let bumpCount = 0;
    const bumpDetails = [];

    for (const missingPlayer of missingPlayers) {
      // Get games where missing player didn't play
      let gamesWithout;

      if (DATABASE_TYPE === 'azuresql') {
        let dateFilter = slateDate ? 'AND game_date < @slateDate' : '';
        gamesWithout = await db.all(`
          SELECT DISTINCT TOP 15 game_date
          FROM historical_games
          WHERE team = @team
            AND game_date NOT IN (
              SELECT game_date FROM historical_games
              WHERE player_name = @missingPlayer AND team = @team AND minutes > 5
            )
            ${dateFilter}
          ORDER BY game_date DESC
        `, { team, missingPlayer: missingPlayer.player_name, slateDate });
      } else {
        let dateFilter = slateDate ? 'AND game_date < ?' : '';
        const params = [team, missingPlayer.player_name, team];
        if (slateDate) params.push(slateDate);

        gamesWithout = await db.all(`
          SELECT DISTINCT game_date
          FROM historical_games
          WHERE team = ?
            AND game_date NOT IN (
              SELECT game_date FROM historical_games
              WHERE player_name = ? AND team = ? AND minutes > 5
            )
            ${dateFilter}
          ORDER BY game_date DESC
          LIMIT 15
        `, ...params);
      }

      if (gamesWithout.length < 2) continue;

      const gameDatesWithout = gamesWithout.map(g => g.game_date);

      // Get this player's stats when missing player is OUT
      let statsWithout, statsWith;

      if (DATABASE_TYPE === 'azuresql') {
        const placeholders = gameDatesWithout.map((_, i) => `@date${i}`).join(',');
        const dateParams = {};
        gameDatesWithout.forEach((d, i) => dateParams[`date${i}`] = d);

        statsWithout = await db.get(`
          SELECT AVG(${pointsCol}) as avg_dk, COUNT(*) as games
          FROM historical_games
          WHERE player_name LIKE @playerName AND team = @team
            AND game_date IN (${placeholders})
        `, { playerName: `%${playerName}%`, team, ...dateParams });

        statsWith = await db.get(`
          SELECT AVG(${pointsCol}) as avg_dk, COUNT(*) as games
          FROM historical_games
          WHERE player_name LIKE @playerName AND team = @team
            AND game_date NOT IN (${placeholders})
        `, { playerName: `%${playerName}%`, team, ...dateParams });
      } else {
        const placeholders = gameDatesWithout.map(() => '?').join(',');

        statsWithout = await db.get(`
          SELECT AVG(${pointsCol}) as avg_dk, COUNT(*) as games
          FROM historical_games
          WHERE player_name LIKE ? AND team = ?
            AND game_date IN (${placeholders})
        `, `%${playerName}%`, team, ...gameDatesWithout);

        statsWith = await db.get(`
          SELECT AVG(${pointsCol}) as avg_dk, COUNT(*) as games
          FROM historical_games
          WHERE player_name LIKE ? AND team = ?
            AND game_date NOT IN (${placeholders})
        `, `%${playerName}%`, team, ...gameDatesWithout);
      }

      if (statsWithout?.games >= 2 && statsWith?.games >= 3 && statsWithout.avg_dk && statsWith.avg_dk) {
        const pctBump = ((statsWithout.avg_dk - statsWith.avg_dk) / statsWith.avg_dk) * 100;

        if (pctBump >= 5) {
          totalBump += pctBump;
          bumpCount++;
          bumpDetails.push({
            missingPlayer: missingPlayer.player_name,
            missingPlayerAvg: Math.round(missingPlayer.avg_dk * 10) / 10,
            pctBump: Math.round(pctBump * 10) / 10,
            gamesWithout: statsWithout.games,
            gamesWith: statsWith.games
          });
        }
      }
    }

    // Use the highest bump (don't stack them - usually one missing player is most impactful)
    const bestBump = bumpDetails.length > 0
      ? Math.max(...bumpDetails.map(b => b.pctBump))
      : 0;

    return {
      hasUsageBump: bestBump > 0,
      bump: bestBump,
      missingPlayers: bumpDetails.sort((a, b) => b.pctBump - a.pctBump)
    };
  }

  /**
   * Clear historical cache (call when new data is loaded)
   */
  clearCache() {
    this.historicalCache = {};
  }

  /**
   * Load defense rankings into memory
   */
  async loadDefenseRankings() {
    if (!this.defenseRankings) {
      const rankings = await teamDefenseModel.getAll();
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
  async loadPositionDefenseData() {
    if (!this.positionDefenseData) {
      const allData = await teamDefenseVsPositionModel.getAll();
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
   * ENHANCED PROJECTION: Calculate projection using historical data blending
   *
   * This method blends:
   * - RotoWire expert projection (25%)
   * - Historical season average (35%)
   * - Last 3 games momentum (25%)
   * - Matchup-specific history (15%)
   *
   * Plus situational adjustments:
   * - Usage bump (when key teammates are OUT)
   * - Hot/cold streak momentum
   * - Home/away venue adjustment
   * - B2B fatigue (player-specific)
   * - Defense/pace/vegas (existing)
   *
   * @param {Object} player - Player data
   * @param {Object} options - Additional options
   * @param {Array} options.slateRoster - All player names on the slate (for usage bump detection)
   * @param {string} options.slateDate - Slate date for backtesting (YYYY-MM-DD)
   * @param {boolean} options.isHome - Whether player is at home
   * @param {boolean} options.isB2B - Whether this is a back-to-back game
   * @param {string} options.site - DFS site for historical fantasy points (default draftkings)
   */
  async calculateEnhancedProjection(player, options = {}) {
    const {
      name,
      rotowire_projection,
      projected_points,
      opponent,
      team,
      position,
      rest_days,
      vegas_implied_total,
      vegas_over_under,
      vegas_spread,
      projected_minutes,
      dvp_pts_allowed,
      opp_def_eff,
      is_home
    } = player;

    const { slateRoster = [], slateDate = null, isHome = is_home, isB2B = (rest_days === 0), site = 'draftkings' } = options;

    // RotoWire baseline
    const rotowireBaseline = rotowire_projection || projected_points || 0;

    // Get historical data
    const historical = await this.getPlayerHistoricalStats(name, slateDate, site);
    const matchup = opponent ? await this.getMatchupHistory(name, opponent, slateDate, site) : { games: 0, avgDk: 0 };

    // Detect usage bump opportunity
    const usageBump = slateRoster.length > 0
      ? await this.detectUsageBump(name, team, slateRoster, slateDate, site)
      : { hasUsageBump: false, bump: 0, missingPlayers: [] };

    // If no historical data, fall back to original method
    if (historical.seasonGames < 3) {
      const fallback = await this.calculateAdjustedProjection(player);
      return {
        ...fallback,
        enhanced: false,
        reason: 'Insufficient historical data - using RotoWire baseline',
        historical: null,
        usageBump: null
      };
    }

    // === CALCULATE BLENDED BASELINE ===
    // Adjust weights based on data availability
    let weights = { ...this.BLEND_WEIGHTS };
    let blendedBaseline = 0;
    let totalWeight = 0;
    const blendBreakdown = {};

    // Season average (35%)
    if (historical.seasonAvg > 0) {
      blendedBaseline += historical.seasonAvg * weights.seasonAvg;
      totalWeight += weights.seasonAvg;
      blendBreakdown.seasonAvg = { value: historical.seasonAvg, weight: weights.seasonAvg };
    }

    // Last 3 games (25%)
    if (historical.last3Avg > 0 && historical.last3Games >= 2) {
      blendedBaseline += historical.last3Avg * weights.last3Avg;
      totalWeight += weights.last3Avg;
      blendBreakdown.last3Avg = { value: historical.last3Avg, weight: weights.last3Avg };
    }

    // Matchup history (15%) - only if meaningful sample size
    if (matchup.games >= 2 && matchup.avgDk > 0) {
      blendedBaseline += matchup.avgDk * weights.matchupAvg;
      totalWeight += weights.matchupAvg;
      blendBreakdown.matchupAvg = { value: matchup.avgDk, weight: weights.matchupAvg };
    }

    // RotoWire (25%) - if available
    if (rotowireBaseline > 0) {
      blendedBaseline += rotowireBaseline * weights.rotowire;
      totalWeight += weights.rotowire;
      blendBreakdown.rotowire = { value: rotowireBaseline, weight: weights.rotowire };
    }

    // Normalize if total weight < 1
    if (totalWeight > 0 && totalWeight < 1) {
      blendedBaseline = blendedBaseline / totalWeight;
    }

    // Default to RotoWire if no blend possible
    if (blendedBaseline <= 0) {
      blendedBaseline = rotowireBaseline || historical.seasonAvg || 0;
    }

    // === CALCULATE SITUATIONAL ADJUSTMENTS ===
    const adjustments = {};

    // 1. Hot/Cold Streak Adjustment
    // Cap at ±8% to avoid overreacting
    if (historical.streakPct !== 0) {
      const streakAdjustment = Math.max(-8, Math.min(8, historical.streakPct * 0.4)); // 40% of streak % (capped)
      adjustments.streak = (blendedBaseline * streakAdjustment) / 100;
    } else {
      adjustments.streak = 0;
    }

    // 2. Usage Bump Adjustment
    if (usageBump.hasUsageBump && usageBump.bump > 0) {
      // Cap usage bump at 15%
      const cappedBump = Math.min(15, usageBump.bump);
      adjustments.usageBump = (blendedBaseline * cappedBump) / 100;
    } else {
      adjustments.usageBump = 0;
    }

    // 3. Home/Away Adjustment (player-specific)
    if (historical.homeAvg > 0 && historical.awayAvg > 0) {
      const venueDiff = isHome
        ? historical.homeAvg - historical.seasonAvg
        : historical.awayAvg - historical.seasonAvg;
      // Cap venue adjustment at ±5%
      adjustments.venue = Math.max(-blendedBaseline * 0.05, Math.min(blendedBaseline * 0.05, venueDiff * 0.5));
    } else {
      adjustments.venue = 0;
    }

    // 4. B2B Adjustment (player-specific)
    if (isB2B && historical.b2bAvg > 0 && historical.restedAvg > 0) {
      const b2bDiff = historical.b2bAvg - historical.restedAvg;
      // Player's personal B2B impact (usually negative)
      adjustments.b2b = b2bDiff * 0.6; // 60% weight on personal B2B impact
    } else if (isB2B) {
      // Default B2B penalty if no personal data
      adjustments.b2b = -2.0;
    } else {
      adjustments.b2b = 0;
    }

    // 5. Defense/DVP/Pace/Vegas adjustments (from original method)
    await this.loadDefenseRankings();
    await this.loadPositionDefenseData();

    adjustments.defense = this.getDefenseAdjustment(opponent, opp_def_eff);
    adjustments.dvp = this.getDvpAdjustment(opponent, position, dvp_pts_allowed);
    adjustments.pace = this.getPaceAdjustment(opponent, team);
    adjustments.vegas = this.getVegasAdjustment(vegas_implied_total, vegas_over_under);
    adjustments.blowout = this.getBlowoutAdjustment(vegas_spread);

    // === APPLY ADJUSTMENTS ===
    const situationalAdj = adjustments.streak + adjustments.usageBump + adjustments.venue + adjustments.b2b;
    const matchupAdj = adjustments.defense + adjustments.dvp + adjustments.pace + adjustments.vegas + adjustments.blowout;

    // Cap situational adjustments
    const maxSituational = blendedBaseline * this.MAX_SITUATIONAL_ADJUSTMENT;
    const cappedSituational = Math.max(-maxSituational, Math.min(maxSituational, situationalAdj));

    // Cap matchup adjustments (same as before)
    const maxMatchup = blendedBaseline * 0.20;
    const cappedMatchup = Math.max(-maxMatchup, Math.min(maxMatchup, matchupAdj));

    const totalAdjustment = cappedSituational + cappedMatchup;
    const enhancedProjection = Math.max(0, blendedBaseline + totalAdjustment);

    // Calculate confidence based on data quality
    let confidence = 'Low';
    if (historical.seasonGames >= 15 && historical.last3Games >= 3) {
      confidence = 'High';
    } else if (historical.seasonGames >= 8 && historical.last3Games >= 2) {
      confidence = 'Medium';
    }

    return {
      enhanced_projection: Math.round(enhancedProjection * 10) / 10,
      blended_baseline: Math.round(blendedBaseline * 10) / 10,
      rotowire_baseline: Math.round(rotowireBaseline * 10) / 10,
      adjustments: {
        streak: Math.round(adjustments.streak * 10) / 10,
        usageBump: Math.round(adjustments.usageBump * 10) / 10,
        venue: Math.round(adjustments.venue * 10) / 10,
        b2b: Math.round(adjustments.b2b * 10) / 10,
        defense: Math.round(adjustments.defense * 10) / 10,
        dvp: Math.round(adjustments.dvp * 10) / 10,
        pace: Math.round(adjustments.pace * 10) / 10,
        vegas: Math.round(adjustments.vegas * 10) / 10,
        blowout: Math.round(adjustments.blowout * 10) / 10
      },
      total_adjustment: Math.round(totalAdjustment * 10) / 10,
      blend_breakdown: blendBreakdown,
      historical: {
        seasonAvg: Math.round(historical.seasonAvg * 10) / 10,
        seasonGames: historical.seasonGames,
        last3Avg: Math.round(historical.last3Avg * 10) / 10,
        last3Games: historical.last3Games,
        streakPct: Math.round(historical.streakPct * 10) / 10,
        floor: Math.round(historical.floor * 10) / 10,
        ceiling: Math.round(historical.ceiling * 10) / 10,
        homeAvg: Math.round((historical.homeAvg || 0) * 10) / 10,
        awayAvg: Math.round((historical.awayAvg || 0) * 10) / 10,
        b2bAvg: Math.round((historical.b2bAvg || 0) * 10) / 10,
        restedAvg: Math.round((historical.restedAvg || 0) * 10) / 10
      },
      matchup: matchup.games > 0 ? {
        games: matchup.games,
        avgDk: Math.round(matchup.avgDk * 10) / 10,
        best: Math.round(matchup.best * 10) / 10,
        worst: Math.round(matchup.worst * 10) / 10
      } : null,
      usageBump: usageBump.hasUsageBump ? usageBump : null,
      confidence,
      enhanced: true
    };
  }

  /**
   * Batch calculate enhanced projections for all players in a slate
   *
   * The minutes x FPPM model (minutesProjectionService) is blended in last:
   * enhanced_projection becomes the blended value, legacy_projection keeps
   * the historical-blend value and minutes_model has the breakdown.
   *
   * @param {Object} options
   * @param {string} options.slateId - enables OUT statuses and manual overrides
   * @param {number} options.minutesWeight - 0..1 weight of the minutes model
   * @param {boolean} options.minutesModel - false skips the minutes model
   */
  async calculateSlateEnhancedProjections(players, slateDate = null, site = 'draftkings', options = {}) {
    console.log(`\n🧠 Calculating ENHANCED projections for ${players.length} players...`);

    // Build slate roster for usage bump detection
    const slateRoster = players.map(p => p.name);

    // Group players by team for reference
    const playersByTeam = {};
    for (const player of players) {
      if (!playersByTeam[player.team]) {
        playersByTeam[player.team] = [];
      }
      playersByTeam[player.team].push(player.name);
    }

    const results = [];
    let enhanced = 0;
    let fallback = 0;
    let totalDiff = 0;
    let usageBumpsFound = 0;
    let hotStreaks = 0;
    let coldStreaks = 0;

    for (const player of players) {
      const isHome = player.is_home === 1 || player.is_home === true;
      const isB2B = player.rest_days === 0;

      const result = await this.calculateEnhancedProjection(player, {
        slateRoster,
        slateDate,
        isHome,
        isB2B,
        site
      });

      // Track stats
      if (result.enhanced) {
        enhanced++;
        const diff = result.enhanced_projection - (result.rotowire_baseline || 0);
        totalDiff += diff;

        if (result.usageBump) usageBumpsFound++;
        if (result.historical?.streakPct > 10) hotStreaks++;
        if (result.historical?.streakPct < -10) coldStreaks++;
      } else {
        fallback++;
      }

      results.push({
        ...player,
        ...result
      });
    }

    console.log(`✅ Enhanced projection complete:`);
    console.log(`   🧠 Enhanced: ${enhanced} players (${fallback} fallback to RotoWire)`);
    console.log(`   📊 Avg projection change: ${(totalDiff / (enhanced || 1)).toFixed(1)} FP`);
    console.log(`   📈 Usage bumps found: ${usageBumpsFound}`);
    console.log(`   🔥 Hot streaks: ${hotStreaks} | 🥶 Cold streaks: ${coldStreaks}`);

    if (options.minutesModel === false) {
      return results;
    }
    return applyMinutesModel(results, {
      slateId: options.slateId,
      slateDate,
      site,
      minutesWeight: options.minutesWeight
    });
  }

  /**
   * ORIGINAL METHOD: Calculate adjusted projection for a player
   * (Kept for backwards compatibility)
   *
   * @param {Object} player - Player data with RotoWire projection and matchup info
   * @returns {Object} - Adjusted projection with breakdown of factors
   */
  async calculateAdjustedProjection(player) {
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
    await this.loadDefenseRankings();
    await this.loadPositionDefenseData();

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
    const rankings = this.defenseRankings || {};
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

    // Use pre-joined data if available. It is real points allowed to the position
    // (Hashtag Basketball, ~19-27). Values outside that band are stale rows from the
    // old mis-aligned parser (FG% landed in pts_allowed), so fall through to rank.
    if (preJoinedDvp >= this.DVP_PTS_MIN && preJoinedDvp <= this.DVP_PTS_MAX) {
      // Higher = worse defense at position = positive adjustment
      const diff = preJoinedDvp - this.LEAGUE_AVG_DVP_PTS;
      // 0.5 FP per real point allowed above average
      return diff * 0.5;
    }

    // Fallback: lookup from position defense data
    const normalizedTeam = normalizeForVsPosition(opponent);
    const positionData = this.positionDefenseData || {};
    const key = `${normalizedTeam}_${primaryPosition}`;
    const defenseVsPos = positionData[key];

    if (!defenseVsPos) return 0;

    // Use rank-based adjustment (overall rank 1-150, 1 = best defense)
    const rankDiff = defenseVsPos.rank - this.LEAGUE_AVG_DVP_RANK;
    // 0.03 FP per rank (higher rank = worse defense = positive)
    return rankDiff * 0.03;
  }

  /**
   * Pace Adjustment
   * Combined pace of both teams affects fantasy opportunity
   */
  getPaceAdjustment(opponent, playerTeam) {
    const rankings = this.defenseRankings || {};

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
  async calculateSlateProjections(players) {
    console.log(`\n🧮 Calculating adjusted projections for ${players.length} players...`);

    const results = [];
    let totalAdjustment = 0;
    let adjustedUp = 0;
    let adjustedDown = 0;

    for (const player of players) {
      const result = await this.calculateAdjustedProjection(player);

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
