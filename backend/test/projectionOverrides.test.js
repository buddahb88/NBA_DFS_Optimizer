/**
 * End-to-end tests for the minutes model pipeline and manual overrides:
 * /api/projections routes -> projectionService -> minutes model -> players table.
 * Run: npm test (uses vitest, an in-memory SQLite database)
 */

import { test, beforeAll as before, afterAll as after } from 'vitest';
import assert from 'node:assert/strict';
import express from 'express';

// Must be set before database.js is imported so tests never touch real data
process.env.DATABASE_TYPE = 'sqlite';
process.env.DATABASE_PATH = ':memory:';
delete process.env.PROJECTION_MINUTES_WEIGHT;

const { default: db } = await import('../src/config/database.js');
const { createTables } = await import('../src/config/schema.js');
const { backfillPlayerKeys } = await import('../src/config/playerKeyMigrations.js');
const { default: projectionsRouter } = await import('../src/routes/projections.js');
const { default: projectionService } = await import('../src/services/projectionService.js');

let server;
let baseUrl;

const call = async (method, path, body) => {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { status: res.status, body: await res.json() };
};

const playerPoints = async (playerId) =>
  (await db.get(`SELECT projected_points FROM players WHERE slate_id = 's1' AND player_id = ?`, playerId)).projected_points;

before(async () => {
  await createTables(db);

  await db.run(`INSERT INTO slates (slate_id, name, site) VALUES ('s1', 'Main', 'draftkings')`);
  const players = [
    ['1', 'Star Guard', 'PG', 9000, 45, 'OUT'],
    ['2', 'Backup Guard', 'PG', 4000, 18, null],
    ['3', 'Big Man', 'C', 7000, 36, null],
    ['4', 'Opp Wing', 'SF', 6000, 30, null]
  ];
  for (const [id, name, position, salary, proj, injury] of players) {
    await db.run(`
      INSERT INTO players (slate_id, player_id, name, team, opponent, position, salary, projected_points, injury_status, rest_days)
      VALUES ('s1', ?, ?, ?, ?, ?, ?, ?, ?, 1)
    `, id, name, id === '4' ? 'BBB' : 'AAA', id === '4' ? 'AAA' : 'BBB', position, salary, proj, injury);
  }

  // 12 games in November; the star sat the last 3 and the backup took his minutes
  for (let i = 1; i <= 12; i++) {
    const date = `2025-11-${String(i).padStart(2, '0')}`;
    const gameId = `g${i}`;
    const starOut = i > 9;
    const rows = [
      ['Star Guard', 'AAA', 'BBB', starOut ? 0 : 34, 30, 5, 8],
      ['Backup Guard', 'AAA', 'BBB', starOut ? 30 : 16, starOut ? 20 : 8, 2, starOut ? 6 : 3],
      ['Big Man', 'AAA', 'BBB', 30, 16, 10, 2],
      ['Opp Wing', 'BBB', 'AAA', 32, 20, 5, 3]
    ];
    for (const [name, team, opponent, minutes, pts, reb, ast] of rows) {
      if (!minutes) continue;
      await db.run(`
        INSERT INTO historical_games (player_name, team, opponent, game_id, game_date, minutes,
          points, rebounds, assists, steals, blocks, turnovers, fg3_made, dk_fantasy_points, is_back_to_back)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, 1, 1, ?, 0)
      `, name, team, opponent, gameId, date, minutes, pts, reb, ast, pts + reb * 1.25 + ast * 1.5 + 2 - 0.5 + 0.5);
    }
  }
  // As startup does: history lookups match by player_key
  await backfillPlayerKeys(db);

  const app = express();
  app.use(express.json());
  app.use('/api/projections', projectionsRouter);
  await new Promise(resolve => {
    server = app.listen(0, resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise(resolve => server.close(resolve));
  db.close();
});

test('minutes endpoint: OUT player is 0, backup gets his minutes, results saved', async () => {
  const { status, body } = await call('POST', '/api/projections/s1/minutes', {
    slateDate: '2025-12-01',
    minutesWeight: 1,
    updateDb: true
  });
  assert.equal(status, 200);
  assert.equal(body.site, 'draftkings');
  assert.equal(body.weight, 1);

  const byId = Object.fromEntries(body.players.map(p => [p.player_id, p]));
  assert.equal(byId['1'].source, 'out');
  assert.equal(byId['1'].projection, 0);
  assert.equal(byId['2'].source, 'blend');
  assert.ok(byId['2'].minutes >= byId['2'].base_minutes);
  assert.ok(byId['3'].fppm > 0);
  assert.ok(byId['3'].minutes > 25 && byId['3'].minutes < 35);

  assert.equal(await playerPoints('1'), 0);
  assert.equal(await playerPoints('3'), byId['3'].projection);
  // Original RotoWire number is kept for later recalculations
  const big = await db.get(`SELECT rotowire_projection FROM players WHERE slate_id = 's1' AND player_id = '3'`);
  assert.equal(big.rotowire_projection, 36);
});

test('weight 0 keeps the legacy projection (except OUT players)', async () => {
  const { body } = await call('POST', '/api/projections/s1/minutes', { slateDate: '2025-12-01', minutesWeight: 0 });
  const big = body.players.find(p => p.player_id === '3');
  assert.equal(big.source, 'legacy');
  assert.equal(big.projection, big.legacy_projection);
  assert.equal(body.players.find(p => p.player_id === '1').projection, 0);
});

test('points override: saved, applied immediately, restored on delete', async () => {
  const before = await playerPoints('4');

  const put = await call('PUT', '/api/projections/s1/overrides/4', { points: 50, note: 'smash spot' });
  assert.equal(put.status, 200);
  assert.equal(put.body.override.points, 50);
  assert.equal(put.body.override.base_points, before);
  assert.equal(put.body.needsRecalculation, false);
  assert.equal(await playerPoints('4'), 50);

  const list = await call('GET', '/api/projections/s1/overrides');
  assert.deepEqual(list.body.map(o => o.player_id), ['4']);

  // Recalculation keeps the override
  const { body } = await call('POST', '/api/projections/s1/minutes', { slateDate: '2025-12-01', updateDb: true });
  const wing = body.players.find(p => p.player_id === '4');
  assert.equal(wing.source, 'override_points');
  assert.equal(wing.projection, 50);
  assert.equal(await playerPoints('4'), 50);

  const del = await call('DELETE', '/api/projections/s1/overrides/4');
  assert.equal(del.status, 200);
  assert.equal(await playerPoints('4'), before);
  assert.equal((await call('GET', '/api/projections/s1/overrides')).body.length, 0);
});

test('minutes override 0 marks a player OUT and apply recalculates the slate', async () => {
  const put = await call('PUT', '/api/projections/s1/overrides/3', { minutes: 0, apply: true });
  assert.equal(put.status, 200);
  assert.equal(put.body.recalculated, true);
  assert.equal(put.body.needsRecalculation, false);
  assert.equal(await playerPoints('3'), 0);

  // Overrides persist per slate and survive a fresh projection run
  projectionService.clearCache();
  const { body } = await call('POST', '/api/projections/s1/minutes', { slateDate: '2025-12-01' });
  const big = body.players.find(p => p.player_id === '3');
  assert.equal(big.out, true);
  assert.equal(big.override.minutes, 0);

  await call('DELETE', '/api/projections/s1/overrides/3');
});

test('override validation', async () => {
  assert.equal((await call('PUT', '/api/projections/s1/overrides/3', {})).status, 400);
  assert.equal((await call('PUT', '/api/projections/s1/overrides/3', { minutes: 60 })).status, 400);
  assert.equal((await call('PUT', '/api/projections/s1/overrides/3', { points: 'lots' })).status, 400);
  assert.equal((await call('PUT', '/api/projections/s1/overrides/999', { minutes: 20 })).status, 404);
  assert.equal((await call('DELETE', '/api/projections/s1/overrides/999')).status, 404);
  assert.equal((await call('POST', '/api/projections/s1/minutes', { site: 'nope' })).status, 400);
  assert.equal((await call('POST', '/api/projections/missing/minutes', {})).status, 404);
});

test('minutesModel: false leaves calculateSlateEnhancedProjections unchanged', async () => {
  const players = [{ player_id: '3', name: 'Big Man', team: 'AAA', opponent: 'BBB', position: 'C', projected_points: 36, rest_days: 1 }];
  const [legacy] = await projectionService.calculateSlateEnhancedProjections(players, '2025-12-01', 'draftkings', { minutesModel: false });
  assert.equal(legacy.minutes_model, undefined);
  assert.equal(legacy.legacy_projection, undefined);

  const [blended] = await projectionService.calculateSlateEnhancedProjections(players, '2025-12-01', 'draftkings', { minutesWeight: 0 });
  assert.equal(blended.enhanced_projection, legacy.enhanced_projection);
  assert.equal(blended.legacy_projection, legacy.enhanced_projection);
});
