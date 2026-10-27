import { test, describe, vi, beforeAll as before, afterAll as after, beforeEach } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import { buildPlayerPool } from './fixtures/playerPool.js';

// Opportunity factor in the optimizer: opportunityWeight 0-1 (default 0 =
// unchanged) nudges projection / floor / ceiling by the radar score for the
// mode, bounded to +-OPPORTUNITY_NUDGE.maxPct at weight 1.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nba-dfs-opportunity-optimizer-'));
process.env.DATABASE_TYPE = 'sqlite';
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');

let db;
let nudge;
let optimizerService;
let metrics;
let server;
let baseUrl;

// A past night with a saved 32-player slate (backtest)
const SLATE_DATE = '2025-12-20';

before(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  db = (await import('../src/config/database.js')).default;
  await (await import('../src/config/schema.js')).createTables(db);
  nudge = await import('../src/services/opportunity/optimizerNudge.js');
  optimizerService = (await import('../src/services/optimizerService.js')).default;
  metrics = await import('../src/services/opportunity/metricsService.js');
  const { playerKey } = await import('../src/utils/playerKey.js');

  for (const p of buildPlayerPool()) {
    await db.run(`
      INSERT INTO slate_player_snapshots (snapshot_date, game_date, site, slate_id, player_key, player_name, team, opponent, position,
        salary, projected_points, projected_minutes, floor, ceiling, rostership, vegas_implied_total, vegas_spread, over_under)
      VALUES (?, ?, 'draftkings', 'BT1', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, -2, 228)
    `, SLATE_DATE, SLATE_DATE, playerKey(p.name), p.name, p.team, p.opponent, p.position.replace(',', '/'), p.salary,
    p.projected_points, 14 + (p.id % 6) * 4, p.floor, p.ceiling, p.rostership, 108 + (p.id % 4) * 4);
  }

  const router = (await import('../src/routes/optimizer.js')).default;
  const app = express();
  app.use(express.json());
  app.use('/api/optimizer', router);
  await new Promise(resolve => { server = app.listen(0, resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  vi.restoreAllMocks();
  await new Promise(resolve => server.close(resolve));
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => metrics.clearOpportunityCache());

const ids = (lineup) => lineup.players.map(s => s.player?.id).sort((a, b) => a - b);
const radarRows = (players, score) => players.map(p => ({ id: p.id, player_key: null, ...score(p) }));

describe('opportunityFactor', () => {
  test('neutral at 50 or weight 0, bounded by maxPct at the extremes', () => {
    const { maxPct } = nudge.OPPORTUNITY_NUDGE;
    assert.equal(nudge.opportunityFactor(50, 1), 1);
    assert.equal(nudge.opportunityFactor(90, 0), 1);
    assert.equal(nudge.opportunityFactor(null, 1), 1);
    assert.equal(nudge.opportunityFactor(100, 1), 1 + maxPct);
    assert.equal(nudge.opportunityFactor(0, 1), 1 - maxPct);
    assert.equal(nudge.opportunityFactor(75, 0.5), 1 + maxPct / 4);
    assert.equal(nudge.opportunityFactor(150, 1), 1 + maxPct);
  });
});

describe('applyOpportunity', () => {
  const pool = buildPlayerPool();

  test('weight 0 (or missing) returns the players unchanged', () => {
    const rows = radarRows(pool, () => ({ cash_score: 100, gpp_score: 100 }));
    assert.equal(nudge.applyOpportunity(pool, rows, { weight: 0 }), pool);
    assert.equal(nudge.applyOpportunity(pool, rows, {}), pool);
  });

  test('scales projection, floor and ceiling by the mode score and keeps the base projection', () => {
    const [a, b] = pool;
    const rows = [{ id: a.id, cash_score: 100, gpp_score: 0 }, { id: b.id, cash_score: 0, gpp_score: 100 }];
    const [cashA, cashB] = nudge.applyOpportunity([a, b], rows, { weight: 1, mode: 'cash' });
    assert.ok(Math.abs(cashA.projected_points - a.projected_points * 1.1) < 0.01);
    assert.ok(Math.abs(cashA.floor - a.floor * 1.1) < 0.01);
    assert.ok(Math.abs(cashA.ceiling - a.ceiling * 1.1) < 0.01);
    assert.equal(cashA.base_projected_points, a.projected_points);
    assert.equal(cashA.opportunity_score, 100);
    assert.ok(cashB.projected_points < b.projected_points);
    const [gppA, gppB] = nudge.applyOpportunity([a, b], rows, { weight: 1, mode: 'gpp' });
    assert.ok(gppA.projected_points < a.projected_points);
    assert.ok(gppB.projected_points > b.projected_points);
  });

  test('a player without a radar row is untouched; rows also match by player_key', () => {
    const [a, b] = pool.map(p => ({ ...p, player_key: p.name.toLowerCase() }));
    const out = nudge.applyOpportunity([a, b], [{ id: 999, player_key: b.player_key, cash_score: 100 }], { weight: 1 });
    assert.deepEqual(out[0], a);
    assert.ok(out[1].projected_points > b.projected_points);
  });

  test('weight 0 leaves optimizer lineups identical to no opportunity factor', () => {
    const rows = radarRows(pool, p => ({ cash_score: p.id % 2 ? 95 : 5, gpp_score: 50 }));
    const before = optimizerService.optimize(pool, { mode: 'cash', numLineups: 1, minSalary: 0 }).lineups;
    const after = optimizerService.optimize(nudge.applyOpportunity(pool, rows, { weight: 0, mode: 'cash' }),
      { mode: 'cash', numLineups: 1, minSalary: 0 }).lineups;
    assert.deepEqual(after.map(ids), before.map(ids));
  });

  test('weight > 0 moves the lineup toward high-opportunity players', () => {
    const settings = { mode: 'cash', numLineups: 1, minSalary: 0 };
    const [base] = optimizerService.optimize(pool, settings).lineups;
    const inBase = new Set(ids(base));
    // Everyone left out of the base lineup is in a great spot, everyone in it a poor one
    const rows = radarRows(pool, p => ({ cash_score: inBase.has(p.id) ? 0 : 100, gpp_score: 50 }));
    const [nudged] = optimizerService.optimize(nudge.applyOpportunity(pool, rows, { weight: 1, mode: 'cash' }), settings).lineups;
    const boosted = ids(nudged).filter(id => !inBase.has(id)).length;
    assert.ok(boosted > 0, 'lineup unchanged');
    // A small weight moves it less (or not at all)
    const [light] = optimizerService.optimize(nudge.applyOpportunity(pool, rows, { weight: 0.1, mode: 'cash' }), settings).lineups;
    assert.ok(ids(light).filter(id => !inBase.has(id)).length <= boosted);
  });

  test('gpp mode reads gpp_score', () => {
    const settings = { mode: 'gpp', numLineups: 1, minSalary: 0 };
    const [base] = optimizerService.optimize(pool, settings).lineups;
    const inBase = new Set(ids(base));
    const rows = radarRows(pool, p => ({ cash_score: 50, gpp_score: inBase.has(p.id) ? 0 : 100 }));
    const [nudged] = optimizerService.optimize(nudge.applyOpportunity(pool, rows, { weight: 1, mode: 'gpp' }), settings).lineups;
    assert.ok(ids(nudged).some(id => !inBase.has(id)));
    // Cash scores are neutral, so cash mode is unchanged
    const [cash] = optimizerService.optimize(pool, { ...settings, mode: 'cash' }).lineups;
    const [cashNudged] = optimizerService.optimize(nudge.applyOpportunity(pool, rows, { weight: 1, mode: 'cash' }), { ...settings, mode: 'cash' }).lineups;
    assert.deepEqual(ids(cashNudged), ids(cash));
  });
});

describe('validateOpportunityWeight', () => {
  test('accepts 0-1 and empty, rejects the rest', () => {
    for (const ok of [undefined, null, '', 0, 0.5, 1, '0.3']) assert.equal(nudge.validateOpportunityWeight(ok), null, String(ok));
    for (const bad of [-0.1, 1.5, 'lots']) assert.match(nudge.validateOpportunityWeight(bad), /opportunityWeight/);
  });
});

describe('POST /api/optimizer/generate on a backtest slate', () => {
  const generate = async (body) => {
    const res = await fetch(`${baseUrl}/api/optimizer/generate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slateDate: SLATE_DATE, mode: 'cash', numLineups: 1, minSalary: 0, ...body }),
    });
    return { status: res.status, body: await res.json() };
  };

  test('opportunityWeight 0 is the same as leaving it out', async () => {
    const plain = await generate({});
    const zero = await generate({ opportunityWeight: 0 });
    assert.equal(plain.status, 200, JSON.stringify(plain.body));
    assert.equal(plain.body.isBacktest, true);
    assert.deepEqual(zero.body.lineups.map(ids), plain.body.lineups.map(ids));
    assert.equal(plain.body.lineups[0].players[0].player.opportunity_score, undefined);
  });

  test('opportunityWeight > 0 nudges by the radar score computed for that night', async () => {
    const { status, body } = await generate({ opportunityWeight: 1 });
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.opportunity.weight, 1);
    assert.equal(body.opportunity.mode, 'cash');
    assert.ok(body.opportunity.scored > 20);
    for (const { player } of body.lineups[0].players) {
      assert.equal(typeof player.opportunity_score, 'number', player.name);
      const factor = nudge.opportunityFactor(player.opportunity_score, 1);
      assert.ok(Math.abs(player.projected_points - player.base_projected_points * factor) < 0.01, player.name);
    }
  });

  test('a weight outside 0-1 is a 400', async () => {
    const { status, body } = await generate({ opportunityWeight: 2 });
    assert.equal(status, 400);
    assert.match(body.error, /opportunityWeight/);
  });
});

describe('build_lineup (OptimizerAgent)', () => {
  test('opportunityWeight 0 matches the default; > 0 is applied and echoed', async () => {
    const { default: OptimizerAgent } = await import('../src/agents/OptimizerAgent.js');
    const tool = new OptimizerAgent().tools.find(t => t.name === 'build_lineup');
    assert.ok(tool.parameters.properties.opportunityWeight);
    const base = await tool.execute({ slateDate: SLATE_DATE, minSalary: 0 });
    const zero = await tool.execute({ slateDate: SLATE_DATE, minSalary: 0, opportunityWeight: 0 });
    assert.equal(base.success, true, base.error);
    const names = (r) => r.lineups[0].players.map(s => s.player.name).sort();
    assert.deepEqual(names(zero), names(base));
    assert.equal(base.opportunityWeight, undefined);

    const nudged = await tool.execute({ slateDate: SLATE_DATE, minSalary: 0, mode: 'gpp', opportunityWeight: 0.8 });
    assert.equal(nudged.success, true, nudged.error);
    assert.equal(nudged.opportunityWeight, 0.8);
    assert.ok(nudged.lineups[0].players.every(s => typeof s.player.opportunityScore === 'number'));

    const bad = await tool.execute({ slateDate: SLATE_DATE, opportunityWeight: 3 });
    assert.equal(bad.success, false);
  });
});
