import { test, describe, onTestFinished, beforeAll as before, afterAll as after } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import Database from 'better-sqlite3';

// slates only holds the live slate (a sync deletes the others); past slates
// live in slate_catalog / slate_player_snapshots. Writes that carry a past
// (backtest) slate id must not need a slates row.
const LIVE = '29931';
const PAST = '29894';
const PAST_DATE = '2026-10-25';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nba-dfs-past-slate-'));
process.env.DATABASE_TYPE = 'sqlite';
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');

let db;
let chatService;
let server;
let baseUrl;

// Orchestrator stand-in: answers straight away, no tools
const directClient = {
  chat: { completions: { create: async () => ({ choices: [{ message: { role: 'assistant', content: 'Backtest answer' } }] }) } },
};

before(async () => {
  db = (await import('../src/config/database.js')).default;
  await (await import('../src/config/schema.js')).createTables(db);
  await db.run(`INSERT INTO slates (slate_id, name, site) VALUES (?, 'All', 'draftkings')`, LIVE);

  chatService = (await import('../src/services/agenticChatService.js')).default;
  chatService.client = directClient;
  chatService.deploymentName = 'scripted';
  chatService.initialized = true;

  const app = express();
  app.use(express.json());
  app.use('/api/chat', (await import('../src/routes/chat.js')).default);
  await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}/api/chat`;
});

after(async () => {
  await new Promise(resolve => server.close(resolve));
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** SSE events of a POST /chat/stream response as [{ event, data }]. */
async function streamEvents(body) {
  const res = await fetch(`${baseUrl}/stream`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const text = await res.text();
  return text.split('\n\n').filter(Boolean).map(chunk => {
    const event = chunk.match(/^event: (.*)$/m)?.[1];
    const data = chunk.match(/^data: (.*)$/m)?.[1];
    return { event, data: data ? JSON.parse(data) : null };
  });
}

describe('chat sessions on a past slate', () => {
  test('createSession stores a slate id that is not in slates', async () => {
    const result = await chatService.createSession(PAST, 'Backtest');
    assert.equal(result.success, true, result.error);
    const row = await db.get(`SELECT slate_id FROM chat_sessions WHERE id = ?`, result.sessionId);
    assert.equal(row.slate_id, PAST);
  });

  test('POST /chat/stream in backtest mode creates the session and answers', async () => {
    const events = await streamEvents({
      message: 'Build me a cash lineup', slateId: PAST, slateDate: PAST_DATE, mode: 'cash',
    });
    const errors = events.filter(e => e.event === 'error');
    assert.deepEqual(errors, []);
    const created = events.find(e => e.event === 'session_created');
    assert.ok(created, 'no session_created event');
    assert.ok(events.some(e => e.event === 'done'), 'no done event');

    const { sessionId } = created.data;
    const session = await db.get(`SELECT slate_id FROM chat_sessions WHERE id = ?`, sessionId);
    assert.equal(session.slate_id, PAST);
    const roles = (await db.all(`SELECT role FROM chat_messages WHERE session_id = ? ORDER BY id`, sessionId)).map(m => m.role);
    assert.deepEqual(roles, ['user', 'assistant']);
  });

  test('a live slate sync deleting slates leaves chat sessions alone', async () => {
    const { sessionId } = await chatService.createSession(LIVE, 'Live');
    await db.run(`DELETE FROM slates`);
    const row = await db.get(`SELECT slate_id FROM chat_sessions WHERE id = ?`, sessionId);
    assert.equal(row.slate_id, LIVE);
    await db.run(`INSERT INTO slates (slate_id, name, site) VALUES (?, 'All', 'draftkings')`, LIVE);
  });

  test('chat feedback on a past-slate session saves', async () => {
    const { sessionId } = await chatService.createSession(PAST, 'Feedback');
    const { saveFeedback } = await import('../src/services/chatFeedbackService.js');
    const result = await saveFeedback({ sessionId, rating: 'up', content: 'Backtest answer' });
    assert.equal(result.success, true);
  });
});

describe('other writes keyed by a past slate id', () => {
  test('a lineup saved for a past slate keeps its players', async () => {
    const lineupModel = (await import('../src/models/lineupModel.js')).default;
    const lineupId = await lineupModel.create({ slateId: PAST, name: 'Backtest cash', totalSalary: 49800, projectedPoints: 280 });
    await lineupModel.addPlayers(lineupId, [{ playerId: 999999, positionSlot: 'PG' }]);
    const lineup = await lineupModel.getById(lineupId);
    assert.equal(lineup.slate_id, PAST);
    assert.equal(lineup.players.length, 1);
  });

  test('player settings for a past slate save', async () => {
    const playerSettingsModel = (await import('../src/models/playerSettingsModel.js')).default;
    const saved = await playerSettingsModel.upsert(PAST, 'rw-1', { lock: true });
    assert.equal(saved.lock, true);
    const row = await db.get(`SELECT locked FROM player_settings WHERE slate_id = ? AND player_id = 'rw-1'`, PAST);
    assert.equal(row.locked, 1);
  });
});

describe('legacy sqlite chat_sessions schema', () => {
  test('migration drops the slates foreign key and keeps sessions, messages and indexes', async () => {
    const legacy = new Database(path.join(tmpDir, 'legacy.db'));
    onTestFinished(() => legacy.open && legacy.close());
    legacy.pragma('foreign_keys = ON');
    legacy.exec(`
      CREATE TABLE slates (id INTEGER PRIMARY KEY AUTOINCREMENT, slate_id TEXT UNIQUE NOT NULL, name TEXT NOT NULL);
      CREATE TABLE chat_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT,
        slate_id TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (slate_id) REFERENCES slates(slate_id) ON DELETE SET NULL
      );
      CREATE TABLE chat_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id INTEGER NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        FOREIGN KEY (session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE
      );
      CREATE INDEX idx_chat_sessions_slate_id ON chat_sessions(slate_id);
      INSERT INTO slates (slate_id, name) VALUES ('${LIVE}', 'All');
      INSERT INTO chat_sessions (title, slate_id) VALUES ('Old chat', '${LIVE}');
      INSERT INTO chat_messages (session_id, role, content) VALUES (1, 'user', 'hi');
    `);

    const { migrateChatSessionSlateFk } = await import('../src/config/chatMigrations.js');
    const wrap = {
      all: async (q, ...p) => legacy.prepare(q).all(...p),
      run: async (q, ...p) => legacy.prepare(q).run(...p),
      exec: async (q) => legacy.exec(q)
    };
    await migrateChatSessionSlateFk(wrap);
    await migrateChatSessionSlateFk(wrap);

    assert.deepEqual(legacy.pragma('foreign_key_list(chat_sessions)'), []);
    assert.deepEqual(legacy.pragma('foreign_key_list(chat_messages)').map(f => [f.table, f.on_delete]), [['chat_sessions', 'CASCADE']]);
    assert.equal(legacy.pragma('foreign_keys', { simple: true }), 1);
    assert.ok(legacy.pragma('index_list(chat_sessions)').some(i => i.name === 'idx_chat_sessions_slate_id'));
    assert.deepEqual(legacy.prepare(`SELECT id, title, slate_id FROM chat_sessions`).all(), [{ id: 1, title: 'Old chat', slate_id: LIVE }]);

    // A past slate id now inserts; a slate delete no longer nulls the session
    legacy.prepare(`INSERT INTO chat_sessions (title, slate_id) VALUES ('Backtest', ?)`).run(PAST);
    legacy.exec(`DELETE FROM slates`);
    assert.equal(legacy.prepare(`SELECT slate_id FROM chat_sessions WHERE id = 1`).get().slate_id, LIVE);
    // AUTOINCREMENT continues after the kept rows
    assert.equal(legacy.prepare(`SELECT id FROM chat_sessions WHERE title = 'Backtest'`).get().id, 2);

    legacy.exec(`DELETE FROM chat_sessions WHERE id = 1`);
    assert.equal(legacy.prepare(`SELECT COUNT(*) AS n FROM chat_messages`).get().n, 0, 'deleting a session still cascades');
  });
});
