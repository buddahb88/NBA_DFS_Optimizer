import { DATABASE_TYPE } from './database.js';
import { DEFAULT_SITE, getEligibleSlots, isValidSite } from './sites.js';

/**
 * Multi-site schema migration (idempotent, runs on every startup)
 *
 * - slates.site            DFS site key from config/sites.js (default 'draftkings')
 * - players.site_player_id the site's own player ID, used for CSV upload
 *                          (players.player_id stays the RotoWire ID)
 * - players.roster_positions  slots the player can fill on the slate's site,
 *                             slash-delimited like DraftKings' "Roster Position"
 *                             column, e.g. "PG/G/UTIL"
 *
 * Existing slates become 'draftkings'. Existing players get roster_positions
 * from their position and their slate's site. site_player_id stays NULL
 * because the DK IDs were never stored. Ingestion has to fill it in.
 */
export async function migrateSiteColumns(db) {
  if (DATABASE_TYPE === 'azuresql') {
    await db.exec(`
      IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('slates') AND name = 'site')
        ALTER TABLE slates ADD site NVARCHAR(20) NOT NULL CONSTRAINT DF_slates_site DEFAULT '${DEFAULT_SITE}';
      IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('players') AND name = 'site_player_id')
        ALTER TABLE players ADD site_player_id NVARCHAR(100);
      IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('players') AND name = 'roster_positions')
        ALTER TABLE players ADD roster_positions NVARCHAR(100);
    `);
    // Separate batch: SQL Server can't compile a reference to slates.site
    // in the same batch that adds the column
    await db.exec(`
      IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'idx_slates_site')
        CREATE INDEX idx_slates_site ON slates(site);
    `);
  } else {
    const slateColumns = new Set((await db.all(`PRAGMA table_info(slates)`)).map(c => c.name));
    if (!slateColumns.has('site')) {
      await db.exec(`ALTER TABLE slates ADD COLUMN site TEXT NOT NULL DEFAULT '${DEFAULT_SITE}'`);
    }

    const playerColumns = new Set((await db.all(`PRAGMA table_info(players)`)).map(c => c.name));
    if (!playerColumns.has('site_player_id')) {
      await db.exec(`ALTER TABLE players ADD COLUMN site_player_id TEXT`);
    }
    if (!playerColumns.has('roster_positions')) {
      await db.exec(`ALTER TABLE players ADD COLUMN roster_positions TEXT`);
    }
    await db.exec(`CREATE INDEX IF NOT EXISTS idx_slates_site ON slates(site)`);
  }

  await db.run(`UPDATE slates SET site = ? WHERE site IS NULL OR site = ''`, DEFAULT_SITE);

  await backfillRosterPositions(db);
}

// Slate site for a player row; players whose slate is missing count as DraftKings
const PLAYER_SITE_SQL = `COALESCE((SELECT s.site FROM slates s WHERE s.slate_id = players.slate_id), '${DEFAULT_SITE}')`;

async function backfillRosterPositions(db) {
  const pending = await db.all(`
    SELECT DISTINCT position, ${PLAYER_SITE_SQL} AS site
    FROM players
    WHERE roster_positions IS NULL
  `);

  let updated = 0;
  for (const { position, site } of pending) {
    if (!isValidSite(site)) continue;
    const slots = getEligibleSlots(site, position);
    if (slots.length === 0) continue;
    const result = await db.run(`
      UPDATE players SET roster_positions = ?
      WHERE roster_positions IS NULL AND position = ? AND ${PLAYER_SITE_SQL} = ?
    `, slots.join('/'), position, site);
    updated += result?.changes || 0;
  }

  if (updated > 0) {
    console.log(`✓ Backfilled roster_positions for ${updated} player row(s)`);
  }
}
