import { DATABASE_TYPE } from './database.js';

/**
 * agent_value_backtests migration (idempotent, runs on every startup)
 *
 * One row per (run_at, game_date, method) from scripts/agent-value-backtest.js
 * (services/agentValueBacktest.js): the chat agent's top value plays vs the
 * baselines, scored against historical_games. method is 'agent',
 * 'baseline_value' or 'band_average'; players is a JSON array of the picks
 * (empty for band_average). hit_5x is a fraction (0.6 = 3 of 5); minutes are
 * per player.
 */
export async function migrateAgentValueBacktests(db) {
  if (DATABASE_TYPE === 'azuresql') {
    await db.exec(`
      IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='agent_value_backtests' AND xtype='U')
      CREATE TABLE agent_value_backtests (
        id INT IDENTITY(1,1) PRIMARY KEY,
        run_at NVARCHAR(30) NOT NULL,
        game_date DATE NOT NULL,
        site NVARCHAR(20) NOT NULL,
        slate_id NVARCHAR(100),
        method NVARCHAR(30) NOT NULL,
        source NVARCHAR(50),
        players NVARCHAR(MAX),
        n_players INT,
        total_salary INT,
        total_dk FLOAT,
        value_per_1k FLOAT,
        hit_5x FLOAT,
        projected_minutes FLOAT,
        actual_minutes FLOAT
      )
    `);
    await db.exec(`
      IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'idx_agent_value_backtests_date')
        CREATE INDEX idx_agent_value_backtests_date ON agent_value_backtests(game_date, method);
    `);
  } else {
    await db.exec(`
      CREATE TABLE IF NOT EXISTS agent_value_backtests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_at TEXT NOT NULL,
        game_date TEXT NOT NULL,
        site TEXT NOT NULL,
        slate_id TEXT,
        method TEXT NOT NULL,
        source TEXT,
        players TEXT,
        n_players INTEGER,
        total_salary INTEGER,
        total_dk REAL,
        value_per_1k REAL,
        hit_5x REAL,
        projected_minutes REAL,
        actual_minutes REAL
      );
      CREATE INDEX IF NOT EXISTS idx_agent_value_backtests_date ON agent_value_backtests(game_date, method);
    `);
  }
}
