import solver from 'javascript-lp-solver';
import { buildRequestContext, buildSolveContext } from './optimizer/context.js';
import { filterPool, applyConstraints } from './optimizer/constraints/index.js';

/**
 * NBA DFS LINEUP OPTIMIZER
 * Streamlined optimizer for Cash Games and GPP Tournaments
 * Minimal filtering - let the optimizer find the best combinations
 *
 * Site rules (cap, roster slots, team limits) come from config/sites.js.
 * LP constraints live in ./optimizer/constraints/ (index.js lists the pipeline).
 */
class OptimizerService {
  /**
   * Main optimization entry point
   * @param {Array} players - Array of player objects with all metrics
   * @param {Object} settings - Optimization settings
   * @returns {Object} Optimization results with lineups and analytics
   */
  optimize(players, settings = {}) {
    const startTime = Date.now();

    const {
      // Core Settings
      mode = 'cash',                    // 'cash' or 'gpp'
      numLineups = 1,                   // Number of lineups to generate
      // site: 'draftkings' (default), 'fanduel' or 'yahoo'

      // Player Controls
      excludedPlayers = [],             // Array of player IDs to exclude
      // lockedPlayers: array of player IDs to lock
      // minUniqueness: min players each lineup differs from every earlier one (0 = off)

      // minSalary defaults to 98% of the site cap ($49,000 on DK)
      // Pool filters (minMinutes, minProjection, ...): optimizer/constraints/filters.js

      // Diversity for multi-lineup
      maxExposure = 60,                 // Max % exposure per player across lineups

      // Randomness for lineup diversity
      randomness = 0,                   // 0-30 variance injection for GPP

    } = settings;

    const requestCtx = buildRequestContext(settings);
    const { site } = requestCtx;

    console.log(`\n🏀 ═══════════════════════════════════════════════`);
    console.log(`   NBA DFS OPTIMIZER - ${site.name.toUpperCase()} ${mode.toUpperCase()} MODE`);
    console.log(`═══════════════════════════════════════════════════`);
    console.log(`📊 Starting with ${players.length} total players`);
    console.log(`🎯 Generating ${numLineups} lineup(s)`);

    // Step 1: Filter players (request excludes + stat filters)
    const availablePlayers = filterPool(players, buildSolveContext(requestCtx, players));

    console.log(`✅ ${availablePlayers.length} players in pool after filters\n`);

    if (availablePlayers.length < 20) {
      console.error('❌ Not enough players to build diverse lineups!');
      return { lineups: [], exposureStats: null, error: 'Insufficient players' };
    }

    // Step 2: Generate lineups
    const lineups = [];
    const playerUsageCount = new Map(); // Track how many times each player is used
    const usedLineupHashes = new Set(); // Track unique lineups
    const recentTopPlayers = new Set(); // Top players from recent lineups to force diversity
    let consecutiveFailures = 0;
    const maxFailures = 15;

    for (let i = 0; i < numLineups && consecutiveFailures < maxFailures; i++) {
      console.log(`\n━━━ Generating Lineup ${i + 1}/${numLineups} ━━━`);

      // Calculate which players are overexposed
      const overexposedPlayers = this.getOverexposedPlayers(
        playerUsageCount,
        lineups.length,
        numLineups,
        maxExposure
      );

      // Build exclusion list for this iteration
      // Include recently used top players to force more diversity
      const diversityExclusions = consecutiveFailures > 0 ? Array.from(recentTopPlayers) : [];
      const iterationExclusions = new Set([...excludedPlayers, ...overexposedPlayers, ...diversityExclusions]);

      // Calculate randomness - increase significantly for each lineup to get diversity
      // Each subsequent lineup gets more randomness to find different solutions
      const iterationRandomness = randomness + (i * 15) + (consecutiveFailures * 25);

      const lineup = this.generateLineup(availablePlayers, requestCtx, {
        excludedPlayers: iterationExclusions,
        randomness: iterationRandomness,
        lineupNumber: i + 1,
        numLineups,
        priorLineups: lineups.map(l => l.players.map(s => s.player?.id).filter(id => id != null)),
        playerUsageCount
      });

      if (lineup && lineup.isValid) {
        // Check for duplicates
        const lineupHash = this.getLineupHash(lineup);

        if (!usedLineupHashes.has(lineupHash)) {
          lineup.lineupNumber = i + 1;
          lineups.push(lineup);
          usedLineupHashes.add(lineupHash);
          consecutiveFailures = 0;
          recentTopPlayers.clear(); // Clear diversity exclusions on success

          // Update player usage counts
          lineup.players.forEach(slot => {
            if (slot.player) {
              const count = playerUsageCount.get(slot.player.id) || 0;
              playerUsageCount.set(slot.player.id, count + 1);
            }
          });

          // Track the top 3 highest-projected players from this lineup for diversity
          const sortedPlayers = lineup.players
            .filter(s => s.player)
            .sort((a, b) => (b.player.projected_points || 0) - (a.player.projected_points || 0))
            .slice(0, 3);
          sortedPlayers.forEach(s => recentTopPlayers.add(s.player.id));

          console.log(`✅ Lineup ${i + 1} generated successfully`);
          this.displayLineupSummary(lineup, mode);
        } else {
          console.warn(`⚠️  Lineup ${i + 1} is duplicate, retrying...`);
          consecutiveFailures++;

          // On duplicate, add the top scoring players to exclusion to force different selections
          // Sort by projection and exclude top 4-6 players depending on failures
          const playersToExclude = lineup.players
            .filter(s => s.player)
            .sort((a, b) => (b.player.projected_points || 0) - (a.player.projected_points || 0))
            .slice(0, Math.min(4 + consecutiveFailures, 7));

          playersToExclude.forEach(s => recentTopPlayers.add(s.player.id));
          console.log(`   Excluding ${playersToExclude.length} top players from next attempt`);
        }
      } else {
        console.warn(`⚠️  Failed to generate valid lineup ${i + 1}`);
        consecutiveFailures++;
      }
    }

    const executionTime = ((Date.now() - startTime) / 1000).toFixed(2);

    console.log(`\n═══════════════════════════════════════════════════`);
    console.log(`✅ Generated ${lineups.length}/${numLineups} valid lineups`);
    console.log(`⏱️  Execution time: ${executionTime}s`);
    console.log(`═══════════════════════════════════════════════════\n`);

    // Step 3: Calculate exposure stats for multi-lineup
    let exposureStats = null;
    if (lineups.length > 1) {
      exposureStats = this.getExposureStats(lineups, availablePlayers);
      this.displayExposureReport(exposureStats, lineups.length);
    }

    return {
      lineups,
      exposureStats,
      settings: {
        mode,
        site: site.key,
        numLineups: lineups.length,
        executionTime
      }
    };
  }

  /**
   * Get list of players who have exceeded exposure limits
   */
  getOverexposedPlayers(playerUsageCount, currentLineupCount, totalLineups, maxExposure) {
    if (currentLineupCount === 0) return [];

    const overexposed = [];

    playerUsageCount.forEach((count, playerId) => {
      const currentExposure = (count / currentLineupCount) * 100;
      // If player is already at or above max exposure, exclude them
      if (currentExposure >= maxExposure) {
        overexposed.push(playerId);
      }
    });

    return overexposed;
  }

  /**
   * Generate a single lineup using LP solver
   * @param {Object} requestCtx - from buildRequestContext()
   * @param {Object} solveOptions - per-solve state (excludedPlayers, randomness, priorLineups, ...)
   */
  generateLineup(players, requestCtx, solveOptions) {
    const { randomness, ...solveState } = solveOptions;

    // Apply variance to projections for diversity
    const playersWithVariance = this.applyVariance(players, randomness, requestCtx.mode);

    // Build LP model
    const ctx = buildSolveContext(requestCtx, playersWithVariance, solveState);
    const model = this.buildLPModel(ctx);

    // Solve
    const result = solver.Solve(model);

    if (!result || !result.feasible) {
      console.error('❌ LP solver could not find feasible solution');
      return null;
    }

    console.log(`✅ LP solution found! Objective: ${result.result?.toFixed(2)}`);

    // Extract lineup
    const lineup = this.extractLineupFromSolution(result, players, ctx);

    // Add analytics
    if (lineup && lineup.isValid) {
      lineup.analytics = this.calculateLineupAnalytics(lineup, requestCtx.mode);
    }

    return lineup;
  }

  /**
   * Apply variance to projections for lineup diversity
   */
  applyVariance(players, randomness, mode) {
    if (randomness === 0) {
      return players.map(p => ({
        ...p,
        adjustedProjection: p.projected_points || 0
      }));
    }

    return players.map(player => {
      const baseProjection = player.projected_points || 0;

      // Use ceiling-floor range to determine variance potential
      const range = (player.ceiling || baseProjection * 1.2) - (player.floor || baseProjection * 0.8);

      // Random variance based on player's upside potential
      const varianceFactor = (randomness / 100);
      const variance = (Math.random() - 0.5) * range * varianceFactor;

      return {
        ...player,
        adjustedProjection: Math.max(0, baseProjection + variance)
      };
    });
  }

  /**
   * Build LP model by running the constraint pipeline (optimizer/constraints)
   */
  buildLPModel(ctx) {
    // Determine what to optimize based on mode
    const model = {
      optimize: ctx.mode === 'cash' ? 'cashScore' : 'gppScore',
      opType: 'max',
      constraints: {},
      variables: {},
      ints: {}
    };

    return applyConstraints(model, ctx);
  }

  /**
   * Extract lineup from LP solution, in the site's roster slot order
   */
  extractLineupFromSolution(solution, players, ctx) {
    const { site } = ctx;

    // Picked players per slot name (FanDuel has two of each guard/forward slot)
    const picked = new Map();
    ctx.varMeta.forEach(({ playerId, slot }, varName) => {
      if (Math.round(solution[varName] || 0) !== 1) return;
      const player = players.find(p => p.id === playerId);
      if (!player) return;
      if (!picked.has(slot)) picked.set(slot, []);
      picked.get(slot).push(player);
    });

    let totalSalary = 0;
    let projectedPoints = 0;

    const lineupArray = site.rosterSlots.map(({ slot }) => {
      const player = picked.get(slot)?.shift() || null;
      if (player) {
        totalSalary += player.salary;
        projectedPoints += player.projected_points || 0;
      }
      return { position: slot, player };
    });

    const filledSlots = lineupArray.filter(slot => slot.player !== null).length;
    const isValid = filledSlots === ctx.rosterSize && totalSalary <= site.salaryCap;

    return {
      players: lineupArray,
      totalSalary,
      projectedPoints,
      remainingSalary: site.salaryCap - totalSalary,
      filledSlots,
      isValid
    };
  }

  /**
   * Calculate lineup analytics
   */
  calculateLineupAnalytics(lineup, mode) {
    const players = lineup.players.map(slot => slot.player).filter(Boolean);

    if (players.length === 0) return null;

    const totalFloor = players.reduce((sum, p) => sum + (p.floor || 0), 0);
    const totalCeiling = players.reduce((sum, p) => sum + (p.ceiling || 0), 0);
    const avgOwnership = players.reduce((sum, p) => sum + (p.rostership || 0), 0) / players.length;
    const totalLeverage = players.reduce((sum, p) => sum + (p.leverage_score || 0), 0);

    // Team diversity
    const teams = [...new Set(players.map(p => p.team))];
    const games = [...new Set(players.map(p => `${p.team} vs ${p.opponent}`))];

    return {
      totalFloor: totalFloor.toFixed(1),
      totalCeiling: totalCeiling.toFixed(1),
      avgOwnership: avgOwnership.toFixed(1),
      totalLeverage: totalLeverage.toFixed(1),
      numTeams: teams.length,
      numGames: games.length,
      teams,
      salaryEfficiency: ((lineup.projectedPoints / lineup.totalSalary) * 1000).toFixed(2)
    };
  }

  /**
   * Get lineup hash for uniqueness checking
   */
  getLineupHash(lineup) {
    const playerIds = lineup.players
      .map(slot => slot.player?.id)
      .filter(Boolean)
      .sort((a, b) => a - b)
      .join('-');
    return playerIds;
  }

  /**
   * Display lineup summary
   */
  displayLineupSummary(lineup, mode) {
    const analytics = lineup.analytics;
    if (!analytics) return;

    console.log(`\n💰 Salary: $${lineup.totalSalary.toLocaleString()} (${lineup.remainingSalary} remaining)`);
    console.log(`📈 Projection: ${lineup.projectedPoints.toFixed(1)} pts`);
    console.log(`📊 Floor: ${analytics.totalFloor} | Ceiling: ${analytics.totalCeiling}`);
    console.log(`👥 Ownership: ${analytics.avgOwnership}% | Leverage: ${analytics.totalLeverage}`);
    console.log(`🏀 Teams: ${analytics.numTeams} | Games: ${analytics.numGames}`);
  }

  /**
   * Get exposure stats across multiple lineups
   */
  getExposureStats(lineups, allPlayers) {
    const exposure = new Map();

    lineups.forEach(lineup => {
      lineup.players.forEach(slot => {
        if (slot.player) {
          const pid = slot.player.id;
          const current = exposure.get(pid) || {
            player: slot.player,
            count: 0
          };
          exposure.set(pid, { ...current, count: current.count + 1 });
        }
      });
    });

    return Array.from(exposure.entries())
      .map(([id, data]) => ({
        playerId: id,
        name: data.player.name,
        salary: data.player.salary,
        ownership: data.player.rostership || 0,
        leverage: data.player.leverage_score || 0,
        count: data.count,
        exposure: ((data.count / lineups.length) * 100).toFixed(1)
      }))
      .sort((a, b) => parseFloat(b.exposure) - parseFloat(a.exposure));
  }

  /**
   * Display exposure report
   */
  displayExposureReport(stats, numLineups) {
    console.log(`\n╔═══════════════════════════════════════════════════════════╗`);
    console.log(`║           EXPOSURE REPORT (${numLineups} Lineups)                    ║`);
    console.log(`╠═══════════════════════════════════════════════════════════╣`);
    console.log(`║ PLAYER              SALARY   OWN%   EXP%   COUNT  LEV    ║`);
    console.log(`╠═══════════════════════════════════════════════════════════╣`);

    stats.slice(0, 15).forEach(stat => {
      const name = stat.name.padEnd(18).substring(0, 18);
      const salary = `$${(stat.salary / 1000).toFixed(1)}k`.padEnd(8);
      const own = `${stat.ownership.toFixed(0)}%`.padEnd(6);
      const exp = `${stat.exposure}%`.padEnd(6);
      const count = `${stat.count}/${numLineups}`.padEnd(7);
      const lev = stat.leverage.toFixed(1);

      console.log(`║ ${name} ${salary} ${own} ${exp} ${count} ${lev}   ║`);
    });

    console.log(`╚═══════════════════════════════════════════════════════════╝`);

    console.log(`\n👥 Total Unique Players Used: ${stats.length}`);
  }
}

export default new OptimizerService();
