import { DATABASE_TYPE } from './database.js';
import { playerKey } from '../utils/playerKey.js';

/**
 * Saved-lineup persistence migration (idempotent, runs on every startup)
 *
 * A slate sync deletes every slates and players row and re-inserts them, so
 * saved lineups must not depend on those rows:
 * - SQLite: lineups.slate_id -> slates and lineup_players.player_id -> players
 *   were ON DELETE CASCADE, so a resync deleted every saved lineup. Both
 *   foreign keys are dropped (table rebuild). Azure SQL never had them.
 * - lineup_players stores the player as saved (name, team, salary, ...) plus
 *   player_external_id = players.player_id, which is stable across resyncs
 *   (players.id is not). lineupModel.getById re-attaches the live row by it.
 * Deleting a lineup still cascades to its lineup_players.
 */

// Denormalized player columns on lineup_players: [name, sqlite type, azure type]
export const LINEUP_PLAYER_COLUMNS = [
  ['player_external_id', 'TEXT', 'NVARCHAR(100)'],
  ['site_player_id', 'TEXT', 'NVARCHAR(100)'],
  ['player_key', 'TEXT', 'NVARCHAR(255)'],
  ['name', 'TEXT', 'NVARCHAR(255)'],
  ['team', 'TEXT', 'NVARCHAR(50)'],
  ['opponent', 'TEXT', 'NVARCHAR(50)'],
  ['position', 'TEXT', 'NVARCHAR(50)'],
  ['roster_positions', 'TEXT', 'NVARCHAR(100)'],
  ['salary', 'INTEGER', 'INT'],
  ['projected_points', 'REAL', 'FLOAT']
];

export async function migrateLineupPersistence(db) {
  if (DATABASE_TYPE === 'azuresql') {
    for (const [name, , type] of LINEUP_PLAYER_COLUMNS) {
      await db.exec(`
        IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('lineup_players') AND name = '${name}')
          ALTER TABLE lineup_players ADD ${name} ${type};
      `);
    }
  } else {
    await dropSqliteCascades(db);
    const existing = new Set((await db.all(`PRAGMA table_info(lineup_players)`)).map(c => c.name));
    for (const [name, type] of LINEUP_PLAYER_COLUMNS) {
      if (!existing.has(name)) {
        await db.exec(`ALTER TABLE lineup_players ADD COLUMN ${name} ${type}`);
      }
    }
  }

  const updated = await backfillLineupPlayers(db);
  if (updated > 0) {
    console.log(`✓ Backfilled saved player details for ${updated} lineup player row(s)`);
  }
}

// Foreign keys a slate resync must not trigger
const STALE_FKS = { lineups: 'slates', lineup_players: 'players' };
const FK_CLAUSE = (parent) => new RegExp(
  `,\\s*FOREIGN KEY\\s*\\(\\w+\\)\\s*REFERENCES\\s+${parent}\\s*\\(\\w+\\)(\\s+ON\\s+(DELETE|UPDATE)\\s+(CASCADE|SET NULL|SET DEFAULT|RESTRICT|NO ACTION))*`,
  'gi'
);

/** Rebuild lineups / lineup_players without their slates / players foreign keys. */
async function dropSqliteCascades(db) {
  const rebuilds = [];
  for (const [table, parent] of Object.entries(STALE_FKS)) {
    const fks = await db.all(`PRAGMA foreign_key_list(${table})`);
    if (!fks.some(fk => fk.table === parent)) continue;
    const [{ sql }] = await db.all(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`, table);
    const columns = (await db.all(`PRAGMA table_info(${table})`)).map(c => `"${c.name}"`).join(', ');
    const createNew = sql
      .replace(FK_CLAUSE(parent), '')
      .replace(/^CREATE TABLE\s+(IF NOT EXISTS\s+)?("?\w+"?)/i,`CREATE TABLE ${table}_rebuild`);
    rebuilds.push(`
      ${createNew};
      INSERT INTO ${table}_rebuild (${columns}) SELECT ${columns} FROM ${table};
      DROP TABLE ${table};
      ALTER TABLE ${table}_rebuild RENAME TO ${table};
    `);
  }
  if (rebuilds.length === 0) return;

  // foreign_keys can't change inside a transaction, and must be off so the
  // DROP doesn't cascade into the rows being kept
  await db.exec(`PRAGMA foreign_keys = OFF`);
  try {
    await db.exec(`BEGIN; ${rebuilds.join('\n')} COMMIT;`);
  } catch (error) {
    await db.exec(`ROLLBACK`).catch(() => {});
    throw error;
  } finally {
    await db.exec(`PRAGMA foreign_keys = ON`);
  }
  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_lineups_slate_id ON lineups(slate_id);
    CREATE INDEX IF NOT EXISTS idx_lineup_players_lineup_id ON lineup_players(lineup_id);
  `);
  console.log(`✓ Saved lineups no longer cascade-delete on slate resync`);
}

/**
 * Copy player details onto lineup_players rows saved before the columns
 * existed, while their players row is still around. Returns rows updated.
 */
async function backfillLineupPlayers(db) {
  const rows = await db.all(`
    SELECT lp.id AS lineup_player_id, p.*
    FROM lineup_players lp
    JOIN players p ON p.id = lp.player_id
    WHERE lp.player_external_id IS NULL
  `);
  for (const r of rows) {
    await db.run(`
      UPDATE lineup_players SET player_external_id = ?, site_player_id = ?, player_key = ?, name = ?, team = ?,
        opponent = ?, position = ?, roster_positions = ?, salary = ?, projected_points = ?
      WHERE id = ?
    `, r.player_id, r.site_player_id ?? null, playerKey(r.name), r.name, r.team ?? null, r.opponent ?? null,
      r.position, r.roster_positions ?? null, r.salary, r.projected_points ?? null, r.lineup_player_id);
  }
  return rows.length;
}
