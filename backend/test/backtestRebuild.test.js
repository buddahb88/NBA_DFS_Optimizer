import { test, describe, vi, beforeAll as before, afterAll as after } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import { buildPlayerPool } from './fixtures/playerPool.js';

// Rebuild a saved past slate while tonight's slate is live: optimizer,
// review, breakdown, Player Pool, Tonight, portfolio and the chat tools read
// the snapshot, never touch players, and report actual points.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nba-dfs-backtest-'));
process.env.DATABASE_TYPE = 'sqlite';
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');

const PAST = '2026-10-21';
let TODAY;
let db;
let baseUrl;
let server;
let livePlayersBefore;
let pastPlayers;

const raw = (date) => JSON.stringify({ game: { dateTime: `${date} 19:30:00` }, isHome: true });

async function seedSlate(slateId, date, pool) {
  await db.run(`INSERT INTO slates (slate_id, name, sport, start_time, site) VALUES (?, 'Main', 'NBA', '7:30 PM', 'draftkings')`, slateId);
  const playerModel = (await import('../src/models/playerModel.js')).default;
  await playerModel.bulkCreateOrUpdate(slateId, pool.map(p => ({
    playerId: `${slateId}-${p.id}`, name: p.name, team: p.team, opponent: p.opponent, position: p.position,
    salary: p.salary, projectedPoints: p.projected_points, projectedMinutes: 30, floor: p.floor, ceiling: p.ceiling,
    rostership: p.rostership, stdDev: 8, boomProbability: 10, bustProbability: 30, leverageScore: 2, rawData: raw(date)
  })));
}

before(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  db = (await import('../src/config/database.js')).default;
  await (await import('../src/config/schema.js')).createTables(db);
  const { easternDate, snapshotSlate } = await import('../src/services/slateSnapshotService.js');
  TODAY = easternDate(new Date());

  // 10/21 synced and snapshotted pre-lock, then tonight's slate synced over it
  await seedSlate('past', PAST, buildPlayerPool());
  await snapshotSlate('past', { now: new Date(`${PAST}T15:00:00Z`) });
  await db.run('DELETE FROM players');
  await db.run('DELETE FROM slates');
  await seedSlate('tonight', TODAY, buildPlayerPool().map(p => ({ ...p, name: `${p.name} Tonight` })));
  livePlayersBefore = await db.all('SELECT * FROM players ORDER BY id');

  // Box scores for 10/21: everyone played, actual = projection + 5 (Player 1 DNP)
  const { loadSlatePlayers, resolveSlate } = await import('../src/services/slateSource.js');
  pastPlayers = await loadSlatePlayers(await resolveSlate({ slateDate: PAST }));
  for (const p of pastPlayers) {
    const dnp = p.name === 'Player 1';
    await db.run(`INSERT INTO historical_games (player_name, player_key, team, opponent, game_date, minutes, points, dk_fantasy_points,
        season, season_type) VALUES (?, ?, ?, ?, ?, ?, 10, ?, '2026-27', 'regular')`,
      p.name, p.player_key, p.team, p.opponent, PAST, dnp ? 0 : 30, dnp ? 0 : p.projected_points + 5);
  }

  const app = express();
  app.use(express.json());
  app.use('/api/optimizer', (await import('../src/routes/optimizer.js')).default);
  app.use('/api/players', (await import('../src/routes/players.js')).default);
  app.use('/api/archetypes', (await import('../src/routes/archetypes.js')).default);
  app.use('/api/portfolio', (await import('../src/routes/portfolio.js')).default);
  await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}/api`;
});

after(async () => {
  vi.restoreAllMocks();
  // Nothing in a backtest writes to the live players table
  assert.deepEqual(await db.all('SELECT * FROM players ORDER BY id'), livePlayersBefore);
  await new Promise(resolve => server.close(resolve));
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const post = async (url, body) => {
  const res = await fetch(`${baseUrl}${url}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};

const expectedActual = (p) => (p.name === 'Player 1' ? 0 : Math.round((Number(p.projected_points) + 5) * 10) / 10);
const sum = (list) => Math.round(list.reduce((s, x) => s + x, 0) * 10) / 10;

describe('optimizer on a snapshot slate', () => {
  test('generate rebuilds the past slate and scores every lineup', async () => {
    const { status, body } = await post('/optimizer/generate', { slateDate: PAST, mode: 'cash', numLineups: 2, minSalary: 0 });
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.isBacktest, true);
    assert.equal(body.slateDate, PAST);
    assert.equal(body.slateId, 'past');
    assert.equal(body.label, `Backtest ${PAST}`);
    assert.equal(body.lineups.length, 2);
    for (const lineup of body.lineups) {
      const players = lineup.players.map(s => s.player);
      assert.ok(players.every(p => !p.name.endsWith('Tonight')), 'only 10/21 players');
      for (const p of players) assert.equal(p.actualPoints, expectedActual(p));
      assert.equal(lineup.actualPoints, sum(players.map(expectedActual)));
    }
  });

  test('the live slate is unchanged: no slateDate builds tonight without actuals', async () => {
    const { body } = await post('/optimizer/generate', { slateId: 'tonight', mode: 'cash', minSalary: 0 });
    assert.equal(body.isBacktest, false);
    assert.ok(body.lineups[0].players.every(s => s.player.name.endsWith('Tonight')));
    assert.equal(body.lineups[0].actualPoints, undefined);
  });

  test('ranges toggle: model by default, original on request, anything else is a 400', async () => {
    const byDefault = await post('/optimizer/generate', { slateDate: PAST, minSalary: 0 });
    assert.equal(byDefault.body.ranges, 'model');
    const original = await post('/optimizer/generate', { slateDate: PAST, minSalary: 0, ranges: 'original' });
    assert.equal(original.body.ranges, 'original');
    assert.ok(original.body.lineups[0].players.every(s => s.player.range_source === 'original'));
    assert.equal((await post('/optimizer/generate', { slateDate: PAST, ranges: 'nope' })).status, 400);
  });

  test('locks by snapshot player id work and an unknown date is a 404', async () => {
    const lock = pastPlayers.find(p => p.name === 'Player 12');
    const { body } = await post('/optimizer/generate', { slateDate: PAST, lockedPlayers: [lock.id], minSalary: 0 });
    assert.ok(body.lineups[0].players.some(s => s.player.id === lock.id));
    assert.equal((await post('/optimizer/generate', { slateDate: '2020-01-01' })).status, 404);
  });

  test('review-lineup and slate-breakdown use the saved slate and report actuals', async () => {
    const { body: built } = await post('/optimizer/generate', { slateDate: PAST, minSalary: 0 });
    const lineup = built.lineups[0];
    const { status, body } = await post('/optimizer/review-lineup', { slateDate: PAST, lineup, mode: 'gpp' });
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.isBacktest, true);
    assert.equal(body.actualPoints, lineup.actualPoints);
    assert.equal(body.playerActuals.length, 8);

    const breakdown = await post('/optimizer/slate-breakdown', { slateDate: PAST });
    assert.equal(breakdown.status, 200, JSON.stringify(breakdown.body));
    assert.equal(breakdown.body.isBacktest, true);
    assert.ok(breakdown.body.actualResults.length > 0);
    assert.equal(breakdown.body.actualResults[0].actualPoints, Math.max(...pastPlayers.map(expectedActual)));
  });
});

describe('Player Pool and Tonight on a snapshot slate', () => {
  test('GET /players/:slateId?slateDate returns the saved slate with actual points', async () => {
    const players = await (await fetch(`${baseUrl}/players/past?slateDate=${PAST}`)).json();
    assert.equal(players.length, pastPlayers.length);
    const p1 = players.find(p => p.name === 'Player 1');
    assert.equal(p1.actualPoints, 0);
    assert.equal(p1.resultStatus, 'DNP');
    const p2 = players.find(p => p.name === 'Player 2');
    assert.equal(p2.actualPoints, expectedActual(p2));
  });

  test('Tonight for a past date bounds the defense window to the day before', async () => {
    const res = await fetch(`${baseUrl}/archetypes/tonight?slateDate=${PAST}`);
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.equal(body.isBacktest, true);
    assert.equal(body.slateId, 'past');
    assert.equal(body.slateDate, PAST);
    assert.equal(body.endDate, '2026-10-20');
    assert.equal(body.slatePlayers, pastPlayers.length);
  });
});

describe('portfolio builder on a snapshot slate', () => {
  test('a single-entry build on 10/21 completes with actual points', async () => {
    const { status, body } = await post('/portfolio/build', {
      slateDate: PAST, contest: 'single-entry', numLineups: 1, poolSize: 20, fieldSize: 200, iterations: 200,
      optimalIterations: 100, minSalary: 0, seed: 7
    });
    assert.equal(status, 202, JSON.stringify(body));
    let job;
    for (let i = 0; i < 300; i++) {
      job = await (await fetch(`${baseUrl}/portfolio/${body.jobId}`)).json();
      if (['completed', 'failed'].includes(job.status)) break;
      await new Promise(r => setTimeout(r, 100));
    }
    assert.equal(job.status, 'completed', job.error);
    assert.equal(job.isBacktest, true);
    assert.equal(job.slateDate, PAST);
    const [lineup] = job.result.portfolio.lineups;
    const players = lineup.players.map(s => s.player);
    assert.ok(players.every(p => !p.name.endsWith('Tonight')));
    for (const p of players) assert.equal(p.actualPoints, expectedActual(p));
    assert.equal(lineup.actualPoints, sum(players.map(expectedActual)));
    assert.equal(job.result.portfolio.actual.best, lineup.actualPoints);
    assert.ok(job.result.candidates.every(c => typeof c.actualPoints === 'number'));
  });

  test('history for a backtest stops before the slate date (no lookahead)', async () => {
    const { fetchHistoricalStats } = await import('../src/services/simulation/historyRepository.js');
    const name = 'Player 2';
    const all = await fetchHistoricalStats([name]);
    const before = await fetchHistoricalStats([name], { beforeDate: PAST });
    assert.equal(all.get(name)?.n, 1, 'the 10/21 game is in the data');
    assert.equal(before.get(name), undefined, 'but not before 10/21');
  });
});

describe('chat tools on a snapshot slate', () => {
  const assertBacktest = (r) => {
    assert.equal(r.backtest, true);
    assert.equal(r.isStale, false, 'an explicit backtest passes the stale guard');
    assert.equal(r.staleWarning, undefined);
    assert.equal(r.slateDate, PAST);
    assert.equal(r.label, `Backtest ${PAST}`);
    assert.match(r.backtestNote, /BACKTEST/);
  };

  test('OptimizerAgent build_lineup, get_player_pool and validate_lineup take slateDate', async () => {
    const OptimizerAgent = (await import('../src/agents/OptimizerAgent.js')).default;
    const tools = Object.fromEntries(new OptimizerAgent().tools.map(t => [t.name, t]));

    const built = await tools.build_lineup.execute({ slateDate: PAST, minSalary: 0 });
    assert.equal(built.success, true, built.error);
    assertBacktest(built);
    const [lineup] = built.lineups;
    const players = lineup.players.map(s => s.player);
    const byId = new Map(pastPlayers.map(p => [p.id, p]));
    assert.equal(lineup.actualPoints, sum(players.map(p => expectedActual(byId.get(p.id)))));

    const pool = await tools.get_player_pool.execute({ slateDate: PAST, limit: 5 });
    assertBacktest(pool);
    assert.equal(pool.players.length, 5);
    assert.ok(pool.players.every(p => typeof p.actualPoints === 'number'));

    const valid = await tools.validate_lineup.execute({ slateDate: PAST, playerIds: players.map(p => p.id) });
    assert.equal(valid.valid, true, valid.error);
    assert.equal(valid.actualPoints, lineup.actualPoints);
  });

  test('aiChatService build_lineup and ResearchAgent value tools take slateDate', async () => {
    const aiChatService = (await import('../src/services/aiChatService.js')).default;
    const tool = aiChatService.createTools().find(t => t.name === 'build_lineup');
    const built = JSON.parse(await tool.func({ slateDate: PAST, minSalary: 0 }));
    assert.equal(built.success, true, built.error);
    assertBacktest(built);
    assert.equal(typeof built.lineups[0].actualPoints, 'number');

    const ResearchAgent = (await import('../src/agents/ResearchAgent.js')).default;
    const research = Object.fromEntries(new ResearchAgent().tools.map(t => [t.name, t]));
    const summary = await research.get_slate_summary.execute({ slateDate: PAST });
    assert.equal(summary.success, true, summary.error);
    assertBacktest(summary);
    assert.equal(summary.bestValue.length, 10);
    assert.ok(summary.bestValue.every(p => typeof p.actualPoints === 'number'));
    const env = await research.get_game_environment.execute({ slateDate: PAST });
    assertBacktest(env);
    assert.equal(env.gameCount, 2);

    const matchups = await research.get_archetype_matchups.execute({ slateDate: PAST });
    assert.equal(matchups.success, true, matchups.message);
    assertBacktest(matchups);
  });

  test('without slateDate the live slate keeps working (get_current_slate stays live)', async () => {
    const chatService = (await import('../src/services/agenticChatService.js')).default;
    const current = JSON.parse(await chatService.executeOrchestratorTool('get_current_slate', {}, {}, {}));
    assert.equal(current.slate.slateId, 'tonight');
    assert.equal(current.slate.isStale, false);

    const OptimizerAgent = (await import('../src/agents/OptimizerAgent.js')).default;
    const pool = await new OptimizerAgent().tools.find(t => t.name === 'get_player_pool').execute({ limit: 3 });
    assert.equal(pool.slateId, 'tonight');
    assert.equal(pool.backtest, undefined);
    assert.ok(pool.players.every(p => p.actualPoints === undefined));
  });

  test('prompts allow explicit backtest requests through the stale guard', async () => {
    const { ORCHESTRATOR_SYSTEM_PROMPT } = await import('../src/services/agenticChatService.js');
    const ResearchAgent = (await import('../src/agents/ResearchAgent.js')).default;
    const OptimizerAgent = (await import('../src/agents/OptimizerAgent.js')).default;
    const aiChatService = (await import('../src/services/aiChatService.js')).default;
    for (const prompt of [ORCHESTRATOR_SYSTEM_PROMPT, new ResearchAgent().systemPrompt,
      new OptimizerAgent().systemPrompt, aiChatService.getSystemPrompt()]) {
      assert.match(prompt, /backtest/i);
      assert.match(prompt, /slateDate/);
    }
  });
});
