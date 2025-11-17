import Database from 'better-sqlite3';

const db = new Database('./data/nba_dfs.db');

const stats = db.prepare(`
  SELECT
    COUNT(*) as total,
    COUNT(CASE WHEN leverage_score >= 2.5 THEN 1 END) as lev_25,
    COUNT(CASE WHEN leverage_score >= 2.0 THEN 1 END) as lev_20,
    COUNT(CASE WHEN leverage_score >= 1.5 THEN 1 END) as lev_15,
    COUNT(CASE WHEN leverage_score IS NOT NULL THEN 1 END) as has_lev,
    COUNT(CASE WHEN boom_probability >= 20 THEN 1 END) as boom_20,
    COUNT(CASE WHEN boom_probability >= 15 THEN 1 END) as boom_15,
    COUNT(CASE WHEN ceiling >= 50 THEN 1 END) as ceil_50,
    COUNT(CASE WHEN ceiling >= 40 THEN 1 END) as ceil_40,
    COUNT(CASE WHEN projected_points >= 20 THEN 1 END) as proj_20,
    AVG(leverage_score) as avg_lev,
    AVG(boom_probability) as avg_boom,
    AVG(ceiling) as avg_ceil,
    MIN(leverage_score) as min_lev,
    MAX(leverage_score) as max_lev,
    AVG(projected_points) as avg_proj,
    AVG(rostership) as avg_own
  FROM players
  WHERE slate_id = '26194'
    AND (injury_status IS NULL OR injury_status = '')
`).get();

console.log('\n╔═══════════════════════════════════════════════════════════╗');
console.log('║         PLAYER POOL ANALYSIS - SLATE 26194               ║');
console.log('╠═══════════════════════════════════════════════════════════╣');
console.log(`║ Total healthy players: ${stats.total.toString().padEnd(33)}║`);
console.log('╠═══════════════════════════════════════════════════════════╣');
console.log('║ LEVERAGE SCORE DISTRIBUTION:                             ║');
console.log(`║   Players with leverage >= 2.5: ${stats.lev_25.toString().padEnd(24)}║`);
console.log(`║   Players with leverage >= 2.0: ${stats.lev_20.toString().padEnd(24)}║`);
console.log(`║   Players with leverage >= 1.5: ${stats.lev_15.toString().padEnd(24)}║`);
console.log(`║   Players with leverage data:   ${stats.has_lev.toString().padEnd(24)}║`);
console.log(`║   Range: ${stats.min_lev?.toFixed(2)} to ${stats.max_lev?.toFixed(2)} (avg: ${stats.avg_lev?.toFixed(2)})`.padEnd(59) + '║');
console.log('╠═══════════════════════════════════════════════════════════╣');
console.log('║ BOOM PROBABILITY:                                        ║');
console.log(`║   Players with boom >= 20%: ${stats.boom_20.toString().padEnd(28)}║`);
console.log(`║   Players with boom >= 15%: ${stats.boom_15.toString().padEnd(28)}║`);
console.log(`║   Average: ${stats.avg_boom?.toFixed(1)}%`.padEnd(59) + '║');
console.log('╠═══════════════════════════════════════════════════════════╣');
console.log('║ CEILING:                                                 ║');
console.log(`║   Players with ceiling >= 50: ${stats.ceil_50.toString().padEnd(26)}║`);
console.log(`║   Players with ceiling >= 40: ${stats.ceil_40.toString().padEnd(26)}║`);
console.log(`║   Average: ${stats.avg_ceil?.toFixed(1)} pts`.padEnd(59) + '║');
console.log('╠═══════════════════════════════════════════════════════════╣');
console.log('║ PROJECTION & OWNERSHIP:                                  ║');
console.log(`║   Players with projection >= 20: ${stats.proj_20.toString().padEnd(23)}║`);
console.log(`║   Average projection: ${stats.avg_proj?.toFixed(1)} pts`.padEnd(59) + '║');
console.log(`║   Average ownership: ${stats.avg_own?.toFixed(1)}%`.padEnd(59) + '║');
console.log('╚═══════════════════════════════════════════════════════════╝\n');

// Get top 15 leverage plays
console.log('╔═══════════════════════════════════════════════════════════════════════════╗');
console.log('║                     TOP 15 LEVERAGE PLAYS                                ║');
console.log('╠═══════════════════════════════════════════════════════════════════════════╣');
const topLev = db.prepare(`
  SELECT name, position, salary, projected_points, leverage_score,
         ceiling, boom_probability, rostership
  FROM players
  WHERE slate_id = '26194'
    AND (injury_status IS NULL OR injury_status = '')
    AND leverage_score IS NOT NULL
  ORDER BY leverage_score DESC
  LIMIT 15
`).all();

topLev.forEach((p, i) => {
  const rank = `${i+1}.`.padEnd(3);
  const namePos = `${p.name} (${p.position})`.padEnd(28).substring(0, 28);
  const salary = `$${(p.salary/1000).toFixed(1)}k`.padStart(7);
  const proj = p.projected_points?.toFixed(1).padStart(5);
  const lev = p.leverage_score?.toFixed(2).padStart(5);
  const ceil = p.ceiling?.toFixed(0).padStart(4);
  const boom = `${p.boom_probability?.toFixed(0)}%`.padStart(4);
  const own = `${p.rostership?.toFixed(0)}%`.padStart(4);

  console.log(`║ ${rank} ${namePos} ${salary} | Proj:${proj} Lev:${lev} Ceil:${ceil} Boom:${boom} Own:${own} ║`);
});

console.log('╚═══════════════════════════════════════════════════════════════════════════╝\n');

// Recommended settings
console.log('╔═══════════════════════════════════════════════════════════╗');
console.log('║           RECOMMENDED GPP SETTINGS                       ║');
console.log('╠═══════════════════════════════════════════════════════════╣');

const recommendedMinLev = Math.max(1.0, stats.avg_lev - 1.0);
const recommendedMinBoom = Math.max(10, stats.avg_boom - 10);
const recommendedMinCeil = Math.max(30, stats.avg_ceil - 10);

console.log('║ Based on your player pool, try these settings:          ║');
console.log('║                                                          ║');
console.log(`║ Min Leverage Score:    ${recommendedMinLev.toFixed(1).padEnd(33)}║`);
console.log(`║ Min Boom Probability:  ${recommendedMinBoom.toFixed(0)}%`.padEnd(59) + '║');
console.log(`║ Min Ceiling:           ${recommendedMinCeil.toFixed(0)} pts`.padEnd(59) + '║');
console.log('║ Min Projection:        15-20 pts                        ║');
console.log('║ Max Chalk Players:     2-3                              ║');
console.log('║ Randomness:            10-20%                           ║');
console.log('║                                                          ║');
console.log('║ GPP Strategy:          Start with "Balanced"            ║');
console.log('║                        Then try "Max Leverage"           ║');
console.log('╚═══════════════════════════════════════════════════════════╝\n');

// Count how many players pass recommended filters
const passesRecommended = db.prepare(`
  SELECT COUNT(*) as count
  FROM players
  WHERE slate_id = '26194'
    AND (injury_status IS NULL OR injury_status = '')
    AND leverage_score >= ?
    AND boom_probability >= ?
    AND ceiling >= ?
    AND projected_points >= 15
`).get(recommendedMinLev, recommendedMinBoom, recommendedMinCeil);

console.log(`✅ With recommended settings: ${passesRecommended.count} players would pass filters`);
console.log(`   (Need at least 15-20 for good lineup generation)\n`);

db.close();
