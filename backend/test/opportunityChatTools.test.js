import { test, describe, vi, beforeAll as before, afterAll as after, beforeEach } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Opportunity Radar chat tools (research tools): get_opportunity_radar and
// get_player_opportunity, their player_list ui block, and tool ownership.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nba-dfs-opportunity-chat-'));
process.env.DATABASE_TYPE = 'sqlite';
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');

const addDays = (date, n) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

let db;
let metrics;
let playerKey;
let tools;
let getUiBlocks;
let validateUiBlock;

// A past night (backtest whatever today is)
const SLATE_DATE = '2025-12-20';
const SEASON = '2025-26';
const GAMES = 20;
const gameDate = (g) => addDays(SLATE_DATE, -2 * (GAMES + 1 - g));
const STAR_OUT = [4, 5, 6, 7, 8, 9];

async function teamGame(date, team, opp) {
  const gameId = `${date}-${[team, opp].sort().join('-')}`;
  for (const [t, o] of [[team, opp], [opp, team]]) {
    await db.run(`
      INSERT OR IGNORE INTO team_game_stats (game_id, game_date, season, season_type, team, opponent,
        minutes, fgm, fga, fta, tov, oreb, dreb, possessions)
      VALUES (?, ?, ?, 'regular', ?, ?, 240, 40, 90, 25, 14, 10, 35, 100)
    `, gameId, date, SEASON, t, o);
  }
  return gameId;
}

// [minutes, FGA, TOV, DK points, starter]
async function box(name, team, opp, date, [minutes, fga, tov, fp, starter = 1]) {
  const gameId = await teamGame(date, team, opp);
  await db.run(`
    INSERT INTO historical_games (player_name, player_key, team, opponent, game_id, game_date, season, season_type,
      minutes, points, rebounds, assists, steals, blocks, turnovers, fouls, fg_made, fg_attempted, fg3_made, fg3_attempted,
      ft_made, ft_attempted, oreb, dreb, is_starter, dk_fantasy_points, fd_fantasy_points, yahoo_fantasy_points)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'regular', ?, ?, 0, 0, 0, 0, ?, 2, ?, ?, 0, 0, 0, 0, 0, 0, ?, ?, ?, ?)
  `, name, playerKey(name), team, opp, gameId, date, SEASON, minutes, Math.floor(fga / 2), tov, Math.floor(fga / 2), fga,
  starter, fp, fp + 5, fp);
}

async function snapshot(name, team, opp, { salary, projected = 30, minutes = 30, own = 10, floor = 20, ceiling = 40, injury = null, position = 'SF' }) {
  await db.run(`
    INSERT INTO slate_player_snapshots (snapshot_date, game_date, site, slate_id, player_key, player_name, team, opponent, position,
      salary, projected_points, projected_minutes, floor, ceiling, rostership, vegas_implied_total, vegas_spread, over_under, injury_status)
    VALUES (?, ?, 'draftkings', 'S1', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 116, -3, 230, ?)
  `, SLATE_DATE, SLATE_DATE, playerKey(name), name, team, opp, position, salary, projected, minutes, floor, ceiling, own, injury);
}

async function seed() {
  for (let g = 1; g <= GAMES; g++) {
    const date = gameDate(g);
    if (!STAR_OUT.includes(g)) await box('Star Guard', 'BOS', 'NYK', date, [34, 22, 3, 45]);
    const wing = STAR_OUT.includes(g) ? [34, 18, 3, 42, 0] : g > GAMES - 3 ? [34, 16, 2, 38, 1] : [22, 10, 2, 22, 0];
    await box('Wing Man', 'BOS', 'NYK', date, wing);
    await box('Fading Vet', 'NYK', 'BOS', date, g > GAMES - 3 ? [16, 6, 1, 12] : [30, 12, 2, 30]);
    await box('Pricey Center', 'NYK', 'BOS', date, [32, 14, 2, 40]);
  }
  await box('Wing Man', 'BOS', 'NYK', SLATE_DATE, [36, 20, 2, 44]);
  await box('Fading Vet', 'NYK', 'BOS', SLATE_DATE, [15, 5, 1, 10]);
  await box('Pricey Center', 'NYK', 'BOS', SLATE_DATE, [30, 12, 2, 38]);

  await snapshot('Star Guard', 'BOS', 'NYK', { salary: 9000, projected: 0, minutes: 0, injury: 'OUT', position: 'PG' });
  await snapshot('Wing Man', 'BOS', 'NYK', { salary: 6000, projected: 30, minutes: 34, own: 4, floor: 24, ceiling: 48 });
  await snapshot('Fading Vet', 'NYK', 'BOS', { salary: 6000, projected: 28, minutes: 26, own: 25, floor: 15, ceiling: 36, position: 'SG' });
  await snapshot('Pricey Center', 'NYK', 'BOS', { salary: 9500, projected: 40, minutes: 32, own: 30, floor: 30, ceiling: 52, position: 'C' });
}

before(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  db = (await import('../src/config/database.js')).default;
  await (await import('../src/config/schema.js')).createTables(db);
  metrics = await import('../src/services/opportunity/metricsService.js');
  ({ playerKey } = await import('../src/utils/playerKey.js'));
  ({ getUiBlocks, validateUiBlock } = await import('../src/services/chatTools/uiBlocks.js'));
  const { createResearchTools } = await import('../src/services/chatTools/researchTools.js');
  tools = Object.fromEntries(createResearchTools().map(t => [t.name, t]));
  await seed();
});

after(() => {
  vi.restoreAllMocks();
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => metrics.clearOpportunityCache());

describe('get_opportunity_radar', () => {
  test('backtest: players ranked by the mode score, with reason, key metrics, actuals and validation', async () => {
    const out = await tools.get_opportunity_radar.execute({ slateDate: SLATE_DATE, mode: 'cash' });
    assert.equal(out.success, true, out.message);
    assert.equal(out.mode, 'cash');
    assert.equal(out.backtest, true);
    assert.equal(out.slateDate, SLATE_DATE);
    assert.equal(out.slateId, 'S1');
    assert.match(out.label, /Backtest 2025-12-20/);
    const scores = out.players.map(p => p.score);
    assert.deepEqual(scores, [...scores].sort((a, b) => b - a));
    assert.ok(!out.players.some(p => p.name === 'Star Guard'), 'OUT players are left out');
    const wing = out.players.find(p => p.name === 'Wing Man');
    assert.equal(wing.score, wing.cashScore);
    assert.ok(wing.gppScore !== null);
    assert.match(wing.reason, /absorbs ~\d+% of Guard usage/);
    assert.equal(wing.salary, 6000);
    assert.equal(wing.metrics.teammateOut.names[0], 'Star Guard');
    assert.equal(wing.metrics.teammateOut.sample, 'confirmed');
    assert.ok(wing.metrics.minutes.deltaL3 > 0);
    assert.equal(wing.actualPoints, 44);
    assert.ok(out.validation.cash.players >= 3);
    assert.ok(out.howToRead);
  });

  test('gpp mode ranks by gpp score', async () => {
    const out = await tools.get_opportunity_radar.execute({ slateDate: SLATE_DATE, mode: 'gpp' });
    assert.equal(out.mode, 'gpp');
    for (const p of out.players) assert.equal(p.score, p.gppScore);
  });

  test('salary band, position and limit filters', async () => {
    const band = await tools.get_opportunity_radar.execute({ slateDate: SLATE_DATE, maxSalary: 6500 });
    assert.deepEqual(band.players.map(p => p.name).sort(), ['Fading Vet', 'Wing Man']);
    assert.equal(band.totalMatches, 2);
    const centers = await tools.get_opportunity_radar.execute({ slateDate: SLATE_DATE, position: 'C' });
    assert.deepEqual(centers.players.map(p => p.name), ['Pricey Center']);
    const top1 = await tools.get_opportunity_radar.execute({ slateDate: SLATE_DATE, limit: 1 });
    assert.equal(top1.players.length, 1);
    assert.equal(top1.totalMatches, 3);
  });

  test('bad mode and a missing saved slate fail cleanly', async () => {
    const bad = await tools.get_opportunity_radar.execute({ slateDate: SLATE_DATE, mode: 'showdown' });
    assert.equal(bad.success, false);
    assert.match(bad.message, /mode/);
    const none = await tools.get_opportunity_radar.execute({ slateDate: '2025-11-02' });
    assert.equal(none.success, false);
    assert.match(none.message, /No saved slate/);
  });

  test('attaches a valid player_list block with score, reason and key metrics', async () => {
    const out = await tools.get_opportunity_radar.execute({ slateDate: SLATE_DATE, mode: 'gpp' });
    const [block] = getUiBlocks(out);
    assert.ok(block, 'no ui block');
    assert.equal(block.type, 'player_list');
    assert.equal(validateUiBlock(block).success, true);
    assert.match(block.title, /Opportunity/);
    assert.equal(block.players.length, out.players.length);
    const wing = block.players.find(p => p.name === 'Wing Man');
    assert.equal(wing.opportunity_score, out.players.find(p => p.name === 'Wing Man').gppScore);
    assert.match(wing.reason, /absorbs/);
    assert.equal(wing.salary, 6000);
    assert.equal(wing.stats.actual_points, 44);
    assert.ok('min_delta_l3' in wing.stats && 'rate_projection' in wing.stats);
    // The LLM never sees the block
    assert.equal(JSON.stringify(out).includes('opportunity_score'), false);
  });
});

describe('get_player_opportunity', () => {
  test('full breakdown with both scores, components and teammate-out splits', async () => {
    const out = await tools.get_player_opportunity.execute({ name: 'wing man', slateDate: SLATE_DATE });
    assert.equal(out.success, true, out.message);
    assert.equal(out.player.name, 'Wing Man');
    assert.equal(out.backtest, true);
    assert.ok(out.scores.cash.score > 0 && out.scores.gpp.score > 0);
    assert.ok(out.scores.cash.components.minutes > 0.5);
    assert.ok(out.scores.cash.rank >= 1 && out.scores.cash.of === 3);
    assert.match(out.reason, /absorbs/);
    assert.equal(out.metrics.minutes.l3, 34);
    assert.ok(out.metrics.rateProjection.projection > 0);
    assert.equal(out.metrics.valueHitRates.games, 10);
    // Per-teammate splits (pre-lock outs only: no lookahead)
    assert.equal(out.teammateSplits.length, 1);
    const [split] = out.teammateSplits;
    assert.equal(split.outName, 'Star Guard');
    assert.equal(split.gamesWithout, 6);
    assert.ok(split.minutesWithout > split.minutesWith);
    assert.equal(out.actual.points, 44);

    const [block] = getUiBlocks(out);
    assert.equal(block.type, 'player_list');
    assert.equal(validateUiBlock(block).success, true);
    assert.equal(block.players[0].name, 'Wing Man');
  });

  test('a name not on the slate fails with slate suggestions', async () => {
    const out = await tools.get_player_opportunity.execute({ name: 'Wing Guy', slateDate: SLATE_DATE });
    assert.equal(out.success, false);
    assert.match(out.message, /not on/);
    assert.deepEqual(out.closestMatches, ['Wing Man']);
  });
});

describe('tool ownership', () => {
  test('both tools are research tools, named in the research and analyst prompts and owned by research', async () => {
    const { RESEARCH_TOOL_NAMES } = await import('../src/services/chatTools/researchTools.js');
    assert.ok(RESEARCH_TOOL_NAMES.includes('get_opportunity_radar'));
    assert.ok(RESEARCH_TOOL_NAMES.includes('get_player_opportunity'));
    const service = (await import('../src/services/agenticChatService.js')).default;
    assert.equal(service.toolOwners.get_opportunity_radar, 'research');
    assert.equal(service.toolOwners.get_player_opportunity, 'research');
    for (const agent of ['research', 'analyst']) {
      const { systemPrompt, tools: agentTools } = service.agents[agent];
      assert.ok(agentTools.some(t => t.name === 'get_opportunity_radar'), agent);
      assert.match(systemPrompt, /get_opportunity_radar/, agent);
      assert.match(systemPrompt, /get_player_opportunity/, agent);
    }
    assert.match(service.systemPrompt, /good spot.*get_opportunity_radar|get_opportunity_radar.*good spot/i);
  });
});
