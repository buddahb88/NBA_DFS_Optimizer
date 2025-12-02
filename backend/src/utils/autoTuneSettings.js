/**
 * AI AUTO-TUNE OPTIMIZER SETTINGS
 * Uses AI to analyze the slate and intelligently set optimizer parameters
 */

import aiChatService from '../services/aiChatService.js';

/**
 * Analyze player pool with AI and generate intelligent optimizer settings
 * @param {Array} players - Array of player objects
 * @param {String} mode - 'cash' or 'gpp'
 * @returns {Object} AI-generated recommendations with actual values
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

  // Calculate comprehensive stats for the slate
  const stats = calculateSlateStats(activePlayers);

  // Build detailed player summary for AI
  const playerSummary = buildPlayerSummary(activePlayers, mode);

  // Get AI to analyze and recommend settings
  const aiResult = await generateAIRecommendations(playerSummary, stats, mode);

  return {
    mode,
    totalPlayers: activePlayers.length,
    stats,
    recommendations: aiResult.settings,
    aiAnalysis: aiResult.analysis,
    timestamp: new Date().toISOString()
  };
}

/**
 * Calculate comprehensive slate statistics
 */
function calculateSlateStats(players) {
  const projections = players.map(p => p.projected_points);
  const salaries = players.map(p => p.salary);
  const ownerships = players.map(p => p.rostership || 0);
  const floors = players.map(p => p.floor || 0);
  const ceilings = players.map(p => p.ceiling || 0);
  const minutes = players.map(p => p.projected_minutes || 0);
  const usages = players.map(p => p.usage || 0);
  const leverages = players.map(p => p.leverage_score || 0);
  const booms = players.map(p => p.boom_probability || 0);
  const busts = players.map(p => p.bust_probability || 0);
  const volatilities = players.map(p => p.volatility || 0);

  const percentile = (arr, p) => {
    const sorted = [...arr].sort((a, b) => a - b);
    const idx = Math.floor(sorted.length * p);
    return sorted[idx];
  };

  return {
    playerCount: players.length,
    projection: {
      min: Math.min(...projections),
      max: Math.max(...projections),
      avg: (projections.reduce((a, b) => a + b, 0) / projections.length).toFixed(1),
      p25: percentile(projections, 0.25).toFixed(1),
      p50: percentile(projections, 0.50).toFixed(1),
      p75: percentile(projections, 0.75).toFixed(1)
    },
    salary: {
      min: Math.min(...salaries),
      max: Math.max(...salaries),
      avg: Math.round(salaries.reduce((a, b) => a + b, 0) / salaries.length)
    },
    floor: {
      min: Math.min(...floors).toFixed(1),
      max: Math.max(...floors).toFixed(1),
      avg: (floors.reduce((a, b) => a + b, 0) / floors.length).toFixed(1),
      p25: percentile(floors, 0.25).toFixed(1),
      p50: percentile(floors, 0.50).toFixed(1)
    },
    ceiling: {
      min: Math.min(...ceilings).toFixed(1),
      max: Math.max(...ceilings).toFixed(1),
      avg: (ceilings.reduce((a, b) => a + b, 0) / ceilings.length).toFixed(1),
      p75: percentile(ceilings, 0.75).toFixed(1),
      p90: percentile(ceilings, 0.90).toFixed(1)
    },
    minutes: {
      min: Math.min(...minutes).toFixed(1),
      max: Math.max(...minutes).toFixed(1),
      avg: (minutes.reduce((a, b) => a + b, 0) / minutes.length).toFixed(1),
      p25: percentile(minutes, 0.25).toFixed(1),
      p50: percentile(minutes, 0.50).toFixed(1)
    },
    usage: {
      min: Math.min(...usages).toFixed(1),
      max: Math.max(...usages).toFixed(1),
      avg: (usages.reduce((a, b) => a + b, 0) / usages.length).toFixed(1),
      p50: percentile(usages, 0.50).toFixed(1)
    },
    ownership: {
      avgOwnership: (ownerships.reduce((a, b) => a + b, 0) / ownerships.length).toFixed(1),
      highOwned: players.filter(p => (p.rostership || 0) >= 20).length,
      lowOwned: players.filter(p => (p.rostership || 0) < 5).length
    },
    leverage: {
      avg: (leverages.reduce((a, b) => a + b, 0) / leverages.length).toFixed(1),
      p50: percentile(leverages, 0.50).toFixed(1),
      p75: percentile(leverages, 0.75).toFixed(1),
      elite: players.filter(p => (p.leverage_score || 0) >= 5).length
    },
    boom: {
      avg: (booms.reduce((a, b) => a + b, 0) / booms.length).toFixed(1),
      p50: percentile(booms, 0.50).toFixed(1),
      p75: percentile(booms, 0.75).toFixed(1)
    },
    bust: {
      avg: (busts.reduce((a, b) => a + b, 0) / busts.length).toFixed(1),
      p50: percentile(busts, 0.50).toFixed(1)
    },
    volatility: {
      avg: (volatilities.reduce((a, b) => a + b, 0) / volatilities.length).toFixed(2),
      p50: percentile(volatilities, 0.50).toFixed(2),
      p75: percentile(volatilities, 0.75).toFixed(2)
    },
    positions: countPositions(players),
    teams: [...new Set(players.map(p => p.team))].length,
    games: Math.ceil([...new Set(players.map(p => p.team))].length / 2)
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
 * Build comprehensive player summary for AI
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

  // Top 20 players
  const topPlayers = sorted.slice(0, 20);

  let table = `| Player | Pos | Team | Opp | Salary | Proj | Floor | Ceil | Own% | Boom% | Bust% | Vol | Lev | Min | Usg% |\n`;
  table += `|--------|-----|------|-----|--------|------|-------|------|------|-------|-------|-----|-----|-----|------|\n`;

  topPlayers.forEach(p => {
    table += `| ${(p.name || '').substring(0, 16)} | ${(p.position || '').split(',')[0]} | ${p.team || ''} | ${p.opponent || ''} | $${((p.salary || 0) / 1000).toFixed(1)}k | ${(p.projected_points || 0).toFixed(1)} | ${(p.floor || 0).toFixed(1)} | ${(p.ceiling || 0).toFixed(1)} | ${(p.rostership || 0).toFixed(0)}% | ${(p.boom_probability || 0).toFixed(0)}% | ${(p.bust_probability || 0).toFixed(0)}% | ${(p.volatility || 0).toFixed(2)} | ${(p.leverage_score || 0).toFixed(1)} | ${(p.projected_minutes || 0).toFixed(0)} | ${(p.usage || 0).toFixed(0)}% |\n`;
  });

  // Value plays
  const valueSort = [...players].sort((a, b) => {
    const valA = (a.projected_points || 0) / ((a.salary || 10000) / 1000);
    const valB = (b.projected_points || 0) / ((b.salary || 10000) / 1000);
    return valB - valA;
  });

  table += `\n**Top Value Plays (Proj per $1k):**\n`;
  table += `| Player | Salary | Proj | Value | Own% | Floor | Ceil |\n`;
  table += `|--------|--------|------|-------|------|-------|------|\n`;

  valueSort.slice(0, 10).forEach(p => {
    const val = (p.projected_points || 0) / ((p.salary || 10000) / 1000);
    table += `| ${(p.name || '').substring(0, 16)} | $${((p.salary || 0) / 1000).toFixed(1)}k | ${(p.projected_points || 0).toFixed(1)} | ${val.toFixed(2)} | ${(p.rostership || 0).toFixed(0)}% | ${(p.floor || 0).toFixed(1)} | ${(p.ceiling || 0).toFixed(1)} |\n`;
  });

  return table;
}

/**
 * Generate AI recommendations with actual settings values
 */
async function generateAIRecommendations(playerSummary, stats, mode) {
  const settingsDescription = mode === 'cash' ? `
**CASH GAME SETTINGS TO SET:**
- minFloor: Minimum floor projection (range: 0-${stats.floor.max}, median: ${stats.floor.p50})
- maxVolatility: Maximum volatility allowed (range: 0-1, median: ${stats.volatility.p50})
- maxBustProbability: Max bust% allowed (range: 0-100, median: ${stats.bust.p50})
- minProjectedMinutes: Min minutes (range: 0-${stats.minutes.max}, median: ${stats.minutes.p50})
- minProjection: Min projected points (range: 0-${stats.projection.max}, p25: ${stats.projection.p25})
- minSalary: Min salary to use cap (range: 45000-50000)
- minUsage: Min usage rate % (range: 0-${stats.usage.max}, median: ${stats.usage.p50})
` : `
**GPP SETTINGS TO SET:**
- minLeverageScore: Min leverage score (range: 0-${stats.leverage.p75}, median: ${stats.leverage.p50})
- minBoomProbability: Min boom% (range: 0-100, median: ${stats.boom.p50})
- minCeiling: Min ceiling projection (range: 0-${stats.ceiling.max}, p75: ${stats.ceiling.p75})
- minProjection: Min projected points (range: 0-${stats.projection.max}, p25: ${stats.projection.p25})
- maxChalkPlayers: Max high-owned players (range: 0-8)
- randomness: Randomness % for diversity (range: 0-30)
- minSalary: Min salary (range: 45000-50000)
- minUsage: Min usage rate % (range: 0-${stats.usage.max}, median: ${stats.usage.p50})
- gppMode: 'balanced', 'ceiling', or 'leverage'
`;

  const prompt = `You are an expert NBA DFS optimizer. Analyze this ${mode.toUpperCase()} slate and provide SPECIFIC optimizer settings.

**SLATE STATISTICS:**
- ${stats.playerCount} players across ${stats.games} games
- Projections: avg ${stats.projection.avg}, range ${stats.projection.min}-${stats.projection.max}
- Floors: avg ${stats.floor.avg}, p25=${stats.floor.p25}, p50=${stats.floor.p50}
- Ceilings: avg ${stats.ceiling.avg}, p75=${stats.ceiling.p75}, p90=${stats.ceiling.p90}
- Minutes: avg ${stats.minutes.avg}, p25=${stats.minutes.p25}, p50=${stats.minutes.p50}
- Usage: avg ${stats.usage.avg}%, p50=${stats.usage.p50}%
- Ownership: ${stats.ownership.highOwned} chalk plays (20%+), ${stats.ownership.lowOwned} low-owned (<5%)
- Leverage: avg ${stats.leverage.avg}, ${stats.leverage.elite} elite plays (5+)
- Boom%: avg ${stats.boom.avg}, p75=${stats.boom.p75}
- Bust%: avg ${stats.bust.avg}
- Volatility: avg ${stats.volatility.avg}

**PLAYER DATA:**
${playerSummary}

${settingsDescription}

**RESPOND WITH THIS EXACT JSON FORMAT (no markdown, just JSON):**
{
  "settings": {
    ${mode === 'cash' ? `"minFloor": <number>,
    "maxVolatility": <number 0-1>,
    "maxBustProbability": <number 0-100>,
    "minProjectedMinutes": <number>,
    "minProjection": <number>,
    "minSalary": <number>,
    "minUsage": <number>,
    "avoidBlowouts": <boolean>` : `"minLeverageScore": <number>,
    "minBoomProbability": <number 0-100>,
    "minCeiling": <number>,
    "minProjection": <number>,
    "maxChalkPlayers": <number 0-8>,
    "randomness": <number 0-30>,
    "minSalary": <number>,
    "minUsage": <number>,
    "gppMode": "<balanced|ceiling|leverage>",
    "maxExposureChalk": <number 0-100>,
    "maxExposureMid": <number 0-100>,
    "maxExposureLeverage": <number 0-100>`}
  },
  "analysis": "<Your strategic analysis: slate texture, core plays, leverage plays, fades, key strategy tips. 200-300 words with bullet points>"
}

Be aggressive with filters to create an optimal player pool. Don't set everything to 0.`;

  try {
    const response = await aiChatService.chat(prompt, null, []);
    const content = response.message || '';

    // Try to parse JSON from response
    try {
      // Extract JSON from response (handle if wrapped in markdown)
      let jsonStr = content;
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        jsonStr = jsonMatch[0];
      }

      const parsed = JSON.parse(jsonStr);
      return {
        settings: parsed.settings || getDefaultSettings(mode),
        analysis: parsed.analysis || 'AI analysis completed.'
      };
    } catch (parseError) {
      console.error('Failed to parse AI JSON response:', parseError);
      console.log('Raw response:', content);
      // Return defaults with the raw analysis
      return {
        settings: getDefaultSettings(mode),
        analysis: content || 'AI analysis unavailable - using default settings.'
      };
    }
  } catch (error) {
    console.error('AI analysis error:', error);
    return {
      settings: getDefaultSettings(mode),
      analysis: `AI analysis unavailable: ${error.message}`
    };
  }
}

/**
 * Get default settings if AI fails
 */
function getDefaultSettings(mode) {
  if (mode === 'cash') {
    return {
      minFloor: 20,
      maxVolatility: 0.25,
      maxBustProbability: 30,
      minProjectedMinutes: 24,
      minProjection: 20,
      minSalary: 49000,
      minUsage: 15,
      avoidBlowouts: true
    };
  } else {
    return {
      minLeverageScore: 1,
      minBoomProbability: 10,
      minCeiling: 35,
      minProjection: 15,
      maxChalkPlayers: 3,
      randomness: 15,
      minSalary: 47000,
      minUsage: 12,
      gppMode: 'balanced',
      maxExposureChalk: 40,
      maxExposureMid: 60,
      maxExposureLeverage: 80
    };
  }
}

/**
 * AI Lineup Review - Analyze a generated lineup
 */
export async function reviewLineup(lineup, players, mode = 'gpp') {
  const stats = calculateSlateStats(players);

  // Extract actual players from slot structure {position, player}
  const lineupPlayers = lineup.players
    .map(slot => slot.player || slot) // Handle both {position, player} and direct player
    .filter(p => p && p.name); // Filter out empty slots

  if (lineupPlayers.length === 0) {
    return {
      success: false,
      review: 'No valid players found in lineup to review.',
      lineupStats: null
    };
  }

  // Build lineup details
  let lineupTable = `| Player | Pos | Salary | Proj | Floor | Ceil | Own% | Lev |\n`;
  lineupTable += `|--------|-----|--------|------|-------|------|------|-----|\n`;

  let totalSalary = 0;
  let totalProj = 0;
  let totalOwn = 0;
  let totalCeiling = 0;
  let totalFloor = 0;

  lineupPlayers.forEach(p => {
    const pos = p.position?.split(',')[0] || 'UTIL';
    lineupTable += `| ${p.name} | ${pos} | $${((p.salary || 0)/1000).toFixed(1)}k | ${(p.projected_points || 0).toFixed(1)} | ${(p.floor || 0).toFixed(1)} | ${(p.ceiling || 0).toFixed(1)} | ${(p.rostership || 0).toFixed(0)}% | ${(p.leverage_score || 0).toFixed(1)} |\n`;
    totalSalary += p.salary || 0;
    totalProj += p.projected_points || 0;
    totalOwn += p.rostership || 0;
    totalCeiling += p.ceiling || 0;
    totalFloor += p.floor || 0;
  });

  const avgOwn = totalOwn / lineupPlayers.length;

  // Build comparison to slate
  const topProjected = [...players].sort((a, b) => b.projected_points - a.projected_points).slice(0, 15);
  const topValue = [...players].sort((a, b) => {
    return (b.projected_points / (b.salary/1000)) - (a.projected_points / (a.salary/1000));
  }).slice(0, 10);

  const prompt = `You are a brutally honest NBA DFS analyst. Review this ${mode.toUpperCase()} lineup and give your honest opinion.

**THE LINEUP:**
${lineupTable}

**Lineup Totals:**
- Salary: $${totalSalary.toLocaleString()} / $50,000
- Projection: ${totalProj.toFixed(1)} pts
- Floor: ${totalFloor.toFixed(1)} | Ceiling: ${totalCeiling.toFixed(1)}
- Avg Ownership: ${avgOwn.toFixed(1)}%

**SLATE CONTEXT:**
- ${stats.playerCount} players, ${stats.games} games
- Top projected: ${topProjected.slice(0, 5).map(p => `${p.name} (${p.projected_points?.toFixed(1)})`).join(', ')}
- Top value: ${topValue.slice(0, 5).map(p => `${p.name} ($${(p.salary/1000).toFixed(1)}k, ${p.projected_points?.toFixed(1)}pts)`).join(', ')}
- Slate avg projection: ${stats.projection.avg}

**BE HONEST AND CRITICAL. Answer:**
1. **Overall Grade**: A-F rating
2. **Strengths**: What's good about this lineup?
3. **Weaknesses**: What's wrong? Missing key plays? Too chalky/contrarian?
4. **Missed Opportunities**: Better players left on the board?
5. **Risk Assessment**: Boom/bust potential?
6. **Final Verdict**: Would you play this lineup? Why/why not?

Be direct. If it's a bad lineup, say so. If great, say so. No sugar-coating.`;

  try {
    const response = await aiChatService.chat(prompt, null, []);
    return {
      success: true,
      review: response.message || 'Review unavailable',
      lineupStats: {
        totalSalary,
        totalProj,
        totalFloor,
        totalCeiling,
        avgOwnership: avgOwn
      }
    };
  } catch (error) {
    console.error('Lineup review error:', error);
    return {
      success: false,
      review: `Review failed: ${error.message}`,
      lineupStats: null
    };
  }
}

export default { autoTuneSettings, reviewLineup };
