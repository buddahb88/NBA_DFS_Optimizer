/**
 * AI AUTO-TUNE OPTIMIZER SETTINGS
 * Uses AI to analyze the slate and provide strategic recommendations
 */

import aiChatService from '../services/aiChatService.js';

/**
 * Analyze player pool with AI and generate strategic recommendations
 * @param {Array} players - Array of player objects
 * @param {String} mode - 'cash' or 'gpp'
 * @returns {Object} AI-generated recommendations
 */
export async function autoTuneSettings(players, mode = 'gpp') {
  // Filter to players with projections
  const activePlayers = players.filter(p =>
    p.projected_points > 0 && p.projected_minutes > 0
  );

  if (activePlayers.length < 20) {
    return {
      error: 'Not enough active players to analyze',
      playersAvailable: activePlayers.length
    };
  }

  // Calculate quick stats for the slate
  const stats = calculateSlateStats(activePlayers);

  // Build player summary tables for AI
  const playerSummary = buildPlayerSummary(activePlayers, mode);

  // Generate AI analysis
  const aiAnalysis = await generateAIAnalysis(playerSummary, stats, mode);

  // Generate simple settings (since optimizer is now simplified)
  const settings = generateSimpleSettings(stats, mode);

  return {
    mode,
    totalPlayers: activePlayers.length,
    stats,
    settings,
    aiAnalysis,
    timestamp: new Date().toISOString()
  };
}

/**
 * Calculate slate statistics
 */
function calculateSlateStats(players) {
  const projections = players.map(p => p.projected_points);
  const salaries = players.map(p => p.salary);
  const ownerships = players.map(p => p.rostership || 0);
  const ceilings = players.map(p => p.ceiling || 0);
  const leverages = players.map(p => p.leverage_score || 0).filter(v => v > 0);

  return {
    playerCount: players.length,
    projection: {
      min: Math.min(...projections),
      max: Math.max(...projections),
      avg: (projections.reduce((a, b) => a + b, 0) / projections.length).toFixed(1)
    },
    salary: {
      min: Math.min(...salaries),
      max: Math.max(...salaries),
      avg: Math.round(salaries.reduce((a, b) => a + b, 0) / salaries.length)
    },
    ownership: {
      avgOwnership: (ownerships.reduce((a, b) => a + b, 0) / ownerships.length).toFixed(1),
      highOwned: players.filter(p => (p.rostership || 0) >= 20).length,
      lowOwned: players.filter(p => (p.rostership || 0) < 5).length
    },
    ceiling: {
      avg: (ceilings.reduce((a, b) => a + b, 0) / ceilings.length).toFixed(1),
      elite: players.filter(p => (p.ceiling || 0) >= 50).length
    },
    leverage: {
      count: leverages.length,
      avg: leverages.length > 0 ? (leverages.reduce((a, b) => a + b, 0) / leverages.length).toFixed(1) : 0,
      elite: players.filter(p => (p.leverage_score || 0) >= 10).length
    },
    positions: countPositions(players),
    teams: [...new Set(players.map(p => p.team))].length,
    games: [...new Set(players.map(p => `${p.team} vs ${p.opponent}`))].length
  };
}

/**
 * Count players by position
 */
function countPositions(players) {
  const counts = { PG: 0, SG: 0, SF: 0, PF: 0, C: 0 };
  players.forEach(p => {
    const pos = (p.position || '').split(',')[0].trim();
    if (counts[pos] !== undefined) counts[pos]++;
  });
  return counts;
}

/**
 * Build player summary for AI analysis
 */
function buildPlayerSummary(players, mode) {
  // Sort by relevant metric
  const sorted = [...players].sort((a, b) => {
    if (mode === 'cash') {
      return (b.floor || 0) - (a.floor || 0);
    } else {
      return (b.leverage_score || 0) - (a.leverage_score || 0);
    }
  });

  // Top 15 players for the mode
  const topPlayers = sorted.slice(0, 15);

  // Build table
  let table = `| Player | Pos | Team | Opp | Salary | Proj | Floor | Ceil | Own% | Lev |\n`;
  table += `|--------|-----|------|-----|--------|------|-------|------|------|-----|\n`;

  topPlayers.forEach(p => {
    table += `| ${(p.name || '').substring(0, 18)} | ${(p.position || '').split(',')[0]} | ${p.team || ''} | ${p.opponent || ''} | $${((p.salary || 0) / 1000).toFixed(1)}k | ${(p.projected_points || 0).toFixed(1)} | ${(p.floor || 0).toFixed(1)} | ${(p.ceiling || 0).toFixed(1)} | ${(p.rostership || 0).toFixed(0)}% | ${(p.leverage_score || 0).toFixed(1)} |\n`;
  });

  // Value plays (best projection per $1k)
  const valueSort = [...players].sort((a, b) => {
    const valA = (a.projected_points || 0) / ((a.salary || 10000) / 1000);
    const valB = (b.projected_points || 0) / ((b.salary || 10000) / 1000);
    return valB - valA;
  });

  table += `\n**Top Value Plays:**\n`;
  table += `| Player | Salary | Proj | Value | Own% |\n`;
  table += `|--------|--------|------|-------|------|\n`;

  valueSort.slice(0, 10).forEach(p => {
    const val = (p.projected_points || 0) / ((p.salary || 10000) / 1000);
    table += `| ${(p.name || '').substring(0, 18)} | $${((p.salary || 0) / 1000).toFixed(1)}k | ${(p.projected_points || 0).toFixed(1)} | ${val.toFixed(2)} | ${(p.rostership || 0).toFixed(0)}% |\n`;
  });

  return table;
}

/**
 * Generate AI analysis of the slate
 */
async function generateAIAnalysis(playerSummary, stats, mode) {
  const prompt = `You are an expert NBA DFS analyst. Analyze this ${mode.toUpperCase()} slate and provide strategic recommendations.

**Slate Overview:**
- ${stats.playerCount} players across ${stats.games} games
- Average projection: ${stats.projection.avg} FP
- ${stats.ownership.highOwned} chalk plays (20%+ owned)
- ${stats.ownership.lowOwned} low-owned plays (<5%)
- ${stats.leverage.elite} elite leverage plays

**Player Data:**
${playerSummary}

**Provide a brief strategic analysis covering:**
1. **Slate Texture**: Is this a good ${mode} slate? Why?
2. **Core Plays**: 2-3 must-have players for ${mode}
3. **Leverage Plays**: 2-3 low-owned players with upside
4. **Fades**: 1-2 popular players to avoid and why
5. **Game Stacks**: Any games to target for correlation?
6. **Lineup Construction**: Key strategy tips for this slate

Keep response concise (under 400 words). Use bullet points.`;

  try {
    const response = await aiChatService.chat(prompt, null, []);
    return response.message || 'AI analysis unavailable';
  } catch (error) {
    console.error('AI analysis error:', error);
    return `AI analysis unavailable: ${error.message}`;
  }
}

/**
 * Generate simple settings (optimizer is now simplified)
 */
function generateSimpleSettings(stats, mode) {
  // Since we simplified the optimizer, we only recommend minMinutes and minUsage
  return {
    // The only filters the optimizer now uses
    minMinutes: 0,  // Let user decide - don't auto-filter
    minUsage: 0,    // Let user decide - don't auto-filter

    // Multi-lineup settings
    maxExposure: mode === 'cash' ? 80 : 60,
    randomness: mode === 'cash' ? 5 : 15,
    numLineups: mode === 'cash' ? 1 : 5,

    // Salary
    minSalary: mode === 'cash' ? 49000 : 47000,

    // Explanation
    note: mode === 'cash'
      ? 'Cash games: Optimizer prioritizes floor and consistency automatically'
      : 'GPP: Optimizer prioritizes ceiling, value, and low ownership automatically'
  };
}

export default { autoTuneSettings };
