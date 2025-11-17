/**
 * SLATE ANALYZER - AI-Powered Slate Breakdown Generator
 * Analyzes the entire player pool and generates strategic recommendations
 */

import aiChatService from '../services/aiChatService.js';

/**
 * Generate comprehensive slate breakdown with AI analysis
 */
export async function generateSlateBreakdown(players, mode = 'gpp') {
  console.log(`🤖 Generating AI slate breakdown for ${players.length} players (${mode} mode)`);

  // Filter healthy players
  const healthyPlayers = players.filter(p =>
    !p.injury_status || !['OUT', 'Doubtful'].includes(p.injury_status)
  );

  // Categorize players by salary tier
  const studs = healthyPlayers.filter(p => p.salary >= 8000).sort((a, b) => b.salary - a.salary);
  const mids = healthyPlayers.filter(p => p.salary >= 5000 && p.salary < 8000).sort((a, b) => b.projected_points - a.projected_points);
  const values = healthyPlayers.filter(p => p.salary < 5000).sort((a, b) => b.value_gpp - a.value_gpp);

  // Calculate slate statistics
  const stats = calculateSlateStats(healthyPlayers);

  // Group players by game for stacking analysis
  const gameGroups = groupPlayersByGame(healthyPlayers);

  // Identify top plays by category
  const topStuds = studs.slice(0, 8);
  const topMids = mids.slice(0, 10);
  const topValues = values.slice(0, 8);

  // Find chalk and leverage plays
  const chalkPlays = healthyPlayers.filter(p => (p.rostership || 0) >= 25).sort((a, b) => b.rostership - a.rostership).slice(0, 5);
  const leveragePlays = healthyPlayers.filter(p => (p.leverage_score || 0) >= 3.0).sort((a, b) => b.leverage_score - a.leverage_score).slice(0, 8);

  // Build AI prompt
  const aiPrompt = buildAnalysisPrompt(mode, stats, topStuds, topMids, topValues, chalkPlays, leveragePlays, gameGroups);

  // Get AI analysis
  let aiAnalysis;
  try {
    const aiResponse = await aiChatService.chat(aiPrompt, null, []);
    aiAnalysis = aiResponse.message || 'AI analysis could not be generated.';
  } catch (error) {
    console.error('AI analysis failed:', error);
    aiAnalysis = 'AI analysis temporarily unavailable. Using statistical breakdown.';
  }

  return {
    mode,
    stats,
    categories: {
      studs: formatPlayerCategory(topStuds, mode),
      mids: formatPlayerCategory(topMids, mode),
      values: formatPlayerCategory(topValues, mode)
    },
    chalkPlays: formatPlayerList(chalkPlays, mode),
    leveragePlays: formatPlayerList(leveragePlays, mode),
    gameStacks: formatGameStacks(gameGroups),
    aiAnalysis,
    generatedAt: new Date().toISOString()
  };
}

/**
 * Calculate slate-level statistics
 */
function calculateSlateStats(players) {
  return {
    totalPlayers: players.length,
    avgProjection: avg(players.map(p => p.projected_points)),
    avgOwnership: avg(players.map(p => p.rostership)),
    avgSalary: avg(players.map(p => p.salary)),
    totalSalary: players.reduce((sum, p) => sum + p.salary, 0),
    studCount: players.filter(p => p.salary >= 8000).length,
    midCount: players.filter(p => p.salary >= 5000 && p.salary < 8000).length,
    valueCount: players.filter(p => p.salary < 5000).length,
    avgCeiling: avg(players.map(p => p.ceiling)),
    avgFloor: avg(players.map(p => p.floor)),
    avgLeverage: avg(players.map(p => p.leverage_score).filter(v => v > 0)),
    highOwnershipCount: players.filter(p => (p.rostership || 0) >= 25).length,
    leveragePlayCount: players.filter(p => (p.leverage_score || 0) >= 3.0).length
  };
}

/**
 * Group players by game for stacking analysis
 */
function groupPlayersByGame(players) {
  const games = new Map();

  players.forEach(p => {
    if (!p.team || !p.opponent) return;

    const gameKey = [p.team, p.opponent].sort().join(' vs ');
    if (!games.has(gameKey)) {
      games.set(gameKey, []);
    }
    games.get(gameKey).push(p);
  });

  return Array.from(games.entries())
    .map(([game, players]) => ({
      game,
      players: players.length,
      avgProjection: avg(players.map(p => p.projected_points)),
      avgOwnership: avg(players.map(p => p.rostership)),
      totalSalary: players.reduce((sum, p) => sum + p.salary, 0),
      topPlayers: players.sort((a, b) => b.projected_points - a.projected_points).slice(0, 5)
    }))
    .sort((a, b) => b.avgProjection - a.avgProjection);
}

/**
 * Build AI analysis prompt with comprehensive player data
 */
function buildAnalysisPrompt(mode, stats, studs, mids, values, chalk, leverage, games) {
  const contestType = mode === 'cash' ? 'CASH GAME (50/50s, Double-Ups)' : 'GPP TOURNAMENT (Large-field contests)';

  // Build comprehensive player data tables
  const studTable = buildPlayerTable(studs, mode);
  const midTable = buildPlayerTable(mids, mode);
  const valueTable = buildPlayerTable(values, mode);
  const chalkTable = buildPlayerTable(chalk, mode);
  const leverageTable = buildPlayerTable(leverage, mode);

  // Build game environment table
  const gameTable = buildGameTable(games);

  let prompt = `You are an elite NBA DFS analyst. Generate a comprehensive slate breakdown for ${contestType}.

Analyze the complete player pool data below and provide strategic recommendations.

═══════════════════════════════════════════════════════════════
📊 SLATE OVERVIEW
═══════════════════════════════════════════════════════════════
Total Players: ${stats.totalPlayers} (${stats.studCount} Studs, ${stats.midCount} Mids, ${stats.valueCount} Values)
Avg Projection: ${stats.avgProjection?.toFixed(1)} pts | Avg Floor: ${stats.avgFloor?.toFixed(1)} | Avg Ceiling: ${stats.avgCeiling?.toFixed(1)}
Avg Ownership: ${stats.avgOwnership?.toFixed(1)}% | Avg Leverage: ${stats.avgLeverage?.toFixed(2)}
High Ownership Plays (>25%): ${stats.highOwnershipCount} | Elite Leverage Plays (>3.0): ${stats.leveragePlayCount}

═══════════════════════════════════════════════════════════════
🏀 GAME ENVIRONMENT DATA
═══════════════════════════════════════════════════════════════
${gameTable}

═══════════════════════════════════════════════════════════════
💎 STUDS TIER ($8,000+) - ${studs.length} Players
═══════════════════════════════════════════════════════════════
${studTable}

═══════════════════════════════════════════════════════════════
🎯 MIDS TIER ($5,000-$7,999) - ${mids.length} Players
═══════════════════════════════════════════════════════════════
${midTable}

═══════════════════════════════════════════════════════════════
💰 VALUE TIER (<$5,000) - ${values.length} Players
═══════════════════════════════════════════════════════════════
${valueTable}

═══════════════════════════════════════════════════════════════
🔥 CHALK PLAYS (Projected Ownership >25%)
═══════════════════════════════════════════════════════════════
${chalk.length > 0 ? chalkTable : 'No high-ownership plays identified on this slate.'}

═══════════════════════════════════════════════════════════════
⚡ ELITE LEVERAGE PLAYS (Leverage Score >3.0)
═══════════════════════════════════════════════════════════════
${leverageTable}

═══════════════════════════════════════════════════════════════
📋 REQUIRED ANALYSIS REPORT
═══════════════════════════════════════════════════════════════

Please provide a comprehensive slate breakdown covering:

**1. 🔒 ABSOLUTE LOCKS (Must-Play Core)**
   - Identify 2-4 players who are essential for ${contestType}
   - Explain WHY they're locks (matchup, pace, usage, value, game environment)
   - Consider their floor/ceiling, ownership implications, and game theory

**2. ❌ ABSOLUTE FADES (Stay Away)**
   - Identify 3-5 players to completely avoid
   - Explain WHY (poor matchup, volatility, injury concern, overpriced, blowout risk)
   - Suggest better pivots at similar price points

**3. 💎 STUD TIER BREAKDOWN ($8k+)**
   - Which studs are worth paying up for?
   - Who's overpriced/overhyped? Who's underpriced?
   - Best stud combinations that fit salary constraints

**4. 🎲 VALUE TIER ANALYSIS (<$5k)**
   - Best punt plays with legitimate upside
   - Which scrubs have path to minutes/usage?
   - Risk assessment: safe vs. volatile value plays

**5. 📊 OWNERSHIP & LEVERAGE STRATEGY**
   ${mode === 'cash'
     ? '- Safest chalk plays vs. risky chalk to fade\n   - High-floor plays with low bust probability\n   - Optimal ownership distribution for cash'
     : '- Where to absorb chalk vs. where to pivot\n   - Best leverage opportunities (high boom, low own)\n   - Contrarian plays that can separate from field'}

**6. 🏗️ LINEUP CONSTRUCTION SCENARIOS**
   ${mode === 'cash'
     ? '- Stars & Scrubs build (2-3 studs + value)\n   - Balanced build (spread salary evenly)\n   - Recommend optimal structure for this specific slate'
     : '- Tournament-winning archetypes for this slate\n   - Unique stacks/correlations to consider\n   - How many lineups to build and key differentiation points'}

**7. 🏀 GAME STACKING & CORRELATIONS**
   - Best games to target for stacks
   - Team stack opportunities (bring-backs, run-backs)
   - Games to avoid (blowout risk, low pace)

**8. ⚠️ RISK FACTORS & CONSIDERATIONS**
   - Injury news to monitor
   - Blowout concerns
   - Players on back-to-backs or rest disadvantage
   - Vegas lines and game script implications

**9. 💡 FINAL STRATEGIC SUMMARY**
   - Overall slate difficulty (chalky vs. wide open)
   - Key decision points for lineup construction
   - What separates winning lineups from the field tonight

═══════════════════════════════════════════════════════════════

**INSTRUCTIONS:**
- Be specific with player names and reasoning
- Use the data tables above - reference actual stats
- Focus on WHY, not just WHO
- Provide actionable, strategic insights
- Keep analysis concise but comprehensive
- Consider game theory and field dynamics`;

  return prompt;
}

/**
 * Build detailed player data table
 */
function buildPlayerTable(players, mode) {
  if (!players || players.length === 0) return 'No players in this category.';

  const headers = mode === 'cash'
    ? 'Name | Pos | Team | Opp | Salary | Proj | Floor | Ceil | Vol | Bust% | Min | Value | Own%'
    : 'Name | Pos | Team | Opp | Salary | Proj | Floor | Ceil | Boom% | Lev | Min | Value | Own%';

  const separator = '-'.repeat(120);

  const rows = players.map(p => {
    const name = (p.name || 'Unknown').padEnd(20);
    const pos = (p.position || 'N/A').padEnd(4);
    const team = (p.team || 'N/A').padEnd(4);
    const opp = (p.opponent || 'N/A').padEnd(4);
    const salary = `$${((p.salary || 0) / 1000).toFixed(1)}k`.padEnd(7);
    const proj = (p.projected_points || 0).toFixed(1).padEnd(5);
    const floor = (p.floor || 0).toFixed(1).padEnd(5);
    const ceil = (p.ceiling || 0).toFixed(1).padEnd(5);
    const vol = (p.volatility || 0).toFixed(2).padEnd(5);
    const bust = `${(p.bust_probability || 0).toFixed(0)}%`.padEnd(5);
    const boom = `${(p.boom_probability || 0).toFixed(0)}%`.padEnd(6);
    const lev = (p.leverage_score || 0).toFixed(1).padEnd(4);
    const min = (p.projected_minutes || 0).toFixed(0).padEnd(4);
    const value = mode === 'cash'
      ? (p.value || 0).toFixed(2).padEnd(6)
      : (p.value_gpp || 0).toFixed(2).padEnd(6);
    const own = `${(p.rostership || 0).toFixed(0)}%`.padEnd(5);

    if (mode === 'cash') {
      return `${name} ${pos} ${team} ${opp} ${salary} ${proj} ${floor} ${ceil} ${vol} ${bust} ${min} ${value} ${own}`;
    } else {
      return `${name} ${pos} ${team} ${opp} ${salary} ${proj} ${floor} ${ceil} ${boom} ${lev} ${min} ${value} ${own}`;
    }
  });

  return `${headers}\n${separator}\n${rows.join('\n')}`;
}

/**
 * Build game environment table
 */
function buildGameTable(games) {
  if (!games || games.length === 0) return 'No game data available.';

  const headers = 'Matchup | Total Players | Avg Proj | Avg Own% | Top Stars';
  const separator = '-'.repeat(100);

  const rows = games.slice(0, 6).map(g => {
    const matchup = (g.game || 'N/A').padEnd(20);
    const players = `${g.players || 0}`.padEnd(14);
    const avgProj = (g.avgProjection || 0).toFixed(1).padEnd(9);
    const avgOwn = `${(g.avgOwnership || 0).toFixed(1)}%`.padEnd(9);
    const topStars = (g.topPlayers?.slice(0, 3).map(p => p.name).join(', ') || 'N/A').padEnd(40);

    return `${matchup} ${players} ${avgProj} ${avgOwn} ${topStars}`;
  });

  return `${headers}\n${separator}\n${rows.join('\n')}`;
}

/**
 * Format player category for response
 */
function formatPlayerCategory(players, mode) {
  return players.map(p => ({
    name: p.name,
    position: p.position,
    team: p.team,
    opponent: p.opponent,
    salary: p.salary,
    projection: p.projected_points,
    floor: p.floor,
    ceiling: p.ceiling,
    ownership: p.rostership,
    leverage: p.leverage_score,
    value: mode === 'cash' ? p.value : p.value_gpp,
    boomProb: p.boom_probability
  }));
}

/**
 * Format player list
 */
function formatPlayerList(players, mode) {
  return players.map(p => ({
    name: p.name,
    salary: p.salary,
    projection: p.projected_points,
    ownership: p.rostership,
    leverage: p.leverage_score
  }));
}

/**
 * Format game stacks
 */
function formatGameStacks(games) {
  return games.slice(0, 5).map(g => ({
    game: g.game,
    playerCount: g.players,
    avgProjection: g.avgProjection?.toFixed(1),
    avgOwnership: g.avgOwnership?.toFixed(1),
    topPlayers: g.topPlayers.map(p => p.name)
  }));
}

/**
 * Helper: Calculate average
 */
function avg(arr) {
  const filtered = arr.filter(v => v != null && !isNaN(v));
  return filtered.length > 0 ? filtered.reduce((a, b) => a + b, 0) / filtered.length : 0;
}

export default { generateSlateBreakdown };
