import { test, beforeAll as before, afterAll as after } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';

// The route module opens the database on import; keep it off the real DB file
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nba-dfs-chat-feedback-'));
let db;
let chatService;
let server;
let baseUrl;

before(async () => {
  process.env.DATABASE_TYPE = 'sqlite';
  process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');
  db = (await import('../src/config/database.js')).default;
  await (await import('../src/config/schema.js')).createTables(db);
  chatService = (await import('../src/services/agenticChatService.js')).default;
  const router = (await import('../src/routes/chat.js')).default;

  const app = express();
  app.use(express.json());
  app.use('/api/chat', router);
  await new Promise(resolve => { server = app.listen(0, resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}/api/chat`;
});

after(async () => {
  await new Promise(resolve => server.close(resolve));
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const post = (body) => fetch(`${baseUrl}/feedback`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
});

test('POST /feedback stores a rating for an assistant message', async () => {
  const { sessionId } = await chatService.createSession(null, 'Feedback');

  const res = await post({ sessionId, messageId: 12, rating: 'up', content: 'Play Jokic.' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.success, true);
  assert.ok(body.id);

  const row = await db.get('SELECT * FROM chat_feedback WHERE id = ?', body.id);
  assert.equal(row.session_id, sessionId);
  assert.equal(row.message_id, 12);
  assert.equal(row.rating, 'up');
  assert.equal(row.message_excerpt, 'Play Jokic.');
});

test('POST /feedback allows a message without ids and trims long content', async () => {
  const res = await post({ rating: 'down', content: 'x'.repeat(5000) });
  assert.equal(res.status, 200);
  const { id } = await res.json();
  const row = await db.get('SELECT * FROM chat_feedback WHERE id = ?', id);
  assert.equal(row.session_id, null);
  assert.equal(row.rating, 'down');
  assert.equal(row.message_excerpt.length, 2000);
});

test('POST /feedback rejects an invalid rating', async () => {
  for (const body of [{}, { rating: 'meh' }, { rating: 1 }]) {
    const res = await post(body);
    assert.equal(res.status, 400);
    assert.equal((await res.json()).success, false);
  }
});
