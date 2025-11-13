import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const dbPath = path.join(__dirname, '../data/nba_dfs.db');
const db = new Database(dbPath);

// Mapping for team_defense_rankings table
const RANKINGS_MAP = {
  'PHX': 'PHO',   // Phoenix Suns
  'WAS': 'WSH',   // Washington Wizards
  'UTAH': 'UTAH', // Utah Jazz (no change needed)
};

// Mapping for team_defense_vs_position table
const VS_POSITION_MAP = {
  'PHX': 'PHO',   // Phoenix Suns
  'WAS': 'WAS',   // Washington Wizards (no change needed)
  'UTAH': 'UTA',  // Utah Jazz
  'HOU': 'HOU',   // Houston Rockets (no change needed)
};

function normalizeForRankings(teamName) {
  if (!teamName) return null;
  return RANKINGS_MAP[teamName] || teamName;
}

function normalizeForVsPosition(teamName) {
  if (!teamName) return null;
  return VS_POSITION_MAP[teamName] || teamName;
}

console.log('🔄 Backfilling pts_allowed defensive data for existing players...\n');

// Get all players
const players = db.prepare('SELECT id, name, position, opponent FROM players').all();

console.log(`📊 Found ${players.length} players to update`);

let updatedCount = 0;
let skippedCount = 0;

const updateStmt = db.prepare(`
  UPDATE players
  SET dvp_pts_allowed = ?, opp_def_eff = ?
  WHERE id = ?
`);

const updateMany = db.transaction((players) => {
  for (const player of players) {
    if (!player.opponent) {
      skippedCount++;
      continue;
    }

    // Get DVP points allowed for this position vs opponent
    // Extract primary position (first one before comma)
    let dvpPtsAllowed = null;
    const primaryPosition = player.position.split(',')[0].trim();
    const normalizedVsPos = normalizeForVsPosition(player.opponent);

    const dvpData = db.prepare(`
      SELECT pts_allowed
      FROM team_defense_vs_position
      WHERE team = ? AND position = ?
    `).get(normalizedVsPos, primaryPosition);

    if (dvpData) {
      dvpPtsAllowed = dvpData.pts_allowed;
    }

    // Get opponent's defensive efficiency
    let oppDefEff = null;
    const normalizedRankings = normalizeForRankings(player.opponent);
    const defData = db.prepare(`
      SELECT def_eff
      FROM team_defense_rankings
      WHERE team = ?
    `).get(normalizedRankings);

    if (defData) {
      oppDefEff = defData.def_eff;
    }

    // Update player if we have at least one value
    if (dvpPtsAllowed !== null || oppDefEff !== null) {
      updateStmt.run(dvpPtsAllowed, oppDefEff, player.id);
      updatedCount++;

      if (updatedCount % 20 === 0) {
        console.log(`✓ Updated ${updatedCount} players...`);
      }
    } else {
      skippedCount++;
      console.log(`⚠ Skipped ${player.name} (${player.opponent}): No defense data found`);
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
  SELECT name, position, opponent, dvp_pts_allowed, opp_def_eff
  FROM players
  WHERE dvp_pts_allowed IS NOT NULL OR opp_def_eff IS NOT NULL
  LIMIT 10
`).all();

console.table(samples);

db.close();
