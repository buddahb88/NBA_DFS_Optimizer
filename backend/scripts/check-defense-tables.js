import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const dbPath = path.join(__dirname, '../data/nba_dfs.db');
const db = new Database(dbPath);

console.log('🔍 Checking team names in defense tables...\n');

// Check WAS/WSH
console.log('📋 WAS/WSH in tables:');
const wasInRankings = db.prepare(`SELECT * FROM team_defense_rankings WHERE team IN ('WAS', 'WSH')`).all();
console.log('team_defense_rankings:', wasInRankings.map(r => r.team));

const wasInVsPos = db.prepare(`SELECT DISTINCT team FROM team_defense_vs_position WHERE team IN ('WAS', 'WSH')`).all();
console.log('team_defense_vs_position:', wasInVsPos.map(r => r.team));

// Check HOU
console.log('\n📋 HOU in tables:');
const houInRankings = db.prepare(`SELECT * FROM team_defense_rankings WHERE team = 'HOU'`).all();
console.log('team_defense_rankings:', houInRankings.length > 0 ? 'HOU exists' : 'HOU missing');

const houInVsPos = db.prepare(`SELECT DISTINCT team FROM team_defense_vs_position WHERE team = 'HOU'`).all();
console.log('team_defense_vs_position:', houInVsPos.length > 0 ? 'HOU exists' : 'HOU missing');

// Check PHX/PHO
console.log('\n📋 PHX/PHO in tables:');
const phxInRankings = db.prepare(`SELECT * FROM team_defense_rankings WHERE team IN ('PHX', 'PHO')`).all();
console.log('team_defense_rankings:', phxInRankings.map(r => r.team));

const phxInVsPos = db.prepare(`SELECT DISTINCT team FROM team_defense_vs_position WHERE team IN ('PHX', 'PHO')`).all();
console.log('team_defense_vs_position:', phxInVsPos.map(r => r.team));

// Check UTAH/UTA
console.log('\n📋 UTAH/UTA in tables:');
const utahInRankings = db.prepare(`SELECT * FROM team_defense_rankings WHERE team IN ('UTAH', 'UTA')`).all();
console.log('team_defense_rankings:', utahInRankings.map(r => r.team));

const utahInVsPos = db.prepare(`SELECT DISTINCT team FROM team_defense_vs_position WHERE team IN ('UTAH', 'UTA')`).all();
console.log('team_defense_vs_position:', utahInVsPos.map(r => r.team));

db.close();
