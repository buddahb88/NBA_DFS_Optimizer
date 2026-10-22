import { test, describe, vi, beforeAll as before, afterAll as after } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import { buildPlayerPool } from './fixtures/playerPool.js';

// Chat ui blocks end to end: build_lineup attaches a lineup block, BaseAgent
// forwards blocks, StreamHandler streams ui_block events (deduped per tool
// call) and the /stream route persists them for session history.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nba-dfs-chat-ui-blocks-'));
process.env.DATABASE_TYPE = 'sqlite';
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');

let db;
let uiBlocks;
let server;
let baseUrl;
let chatService;

before(async () => {
  db = (await import('../src/config/database.js')).default;
  await (await import('../src/config/schema.js')).createTables(db);
  uiBlocks = await import('../src/services/chatTools/uiBlocks.js');
  chatService = (await import('../src/services/agenticChatService.js')).default;

  await db.run(`INSERT INTO slates (slate_id, name, site) VALUES ('opt', 'Main', 'draftkings')`);
  for (const p of buildPlayerPool()) {
    await db.run(
      `INSERT INTO players (id, slate_id, player_id, name, team, opponent, position, salary, projected_points, floor, ceiling, rostership, headshot)
       VALUES (?, 'opt', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      p.id, String(p.id), p.name, p.team, p.opponent, p.position, p.salary, p.projected_points, p.floor, p.ceiling, p.rostership,
      `https://img/${p.id}.png`);
  }

  const app = express();
  app.use(express.json());
  app.use('/api/chat', (await import('../src/routes/chat.js')).default);
  await new Promise(resolve => { server = app.listen(0, resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}/api/chat`;
});

after(async () => {
  vi.restoreAllMocks();
  await new Promise(resolve => server.close(resolve));
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const sample = (title) => uiBlocks.uiBlock('streaks', { title, kind: 'hot', players: [{ name: 'Tyrese Maxey', last3_avg: 45 }] });

function parseSse(text) {
  return text.split('\n\n').filter(Boolean).map((chunk) => {
    const type = chunk.match(/^event: (.+)$/m)?.[1];
    const data = chunk.match(/^data: (.+)$/m)?.[1];
    return { type, data: data ? JSON.parse(data) : null };
  });
}

describe('build_lineup', () => {
  test('attaches one valid lineup block per lineup; the LLM JSON is unchanged', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const OptimizerAgent = (await import('../src/agents/OptimizerAgent.js')).default;
    const tool = new OptimizerAgent().tools.find(t => t.name === 'build_lineup');
    const result = await tool.execute({ slateId: 'opt', minSalary: 0, numLineups: 2 });
    assert.equal(result.success, true);
    assert.doesNotMatch(JSON.stringify(result), /"slots"/);

    const blocks = uiBlocks.getUiBlocks(result);
    assert.equal(blocks.length, result.lineups.length);
    const [block] = blocks;
    assert.equal(uiBlocks.validateUiBlock(block).success, true);
    assert.equal(block.type, 'lineup');
    assert.equal(block.mode, 'cash');
    assert.deepEqual(block.slots.map(s => s.slot), ['PG', 'SG', 'SF', 'PF', 'C', 'G', 'F', 'UTIL']);
    const first = result.lineups[0];
    assert.equal(block.totals.salary, first.totalSalary);
    assert.equal(block.totals.projection, first.projectedPoints);
    const pg = block.slots[0].player;
    assert.equal(pg.name, first.players[0].player.name);
    assert.equal(pg.player_key, pg.name.toLowerCase());
    assert.equal(pg.headshot, `https://img/${first.players[0].player.id}.png`);
    assert.equal(pg.salary, first.players[0].player.salary);
  });
});

describe('BaseAgent.executeTool', () => {
  test('forwards attached blocks with the tool call id', async () => {
    const BaseAgent = (await import('../src/agents/BaseAgent.js')).default;
    const agent = new BaseAgent({
      name: 'test',
      tools: [{ name: 'cards', execute: async () => uiBlocks.attachUiBlocks({ success: true, n: 1 }, [sample('Hot')]) }],
    });
    const onUiBlock = vi.fn();
    const out = await agent.executeTool('cards', {}, { onUiBlock }, 'call_9');
    assert.equal(out, JSON.stringify({ success: true, n: 1 }));
    assert.equal(onUiBlock.mock.calls.length, 1);
    const [blocks, source] = onUiBlock.mock.calls[0];
    assert.equal(blocks[0].title, 'Hot');
    assert.deepEqual(source, { tool: 'cards', toolCallId: 'call_9' });

    // No blocks -> no callback
    const plain = new BaseAgent({ name: 'plain', tools: [{ name: 'p', execute: async () => ({ success: true }) }] });
    await plain.executeTool('p', {}, { onUiBlock }, 'call_10');
    assert.equal(onUiBlock.mock.calls.length, 1);
  });

  test('forwards blocks on the Claude (Foundry) path too', async () => {
    const BaseAgent = (await import('../src/agents/BaseAgent.js')).default;
    const agent = new BaseAgent({
      name: 'test',
      tools: [{ name: 'cards', execute: async () => uiBlocks.attachUiBlocks({ success: true }, [sample('Hot')]) }],
    });
    const responses = [
      { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tu_1', name: 'cards', input: {} }] },
      { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Done' }] },
    ];
    agent.claudeClient = { messages: { create: async () => responses.shift() } };
    const onUiBlock = vi.fn();
    const result = await agent.execute('who is hot?', {}, { onUiBlock });
    assert.equal(result.message, 'Done');
    assert.equal(onUiBlock.mock.calls.length, 1);
    assert.equal(onUiBlock.mock.calls[0][0][0].title, 'Hot');
    assert.equal(onUiBlock.mock.calls[0][1].tool, 'cards');
  });
});

describe('StreamHandler.sendUiBlocks', () => {
  test('ui_block events in order with message id, deduped per tool call', async () => {
    const { StreamHandler, createStreamCallbacks } = await import('../src/services/streamHandler.js');
    const written = [];
    const res = { writeHead() {}, write: (s) => written.push(s), end() {}, on() {} };
    const stream = new StreamHandler(res);
    stream.setupSSE();
    const { onUiBlock } = createStreamCallbacks(stream);

    onUiBlock([sample('A'), sample('B')], { tool: 'get_team_defense_profile', toolCallId: 'call_1' });
    onUiBlock([sample('A again')], { tool: 'get_team_defense_profile', toolCallId: 'call_1' });
    onUiBlock([sample('C')], { tool: 'get_streaks_and_consistency', toolCallId: 'call_2' });
    // No tool call id: each call still streams once
    onUiBlock([sample('D')], { tool: 'score_lineup' });

    const events = parseSse(written.join('')).filter(e => e.type === 'ui_block');
    assert.deepEqual(events.map(e => e.data.block.title), ['A', 'B', 'C', 'D']);
    assert.deepEqual(events.map(e => e.data.block.id), ['call_1:0', 'call_1:1', 'call_2:0', 'score_lineup-1:0']);
    assert.ok(events.every(e => e.data.messageId === stream.messageId));
    assert.equal(events[0].data.block.tool, 'get_team_defense_profile');
    assert.deepEqual(stream.uiBlocks.map(b => b.title), ['A', 'B', 'C', 'D']);
  });
});

describe('POST /stream', () => {
  test('streams ui_block events and persists them with the assistant message', async () => {
    vi.spyOn(chatService, 'chat').mockImplementation(async (message, sessionId, options) => {
      options.onToolCall('get_streaks_and_consistency', { type: 'hot' });
      options.onUiBlock([sample('Hot streaks')], { tool: 'get_streaks_and_consistency', toolCallId: 'call_1' });
      options.onUiBlock([sample('Hot streaks')], { tool: 'get_streaks_and_consistency', toolCallId: 'call_1' });
      options.onMessage('Maxey is heating up. [[block:call_1:0]]', true);
      return { success: true, message: 'Maxey is heating up. [[block:call_1:0]]', toolsUsed: [], agentsUsed: ['research'], iterations: 2 };
    });

    const res = await fetch(`${baseUrl}/stream`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'who is hot?' }),
    });
    const events = parseSse(await res.text());
    const types = events.map(e => e.type);
    const blockEvents = events.filter(e => e.type === 'ui_block');
    assert.equal(blockEvents.length, 1);
    assert.ok(types.indexOf('ui_block') < types.indexOf('message'));
    const done = events.find(e => e.type === 'done').data;
    assert.equal(done.messageId, blockEvents[0].data.messageId);
    assert.equal(done.uiBlockCount, 1);

    const history = await (await fetch(`${baseUrl}/sessions/${done.sessionId}`)).json();
    const [user, assistant] = history.messages;
    assert.deepEqual(user.uiBlocks, []);
    assert.equal(user.ui_blocks, undefined);
    assert.deepEqual(assistant.uiBlocks, [blockEvents[0].data.block]);
    assert.equal(assistant.uiBlocks[0].id, 'call_1:0');
    assert.equal(uiBlocks.validateUiBlock(assistant.uiBlocks[0]).success, true);
  });

  test('answers without blocks persist no blocks', async () => {
    vi.spyOn(chatService, 'chat').mockResolvedValue({ success: true, message: 'Plain answer', toolsUsed: [], agentsUsed: [], iterations: 1 });
    const events = parseSse(await (await fetch(`${baseUrl}/stream`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'hi' }),
    })).text());
    assert.equal(events.some(e => e.type === 'ui_block'), false);
    const { sessionId } = events.find(e => e.type === 'done').data;
    const { messages } = await (await fetch(`${baseUrl}/sessions/${sessionId}`)).json();
    assert.deepEqual(messages.map(m => m.uiBlocks), [[], []]);
    const raw = await db.get(`SELECT ui_blocks FROM chat_messages WHERE session_id = ? AND role = 'assistant'`, sessionId);
    assert.equal(raw.ui_blocks, null);
  });
});
