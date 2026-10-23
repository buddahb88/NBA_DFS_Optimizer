import { test, describe, vi, beforeAll as before, afterAll as after } from 'vitest';
import assert from 'node:assert/strict';
import express from 'express';

// Chat bar in backtest mode: POST /chat/stream with slateDate tells the
// agents to use that saved slate; the stored user message stays as typed.
const chat = vi.hoisted(() => ({
  createSession: vi.fn(async () => ({ success: true, sessionId: 7 })),
  getChatHistory: vi.fn(async () => ({ success: true, messages: [] })),
  saveMessage: vi.fn(async () => ({ success: true })),
  chat: vi.fn(async () => ({ success: true, message: 'ok', toolsUsed: [], agentsUsed: [], iterations: 1 })),
}));
vi.mock('../src/services/agenticChatService.js', () => ({ default: chat }));

let server;
let baseUrl;
let withBacktestContext;

before(async () => {
  const routes = await import('../src/routes/chat.js');
  ({ withBacktestContext } = routes);
  const app = express();
  app.use(express.json());
  app.use('/api/chat', routes.default);
  await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}/api/chat`;
});

after(async () => {
  await new Promise(resolve => server.close(resolve));
});

const stream = (body) => fetch(`${baseUrl}/stream`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
}).then(async r => ({ status: r.status, text: await r.text() }));

describe('POST /chat/stream backtest context', () => {
  test('slateDate adds the backtest note for the agents; history keeps the user text', async () => {
    chat.chat.mockClear();
    chat.saveMessage.mockClear();
    const res = await stream({ message: 'Build me a GPP lineup', slateId: '29805', slateDate: '2026-10-21' });
    assert.equal(res.status, 200);
    const [sent, sessionId, opts] = chat.chat.mock.calls[0];
    assert.equal(sessionId, 7);
    assert.match(sent, /Backtest mode/);
    assert.match(sent, /slateDate "2026-10-21"/);
    assert.match(sent, /Build me a GPP lineup$/);
    assert.equal(opts.slateId, '29805');
    assert.deepEqual(chat.saveMessage.mock.calls[0].slice(0, 3), [7, 'user', 'Build me a GPP lineup']);
  });

  test('live questions are passed through unchanged; a bad slateDate is a 400', async () => {
    chat.chat.mockClear();
    await stream({ message: 'Best plays tonight', slateId: '29806' });
    assert.equal(chat.chat.mock.calls[0][0], 'Best plays tonight');
    assert.equal((await stream({ message: 'x', slateDate: '10/21' })).status, 400);
    assert.equal(withBacktestContext('hi', {}), 'hi');
  });
});
