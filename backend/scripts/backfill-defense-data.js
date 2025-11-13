import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const dbPath = path.join(__dirname, '../data/nba_dfs.db');
const db = new Database(dbPath);

console.log('🔄 Backfilling defensive data for existing players...\n');

// Get all players
const players = db.prepare('SELECT id, name, position, opponent FROM players').all();

console.log(`📊 Found ${players.length} players to update`);

let updatedCount = 0;
let skippedCount = 0;

const updateStmt = db.prepare(`
  UPDATE players
  SET dvp_rank = ?, opp_def_eff = ?
  WHERE id = ?
`);

const updateMany = db.transaction((players) => {
  for (const player of players) {
    if (!player.opponent) {
      skippedCount++;
      continue;
    }

    // Get DVP rank for this position vs opponent
    // Extract primary position (first one before comma)
    let dvpRank = null;
    const primaryPosition = player.position.split(',')[0].trim();

    const dvpData = db.prepare(`
      SELECT rank
      FROM team_defense_vs_position
      WHERE team = ? AND position = ?
    `).get(player.opponent, primaryPosition);

    if (dvpData) {
      dvpRank = dvpData.rank;
    }

    // Get opponent's defensive efficiency
    let oppDefEff = null;
    const defData = db.prepare(`
      SELECT def_eff
      FROM team_defense_rankings
      WHERE team = ?
    `).get(player.opponent);

    if (defData) {
      oppDefEff = defData.def_eff;
    }

    // Update player if we have at least one value
    if (dvpRank !== null || oppDefEff !== null) {
      updateStmt.run(dvpRank, oppDefEff, player.id);
      updatedCount++;

      if (updatedCount % 20 === 0) {
        console.log(`✓ Updated ${updatedCount} players...`);
      }
    } else {
      skippedCount++;
    }
  }
});

updateMany(players);

console.log('\n✅ Backfill complete!');
console.log(`   Updated: ${updatedCount} players`);
console.log(`   Skipped: ${skippedCount} players (no opponent or defense data)`);

// Show sample results
console.log('\n📊 Sample updated players:');
const samples = db.prepare(`
  SELECT name, position, opponent, dvp_rank, opp_def_eff
  FROM players
  WHERE dvp_rank IS NOT NULL OR opp_def_eff IS NOT NULL
  LIMIT 5
`).all();

console.table(samples);

db.close();
