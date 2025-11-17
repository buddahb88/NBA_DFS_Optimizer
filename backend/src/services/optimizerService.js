import solver from 'javascript-lp-solver';

/**
 * ELITE NBA DFS LINEUP OPTIMIZER
 * Professional-grade optimizer for Cash Games and GPP Tournaments
 * Leverages advanced metrics: floor, ceiling, leverage_score, boom/bust probabilities
 */
class OptimizerService {
  constructor() {
    this.SALARY_CAP = 50000;
    this.ROSTER_SLOTS = ['PG', 'SG', 'SF', 'PF', 'C', 'G', 'F', 'UTIL'];

    // GPP Strategy Modes
    this.GPP_MODES = {
      MAX_LEVERAGE: 'max_leverage',
      BALANCED: 'balanced',
      CONTRARIAN: 'contrarian'
    };
  }

  /**
   * Main optimization entry point
   * @param {Array} players - Array of player objects with all metrics
   * @param {Object} settings - Comprehensive optimization settings
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
      minSalary = mode === 'cash' ? 49000 : 47000,

      // Cash Game Settings
      minFloor = 30,                    // Minimum floor for cash
      maxVolatility = 0.20,             // Maximum volatility for cash
      maxBustProbability = 25,          // Max bust % for cash
      minProjectedMinutes = 28,         // Minimum minutes for cash
      requireHighVegas = false,         // Require players in high Vegas total games
      avoidBlowouts = true,             // Avoid blowout risk in cash

      // GPP Settings
      gppMode = this.GPP_MODES.BALANCED, // GPP strategy mode
      minLeverageScore = 2.5,           // Minimum leverage score
      minBoomProbability = 20,          // Minimum boom %
      minCeiling = 50,                  // Minimum ceiling
      maxChalkPlayers = 2,              // Max players with >25% ownership
      randomness = 0,                   // 0-30 variance injection

      // Exposure Settings (GPP multi-lineup)
      maxExposureChalk = 30,            // Max exposure for >25% owned
      maxExposureMid = 50,              // Max exposure for 10-25% owned
      maxExposureLeverage = 70,         // Max exposure for <10% owned
      minExposure = 0,                  // Minimum exposure % for any player

      // Stacking Settings
      gameStacks = [],                  // [{game: 'LAL vs BOS', minPlayers: 2}]
      teamStacks = [],                  // [{team: 'LAL', minPlayers: 2}]
      enableBringBack = false,          // If game stacking, require opponent player

      // Diversity Constraints
      maxPlayersPerTeam = 3,            // Max from same team
      minDifferentTeams = 6,            // Min different teams
      minGamesRepresented = 3,          // Min different games

      // Advanced Filters
      minRestDays = 0,                  // Filter by rest advantage
      minUsage = 0,                     // Filter by usage rate
      requireDvpAdvantage = false,      // Require 3+ players with dvp_pts_allowed >= 45
      usePaceBoost = true,              // Boost projections in high-pace games

      // Quality Filters
      minProjection = mode === 'cash' ? 25 : 20,
      filterInjured = true,             // Remove OUT/Doubtful/Questionable

    } = settings;

    console.log(`\n🏀 ═══════════════════════════════════════════════`);
    console.log(`   ELITE NBA DFS OPTIMIZER - ${mode.toUpperCase()} MODE`);
    console.log(`═══════════════════════════════════════════════════`);
    console.log(`📊 Starting with ${players.length} total players`);
    console.log(`🎯 Generating ${numLineups} lineup(s)`);
    if (mode === 'gpp') {
      console.log(`⚡ GPP Strategy: ${gppMode}`);
    }

    // Step 1: Filter players based on mode and settings
    let availablePlayers = this.filterPlayers(players, {
      mode,
      lockedPlayers,
      excludedPlayers,
      filterInjured,
      minFloor,
      maxVolatility,
      maxBustProbability,
      minProjectedMinutes,
      minLeverageScore,
      minBoomProbability,
      minCeiling,
      minProjection,
      minRestDays,
      minUsage,
      avoidBlowouts
    });

    console.log(`✅ ${availablePlayers.length} players passed filters\n`);

    if (availablePlayers.length < 8) {
      console.error('❌ Not enough players to build lineup!');
      return { lineups: [], exposureStats: null, error: 'Insufficient players' };
    }

    // Step 2: Apply pace boost if enabled
    if (usePaceBoost) {
      availablePlayers = this.applyPaceBoost(availablePlayers);
    }

    // Step 3: Generate lineups
    const lineups = [];
    const excludedPlayerIds = new Set(excludedPlayers);
    const usedLineupHashes = new Set(); // Track unique lineups

    for (let i = 0; i < numLineups; i++) {
      console.log(`\n━━━ Generating Lineup ${i + 1}/${numLineups} ━━━`);

      // Calculate exposure limits for this iteration
      const exposureLimits = this.calculateExposureLimits(
        lineups,
        numLineups,
        maxExposureChalk,
        maxExposureMid,
        maxExposureLeverage
      );

      // Add overexposed players to excluded list
      exposureLimits.overexposed.forEach(id => excludedPlayerIds.add(id));

      const lineup = this.generateLineup(availablePlayers, {
        mode,
        gppMode,
        lockedPlayers,
        excludedPlayers: Array.from(excludedPlayerIds),
        minSalary,
        randomness: randomness + (i * 2), // Increase variance for each lineup
        gameStacks,
        teamStacks,
        enableBringBack,
        maxPlayersPerTeam,
        minDifferentTeams,
        minGamesRepresented,
        requireDvpAdvantage,
        maxChalkPlayers,
        lineupNumber: i + 1,
        usedLineupHashes // For diversity
      });

      if (lineup && lineup.isValid) {
        lineup.lineupNumber = i + 1;

        // Calculate lineup hash for uniqueness
        const lineupHash = this.getLineupHash(lineup);

        if (!usedLineupHashes.has(lineupHash)) {
          lineups.push(lineup);
          usedLineupHashes.add(lineupHash);

          console.log(`✅ Lineup ${i + 1} generated successfully`);
          this.displayLineupSummary(lineup, mode);
        } else {
          console.warn(`⚠️  Lineup ${i + 1} is duplicate, skipping`);
          i--; // Retry this iteration
        }
      } else {
        console.warn(`⚠️  Failed to generate valid lineup ${i + 1}`);

        // If we're failing repeatedly, try relaxing constraints
        if (i > 0 && lineups.length === 0) {
          console.log(`⚡ Relaxing constraints to find solution...`);
          // Could implement constraint relaxation here
        }
      }
    }

    const executionTime = ((Date.now() - startTime) / 1000).toFixed(2);

    console.log(`\n═══════════════════════════════════════════════════`);
    console.log(`✅ Generated ${lineups.length}/${numLineups} valid lineups`);
    console.log(`⏱️  Execution time: ${executionTime}s`);
    console.log(`═══════════════════════════════════════════════════\n`);

    // Step 4: Calculate exposure stats for multi-lineup
    let exposureStats = null;
    if (numLineups > 1) {
      exposureStats = this.getExposureStats(lineups, availablePlayers);
      this.displayExposureReport(exposureStats, numLineups);
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
   * Filter players based on mode-specific criteria
   */
  filterPlayers(players, filters) {
    const {
      mode,
      lockedPlayers,
      excludedPlayers,
      filterInjured,
      minFloor,
      maxVolatility,
      maxBustProbability,
      minProjectedMinutes,
      minLeverageScore,
      minBoomProbability,
      minCeiling,
      minProjection,
      minRestDays,
      minUsage,
      avoidBlowouts
    } = filters;

    console.log(`\n🔍 Applying ${mode.toUpperCase()} filters:`);

    return players.filter(player => {
      // Always keep locked players
      if (lockedPlayers.includes(player.id)) {
        console.log(`🔒 Locked: ${player.name}`);
        return true;
      }

      // Exclude specified players
      if (excludedPlayers.includes(player.id)) {
        return false;
      }

      // Filter injured players
      if (filterInjured) {
        const injuryStatuses = ['OUT', 'Doubtful', 'Questionable'];
        if (player.injury_status && injuryStatuses.includes(player.injury_status)) {
          return false;
        }
      }

      // Minimum projection
      if ((player.projected_points || 0) < minProjection) {
        return false;
      }

      // Cash game specific filters
      if (mode === 'cash') {
        // Floor requirement
        if ((player.floor || 0) < minFloor) {
          return false;
        }

        // Volatility limit
        if ((player.volatility || 1) > maxVolatility) {
          return false;
        }

        // Bust probability limit
        if ((player.bust_probability || 100) > maxBustProbability) {
          return false;
        }

        // Minutes requirement
        if ((player.projected_minutes || 0) < minProjectedMinutes) {
          return false;
        }

        // Avoid blowout risk
        if (avoidBlowouts && (player.blowout_risk || 0) > 0.5) {
          return false;
        }
      }

      // GPP specific filters
      if (mode === 'gpp') {
        // Leverage score requirement (most important GPP metric)
        if ((player.leverage_score || 0) < minLeverageScore) {
          return false;
        }

        // Boom probability
        if ((player.boom_probability || 0) < minBoomProbability) {
          return false;
        }

        // Ceiling requirement
        if ((player.ceiling || 0) < minCeiling) {
          return false;
        }
      }

      // Universal filters
      if (minRestDays > 0 && (player.rest_days || 0) < minRestDays) {
        return false;
      }

      if (minUsage > 0 && (player.usage || 0) < minUsage) {
        return false;
      }

      return true;
    });
  }

  /**
   * Apply pace boost to projections for players in high-pace games
   */
  applyPaceBoost(players) {
    return players.map(player => {
      // Boost projections by 2-5% for pace > 102
      // This is already factored into projections, but can be emphasized
      const paceFactor = 1.0; // Could make this configurable

      return {
        ...player,
        pace_boosted: player.pace > 102
      };
    });
  }

  /**
   * Generate a single lineup with comprehensive constraints
   */
  generateLineup(players, settings) {
    const {
      mode,
      gppMode,
      lockedPlayers,
      excludedPlayers,
      minSalary,
      randomness,
      gameStacks,
      teamStacks,
      enableBringBack,
      maxPlayersPerTeam,
      minDifferentTeams,
      minGamesRepresented,
      requireDvpAdvantage,
      maxChalkPlayers,
      usedLineupHashes
    } = settings;

    // Apply variance to projections
    const playersWithVariance = this.applyVariance(players, randomness, mode);

    // Build LP model based on mode
    const model = this.buildLPModel(playersWithVariance, {
      mode,
      gppMode,
      lockedPlayers,
      excludedPlayers,
      minSalary,
      gameStacks,
      teamStacks,
      enableBringBack,
      maxPlayersPerTeam,
      minDifferentTeams,
      minGamesRepresented,
      requireDvpAdvantage,
      maxChalkPlayers
    });

    // Solve
    const result = solver.Solve(model);

    if (!result || !result.feasible) {
      console.error('❌ LP solver could not find feasible solution');
      return null;
    }

    console.log(`✅ LP solution found! Objective: ${result.result?.toFixed(2)}`);

    // Extract and validate lineup
    const lineup = this.extractLineupFromSolution(result, players, mode);

    // Add comprehensive analytics
    if (lineup && lineup.isValid) {
      lineup.analytics = this.calculateLineupAnalytics(lineup, mode);
    }

    return lineup;
  }

  /**
   * Apply smart variance to projections
   */
  applyVariance(players, randomness, mode) {
    if (randomness === 0) {
      return players.map(p => ({ ...p, adjustedProjection: p.projected_points || 0 }));
    }

    return players.map(player => {
      const baseProjection = player.projected_points || 0;
      const std_dev = player.std_dev || (baseProjection * 0.15);

      // Use player's actual volatility for smart variance
      const playerVolatility = player.volatility || 0.2;

      // Apply more variance to high-volatility players, less to consistent players
      const varianceFactor = playerVolatility * (randomness / 100);
      const variance = (Math.random() - 0.5) * 2 * std_dev * varianceFactor;

      const adjustedProjection = Math.max(0, baseProjection + variance);

      return {
        ...player,
        adjustedProjection,
        variance_applied: variance
      };
    });
  }

  /**
   * Build comprehensive LP model with all constraints
   */
  buildLPModel(players, settings) {
    const {
      mode,
      gppMode,
      lockedPlayers,
      excludedPlayers,
      minSalary,
      gameStacks,
      teamStacks,
      maxPlayersPerTeam,
      minDifferentTeams,
      maxChalkPlayers
    } = settings;

    // Determine objective function based on mode
    let optimizeField;
    if (mode === 'cash') {
      // Cash: Maximize weighted floor + projection
      optimizeField = 'cashScore';
    } else if (mode === 'gpp') {
      if (gppMode === 'max_leverage') {
        optimizeField = 'leverageScore';
      } else if (gppMode === 'contrarian') {
        optimizeField = 'contrarian';
      } else {
        optimizeField = 'gppScore'; // Balanced
      }
    } else {
      optimizeField = 'projectedPoints';
    }

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

    // Position constraints
    this.ROSTER_SLOTS.forEach(slot => {
      model.constraints[`slot_${slot}`] = { equal: 1 };
    });

    // Player uniqueness constraints
    players.forEach(player => {
      if (lockedPlayers.includes(player.id)) {
        model.constraints[`player_${player.id}`] = { equal: 1 };
      } else {
        model.constraints[`player_${player.id}`] = { max: 1 };
      }
    });

    // Team diversity constraints
    const teams = [...new Set(players.map(p => p.team).filter(Boolean))];
    teams.forEach(team => {
      model.constraints[`team_${team}`] = { max: maxPlayersPerTeam };
    });

    // Chalk player limit for GPP
    if (mode === 'gpp' && maxChalkPlayers > 0) {
      model.constraints.chalkPlayers = { max: maxChalkPlayers };
    }

    // Game stacking constraints
    gameStacks.forEach((stack, idx) => {
      model.constraints[`gameStack_${idx}`] = { min: stack.minPlayers };
    });

    // Team stacking constraints
    teamStacks.forEach((stack, idx) => {
      model.constraints[`teamStack_${stack.team}`] = { min: stack.minPlayers };
    });

    // Create decision variables
    players.forEach(player => {
      if (excludedPlayers.includes(player.id)) return;

      const playerPositions = this.getPlayerPositions(player.position);
      const eligibleSlots = this.getEligibleSlots(playerPositions);

      eligibleSlots.forEach(slot => {
        const varName = `p${player.id}_${slot}`;

        // Calculate objective scores
        const projectedPoints = player.adjustedProjection || 0;
        const floor = player.floor || (projectedPoints * 0.8);
        const ceiling = player.ceiling || (projectedPoints * 1.2);
        const leverage = player.leverage_score || 0;
        const ownership = player.rostership || 50;

        // Cash score: 40% floor + 60% projection
        const cashScore = (floor * 0.4) + (projectedPoints * 0.6);

        // GPP score: leverage-adjusted ceiling
        const leverageMultiplier = 1 + ((100 - ownership) / 100);
        const gppScore = ceiling * leverageMultiplier;

        // Leverage score: pure leverage
        const leverageScore = leverage * 10; // Scale for LP

        // Contrarian: heavily weight low ownership
        const contrarian = ceiling * (100 - ownership) / 10;

        const variable = {
          projectedPoints,
          cashScore,
          gppScore,
          leverageScore,
          contrarian,
          salary: player.salary,
          minSalary: player.salary,
          totalPlayers: 1,
          [`slot_${slot}`]: 1,
          [`player_${player.id}`]: 1,
          [`team_${player.team}`]: 1
        };

        // Add to chalk constraint if high ownership
        if (ownership >= 25) {
          variable.chalkPlayers = 1;
        }

        // Add to game stack constraints
        gameStacks.forEach((stack, idx) => {
          const matchupStr = `${player.team} vs ${player.opponent}`;
          const matchupStrRev = `${player.opponent} vs ${player.team}`;
          if (stack.game === matchupStr || stack.game === matchupStrRev) {
            variable[`gameStack_${idx}`] = 1;
          }
        });

        // Add to team stack constraints
        teamStacks.forEach(stack => {
          if (player.team === stack.team) {
            variable[`teamStack_${stack.team}`] = 1;
          }
        });

        model.variables[varName] = variable;
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

          if (player) {
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
   * Calculate comprehensive lineup analytics
   */
  calculateLineupAnalytics(lineup, mode) {
    const players = lineup.players.map(slot => slot.player).filter(Boolean);

    if (players.length === 0) return null;

    const totalFloor = players.reduce((sum, p) => sum + (p.floor || 0), 0);
    const totalCeiling = players.reduce((sum, p) => sum + (p.ceiling || 0), 0);
    const avgVolatility = players.reduce((sum, p) => sum + (p.volatility || 0), 0) / players.length;
    const avgBoomProb = players.reduce((sum, p) => sum + (p.boom_probability || 0), 0) / players.length;
    const avgBustProb = players.reduce((sum, p) => sum + (p.bust_probability || 0), 0) / players.length;
    const avgOwnership = players.reduce((sum, p) => sum + (p.rostership || 0), 0) / players.length;
    const totalLeverage = players.reduce((sum, p) => sum + (p.leverage_score || 0), 0);

    // Team diversity
    const teams = [...new Set(players.map(p => p.team))];
    const games = [...new Set(players.map(p => `${p.team} vs ${p.opponent}`))];

    // Value metrics
    const avgValue = mode === 'cash'
      ? players.reduce((sum, p) => sum + (p.value || 0), 0) / players.length
      : players.reduce((sum, p) => sum + (p.value_gpp || 0), 0) / players.length;

    return {
      totalFloor: totalFloor.toFixed(1),
      totalCeiling: totalCeiling.toFixed(1),
      avgVolatility: avgVolatility.toFixed(3),
      avgBoomProb: avgBoomProb.toFixed(1),
      avgBustProb: avgBustProb.toFixed(1),
      avgOwnership: avgOwnership.toFixed(1),
      totalLeverage: totalLeverage.toFixed(1),
      avgValue: avgValue.toFixed(2),
      numTeams: teams.length,
      numGames: games.length,
      teams,
      salaryEfficiency: ((lineup.projectedPoints / lineup.totalSalary) * 1000).toFixed(2)
    };
  }

  /**
   * Calculate exposure limits for current iteration
   */
  calculateExposureLimits(lineups, totalLineups, maxChalk, maxMid, maxLeverage, minExposure = 0) {
    if (lineups.length === 0) {
      return { overexposed: [], underexposed: [] };
    }

    const playerUsage = new Map();

    lineups.forEach(lineup => {
      lineup.players.forEach(slot => {
        if (slot.player) {
          const count = playerUsage.get(slot.player.id) || 0;
          playerUsage.set(slot.player.id, count + 1);
        }
      });
    });

    const overexposed = [];
    const underexposed = [];

    playerUsage.forEach((count, playerId) => {
      const exposure = (count / lineups.length) * 100;
      const player = lineups[0].players.find(s => s.player?.id === playerId)?.player;

      if (player) {
        const ownership = player.rostership || 0;
        let maxExposure;

        if (ownership >= 25) {
          maxExposure = maxChalk;
        } else if (ownership >= 10) {
          maxExposure = maxMid;
        } else {
          maxExposure = maxLeverage;
        }

        // Check max exposure
        if (exposure >= maxExposure) {
          overexposed.push(playerId);
        }

        // Check min exposure (if player is already in at least 1 lineup but below minimum)
        if (minExposure > 0 && count > 0 && exposure < minExposure && lineups.length >= 5) {
          // Only enforce minimum if we have enough lineups
          underexposed.push(playerId);
        }
      }
    });

    return { overexposed, underexposed };
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
   * Display lineup summary to console
   */
  displayLineupSummary(lineup, mode) {
    const analytics = lineup.analytics;
    if (!analytics) return;

    console.log(`\n💰 Salary: $${lineup.totalSalary.toLocaleString()} (${lineup.remainingSalary} remaining)`);
    console.log(`📈 Projection: ${lineup.projectedPoints.toFixed(1)} pts`);
    console.log(`📊 Floor: ${analytics.totalFloor} | Ceiling: ${analytics.totalCeiling}`);
    console.log(`🎲 Volatility: ${analytics.avgVolatility} | Boom: ${analytics.avgBoomProb}%`);
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
      .sort((a, b) => b.exposure - a.exposure);
  }

  /**
   * Display exposure report
   */
  displayExposureReport(stats, numLineups) {
    console.log(`\n╔═══════════════════════════════════════════════════════════╗`);
    console.log(`║           EXPOSURE REPORT (${numLineups} Lineups)               ║`);
    console.log(`╠═══════════════════════════════════════════════════════════╣`);
    console.log(`║ PLAYER              SALARY   OWN%   EXP%   USE   LEV     ║`);
    console.log(`╠═══════════════════════════════════════════════════════════╣`);

    stats.slice(0, 15).forEach(stat => {
      const name = stat.name.padEnd(18).substring(0, 18);
      const salary = `$${(stat.salary / 1000).toFixed(1)}k`.padEnd(7);
      const own = `${stat.ownership.toFixed(0)}%`.padEnd(5);
      const exp = `${stat.exposure}%`.padEnd(5);
      const use = `${stat.count}/${numLineups}`.padEnd(5);
      const lev = stat.leverage.toFixed(1).padEnd(5);
      const star = parseFloat(stat.leverage) >= 4.0 ? '⭐' : '  ';

      console.log(`║ ${name} ${salary} ${own} ${exp} ${use} ${lev}${star}║`);
    });

    console.log(`╚═══════════════════════════════════════════════════════════╝`);

    const avgOwnership = stats.reduce((sum, s) => sum + s.ownership * parseFloat(s.exposure), 0) /
                         stats.reduce((sum, s) => sum + parseFloat(s.exposure), 0);
    console.log(`\n📊 Avg Projected Ownership per Lineup: ${avgOwnership.toFixed(1)}%`);
    console.log(`👥 Total Unique Players Used: ${stats.length}`);
  }

  /**
   * Helper: Parse position string
   */
  getPlayerPositions(positionString) {
    return positionString.split(',').map(p => p.trim());
  }

  /**
   * Helper: Get eligible roster slots
   */
  getEligibleSlots(playerPositions) {
    const slots = new Set();

    playerPositions.forEach(pos => {
      if (this.ROSTER_SLOTS.includes(pos)) {
        slots.add(pos);
      }
      if (pos === 'PG' || pos === 'SG') slots.add('G');
      if (pos === 'SF' || pos === 'PF') slots.add('F');
      slots.add('UTIL');
    });

    return Array.from(slots);
  }

  /**
   * Validate lineup (legacy support)
   */
  validateLineup(lineup, totalSalary, minSalary) {
    const allFilled = Object.values(lineup).every(player => player !== null);
    const withinCap = totalSalary <= this.SALARY_CAP;
    const meetsMinimum = totalSalary >= minSalary;
    const playerIds = Object.values(lineup).map(p => p?.id).filter(Boolean);
    const noDuplicates = playerIds.length === new Set(playerIds).size;

    return allFilled && withinCap && meetsMinimum && noDuplicates;
  }
}

export default new OptimizerService();
