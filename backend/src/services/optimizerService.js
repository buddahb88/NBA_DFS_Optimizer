import solver from 'javascript-lp-solver';

class OptimizerService {
  constructor() {
    this.SALARY_CAP = 50000;
    this.ROSTER_SLOTS = ['PG', 'SG', 'SF', 'PF', 'C', 'G', 'F', 'UTIL'];
  }

  /**
   * Generate optimal lineup(s) based on settings using Linear Programming
   * @param {Array} players - Array of player objects
   * @param {Object} settings - Optimization settings
   * @returns {Array} Array of optimized lineups
   */
  optimize(players, settings = {}) {
    const {
      mode = 'cash',              // 'cash' or 'gpp'
      numLineups = 1,              // Number of lineups to generate
      lockedPlayers = [],          // Array of player IDs to lock
      excludedPlayers = [],        // Array of player IDs to exclude
      minSalary = 49000,           // Minimum salary to use
      maxExposure = 100,           // Max exposure % per player (for multi-lineup)
      randomness = 0,              // 0-100, adds variance for GPP
      minMinutes = 15,             // Minimum projected minutes
      minProjection = 15,          // Minimum projected points
      useValueFilter = true,       // Filter by value percentile
    } = settings;

    console.log(`\n🏀 === LINEAR PROGRAMMING OPTIMIZER ===`);
    console.log(`Starting with ${players.length} total players`);

    // Filter out excluded players
    let availablePlayers = players.filter(p => !excludedPlayers.includes(p.id));

    // Apply quality filters (but keep locked players)
    availablePlayers = this.filterPlayersByQuality(availablePlayers, {
      minMinutes,
      minProjection,
      useValueFilter,
      mode,
      lockedPlayers
    });

    console.log(`✅ ${availablePlayers.length} players passed quality filters`);

    if (availablePlayers.length === 0) {
      console.error('❌ No players available after filtering!');
      return [];
    }

    // Generate lineups
    const lineups = [];
    const excludedPlayerIds = new Set(excludedPlayers);

    for (let i = 0; i < numLineups; i++) {
      console.log(`\n--- Generating Lineup ${i + 1}/${numLineups} ---`);

      const lineup = this.generateLineupWithLP(
        availablePlayers,
        lockedPlayers,
        Array.from(excludedPlayerIds),
        minSalary,
        mode,
        randomness + (i * 5) // Add variance for multiple lineups
      );

      if (lineup && lineup.isValid) {
        lineup.lineupNumber = i + 1;
        lineups.push(lineup);

        // For multiple lineups, track exposure and exclude overexposed players
        if (numLineups > 1) {
          const maxUses = Math.ceil((maxExposure / 100) * numLineups);
          lineup.players.forEach(slot => {
            if (slot.player) {
              const playerId = slot.player.id;
              const currentUses = lineups.filter(lu =>
                lu.players.some(s => s.player?.id === playerId)
              ).length;

              if (currentUses >= maxUses) {
                excludedPlayerIds.add(playerId);
                console.log(`🚫 Player ${slot.player.name} at max exposure (${currentUses}/${maxUses})`);
              }
            }
          });
        }
      } else {
        console.warn(`⚠️  Failed to generate valid lineup ${i + 1}`);
      }
    }

    console.log(`\n✅ Generated ${lineups.length}/${numLineups} valid lineups\n`);

    return lineups;
  }

  /**
   * Filter players by quality metrics
   */
  filterPlayersByQuality(players, filters) {
    const { minMinutes, minProjection, useValueFilter, mode, lockedPlayers } = filters;

    let filtered = players.filter(player => {
      // Always keep locked players
      if (lockedPlayers.includes(player.id)) return true;

      // Minutes filter
      if (minMinutes && (player.projected_minutes || 0) < minMinutes) {
        console.log(`❌ Filtered ${player.name}: only ${player.projected_minutes} min`);
        return false;
      }

      // Projection filter
      if (minProjection && (player.projected_points || 0) < minProjection) {
        console.log(`❌ Filtered ${player.name}: only ${player.projected_points} proj`);
        return false;
      }

      return true;
    });

    // Value percentile filter - only use top 75% by value
    if (useValueFilter) {
      const valueField = mode === 'gpp' ? 'value_gpp' : 'value';
      const values = filtered.map(p => p[valueField] || 0).filter(v => v > 0).sort((a, b) => b - a);

      if (values.length > 0) {
        // Calculate 25th percentile (bottom 25% threshold)
        const percentile25Index = Math.floor(values.length * 0.75);
        const valueThreshold = values[percentile25Index] || 0;

        console.log(`💎 Value threshold (top 75%): ${valueThreshold.toFixed(2)}`);

        const beforeCount = filtered.length;
        filtered = filtered.filter(player => {
          // Keep locked players
          if (lockedPlayers.includes(player.id)) return true;

          // Keep if above value threshold
          return (player[valueField] || 0) >= valueThreshold;
        });

        console.log(`Removed ${beforeCount - filtered.length} low-value players`);
      }
    }

    return filtered;
  }

  /**
   * Generate lineup using Linear Programming solver
   */
  generateLineupWithLP(players, lockedPlayerIds, excludedPlayerIds, minSalary, mode, randomness) {
    console.log(`📊 Setting up LP problem with ${players.length} players`);

    // Add variance to projections for diversity
    const playersWithVariance = players.map(p => {
      let projectedPoints = p.projected_points || 0;

      if (randomness > 0) {
        const variance = (Math.random() - 0.5) * 2 * (randomness / 100);
        projectedPoints = projectedPoints * (1 + variance);
      }

      return { ...p, adjustedProjection: projectedPoints };
    });

    // Build the LP model
    const model = this.buildLPModel(playersWithVariance, lockedPlayerIds, excludedPlayerIds, minSalary);

    // Solve the LP problem
    console.log(`🔧 Solving LP problem...`);
    const result = solver.Solve(model);

    if (!result || !result.feasible) {
      console.error('❌ LP solver could not find a feasible solution');
      console.error('Result:', result);
      return null;
    }

    console.log(`✅ LP solution found! Objective value: ${result.result?.toFixed(2)}`);

    // Extract lineup from solution
    return this.extractLineupFromSolution(result, players);
  }

  /**
   * Build LP model for DFS lineup optimization
   * Decision variables: x_playerId_slot (binary: 0 or 1)
   * Objective: Maximize total projected points
   * Constraints: Position requirements, salary cap, uniqueness
   */
  buildLPModel(players, lockedPlayerIds, excludedPlayerIds, minSalary) {
    const model = {
      optimize: 'projectedPoints',
      opType: 'max',
      constraints: {
        salary: { max: this.SALARY_CAP },
        minSalary: { min: minSalary },
        totalPlayers: { equal: 8 } // Exactly 8 players
      },
      variables: {},
      ints: {}
    };

    // Add position constraints (each slot must be filled exactly once)
    this.ROSTER_SLOTS.forEach(slot => {
      model.constraints[`slot_${slot}`] = { equal: 1 };
    });

    // Add player uniqueness constraints (each player used at most once)
    players.forEach(player => {
      model.constraints[`player_${player.id}`] = { max: 1 };
    });

    // Create decision variables for each player-slot combination
    players.forEach(player => {
      const playerPositions = this.getPlayerPositions(player.position);
      const eligibleSlots = this.getEligibleSlots(playerPositions);

      eligibleSlots.forEach(slot => {
        const varName = `p${player.id}_${slot}`;

        // Skip if player is excluded
        if (excludedPlayerIds.includes(player.id)) {
          return;
        }

        model.variables[varName] = {
          projectedPoints: player.adjustedProjection,
          salary: player.salary,
          minSalary: player.salary,
          totalPlayers: 1,
          [`slot_${slot}`]: 1,
          [`player_${player.id}`]: 1
        };

        // Force locked players to be selected
        if (lockedPlayerIds.includes(player.id)) {
          // Find the best slot for this locked player
          model.constraints[varName] = { min: 1 };
          console.log(`🔒 Locked: ${player.name} (${player.position})`);
        }

        // Binary constraint
        model.ints[varName] = 1;
      });
    });

    return model;
  }

  /**
   * Extract lineup from LP solution
   */
  extractLineupFromSolution(solution, players) {
    const lineup = {
      PG: null,
      SG: null,
      SF: null,
      PF: null,
      C: null,
      G: null,
      F: null,
      UTIL: null
    };

    let totalSalary = 0;
    let projectedPoints = 0;

    // Parse solution to find selected player-slot combinations
    Object.keys(solution).forEach(key => {
      if (key.startsWith('p') && solution[key] === 1) {
        // Parse variable name: p{playerId}_{slot}
        const match = key.match(/^p(\d+)_(.+)$/);
        if (match) {
          const playerId = parseInt(match[1]);
          const slot = match[2];

          const player = players.find(p => p.id === playerId);
          if (player) {
            lineup[slot] = player;
            totalSalary += player.salary;
            projectedPoints += player.projected_points || 0;
            console.log(`  ${slot}: ${player.name} (${player.position}) - $${player.salary.toLocaleString()}, ${(player.projected_points || 0).toFixed(1)} pts`);
          }
        }
      }
    });

    // Convert to array format
    const lineupArray = Object.entries(lineup).map(([pos, player]) => ({
      position: pos,
      player
    }));

    const filledSlots = lineupArray.filter(slot => slot.player !== null).length;
    const isValid = filledSlots === 8 && totalSalary <= this.SALARY_CAP;

    console.log(`\n💰 Salary: $${totalSalary.toLocaleString()} / $${this.SALARY_CAP.toLocaleString()}`);
    console.log(`📈 Projected: ${projectedPoints.toFixed(2)} points`);
    console.log(`✓ Valid: ${isValid ? 'YES' : 'NO'} (${filledSlots}/8 slots)`);

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
   * Parse player position string into array
   */
  getPlayerPositions(positionString) {
    return positionString.split(',').map(p => p.trim());
  }

  /**
   * Get eligible roster slots for given player positions
   */
  getEligibleSlots(playerPositions) {
    const slots = new Set();

    playerPositions.forEach(pos => {
      // Exact position match
      if (this.ROSTER_SLOTS.includes(pos)) {
        slots.add(pos);
      }

      // Flex positions
      if (pos === 'PG' || pos === 'SG') {
        slots.add('G');
      }
      if (pos === 'SF' || pos === 'PF') {
        slots.add('F');
      }

      // UTIL can be filled by anyone
      slots.add('UTIL');
    });

    return Array.from(slots);
  }


  /**
   * Validate lineup meets all constraints
   */
  validateLineup(lineup, totalSalary, minSalary) {
    // Check all 8 positions filled
    const allFilled = Object.values(lineup).every(player => player !== null);
    const filledCount = Object.values(lineup).filter(p => p !== null).length;

    // Check salary constraints
    const withinCap = totalSalary <= this.SALARY_CAP;
    const meetsMinimum = totalSalary >= minSalary;

    // Check no duplicate players
    const playerIds = Object.values(lineup).map(p => p?.id).filter(Boolean);
    const noDuplicates = playerIds.length === new Set(playerIds).size;

    // Check we have exactly 8 players
    const exactlyEight = filledCount === 8 && playerIds.length === 8;

    if (!exactlyEight) {
      console.warn(`⚠️  Lineup only has ${filledCount}/8 players filled`);
    }

    return allFilled && withinCap && meetsMinimum && noDuplicates && exactlyEight;
  }


  /**
   * Get player exposure stats across multiple lineups
   */
  getExposureStats(lineups) {
    const exposure = new Map();

    lineups.forEach(lineup => {
      lineup.players.forEach(slot => {
        if (slot.player) {
          const current = exposure.get(slot.player.id) || { name: slot.player.name, count: 0 };
          exposure.set(slot.player.id, { ...current, count: current.count + 1 });
        }
      });
    });

    return Array.from(exposure.entries())
      .map(([id, data]) => ({
        playerId: id,
        name: data.name,
        count: data.count,
        exposure: ((data.count / lineups.length) * 100).toFixed(1)
      }))
      .sort((a, b) => b.count - a.count);
  }
}

export default new OptimizerService();
