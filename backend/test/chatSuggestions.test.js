import { test, describe, beforeAll as before, afterAll as after } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';

// GET /api/chat/suggestions: starter prompts for a new chat built from the slate.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nba-dfs-chat-suggestions-'));
process.env.DATABASE_TYPE = 'sqlite';
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');

let db;
let buildChatSuggestions;
let server;
let baseUrl;

const slatePlayer = (slateId, name, team, opp, salary, proj, { ou = null, implied = null, spread = null, injury = null } = {}) => db.run(
  `INSERT INTO players (slate_id, player_id, name, team, opponent, position, salary, projected_points,
     vegas_over_under, vegas_implied_total, vegas_spread, injury_status)
   VALUES (?, ?, ?, ?, ?, 'PG', ?, ?, ?, ?, ?, ?)`,
  slateId, name, name, team, opp, salary, proj, ou, implied, spread, injury);

before(async () => {
  db = (await import('../src/config/database.js')).default;
  await (await import('../src/config/schema.js')).createTables(db);
  ({ buildChatSuggestions } = await import('../src/services/chatSuggestions.js'));

  await db.run(`INSERT INTO slates (slate_id, name, site, created_at) VALUES ('s1', 'Main', 'draftkings', '2030-01-01 00:00:00')`);
  // BOS-NYK has the top total (from implied totals); LAL-DEN from the game O/U
  await slatePlayer('s1', 'Star Guard', 'BOS', 'NYK', 9500, 50, { implied: 121.5, spread: -6.5 });
  await slatePlayer('s1', 'Cheap Wing', 'NYK', 'BOS', 4000, 28, { implied: 115 });
  await slatePlayer('s1', 'Hurt Cheapie', 'LAL', 'DEN', 3600, 30, { ou: 228.5, injury: 'OUT' });
  await slatePlayer('s1', 'Okay Value', 'DEN', 'LAL', 5800, 30, { ou: 228.5 });

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

const PLAYERS = [
  { name: 'Jalen Brunson', team: 'NYK', opponent: 'BOS', salary: 9000, projected_points: 48, vegas_implied_total: 117, vegas_spread: 2 },
  { name: 'Payton Pritchard', team: 'BOS', opponent: 'NYK', salary: 4200, projected_points: 26, vegas_implied_total: 119 },
];

function fakeSources(overrides = {}) {
  return {
    latestSlateId: async () => 'live',
    slatePlayers: async () => PLAYERS,
    usageBumps: async () => [{ player: 'Payton Pritchard', missingPlayer: 'Jaylen Brown', dkBump: 8.4, pctBump: 31.2 }],
    archetypeEdges: async () => [{ name: 'Jalen Brunson', opponent: 'BOS', archetypeLabel: 'Primary Creator', adjustedEdge: 4.26 }],
    hotStreaks: async () => [
      { player_key: 'not on slate', player_name: 'Someone Else', last3_avg: 60, season_avg: 30 },
      { player_key: 'jalen brunson', player_name: 'Jalen Brunson', last3_avg: 55.1, season_avg: 44 },
    ],
    latestResultsDate: async () => '2026-10-21',
    ...overrides,
  };
}

describe('buildChatSuggestions', () => {
  test('builds one prompt per source from the data, in order', async () => {
    const { slateId, suggestions } = await buildChatSuggestions({}, fakeSources());
    assert.equal(slateId, 'live');
    assert.deepEqual(suggestions.map(s => s.kind), ['usage_bump', 'archetype_edge', 'game_stack', 'hot_streak', 'value_play', 'score_lineup']);
    const byKind = Object.fromEntries(suggestions.map(s => [s.kind, s]));

    assert.match(byKind.usage_bump.prompt, /Payton Pritchard.*Jaylen Brown out/);
    assert.match(byKind.usage_bump.detail, /\+8\.4 FP \(\+31%\)/);
    assert.match(byKind.archetype_edge.prompt, /Jalen Brunson's matchup vs BOS/);
    assert.match(byKind.archetype_edge.detail, /\+4\.3 FP/);
    assert.match(byKind.game_stack.prompt, /BOS vs NYK.*\(236\)/);
    assert.match(byKind.hot_streak.prompt, /^Jalen Brunson is averaging 55\.1/);
    assert.match(byKind.value_play.prompt, /Payton Pritchard \(\$4,200, 6\.2x\)/);
    assert.equal(byKind.score_lineup.prompt, 'Score my lineup from last night (2026-10-21).');
    for (const s of suggestions) assert.equal(s.id, s.kind);
  });

  test('skips sources that are empty or throw', async () => {
    const { suggestions } = await buildChatSuggestions({}, fakeSources({
      usageBumps: async () => [],
      archetypeEdges: async () => { throw new Error('no defense data'); },
      hotStreaks: async () => [{ player_key: 'not on slate', player_name: 'X', last3_avg: 1, season_avg: 1 }],
    }));
    assert.deepEqual(suggestions.map(s => s.kind), ['game_stack', 'value_play', 'score_lineup']);
  });

  test('with no slate only the results prompt can be built', async () => {
    const { slateId, suggestions } = await buildChatSuggestions({}, fakeSources({ latestSlateId: async () => null }));
    assert.equal(slateId, null);
    assert.deepEqual(suggestions.map(s => s.kind), ['score_lineup']);

    const none = await buildChatSuggestions({}, fakeSources({ latestSlateId: async () => null, latestResultsDate: async () => null }));
    assert.deepEqual(none.suggestions, []);
  });
});

describe('GET /api/chat/suggestions', () => {
  test('builds stack and value prompts from the slate players', async () => {
    const res = await fetch(`${baseUrl}/suggestions?slateId=s1`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.slateId, 's1');
    const byKind = Object.fromEntries(body.suggestions.map(s => [s.kind, s]));

    // 121.5 + 115 = 236.5 beats the 228.5 O/U
    assert.match(byKind.game_stack.prompt, /BOS vs NYK.*\(236\.5\)/);
    assert.match(byKind.game_stack.detail, /spread 6\.5/);
    // The OUT $3,600 player is skipped; 28 / 4.0K = 7x beats 30 / 5.8K
    assert.match(byKind.value_play.prompt, /^Is Cheap Wing \(\$4,000, 7x\)/);
    // No game logs in this DB
    assert.equal(byKind.score_lineup, undefined);
  });

  test('defaults to the latest slate', async () => {
    const body = await (await fetch(`${baseUrl}/suggestions`)).json();
    assert.equal(body.slateId, 's1');
    assert.ok(body.suggestions.some(s => s.kind === 'game_stack'));
  });

  test('an unknown slate returns an empty list, not an error', async () => {
    const res = await fetch(`${baseUrl}/suggestions?slateId=nope`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.deepEqual(body.suggestions, []);
  });
});
