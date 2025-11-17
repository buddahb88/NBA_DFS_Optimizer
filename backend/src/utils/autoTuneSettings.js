/**
 * AUTO-TUNE OPTIMIZER SETTINGS
 * Analyzes the current player pool and recommends optimal filter settings
 * to maximize lineup generation success while maintaining quality
 */

/**
 * Analyze player pool and generate optimal settings
 * @param {Array} players - Array of player objects
 * @param {String} mode - 'cash' or 'gpp'
 * @returns {Object} Recommended settings with explanations
 */
export function autoTuneSettings(players, mode = 'gpp') {
  // Filter to healthy players only
  const healthyPlayers = players.filter(p =>
    !p.injury_status || !['OUT', 'Doubtful', 'Questionable'].includes(p.injury_status)
  );

  if (healthyPlayers.length < 20) {
    return {
      error: 'Not enough healthy players to analyze',
      playersAvailable: healthyPlayers.length
    };
  }

  // Calculate distribution statistics
  const stats = calculateDistributions(healthyPlayers);

  // Generate recommendations based on mode
  const recommendations = mode === 'cash'
    ? generateCashRecommendations(stats, healthyPlayers)
    : generateGPPRecommendations(stats, healthyPlayers);

  return {
    mode,
    totalPlayers: healthyPlayers.length,
    stats,
    recommendations,
    explanation: generateExplanation(mode, stats, recommendations),
    timestamp: new Date().toISOString()
  };
}

/**
 * Calculate statistical distributions for all metrics
 */
function calculateDistributions(players) {
  const metrics = {
    leverage_score: players.map(p => p.leverage_score || 0).filter(v => v > 0),
    boom_probability: players.map(p => p.boom_probability || 0),
    bust_probability: players.map(p => p.bust_probability || 0),
    ceiling: players.map(p => p.ceiling || 0),
    floor: players.map(p => p.floor || 0),
    volatility: players.map(p => p.volatility || 0),
    projected_points: players.map(p => p.projected_points || 0),
    projected_minutes: players.map(p => p.projected_minutes || 0),
    rostership: players.map(p => p.rostership || 0),
    usage: players.map(p => p.usage || 0),
    value: players.map(p => p.value || 0),
    value_gpp: players.map(p => p.value_gpp || 0)
  };

  const stats = {};
  for (const [key, values] of Object.entries(metrics)) {
    stats[key] = {
      min: Math.min(...values),
      max: Math.max(...values),
      avg: values.reduce((a, b) => a + b, 0) / values.length,
      median: getPercentile(values, 50),
      p25: getPercentile(values, 25),
      p75: getPercentile(values, 75),
      p90: getPercentile(values, 90),
      count: values.filter(v => v > 0).length
    };
  }

  return stats;
}

/**
 * Calculate percentile value
 */
function getPercentile(arr, percentile) {
  const sorted = [...arr].sort((a, b) => a - b);
  const index = Math.floor((percentile / 100) * sorted.length);
  return sorted[index] || 0;
}

/**
 * Generate Cash Game recommendations
 */
function generateCashRecommendations(stats, players) {
  // Cash games: Want high floor, low volatility, low bust risk
  // Target: Keep top 50-60% of players by floor

  // Advanced filters - be intelligent about usage/rest
  const avgUsage = stats.usage.avg;
  const minUsage = avgUsage > 22 ? Math.max(18, stats.usage.p25) : 0;

  return {
    minFloor: Math.max(15, stats.floor.p25), // 25th percentile floor
    maxVolatility: Math.min(0.30, stats.volatility.p75), // 75th percentile (allow some variance)
    maxBustProbability: Math.min(40, stats.bust_probability.p75), // 75th percentile
    minProjectedMinutes: Math.max(20, stats.projected_minutes.p25), // 25th percentile minutes
    minProjection: Math.max(15, stats.projected_points.p25), // 25th percentile projection
    minSalary: 48000, // Leave room for value
    avoidBlowouts: true,
    requireHighVegas: false, // Optional - can enable for safer plays

    // Advanced filters
    minUsage: minUsage, // Target primary options
    minRestDays: 0, // Don't filter by rest in cash
    requireDvpAdvantage: false,
    usePaceBoost: true,

    // Expected pass rate
    estimatedPlayersPass: estimatePassRate(players, {
      minFloor: Math.max(15, stats.floor.p25),
      maxVolatility: Math.min(0.30, stats.volatility.p75),
      maxBustProbability: Math.min(40, stats.bust_probability.p75),
      minProjectedMinutes: Math.max(20, stats.projected_minutes.p25),
      minProjection: Math.max(15, stats.projected_points.p25)
    }, 'cash')
  };
}

/**
 * Generate GPP recommendations
 */
function generateGPPRecommendations(stats, players) {
  // GPP: Want high ceiling, high boom, low ownership
  // Be more lenient to allow diverse player pool

  // Adaptive leverage threshold based on distribution
  let minLeverageScore = 1.0; // Default floor
  if (stats.leverage_score.count > 50) {
    // If we have lots of leverage data, use 40th percentile
    minLeverageScore = Math.max(1.0, stats.leverage_score.p25);
  } else if (stats.leverage_score.count > 20) {
    // If medium data, use 25th percentile
    minLeverageScore = Math.max(0.5, getPercentile(
      players.map(p => p.leverage_score || 0).filter(v => v > 0),
      25
    ));
  }

  // Adaptive ceiling - use 30th percentile or 25 pts minimum
  const minCeiling = Math.max(25, stats.ceiling.p25);

  // Boom probability - be lenient, many players may have 0
  const boomValues = players.map(p => p.boom_probability || 0).filter(v => v > 0);
  const minBoomProbability = boomValues.length > 20
    ? Math.max(0, getPercentile(boomValues, 20))
    : 0;

  // Advanced filters - GPP is more flexible
  const minUsage = 0; // Don't filter by usage in GPP - want contrarian plays
  const minRestDays = 0; // Don't filter by rest

  return {
    minLeverageScore,
    minBoomProbability,
    minCeiling,
    minProjection: Math.max(12, stats.projected_points.p25 - 5), // Lower than cash
    maxChalkPlayers: 3, // Allow some chalk
    randomness: 15, // Moderate randomness

    // Exposure settings
    maxExposureChalk: 30,
    maxExposureMid: 50,
    maxExposureLeverage: 70,
    minExposure: 0, // Default: no minimum exposure

    // Advanced filters
    minSalary: 46000, // More room for value plays
    minUsage: minUsage, // Flexible for GPP
    minRestDays: minRestDays, // No rest requirement
    requireDvpAdvantage: false,
    usePaceBoost: true,

    // Stacking (can be customized by user)
    gameStacks: [],
    teamStacks: [],
    maxPlayersPerTeam: 3,
    minDifferentTeams: 6,
    minGamesRepresented: 3,

    // GPP Strategy
    gppMode: stats.leverage_score.count > 30 ? 'max_leverage' : 'balanced',

    // Expected pass rate
    estimatedPlayersPass: estimatePassRate(players, {
      minLeverageScore,
      minBoomProbability,
      minCeiling,
      minProjection: Math.max(12, stats.projected_points.p25 - 5)
    }, 'gpp')
  };
}

/**
 * Estimate how many players will pass the filters
 */
function estimatePassRate(players, filters, mode) {
  const passing = players.filter(p => {
    if (!p.projected_points || p.projected_points < (filters.minProjection || 0)) return false;

    if (mode === 'cash') {
      if ((p.floor || 0) < (filters.minFloor || 0)) return false;
      if ((p.volatility || 1) > (filters.maxVolatility || 1)) return false;
      if ((p.bust_probability || 100) > (filters.maxBustProbability || 100)) return false;
      if ((p.projected_minutes || 0) < (filters.minProjectedMinutes || 0)) return false;
    } else {
      if ((p.leverage_score || 0) < (filters.minLeverageScore || 0)) return false;
      if ((p.boom_probability || 0) < (filters.minBoomProbability || 0)) return false;
      if ((p.ceiling || 0) < (filters.minCeiling || 0)) return false;
    }

    return true;
  });

  return passing.length;
}

/**
 * Generate human-readable explanation
 */
function generateExplanation(mode, stats, recommendations) {
  const passRate = recommendations.estimatedPlayersPass;
  const total = stats.projected_points.count;
  const percentage = ((passRate / total) * 100).toFixed(0);

  let explanation = `🤖 **AUTO-TUNE ANALYSIS** (${mode.toUpperCase()} MODE)\n\n`;

  if (mode === 'cash') {
    explanation += `**Strategy**: Maximize floor and consistency\n`;
    explanation += `**Target**: Keep ${percentage}% of players (${passRate}/${total})\n\n`;
    explanation += `**Settings Adjusted**:\n`;
    explanation += `• Min Floor: ${recommendations.minFloor.toFixed(1)} (25th percentile)\n`;
    explanation += `• Max Volatility: ${recommendations.maxVolatility.toFixed(2)} (controlled variance)\n`;
    explanation += `• Max Bust%: ${recommendations.maxBustProbability.toFixed(0)}% (minimize downside)\n`;
    explanation += `• Min Minutes: ${recommendations.minProjectedMinutes.toFixed(0)} (starters priority)\n\n`;

    if (passRate < 20) {
      explanation += `⚠️ **WARNING**: Only ${passRate} players pass filters. Consider relaxing constraints.\n`;
    } else if (passRate > 80) {
      explanation += `💡 **TIP**: ${passRate} players qualify - filters may be too loose. Increase for safety.\n`;
    } else {
      explanation += `✅ **OPTIMAL**: ${passRate} players qualify - good balance for lineup generation!\n`;
    }
  } else {
    explanation += `**Strategy**: Maximize leverage and upside\n`;
    explanation += `**Target**: Keep ${percentage}% of players (${passRate}/${total})\n\n`;
    explanation += `**Settings Adjusted**:\n`;
    explanation += `• Min Leverage: ${recommendations.minLeverageScore.toFixed(1)} (low-owned upside)\n`;
    explanation += `• Min Boom%: ${recommendations.minBoomProbability.toFixed(0)}% (ceiling potential)\n`;
    explanation += `• Min Ceiling: ${recommendations.minCeiling.toFixed(0)} pts (tournament upside)\n`;
    explanation += `• Strategy: ${recommendations.gppMode.replace('_', ' ').toUpperCase()}\n\n`;

    if (passRate < 15) {
      explanation += `⚠️ **WARNING**: Only ${passRate} players pass. Filters too strict - relaxing...\n`;
    } else if (passRate > 100) {
      explanation += `💡 **TIP**: ${passRate} players qualify - consider tightening for more leverage.\n`;
    } else {
      explanation += `✅ **OPTIMAL**: ${passRate} players qualify - excellent GPP diversity!\n`;
    }
  }

  return explanation;
}

export default { autoTuneSettings };
