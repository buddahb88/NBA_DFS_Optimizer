import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const dbPath = path.join(__dirname, '../data/nba_dfs.db');
const db = new Database(dbPath);

console.log('🔍 Investigating team name mismatches...\n');

// Get unique opponent names from players
console.log('📋 OPPONENTS IN PLAYERS TABLE:');
const playerOpponents = db.prepare(`
  SELECT DISTINCT opponent
  FROM players
  WHERE opponent IS NOT NULL
  ORDER BY opponent
`).all();
console.log(playerOpponents.map(r => r.opponent).join(', '));
console.log(`Total: ${playerOpponents.length}\n`);

// Get team names from defense rankings
console.log('📋 TEAMS IN TEAM_DEFENSE_RANKINGS:');
const defenseTeams = db.prepare(`
  SELECT DISTINCT team
  FROM team_defense_rankings
  ORDER BY team
`).all();
console.log(defenseTeams.map(r => r.team).join(', '));
console.log(`Total: ${defenseTeams.length}\n`);

// Get team names from defense vs position
console.log('📋 TEAMS IN TEAM_DEFENSE_VS_POSITION:');
const dvpTeams = db.prepare(`
  SELECT DISTINCT team
  FROM team_defense_vs_position
  ORDER BY team
`).all();
console.log(dvpTeams.map(r => r.team).join(', '));
console.log(`Total: ${dvpTeams.length}\n`);

// Find mismatches
console.log('❌ OPPONENTS NOT IN DEFENSE TABLES:');
const defenseTeamSet = new Set(defenseTeams.map(r => r.team));
const mismatches = playerOpponents.filter(r => !defenseTeamSet.has(r.opponent));
if (mismatches.length > 0) {
  mismatches.forEach(m => console.log(`  - ${m.opponent}`));
} else {
  console.log('  (None - all match!)');
}

console.log('\n📊 SAMPLE DVP DATA (with pts_allowed):');
const sampleDvp = db.prepare(`
  SELECT team, position, rank, pts_allowed
  FROM team_defense_vs_position
  WHERE position = 'PG'
  ORDER BY pts_allowed DESC
  LIMIT 5
`).all();
console.table(sampleDvp);

db.close();
