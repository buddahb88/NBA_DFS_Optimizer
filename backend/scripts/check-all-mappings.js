import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const dbPath = path.join(__dirname, '../data/nba_dfs.db');
const db = new Database(dbPath);

console.log('🔍 Checking all team mappings...\n');

// Get all distinct opponent values from players
console.log('📋 ALL OPPONENT VALUES IN PLAYERS TABLE:');
const allOpponents = db.prepare(`
  SELECT DISTINCT opponent
  FROM players
  WHERE opponent IS NOT NULL
  ORDER BY opponent
`).all();
console.log(allOpponents.map(r => r.opponent).join(', '));

// Get all teams from defense tables
console.log('\n📋 ALL TEAMS IN DEFENSE RANKINGS:');
const rankingsTeams = db.prepare('SELECT DISTINCT team FROM team_defense_rankings ORDER BY team').all();
console.log(rankingsTeams.map(r => r.team).join(', '));

console.log('\n📋 ALL TEAMS IN DEFENSE VS POSITION:');
const vsPositionTeams = db.prepare('SELECT DISTINCT team FROM team_defense_vs_position ORDER BY team').all();
console.log(vsPositionTeams.map(r => r.team).join(', '));

// Check for missing defensive data
console.log('\n❌ PLAYERS WITH MISSING DVP DATA:');
const missingDvp = db.prepare(`
  SELECT name, opponent, position, dvp_pts_allowed
  FROM players
  WHERE opponent IS NOT NULL AND dvp_pts_allowed IS NULL
  LIMIT 10
`).all();
if (missingDvp.length > 0) {
  console.table(missingDvp);
} else {
  console.log('✅ ALL PLAYERS HAVE DVP DATA');
}

console.log('\n❌ PLAYERS WITH MISSING DEF EFF DATA:');
const missingDefEff = db.prepare(`
  SELECT name, opponent, opp_def_eff
  FROM players
  WHERE opponent IS NOT NULL AND opp_def_eff IS NULL
  LIMIT 10
`).all();
if (missingDefEff.length > 0) {
  console.table(missingDefEff);
} else {
  console.log('✅ ALL PLAYERS HAVE DEF EFF DATA');
}

db.close();
