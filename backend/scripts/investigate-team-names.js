import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const dbPath = path.join(__dirname, '../data/nba_dfs.db');
const db = new Database(dbPath);

console.log('🔍 Investigating Phoenix and Utah team name issues...\n');

// Check what opponent names players have for Phoenix
console.log('📋 PLAYERS FACING PHOENIX:');
const phxPlayers = db.prepare(`
  SELECT DISTINCT opponent
  FROM players
  WHERE opponent LIKE '%PHO%' OR opponent LIKE '%PHX%' OR opponent LIKE '%Phoenix%'
`).all();
console.log('Opponent values:', phxPlayers.map(r => r.opponent).join(', ') || 'NONE');

// Check what opponent names players have for Utah
console.log('\n📋 PLAYERS FACING UTAH:');
const utahPlayers = db.prepare(`
  SELECT DISTINCT opponent
  FROM players
  WHERE opponent LIKE '%UTA%' OR opponent LIKE '%UTAH%' OR opponent LIKE '%Utah%'
`).all();
console.log('Opponent values:', utahPlayers.map(r => r.opponent).join(', ') || 'NONE');

// Check all defense table teams
console.log('\n📋 DEFENSE RANKINGS TEAMS:');
const rankingsTeams = db.prepare('SELECT team FROM team_defense_rankings ORDER BY team').all();
const phxInRankings = rankingsTeams.filter(t => t.team.includes('PHO') || t.team.includes('PHX') || t.team.toLowerCase().includes('phoenix'));
const utahInRankings = rankingsTeams.filter(t => t.team.includes('UTA') || t.team.includes('UTAH') || t.team.toLowerCase().includes('utah'));
console.log('Phoenix:', phxInRankings.map(t => t.team).join(', ') || 'NOT FOUND');
console.log('Utah:', utahInRankings.map(t => t.team).join(', ') || 'NOT FOUND');

console.log('\n📋 DEFENSE VS POSITION TEAMS:');
const vsPositionTeams = db.prepare('SELECT DISTINCT team FROM team_defense_vs_position ORDER BY team').all();
const phxInVsPos = vsPositionTeams.filter(t => t.team.includes('PHO') || t.team.includes('PHX') || t.team.toLowerCase().includes('phoenix'));
const utahInVsPos = vsPositionTeams.filter(t => t.team.includes('UTA') || t.team.includes('UTAH') || t.team.toLowerCase().includes('utah'));
console.log('Phoenix:', phxInVsPos.map(t => t.team).join(', ') || 'NOT FOUND');
console.log('Utah:', utahInVsPos.map(t => t.team).join(', ') || 'NOT FOUND');

// Check sample players facing these teams
console.log('\n📊 SAMPLE PLAYERS FACING PHOENIX:');
const samplePhx = db.prepare(`
  SELECT name, opponent, dvp_pts_allowed, opp_def_eff
  FROM players
  WHERE opponent LIKE '%PHO%' OR opponent LIKE '%PHX%' OR opponent LIKE '%Phoenix%'
  LIMIT 3
`).all();
if (samplePhx.length > 0) {
  console.table(samplePhx);
} else {
  console.log('NO PLAYERS FOUND');
}

console.log('\n📊 SAMPLE PLAYERS FACING UTAH:');
const sampleUtah = db.prepare(`
  SELECT name, opponent, dvp_pts_allowed, opp_def_eff
  FROM players
  WHERE opponent LIKE '%UTA%' OR opponent LIKE '%UTAH%' OR opponent LIKE '%Utah%'
  LIMIT 3
`).all();
if (sampleUtah.length > 0) {
  console.table(sampleUtah);
} else {
  console.log('NO PLAYERS FOUND');
}

db.close();
