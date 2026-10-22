import { test, beforeAll as before, afterAll as after } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';

// The route module opens the database on import; keep it off the real DB file
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nba-dfs-chat-route-'));
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

const patch = (id, body) => fetch(`${baseUrl}/sessions/${id}`, {
  method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
});

test('PATCH /sessions/:id renames the session', async () => {
  const { sessionId } = await chatService.createSession(null, 'Old title');

  const res = await patch(sessionId, { title: '  Lakers stack ideas  ' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.success, true);
  assert.equal(body.session.title, 'Lakers stack ideas');

  const { sessions } = await (await fetch(`${baseUrl}/sessions`)).json();
  assert.equal(sessions.find(s => s.id === sessionId).title, 'Lakers stack ideas');
});

test('PATCH /sessions/:id rejects an empty or missing title', async () => {
  const { sessionId } = await chatService.createSession(null, 'Keep me');

  for (const body of [{ title: '   ' }, {}, { title: 42 }]) {
    const res = await patch(sessionId, body);
    assert.equal(res.status, 400);
    assert.equal((await res.json()).success, false);
  }
  const { sessions } = await (await fetch(`${baseUrl}/sessions`)).json();
  assert.equal(sessions.find(s => s.id === sessionId).title, 'Keep me');
});

test('PATCH /sessions/:id caps long titles at 120 characters', async () => {
  const { sessionId } = await chatService.createSession(null, 'Short');
  const res = await patch(sessionId, { title: 'x'.repeat(300) });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).session.title.length, 120);
});

test('PATCH /sessions/:id returns 404 for an unknown session', async () => {
  const res = await patch(999999, { title: 'Nope' });
  assert.equal(res.status, 404);
  assert.equal((await res.json()).success, false);
});
