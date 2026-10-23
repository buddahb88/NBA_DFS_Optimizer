import { test, describe, vi, beforeAll as before, afterAll as after } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import { buildPlayerPool } from './fixtures/playerPool.js';

// A "latest" slate from an earlier night must say so: get_current_slate,
// slate-based tools, suggestions and the slates API carry the slate date and
// a stale flag, and the prompts tell the model to stop and ask for a sync.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nba-dfs-stale-slate-'));
process.env.DATABASE_TYPE = 'sqlite';
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');

const SLATE_NIGHT = '2026-10-21';
const TODAY = '2026-10-23';
let db;
let server;
let baseUrl;

before(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(`${TODAY}T16:00:00Z`)); // noon ET
  vi.spyOn(console, 'log').mockImplementation(() => {});

  db = (await import('../src/config/database.js')).default;
  await (await import('../src/config/schema.js')).createTables(db);

  await db.run(`INSERT INTO slates (slate_id, name, site, created_at) VALUES ('29805', 'All', 'draftkings', '2026-10-21 21:24:37')`);
  for (const p of buildPlayerPool()) {
    await db.run(
      `INSERT INTO players (id, slate_id, player_id, name, team, opponent, position, salary, projected_points, floor, ceiling, rostership, raw_data)
       VALUES (?, '29805', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      p.id, String(p.id), p.name, p.team, p.opponent, p.position, p.salary, p.projected_points, p.floor, p.ceiling, p.rostership,
      JSON.stringify({ game: { dateTime: `${SLATE_NIGHT} 19:30:00` } }));
  }

  const app = express();
  app.use(express.json());
  app.use('/api/chat', (await import('../src/routes/chat.js')).default);
  app.use('/api/slates', (await import('../src/routes/slates.js')).default);
  await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}/api`;
});

after(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await new Promise(resolve => server.close(resolve));
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const assertStaleSlate = (slate) => {
  assert.equal(slate.slateDate, SLATE_NIGHT);
  assert.equal(slate.today, TODAY);
  assert.equal(slate.isStale, true);
  assert.equal(slate.daysOld, 2);
  assert.match(slate.warning, /sync tonight's slate/i);
};

describe('get_current_slate', () => {
  test('orchestrator tool reports the slate date, today and a stale warning', async () => {
    const chatService = (await import('../src/services/agenticChatService.js')).default;
    const result = JSON.parse(await chatService.executeOrchestratorTool('get_current_slate', {}, {}, {}));
    assert.equal(result.success, true);
    assert.equal(result.slate.slateId, '29805');
    assertStaleSlate(result.slate);
    assert.match(result.message, /STALE/);
  });

  test('ResearchAgent tool reports the same', async () => {
    const ResearchAgent = (await import('../src/agents/ResearchAgent.js')).default;
    const tool = new ResearchAgent().tools.find(t => t.name === 'get_current_slate');
    const result = await tool.execute({});
    assert.equal(result.success, true);
    assert.equal(result.slate.playerCount, 32);
    assertStaleSlate(result.slate);
  });

  test('aiChatService tool reports the same', async () => {
    const aiChatService = (await import('../src/services/aiChatService.js')).default;
    const tool = aiChatService.createTools().find(t => t.name === 'get_current_slate');
    const result = JSON.parse(await tool.func({}));
    assert.equal(result.success, true);
    assertStaleSlate(result.slate);
  });
});

describe('slate-based tools state the date they cover', () => {
  const assertDated = (result) => {
    assert.equal(result.slateDate, SLATE_NIGHT);
    assert.equal(result.isStale, true);
    assert.match(result.staleWarning, /2026-10-21/);
  };

  test('OptimizerAgent build_lineup and get_player_pool', async () => {
    const OptimizerAgent = (await import('../src/agents/OptimizerAgent.js')).default;
    const agent = new OptimizerAgent();
    const lineup = await agent.tools.find(t => t.name === 'build_lineup').execute({ slateId: '29805', minSalary: 0 });
    assert.equal(lineup.success, true);
    assertDated(lineup);
    assertDated(await agent.tools.find(t => t.name === 'get_player_pool').execute({ slateId: '29805', limit: 3 }));
  });

  test('aiChatService build_lineup', async () => {
    const aiChatService = (await import('../src/services/aiChatService.js')).default;
    const tool = aiChatService.createTools().find(t => t.name === 'build_lineup');
    const result = JSON.parse(await tool.func({ slateId: '29805', minSalary: 0 }));
    assert.equal(result.success, true);
    assertDated(result);
  });

  test('research slate tools default to the latest slate and carry its date', async () => {
    const { createResearchTools } = await import('../src/services/chatTools/researchTools.js');
    const tools = Object.fromEntries(createResearchTools().map(t => [t.name, t]));
    for (const name of ['get_archetype_matchups', 'get_usage_bumps', 'get_missing_players']) {
      const result = await tools[name].execute({});
      assert.equal(result.success, true, `${name}: ${result.message}`);
      assert.equal(result.slateId, '29805');
      assertDated(result);
    }
  });
});

describe('prompts guard against stale slates', () => {
  const GUARD = /isStale[\s\S]*(sync|Sync)[\s\S]*(Home|Data Status)/;

  test('orchestrator prompt', async () => {
    const { ORCHESTRATOR_SYSTEM_PROMPT } = await import('../src/services/agenticChatService.js');
    assert.match(ORCHESTRATOR_SYSTEM_PROMPT, GUARD);
    assert.match(ORCHESTRATOR_SYSTEM_PROMPT, /past date/i);
  });

  test('research, optimizer and aiChatService prompts', async () => {
    const ResearchAgent = (await import('../src/agents/ResearchAgent.js')).default;
    const OptimizerAgent = (await import('../src/agents/OptimizerAgent.js')).default;
    const aiChatService = (await import('../src/services/aiChatService.js')).default;
    assert.match(new ResearchAgent().systemPrompt, GUARD);
    assert.match(new OptimizerAgent().systemPrompt, GUARD);
    assert.match(aiChatService.getSystemPrompt(), GUARD);
  });
});

describe('GET /chat/suggestions', () => {
  test('a stale slate prompts a sync instead of slate-specific suggestions', async () => {
    const body = await (await fetch(`${baseUrl}/chat/suggestions`)).json();
    assert.equal(body.success, true);
    assert.equal(body.slateDate, SLATE_NIGHT);
    assert.equal(body.isStale, true);
    const kinds = body.suggestions.map(s => s.kind);
    assert.equal(kinds[0], 'sync_slate');
    for (const k of ['usage_bump', 'archetype_edge', 'game_stack', 'hot_streak', 'value_play']) {
      assert.ok(!kinds.includes(k), `${k} is not suggested for a stale slate`);
    }
    assert.match(body.suggestions[0].detail, /2026-10-21/);
  });
});

describe('GET /slates', () => {
  test('each slate carries its date and staleness', async () => {
    const [slate] = await (await fetch(`${baseUrl}/slates`)).json();
    assert.equal(slate.slate_id, '29805');
    assert.equal(slate.slate_date, SLATE_NIGHT);
    assert.equal(slate.is_stale, true);
    assert.equal(slate.days_old, 2);
  });
});
