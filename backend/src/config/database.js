/**
 * DATABASE CONNECTION MODULE
 *
 * Supports both SQLite (local dev) and Azure SQL (production)
 * Use DATABASE_TYPE=azuresql in .env for Azure SQL
 *
 * All methods are async-compatible for both database types.
 */

import sql from 'mssql';
import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATABASE_TYPE = process.env.DATABASE_TYPE || 'sqlite';

// Azure SQL configuration
const azureSqlConfig = {
  server: process.env.AZURE_SQL_SERVER || 'nbadfs-sql.database.windows.net',
  database: process.env.AZURE_SQL_DATABASE || 'nbadfs',
  user: process.env.AZURE_SQL_USER || 'nbadfsadmin',
  password: process.env.AZURE_SQL_PASSWORD || 'NbaDfs2024!Secure',
  options: {
    encrypt: true,
    trustServerCertificate: false,
    enableArithAbort: true,
    connectTimeout: 30000,
    requestTimeout: 60000
  },
  pool: {
    max: 10,
    min: 0,
    idleTimeoutMillis: 30000
  }
};

// Global pool for Azure SQL
let pool = null;

/**
 * Database wrapper class that provides unified async API for both SQLite and Azure SQL
 */
class DatabaseWrapper {
  constructor() {
    this.isAzureSql = DATABASE_TYPE === 'azuresql';
    this.sqliteDb = null;

    if (!this.isAzureSql) {
      this.sqliteDb = this._createSqliteDb();
    }
  }

  _createSqliteDb() {
    const isBacktesting = process.env.BACKTESTING_MODE === 'true';
    const defaultDbName = isBacktesting ? 'nba_dfs_backtest.db' : 'nba_dfs.db';
    const dbPath = process.env.DATABASE_PATH || path.join(__dirname, '../../data', defaultDbName);
    const dbDir = path.dirname(dbPath);

    if (isBacktesting) {
      console.log('🧪 BACKTESTING MODE ENABLED - Using separate database:', dbPath);
    }

    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }

    const db = new Database(dbPath);
    db.pragma('foreign_keys = ON');
    db.pragma('journal_mode = WAL');
    return db;
  }

  async connect() {
    if (this.isAzureSql && !pool) {
      console.log('🔌 Connecting to Azure SQL...');
      pool = await sql.connect(azureSqlConfig);
      console.log('✅ Connected to Azure SQL');
    }
    return pool;
  }

  /**
   * Execute a SELECT query and return all rows
   */
  async all(query, ...params) {
    if (this.isAzureSql) {
      return this._azureAll(query, params);
    }
    return this._sqliteAll(query, params);
  }

  /**
   * Execute a SELECT query and return first row
   */
  async get(query, ...params) {
    if (this.isAzureSql) {
      return this._azureGet(query, params);
    }
    return this._sqliteGet(query, params);
  }

  /**
   * Execute an INSERT/UPDATE/DELETE query
   */
  async run(query, ...params) {
    if (this.isAzureSql) {
      return this._azureRun(query, params);
    }
    return this._sqliteRun(query, params);
  }

  /**
   * Execute raw SQL (for schema creation, etc.)
   */
  async exec(query) {
    if (this.isAzureSql) {
      const p = await this.connect();
      await p.request().batch(query);
    } else {
      this.sqliteDb.exec(query);
    }
  }

  /**
   * Create a prepared statement-like interface
   * Returns an object with async all/get/run methods
   */
  prepare(query) {
    const self = this;
    return {
      all: async (...params) => self.all(query, ...params),
      get: async (...params) => self.get(query, ...params),
      run: async (...params) => self.run(query, ...params)
    };
  }

  /**
   * Transaction wrapper
   */
  transaction(fn) {
    if (this.isAzureSql) {
      return this._azureTransaction(fn);
    }
    return this._sqliteTransaction(fn);
  }

  // SQLite implementations (sync wrapped as async)
  _sqliteAll(query, params) {
    const flatParams = this._flattenParams(params);
    return this.sqliteDb.prepare(query).all(...flatParams);
  }

  _sqliteGet(query, params) {
    const flatParams = this._flattenParams(params);
    return this.sqliteDb.prepare(query).get(...flatParams);
  }

  _sqliteRun(query, params) {
    const flatParams = this._flattenParams(params);
    return this.sqliteDb.prepare(query).run(...flatParams);
  }

  _sqliteTransaction(fn) {
    return this.sqliteDb.transaction(fn);
  }

  // Azure SQL implementations
  async _azureAll(query, params) {
    const p = await this.connect();
    const request = p.request();
    const { convertedQuery, inputParams } = this._convertParams(query, params);

    for (const [key, value] of Object.entries(inputParams)) {
      request.input(key, value);
    }

    const result = await request.query(convertedQuery);
    return result.recordset || [];
  }

  async _azureGet(query, params) {
    const results = await this._azureAll(query, params);
    return results[0] || null;
  }

  async _azureRun(query, params) {
    const p = await this.connect();
    const request = p.request();
    const { convertedQuery, inputParams } = this._convertParams(query, params);

    for (const [key, value] of Object.entries(inputParams)) {
      request.input(key, value);
    }

    const result = await request.query(convertedQuery);
    return {
      changes: result.rowsAffected?.[0] || 0,
      lastInsertRowid: null
    };
  }

  _azureTransaction(fn) {
    return async (...args) => {
      const p = await this.connect();
      const transaction = new sql.Transaction(p);
      try {
        await transaction.begin();
        const result = await fn(...args);
        await transaction.commit();
        return result;
      } catch (err) {
        await transaction.rollback();
        throw err;
      }
    };
  }

  /**
   * Convert SQLite-style ? params to Azure SQL @p1, @p2, etc.
   * Also handles named parameters (@param style)
   */
  _convertParams(query, params) {
    const flatParams = this._flattenParams(params);
    const inputParams = {};

    // Handle named parameters (object with keys)
    if (flatParams.length === 1 && typeof flatParams[0] === 'object' && flatParams[0] !== null && !Array.isArray(flatParams[0])) {
      const paramObj = flatParams[0];
      for (const [key, value] of Object.entries(paramObj)) {
        inputParams[key] = value;
      }
      return { convertedQuery: query, inputParams };
    }

    // Handle positional ? parameters
    let paramIndex = 0;
    const convertedQuery = query.replace(/\?/g, () => {
      const paramName = `p${++paramIndex}`;
      inputParams[paramName] = flatParams[paramIndex - 1];
      return `@${paramName}`;
    });

    return { convertedQuery, inputParams };
  }

  /**
   * Flatten nested params array
   */
  _flattenParams(params) {
    if (params.length === 0) return [];
    if (params.length === 1 && Array.isArray(params[0])) {
      return params[0];
    }
    return params;
  }

  pragma(value) {
    if (!this.isAzureSql && this.sqliteDb) {
      this.sqliteDb.pragma(value);
    }
  }

  close() {
    if (this.isAzureSql && pool) {
      pool.close();
      pool = null;
    } else if (this.sqliteDb) {
      this.sqliteDb.close();
    }
  }
}

// Create and export the database instance
const db = new DatabaseWrapper();

export default db;
export { DATABASE_TYPE };
