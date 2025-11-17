import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const dbPath = path.join(__dirname, '../data/nba_dfs.db');
const db = new Database(dbPath);

console.log('🔍 Production Mapping Verification\n');
console.log('=' .repeat(60));

// Check PHX/PHO mapping
console.log('\n🏀 PHOENIX SUNS MAPPING:');
console.log('-'.repeat(60));
const phxPlayers = db.prepare(`
  SELECT name, opponent, position, dvp_pts_allowed, opp_def_eff
  FROM players
  WHERE opponent = 'PHX'
`).all();
console.log(`Players facing PHX: ${phxPlayers.length}`);
if (phxPlayers.length > 0) {
  const withDvp = phxPlayers.filter(p => p.dvp_pts_allowed !== null).length;
  const withDefEff = phxPlayers.filter(p => p.opp_def_eff !== null).length;
  console.log(`  ✅ With DVP data: ${withDvp}/${phxPlayers.length}`);
  console.log(`  ✅ With DEF EFF data: ${withDefEff}/${phxPlayers.length}`);
  console.log('\nSample players:');
  console.table(phxPlayers.slice(0, 3));
} else {
  console.log('  ⚠️  No players facing PHX in current slate');
}

// Check WAS/WSH mapping
console.log('\n🏀 WASHINGTON WIZARDS MAPPING:');
console.log('-'.repeat(60));
const wasPlayers = db.prepare(`
  SELECT name, opponent, position, dvp_pts_allowed, opp_def_eff
  FROM players
  WHERE opponent = 'WAS'
`).all();
console.log(`Players facing WAS: ${wasPlayers.length}`);
if (wasPlayers.length > 0) {
  const withDvp = wasPlayers.filter(p => p.dvp_pts_allowed !== null).length;
  const withDefEff = wasPlayers.filter(p => p.opp_def_eff !== null).length;
  console.log(`  ✅ With DVP data: ${withDvp}/${wasPlayers.length}`);
  console.log(`  ✅ With DEF EFF data: ${withDefEff}/${wasPlayers.length}`);
  console.log('\nSample players:');
  console.table(wasPlayers.slice(0, 3));
} else {
  console.log('  ⚠️  No players facing WAS in current slate');
}

// Overall stats
console.log('\n📊 OVERALL DEFENSIVE DATA COVERAGE:');
console.log('-'.repeat(60));
const totalPlayers = db.prepare('SELECT COUNT(*) as count FROM players WHERE opponent IS NOT NULL').get();
const withDvp = db.prepare('SELECT COUNT(*) as count FROM players WHERE opponent IS NOT NULL AND dvp_pts_allowed IS NOT NULL').get();
const withDefEff = db.prepare('SELECT COUNT(*) as count FROM players WHERE opponent IS NOT NULL AND opp_def_eff IS NOT NULL').get();

console.log(`Total players with opponents: ${totalPlayers.count}`);
console.log(`Players with DVP data: ${withDvp.count} (${(withDvp.count/totalPlayers.count*100).toFixed(1)}%)`);
console.log(`Players with DEF EFF data: ${withDefEff.count} (${(withDefEff.count/totalPlayers.count*100).toFixed(1)}%)`);

if (withDvp.count === totalPlayers.count && withDefEff.count === totalPlayers.count) {
  console.log('\n✅ ALL MAPPINGS WORKING CORRECTLY!');
} else {
  console.log('\n❌ MISSING DATA DETECTED');

  const missingDvp = db.prepare(`
    SELECT name, opponent, position
    FROM players
    WHERE opponent IS NOT NULL AND dvp_pts_allowed IS NULL
    LIMIT 5
  `).all();

  if (missingDvp.length > 0) {
    console.log('\nPlayers missing DVP data:');
    console.table(missingDvp);
  }

  const missingDefEff = db.prepare(`
    SELECT name, opponent, position
    FROM players
    WHERE opponent IS NOT NULL AND opp_def_eff IS NULL
    LIMIT 5
  `).all();

  if (missingDefEff.length > 0) {
    console.log('\nPlayers missing DEF EFF data:');
    console.table(missingDefEff);
  }
}

db.close();
