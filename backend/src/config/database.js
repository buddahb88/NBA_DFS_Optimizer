import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Use backtesting database if in backtest mode
const isBacktesting = process.env.BACKTESTING_MODE === 'true';
const defaultDbName = isBacktesting ? 'nba_dfs_backtest.db' : 'nba_dfs.db';
const dbPath = process.env.DATABASE_PATH || path.join(__dirname, '../../data', defaultDbName);
const dbDir = path.dirname(dbPath);

if (isBacktesting) {
  console.log('🧪 BACKTESTING MODE ENABLED - Using separate database:', dbPath);
}

// Ensure data directory exists
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const db = new Database(dbPath);

// Enable foreign keys
db.pragma('foreign_keys = ON');

// Enable WAL mode for better concurrency
db.pragma('journal_mode = WAL');

export default db;
