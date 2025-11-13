import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const dbPath = path.join(__dirname, '../data/nba_dfs.db');
const db = new Database(dbPath);

console.log('🔍 Checking for Houston in defense tables...\n');

// Check team_defense_rankings
console.log('📊 team_defense_rankings:');
const houRankings = db.prepare(`SELECT * FROM team_defense_rankings WHERE team = 'HOU'`).get();
if (houRankings) {
  console.log('✅ HOUSTON FOUND:');
  console.log(houRankings);
} else {
  console.log('❌ HOUSTON NOT FOUND');
  console.log('\nAll teams in table:');
  const allTeams = db.prepare('SELECT team, def_eff FROM team_defense_rankings ORDER BY team').all();
  allTeams.forEach(t => console.log(`  ${t.team}: ${t.def_eff}`));
}

// Check team_defense_vs_position
console.log('\n📊 team_defense_vs_position:');
const houVsPos = db.prepare(`SELECT * FROM team_defense_vs_position WHERE team = 'HOU'`).all();
if (houVsPos.length > 0) {
  console.log(`✅ HOUSTON FOUND (${houVsPos.length} positions)`);
  houVsPos.forEach(p => console.log(`  ${p.position}: ${p.pts_allowed} pts`));
} else {
  console.log('❌ HOUSTON NOT FOUND in vs_position table');
}

db.close();
