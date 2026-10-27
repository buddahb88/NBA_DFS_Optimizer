import { DATABASE_TYPE } from './database.js';
import { dropSqliteForeignKeys } from './lineupMigrations.js';

/**
 * chat_sessions.slate_id foreign key migration (idempotent, runs on every startup)
 *
 * slates only holds the live slate (a sync deletes the rest), so a chat in
 * backtest mode on a past slate (slate_catalog / slate_player_snapshots)
 * failed its session insert, and every resync nulled old sessions' slate_id.
 * slate_id stays as plain text. SQLite rebuilds the table without the key;
 * Azure SQL never created one but drops it if present.
 */
export async function migrateChatSessionSlateFk(db) {
  if (DATABASE_TYPE === 'azuresql') {
    await db.exec(`
      DECLARE @fk NVARCHAR(256) = (SELECT TOP 1 name FROM sys.foreign_keys
        WHERE parent_object_id = OBJECT_ID('chat_sessions') AND referenced_object_id = OBJECT_ID('slates'));
      IF @fk IS NOT NULL EXEC('ALTER TABLE chat_sessions DROP CONSTRAINT [' + @fk + ']');
    `);
    return;
  }
  if (!(await dropSqliteForeignKeys(db, { chat_sessions: 'slates' }))) return;
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_chat_sessions_slate_id ON chat_sessions(slate_id)`);
  console.log(`✓ Chat sessions no longer reference the live slates table`);
}

/**
 * chat_messages.ui_blocks migration (idempotent, runs on every startup)
 *
 * JSON array of the typed result blocks (services/chatTools/uiBlocks.js)
 * streamed with an assistant message, so session history can re-render the
 * cards. NULL for user messages and answers without blocks.
 */
export async function migrateChatUiBlocks(db) {
  if (DATABASE_TYPE === 'azuresql') {
    await db.exec(`
      IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('chat_messages') AND name = 'ui_blocks')
        ALTER TABLE chat_messages ADD ui_blocks NVARCHAR(MAX);
    `);
  } else {
    const existing = new Set((await db.all(`PRAGMA table_info(chat_messages)`)).map(c => c.name));
    if (!existing.has('ui_blocks')) await db.exec(`ALTER TABLE chat_messages ADD COLUMN ui_blocks TEXT`);
  }
}
