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
 *                         + DVP Adjustment (opponent vs archetype / G/F/C, dvpAdjustment.js)
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
import { archetypeDvpAdjustment, loadDvpContext, resolveDvpConfig } from './dvpAdjustment.js';
import { playerKey } from '../utils/playerKey.js';
import { seasonForDate, previousSeason, seasonStartDate } from '../utils/season.js';
import { easternDate } from './slateSnapshotService.js';

// Pseudo-games of last season's average in the season average (early-season shrink)
export const SEASON_PRIOR_GAMES = 10;

const todayEastern = () => easternDate(new Date());
// Azure returns DATE columns as Date objects
const toDateStr = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));
const addDays = (date, n) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

class ProjectionService {
  constructor() {
    this.defenseRankings = null;
    this.positionDefenseData = null;
    this.dvpContexts = {}; // `${date}|${site}` -> archetype DVP context
    this.gamesCache = new Map(); // `${player_key}|${date}|${points column}` -> regular-season games
    this.SEASON_PRIOR_GAMES = SEASON_PRIOR_GAMES;

    // League averages. Defense / pace are replaced by the mean of
    // team_defense_rankings when it is loaded (teamRatingsService: pace =
    // possessions per game); these 2025-26 values are the fallback.
    this.LEAGUE_AVG_DEF_EFF = 112.7;
    this.LEAGUE_AVG_PACE = 102.5;
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
   * Regular-season games (site points as `fp`) for player keys in the
   * current and previous season of `slateDate`, before it (today when null).
   * One set-based query, chunked for Azure SQL's parameter cap; cached per
   * key + date + site. Returns Map(player_key -> rows, most recent first).
   */
  async loadPlayerGames(keys, slateDate = null, site = 'draftkings') {
    const pointsCol = fantasyPointsColumn(site);
    const date = slateDate || todayEastern();
    const from = seasonStartDate(previousSeason(seasonForDate(date)));
    const cacheKey = (key) => `${key}|${date}|${pointsCol}`;
    const wanted = [...new Set(keys.filter(Boolean))];
    const missing = wanted.filter(k => !this.gamesCache.has(cacheKey(k)));
    for (let i = 0; i < missing.length; i += 500) {
      const chunk = missing.slice(i, i + 500);
      const rows = await db.all(`
        SELECT player_key, team, opponent, game_date, season, minutes, is_home, is_back_to_back, ${pointsCol} AS fp
        FROM historical_games
        WHERE player_key IN (${chunk.map(() => '?').join(', ')})
          AND game_date >= ? AND game_date < ?
          AND COALESCE(season_type, 'regular') = 'regular'
          AND ${pointsCol} IS NOT NULL
        ORDER BY player_key, game_date DESC
      `, ...chunk, from, date);
      const byKey = new Map(chunk.map(k => [k, []]));
      for (const r of rows) {
        const gameDate = toDateStr(r.game_date);
        byKey.get(r.player_key)?.push({ ...r, game_date: gameDate, season: r.season || seasonForDate(gameDate), fp: Number(r.fp) });
      }
      for (const [k, list] of byKey) this.gamesCache.set(cacheKey(k), list);
    }
    return new Map(wanted.map(k => [k, this.gamesCache.get(cacheKey(k)) ?? []]));
  }

  /** One player's games (loadPlayerGames), by player_key. */
  async playerGames(playerName, slateDate, site) {
    const key = playerKey(playerName);
    return (await this.loadPlayerGames([key], slateDate, site)).get(key) ?? [];
  }

  /**
   * Get historical stats for a player (regular season, games before the slate date)
   *
   * seasonAvg = this season's average shrunk toward last season's with
   * SEASON_PRIOR_GAMES pseudo-games: (Σ this season + k x last avg) / (games + k);
   * last season alone without games this season. Splits, floor / ceiling and
   * L3 / L5 run over both seasons (most recent first). Matched by player_key.
   * @param {string} playerName - Player's name (resolved with playerKey)
   * @param {string} slateDate - Date of the slate (to filter out future games for backtesting)
   * @param {string} site - DFS site whose fantasy points to use (default draftkings)
   */
  async getPlayerHistoricalStats(playerName, slateDate = null, site = 'draftkings') {
    const games = await this.playerGames(playerName, slateDate, site);
    const season = seasonForDate(slateDate || todayEastern());
    const current = games.filter(g => g.season === season);
    const prior = games.filter(g => g.season !== season);
    const avg = (list) => (list.length ? list.reduce((s, g) => s + g.fp, 0) / list.length : 0);
    const avgWhere = (pred) => avg(games.filter(pred));
    const k = SEASON_PRIOR_GAMES;

    let seasonAvg;
    if (current.length && prior.length) {
      seasonAvg = (current.reduce((s, g) => s + g.fp, 0) + k * avg(prior)) / (current.length + k);
    } else {
      seasonAvg = current.length ? avg(current) : avg(prior);
    }
    const last3 = games.slice(0, 3);
    const last5 = games.slice(0, 5);
    const fps = games.map(g => g.fp);

    const result = {
      seasonAvg,
      seasonGames: games.length,
      currentSeasonGames: current.length,
      priorSeasonGames: prior.length,
      currentSeasonAvg: avg(current),
      priorSeasonAvg: avg(prior),
      floor: fps.length ? Math.min(...fps) : 0,
      ceiling: fps.length ? Math.max(...fps) : 0,
      avgMinutes: games.length ? games.reduce((s, g) => s + (Number(g.minutes) || 0), 0) / games.length : 0,
      homeAvg: avgWhere(g => Number(g.is_home) === 1),
      awayAvg: avgWhere(g => Number(g.is_home) === 0),
      b2bAvg: avgWhere(g => Number(g.is_back_to_back) === 1),
      restedAvg: avgWhere(g => Number(g.is_back_to_back) !== 1),
      last3Avg: avg(last3),
      last3Games: last3.length,
      last5Avg: avg(last5),
      last5Games: last5.length
    };

    // Calculate hot/cold streak
    if (result.seasonAvg > 0 && result.last3Avg > 0) {
      result.streakPct = ((result.last3Avg - result.seasonAvg) / result.seasonAvg) * 100;
    } else {
      result.streakPct = 0;
    }
    return result;
  }

  /**
   * Get matchup-specific history (player vs opponent): regular-season games
   * this season and last, before the slate date, by player_key
   */
  async getMatchupHistory(playerName, opponent, slateDate = null, site = 'draftkings') {
    const games = (await this.playerGames(playerName, slateDate, site)).filter(g => g.opponent === opponent);
    const fps = games.map(g => g.fp);
    return {
      games: games.length,
      avgDk: games.length ? fps.reduce((s, v) => s + v, 0) / games.length : 0,
      avgMin: games.length ? games.reduce((s, g) => s + (Number(g.minutes) || 0), 0) / games.length : 0,
      best: fps.length ? Math.max(...fps) : 0,
      worst: fps.length ? Math.min(...fps) : 0
    };
  }

  /**
   * Detect if there's a usage bump opportunity for this player
   * Checks if any high-usage teammates (regular season, the 30 days before
   * the slate date) are missing from the slate, matched by player_key
   */
  async detectUsageBump(playerName, team, slateRoster, slateDate = null, site = 'draftkings') {
    const pointsCol = fantasyPointsColumn(site);
    const date = slateDate || todayEastern();
    const seasonFrom = seasonStartDate(previousSeason(seasonForDate(date)));

    const historicalRoster = await db.all(`
      SELECT player_key, MAX(player_name) AS player_name, COUNT(*) AS games,
        AVG(${pointsCol}) AS avg_dk, AVG(minutes) AS avg_min
      FROM historical_games
      WHERE team = ? AND game_date >= ? AND game_date < ?
        AND COALESCE(season_type, 'regular') = 'regular'
      GROUP BY player_key
      HAVING COUNT(*) >= 3 AND AVG(${pointsCol}) >= 25
      ORDER BY avg_dk DESC
    `, team, addDays(date, -30), date);

    // Find missing high-usage players
    const onSlate = new Set(slateRoster.map(n => playerKey(n)));
    const missingPlayers = historicalRoster.filter(h => h.player_key && !onSlate.has(h.player_key));
    if (missingPlayers.length === 0) {
      return { hasUsageBump: false, bump: 0, missingPlayers: [] };
    }

    const ownGames = (await this.playerGames(playerName, slateDate, site)).filter(g => g.team === team);
    const avgOf = (list) => (list.length ? list.reduce((s, g) => s + g.fp, 0) / list.length : null);
    const bumpDetails = [];

    for (const missingPlayer of missingPlayers) {
      // Team games (this season and last, before the slate) the missing player sat out, latest 15
      const gamesWithout = (await db.all(`
        SELECT DISTINCT game_date
        FROM historical_games
        WHERE team = ? AND game_date >= ? AND game_date < ?
          AND COALESCE(season_type, 'regular') = 'regular'
          AND game_date NOT IN (
            SELECT game_date FROM historical_games
            WHERE player_key = ? AND team = ? AND minutes > 5
          )
        ORDER BY game_date DESC
      `, team, seasonFrom, date, missingPlayer.player_key, team)).slice(0, 15);

      if (gamesWithout.length < 2) continue;

      const without = new Set(gamesWithout.map(g => toDateStr(g.game_date)));
      const gamesOut = ownGames.filter(g => without.has(g.game_date));
      const gamesIn = ownGames.filter(g => !without.has(g.game_date));
      const statsWithout = { games: gamesOut.length, avg_dk: avgOf(gamesOut) };
      const statsWith = { games: gamesIn.length, avg_dk: avgOf(gamesIn) };

      if (statsWithout.games >= 2 && statsWith.games >= 3 && statsWithout.avg_dk && statsWith.avg_dk) {
        const pctBump = ((statsWithout.avg_dk - statsWith.avg_dk) / statsWith.avg_dk) * 100;

        if (pctBump >= 5) {
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
    this.gamesCache.clear();
    this.dvpContexts = {};
  }

  /**
   * Load defense rankings into memory
   */
  async loadDefenseRankings() {
    // Reload after teamRatingsService rewrites the table (box-score sync, slate sync)
    if (!this.defenseRankings || this.defenseRankingsVersion !== teamDefenseModel.version) {
      const rankings = await teamDefenseModel.getAll();
      this.defenseRankings = {};
      for (const team of rankings) {
        this.defenseRankings[team.team] = team;
      }
      this.defenseRankingsVersion = teamDefenseModel.version;
      this.setLeagueAverages(rankings);
      console.log(`📊 Loaded defense rankings for ${Object.keys(this.defenseRankings).length} teams`);
    }
    return this.defenseRankings;
  }

  /**
   * League defensive efficiency and pace as the mean over teams, so the
   * defense / pace adjustments are centered on the ratings they compare.
   * Kept at the constructor fallbacks with fewer than 20 teams.
   */
  setLeagueAverages(rankings) {
    const mean = (field) => {
      const values = rankings.map(r => Number(r[field])).filter(v => Number.isFinite(v) && v > 0);
      return values.length >= 20 ? values.reduce((s, v) => s + v, 0) / values.length : null;
    };
    this.LEAGUE_AVG_DEF_EFF = mean('def_eff') ?? this.LEAGUE_AVG_DEF_EFF;
    this.LEAGUE_AVG_PACE = mean('pace') ?? this.LEAGUE_AVG_PACE;
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
   * Load everything the matchup adjustments read. Shared by the recalculate
   * (calculateAdjustedProjection) and enhanced paths so both use the same
   * DVP signal. Returns the DVP options for getDvpAdjustment; options.dvp
   * ({ config, context }) overrides the defaults (replay backtest, tests).
   */
  async loadMatchupData({ slateDate = null, site = 'draftkings', dvp = {} } = {}) {
    await this.loadDefenseRankings();
    await this.loadPositionDefenseData();
    // Read per call: .env is loaded after this module is imported
    const config = resolveDvpConfig(dvp.config || {});
    let context = dvp.context ?? null;
    if (!context && config.mode === 'archetype') {
      // Keyed by date so a long-running server picks up the nightly refresh
      const key = `${slateDate || new Date().toISOString().slice(0, 10)}|${site}`;
      if (!this.dvpContexts[key]) this.dvpContexts[key] = await loadDvpContext({ slateDate, site });
      context = this.dvpContexts[key];
    }
    return { config, context };
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

    const { slateRoster = [], slateDate = null, isHome = is_home, isB2B = (rest_days === 0), site = 'draftkings', dvp = {} } = options;

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
      const fallback = await this.calculateAdjustedProjection(player, { slateDate, site, dvp });
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
    const dvpOptions = await this.loadMatchupData({ slateDate, site, dvp });

    adjustments.defense = this.getDefenseAdjustment(opponent, opp_def_eff);
    adjustments.dvp = this.getDvpAdjustment(player, dvpOptions);
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
    // Every player's games in one query (getPlayerHistoricalStats / getMatchupHistory read the cache)
    await this.loadPlayerGames(players.map(p => playerKey(p.name)), slateDate, site);

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
   * @param {Object} options - { slateDate, site, dvp } (see loadMatchupData)
   * @returns {Object} - Adjusted projection with breakdown of factors
   */
  async calculateAdjustedProjection(player, options = {}) {
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
    const dvpOptions = await this.loadMatchupData(options);

    // Calculate each adjustment
    const adjustments = {};

    // 1. DEFENSE EFFICIENCY ADJUSTMENT
    // Higher def_eff = worse defense = positive adjustment
    adjustments.defense = this.getDefenseAdjustment(opponent, opp_def_eff);

    // 2. DVP (DEFENSE VS ARCHETYPE / POSITION) ADJUSTMENT
    // Opponent allows more than expected to this archetype = positive adjustment
    adjustments.dvp = this.getDvpAdjustment(player, dvpOptions);

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
   * DVP Adjustment, per the configured mode (dvpAdjustment.js):
   * 'archetype' = capped, weighted opponent x archetype FP over expectation
   * (falling back to G/F/C, then 0); 'legacy' = getLegacyDvpAdjustment; 'off' = 0.
   * @param {Object} player - { name, opponent, position, dvp_pts_allowed }
   * @param {Object} dvpOptions - { config, context } from loadMatchupData
   */
  getDvpAdjustment(player, { config = resolveDvpConfig(), context = null } = {}) {
    if (config.mode === 'off') return 0;
    if (config.mode === 'legacy') {
      return this.getLegacyDvpAdjustment(player.opponent, player.position, player.dvp_pts_allowed);
    }
    return archetypeDvpAdjustment(player, context, config).value;
  }

  /**
   * Legacy DVP (Defense vs Position) Adjustment
   * How many fantasy points the opponent allows to this position
   */
  getLegacyDvpAdjustment(opponent, position, preJoinedDvp) {
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
