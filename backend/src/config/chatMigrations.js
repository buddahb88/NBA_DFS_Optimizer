import { DATABASE_TYPE } from './database.js';

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
