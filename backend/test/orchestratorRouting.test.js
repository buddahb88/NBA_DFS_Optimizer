import { test, describe, vi, beforeAll as before, afterAll as after } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { buildPlayerPool } from './fixtures/playerPool.js';

// The orchestrator only owns delegate_to_agent and get_current_slate. When
// the model calls an agent's tool itself (user prompts like "use
// get_usage_bumps"), the call is handed to the owning agent in the same step
// instead of failing with "Unknown tool".
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nba-dfs-orchestrator-routing-'));
process.env.DATABASE_TYPE = 'sqlite';
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');

let db;
let service;

before(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  db = (await import('../src/config/database.js')).default;
  await (await import('../src/config/schema.js')).createTables(db);
  await db.run(`INSERT INTO slates (slate_id, name, site, created_at) VALUES ('29805', 'All', 'draftkings', '2026-10-21 21:24:37')`);
  for (const p of buildPlayerPool()) {
    await db.run(
      `INSERT INTO players (id, slate_id, player_id, name, team, opponent, position, salary, projected_points, floor, ceiling, rostership, raw_data)
       VALUES (?, '29805', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      p.id, String(p.id), p.name, p.team, p.opponent, p.position, p.salary, p.projected_points, p.floor, p.ceiling, p.rostership,
      JSON.stringify({ game: { dateTime: '2026-10-21 19:30:00' } }));
  }
  service = (await import('../src/services/agenticChatService.js')).default;
});

after(() => {
  vi.restoreAllMocks();
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Orchestrator model that calls `tool` itself, then answers with the tool turn's content. */
function misroutingClient(tool, args) {
  const calls = [];
  const create = async (request) => {
    const offered = (request.tools || []).map(t => t.function.name);
    calls.push({ offered });
    const last = request.messages[request.messages.length - 1];
    if (last.role === 'user') {
      return { choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: tool, arguments: JSON.stringify(args) } }] } }] };
    }
    return { choices: [{ message: { role: 'assistant', content: last.content } }] };
  };
  return { calls, chat: { completions: { create } } };
}

async function runChat(tool, args, maxIterations = 10) {
  const client = misroutingClient(tool, args);
  service.client = client;
  service.deploymentName = 'scripted';
  service.initialized = true;
  service.claudeClient = null;
  for (const agent of Object.values(service.agents)) {
    agent.client = client;
    agent.deploymentName = 'scripted';
  }

  const events = [];
  const record = (type) => (...data) => events.push([type, ...data]);
  const response = await service.chat(`use ${tool}`, 1, {
    maxIterations,
    onThinking: record('thinking'),
    onToolCall: record('tool_call'),
    onToolResult: record('tool_result'),
    onUiBlock: record('ui_block'),
    onAgentSpawn: record('agent_spawn'),
    onAgentComplete: record('agent_complete'),
    onIteration: record('iteration'),
  });
  return { response, events, client, toolResult: JSON.parse(response.message) };
}

describe('tool ownership map', () => {
  test('comes from the agents\' own tool lists', async () => {
    const { RESEARCH_TOOL_NAMES } = await import('../src/services/chatTools/researchTools.js');
    const { HISTORY_TOOL_NAMES } = await import('../src/services/chatTools/historyTools.js');
    const owners = service.toolOwners;
    for (const name of RESEARCH_TOOL_NAMES) assert.equal(owners[name], 'research', name);
    for (const name of HISTORY_TOOL_NAMES) assert.equal(owners[name], 'analyst', name);
    for (const name of ['build_lineup', 'validate_lineup', 'get_player_pool']) assert.equal(owners[name], 'optimizer', name);
    for (const name of ['sql_query', 'search_players', 'get_slate_summary', 'get_game_environment']) assert.equal(owners[name], 'research', name);
    // Every agent tool has an owner that actually has it
    for (const [agentName, agent] of Object.entries(service.agents)) {
      for (const t of agent.tools) {
        if (t.name === 'get_current_slate') continue;
        assert.ok(service.agents[owners[t.name]].tools.some(x => x.name === t.name), `${agentName}:${t.name}`);
      }
    }
    // The orchestrator's own tools are not routed
    assert.equal(owners.get_current_slate, undefined);
    assert.equal(owners.delegate_to_agent, undefined);
  });

  test('the orchestrator prompt lists each agent\'s tools and says to route named tools', async () => {
    const { ORCHESTRATOR_SYSTEM_PROMPT } = await import('../src/services/agenticChatService.js');
    assert.match(ORCHESTRATOR_SYSTEM_PROMPT, /optimizer: .*build_lineup/);
    assert.match(ORCHESTRATOR_SYSTEM_PROMPT, /research: .*get_usage_bumps/);
    assert.match(ORCHESTRATOR_SYSTEM_PROMPT, /analyst: .*get_player_history/);
    assert.match(ORCHESTRATOR_SYSTEM_PROMPT, /plan and delegate/i);
    assert.match(ORCHESTRATOR_SYSTEM_PROMPT, /names a tool.*delegate/i);
  });
});

describe('orchestrator calling an agent\'s tool is routed to that agent', () => {
  const cases = [
    { tool: 'get_usage_bumps', args: {}, agent: 'research' },
    { tool: 'get_opportunity_radar', args: { mode: 'gpp', maxSalary: 6500 }, agent: 'research' },
    { tool: 'build_lineup', args: { slateId: '29805', minSalary: 0 }, agent: 'optimizer' },
    { tool: 'get_player_history', args: { playerName: 'Nobody Atall' }, agent: 'analyst' },
  ];

  for (const c of cases) {
    test(`${c.tool} -> ${c.agent}`, async () => {
      const { response, events, client, toolResult } = await runChat(c.tool, c.args);

      assert.equal(response.success, true);
      assert.doesNotMatch(response.message, /Unknown tool/);
      assert.equal(toolResult.routedTo, c.agent);
      assert.equal(toolResult.tool, c.tool);
      assert.ok(toolResult.result, 'carries the tool output');
      assert.deepEqual(response.agentsUsed, [c.agent]);
      assert.deepEqual(response.toolsUsed.map(t => [t.name, t.agent]), [[c.tool, c.agent]]);

      // Timeline: agent_spawn -> tool_call -> tool_result -> agent_complete, all for the owning agent
      const types = events.map(e => e[0]).filter(t => t !== 'thinking' && t !== 'iteration' && t !== 'ui_block');
      assert.deepEqual(types, ['agent_spawn', 'tool_call', 'tool_result', 'agent_complete']);
      const spawn = events.find(e => e[0] === 'agent_spawn');
      assert.equal(spawn[1], c.agent);
      assert.match(spawn[2], new RegExp(`${c.tool}.*orchestrator|orchestrator.*${c.tool}`));
      assert.equal(events.find(e => e[0] === 'tool_call')[1], c.tool);
      assert.equal(events.find(e => e[0] === 'agent_complete')[1], c.agent);

      // One step: no sub-agent model loop, two orchestrator turns (call + answer)
      assert.equal(response.iterations, 2);
      assert.ok(client.calls.every(call => call.offered.includes('delegate_to_agent')), 'no sub-agent LLM calls');
    });
  }

  test('routing fits a two-step budget', async () => {
    const { response } = await runChat('get_usage_bumps', {}, 2);
    assert.equal(response.maxIterationsReached, undefined);
    assert.equal(JSON.parse(response.message).routedTo, 'research');
  });

  test('build_lineup output reaches the orchestrator', async () => {
    const { toolResult } = await runChat('build_lineup', { slateId: '29805', minSalary: 0 });
    assert.equal(toolResult.result.success, true);
    assert.ok(toolResult.result.lineups[0].players.length > 0);
  });
});

describe('tools no agent owns', () => {
  test('return a clear error naming the agents and their tools', async () => {
    const { response, events } = await runChat('get_moon_phase', {});
    const result = JSON.parse(response.message);
    assert.equal(result.success, false);
    assert.match(result.error, /Unknown tool: get_moon_phase/);
    assert.match(result.error, /delegate_to_agent/);
    assert.ok(result.toolOwners.research.includes('get_usage_bumps'));
    assert.ok(result.toolOwners.optimizer.includes('build_lineup'));
    assert.equal(events.some(e => e[0] === 'agent_spawn'), false);
  });
});
