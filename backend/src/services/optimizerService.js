import solver from 'javascript-lp-solver';

/**
 * NBA DFS LINEUP OPTIMIZER
 * Streamlined optimizer for Cash Games and GPP Tournaments
 * Minimal filtering - let the optimizer find the best combinations
 */
class OptimizerService {
  constructor() {
    this.SALARY_CAP = 50000;
    this.ROSTER_SLOTS = ['PG', 'SG', 'SF', 'PF', 'C', 'G', 'F', 'UTIL'];
  }

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

      // Player Controls
      lockedPlayers = [],               // Array of player IDs to lock
      excludedPlayers = [],             // Array of player IDs to exclude

      // Salary Settings
      minSalary = 49000,                // Minimum salary to use

      // Simple Filters (the only ones we really need)
      minMinutes = 0,                   // Minimum projected minutes (0 = no filter)
      minUsage = 0,                     // Minimum usage rate (0 = no filter)

      // Diversity for multi-lineup
      maxExposure = 60,                 // Max % exposure per player across lineups

      // Randomness for lineup diversity
      randomness = 0,                   // 0-30 variance injection for GPP

    } = settings;

    console.log(`\n🏀 ═══════════════════════════════════════════════`);
    console.log(`   NBA DFS OPTIMIZER - ${mode.toUpperCase()} MODE`);
    console.log(`═══════════════════════════════════════════════════`);
    console.log(`📊 Starting with ${players.length} total players`);
    console.log(`🎯 Generating ${numLineups} lineup(s)`);

    // Step 1: Simple filter - only minutes and usage
    let availablePlayers = this.filterPlayers(players, {
      lockedPlayers,
      excludedPlayers,
      minMinutes,
      minUsage
    });

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
      const iterationExclusions = [...excludedPlayers, ...overexposedPlayers, ...diversityExclusions];

      // Calculate randomness - increase significantly for each lineup to get diversity
      // Each subsequent lineup gets more randomness to find different solutions
      const iterationRandomness = randomness + (i * 15) + (consecutiveFailures * 25);

      const lineup = this.generateLineup(availablePlayers, {
        mode,
        lockedPlayers,
        excludedPlayers: iterationExclusions,
        minSalary,
        randomness: iterationRandomness,
        lineupNumber: i + 1
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
        numLineups: lineups.length,
        executionTime
      }
    };
  }

  /**
   * Simple player filter - only minutes and usage
   */
  filterPlayers(players, filters) {
    const { lockedPlayers, excludedPlayers, minMinutes, minUsage } = filters;

    console.log(`\n🔍 Applying filters:`);
    if (minMinutes > 0) console.log(`   - Min Minutes: ${minMinutes}`);
    if (minUsage > 0) console.log(`   - Min Usage: ${minUsage}%`);

    return players.filter(player => {
      // Always keep locked players
      if (lockedPlayers.includes(player.id)) {
        return true;
      }

      // Exclude specified players
      if (excludedPlayers.includes(player.id)) {
        return false;
      }

      // Filter by minutes if set
      if (minMinutes > 0 && (player.projected_minutes || 0) < minMinutes) {
        return false;
      }

      // Filter by usage if set
      if (minUsage > 0 && (player.usage || 0) < minUsage) {
        return false;
      }

      // Must have a projection
      if (!player.projected_points || player.projected_points <= 0) {
        return false;
      }

      // Must have a salary
      if (!player.salary || player.salary <= 0) {
        return false;
      }

      return true;
    });
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
   */
  generateLineup(players, settings) {
    const {
      mode,
      lockedPlayers,
      excludedPlayers,
      minSalary,
      randomness
    } = settings;

    // Apply variance to projections for diversity
    const playersWithVariance = this.applyVariance(players, randomness, mode);

    // Build LP model
    const model = this.buildLPModel(playersWithVariance, {
      mode,
      lockedPlayers,
      excludedPlayers,
      minSalary
    });

    // Solve
    const result = solver.Solve(model);

    if (!result || !result.feasible) {
      console.error('❌ LP solver could not find feasible solution');
      return null;
    }

    console.log(`✅ LP solution found! Objective: ${result.result?.toFixed(2)}`);

    // Extract lineup
    const lineup = this.extractLineupFromSolution(result, players, mode);

    // Add analytics
    if (lineup && lineup.isValid) {
      lineup.analytics = this.calculateLineupAnalytics(lineup, mode);
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
   * Build LP model - clean and simple
   */
  buildLPModel(players, settings) {
    const { mode, lockedPlayers, excludedPlayers, minSalary } = settings;

    // Determine what to optimize based on mode
    const optimizeField = mode === 'cash' ? 'cashScore' : 'gppScore';

    const model = {
      optimize: optimizeField,
      opType: 'max',
      constraints: {
        salary: { max: this.SALARY_CAP },
        minSalary: { min: minSalary },
        totalPlayers: { equal: 8 }
      },
      variables: {},
      ints: {}
    };

    // Position slot constraints - exactly 1 player per slot
    this.ROSTER_SLOTS.forEach(slot => {
      model.constraints[`slot_${slot}`] = { equal: 1 };
    });

    // Player uniqueness - each player can only be used once
    const playerIds = new Set();
    players.forEach(player => {
      if (!playerIds.has(player.id)) {
        playerIds.add(player.id);
        if (lockedPlayers.includes(player.id)) {
          model.constraints[`player_${player.id}`] = { equal: 1 };
        } else {
          model.constraints[`player_${player.id}`] = { max: 1 };
        }
      }
    });

    // Create decision variables for each player-slot combination
    players.forEach(player => {
      if (excludedPlayers.includes(player.id)) return;

      const playerPositions = this.getPlayerPositions(player.position);
      const eligibleSlots = this.getEligibleSlots(playerPositions);

      eligibleSlots.forEach(slot => {
        const varName = `p${player.id}_${slot}`;

        // Calculate scores for optimization
        const projection = player.adjustedProjection || player.projected_points || 0;
        const floor = player.floor || (projection * 0.75);
        const ceiling = player.ceiling || (projection * 1.25);
        const ownership = player.rostership || 10;
        const leverage = player.leverage_score || 1;

        // Cash score: weighted toward floor and consistency
        // Prioritize: high floor, solid projection, good value
        const value = projection / (player.salary / 1000);
        const cashScore = (projection * 0.5) + (floor * 0.4) + (value * 1.5);

        // GPP score: weighted toward ceiling, value, and ownership
        // Low ownership + high ceiling + good value = GPP gold
        // Leverage already factors in boom probability vs ownership
        const ceilingValue = ceiling / (player.salary / 1000);
        const ownershipBoost = Math.max(0, (25 - ownership) * 0.5); // Boost for <25% owned
        const leverageBonus = Math.min(leverage, 20) * 0.5; // Cap leverage impact
        const gppScore = (ceiling * 0.4) + (ceilingValue * 3) + ownershipBoost + leverageBonus;

        model.variables[varName] = {
          cashScore,
          gppScore,
          salary: player.salary,
          minSalary: player.salary,
          totalPlayers: 1,
          [`slot_${slot}`]: 1,
          [`player_${player.id}`]: 1
        };

        model.ints[varName] = 1;
      });
    });

    return model;
  }

  /**
   * Extract lineup from LP solution
   */
  extractLineupFromSolution(solution, players, mode) {
    const lineup = {
      PG: null, SG: null, SF: null, PF: null,
      C: null, G: null, F: null, UTIL: null
    };

    let totalSalary = 0;
    let projectedPoints = 0;

    Object.keys(solution).forEach(key => {
      if (key.startsWith('p') && solution[key] === 1) {
        const match = key.match(/^p(\d+)_(.+)$/);
        if (match) {
          const playerId = parseInt(match[1]);
          const slot = match[2];
          const player = players.find(p => p.id === playerId);

          if (player && lineup[slot] === null) {
            lineup[slot] = player;
            totalSalary += player.salary;
            projectedPoints += player.projected_points || 0;
          }
        }
      }
    });

    const lineupArray = Object.entries(lineup).map(([pos, player]) => ({
      position: pos,
      player
    }));

    const filledSlots = lineupArray.filter(slot => slot.player !== null).length;
    const isValid = filledSlots === 8 && totalSalary <= this.SALARY_CAP;

    return {
      players: lineupArray,
      totalSalary,
      projectedPoints,
      remainingSalary: this.SALARY_CAP - totalSalary,
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

  /**
   * Parse position string into array
   */
  getPlayerPositions(positionString) {
    if (!positionString) return [];
    return positionString.split(',').map(p => p.trim());
  }

  /**
   * Get eligible roster slots for a player's positions
   */
  getEligibleSlots(playerPositions) {
    const slots = new Set();

    playerPositions.forEach(pos => {
      // Primary positions
      if (this.ROSTER_SLOTS.includes(pos)) {
        slots.add(pos);
      }
      // Flex positions
      if (pos === 'PG' || pos === 'SG') slots.add('G');
      if (pos === 'SF' || pos === 'PF') slots.add('F');
      // Everyone can go in UTIL
      slots.add('UTIL');
    });

    return Array.from(slots);
  }
}

export default new OptimizerService();
