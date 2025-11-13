import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const dbPath = path.join(__dirname, '../data/nba_dfs.db');
const db = new Database(dbPath);

console.log('🔍 Checking players facing Houston...\n');

const houPlayers = db.prepare(`
  SELECT name, position, opponent, dvp_pts_allowed, opp_def_eff
  FROM players
  WHERE opponent = 'HOU'
`).all();

if (houPlayers.length > 0) {
  console.log(`✅ Found ${houPlayers.length} players facing Houston:\n`);
  console.table(houPlayers);
} else {
  console.log('❌ No players found facing Houston');
  console.log('\nChecking what opponents exist in players table:');
  const opponents = db.prepare('SELECT DISTINCT opponent FROM players WHERE opponent IS NOT NULL ORDER BY opponent').all();
  console.log(opponents.map(o => o.opponent).join(', '));
}

db.close();
