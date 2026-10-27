import { test, describe, vi, beforeAll as before, afterAll as after, beforeEach } from 'vitest';
import assert from 'node:assert/strict';
import express from 'express';

// The projection sanity setting over HTTP (Lineup Studio toggle) and the live
// player table carrying the adjusted projection with the RotoWire value.
process.env.DATABASE_TYPE = 'sqlite';
process.env.DATABASE_PATH = ':memory:';
for (const k of ['PROJECTION_SANITY', 'PROJECTION_SANITY_FPPM', 'PROJECTION_SANITY_BLOWOUT']) delete process.env[k];

const { default: db } = await import('../src/config/database.js');
const { createTables } = await import('../src/config/schema.js');
const setting = await import('../src/config/projectionSanity.js');

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

before(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  await createTables(db);
  await db.run(`INSERT INTO slates (slate_id, name, site) VALUES ('s1', 'Main', 'draftkings')`);
  const add = (id, name, team, opp, proj, minutes, spread) => db.run(`
    INSERT INTO players (slate_id, player_id, name, team, opponent, position, salary, projected_points, projected_minutes,
      vegas_spread, value, floor, ceiling, rotowire_projection)
    VALUES ('s1', ?, ?, ?, ?, 'SF', 5000, ?, ?, ?, ?, ?, ?, ?)`, id, name, team, opp, proj, minutes, spread, proj / 5, proj * 0.7, proj * 1.4, proj);
  await add('1', 'Dog Starter', 'WAS', 'BOS', 34, 34, 16);
  await add('2', 'Steady Wing', 'NYK', 'MIA', 30, 30, -2);

  const app = express();
  app.use(express.json());
  app.use('/api/projections', (await import('../src/routes/projections.js')).default);
  app.use('/api/players', (await import('../src/routes/players.js')).default);
  await new Promise(resolve => { server = app.listen(0, resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  vi.restoreAllMocks();
  await new Promise(resolve => server.close(resolve));
  db.close();
});

beforeEach(() => {
  setting.setProjectionSanity(null);
  setting.setProjectionSanityComponents(null);
});

describe('GET / PUT /api/projections/sanity', () => {
  test('reports the setting, its defaults and the config', async () => {
    const { status, body } = await call('GET', '/api/projections/sanity');
    assert.equal(status, 200);
    assert.equal(body.enabled, true);
    assert.equal(body.source, 'default');
    assert.deepEqual(body.components, { fppm: false, blowout: true });
    assert.equal(body.config.blowout.threshold, 10);
  });

  test('PUT switches it (and components) at runtime; null resets to the default', async () => {
    let r = await call('PUT', '/api/projections/sanity', { enabled: false });
    assert.equal(r.status, 200);
    assert.deepEqual([r.body.enabled, r.body.source], [false, 'runtime']);
    r = await call('PUT', '/api/projections/sanity', { components: { fppm: true } });
    assert.deepEqual(r.body.components, { fppm: true, blowout: true });
    r = await call('PUT', '/api/projections/sanity', { enabled: null, components: null });
    assert.deepEqual([r.body.enabled, r.body.source, r.body.components.fppm], [true, 'default', false]);
  });

  test('rejects anything but a boolean or null', async () => {
    assert.equal((await call('PUT', '/api/projections/sanity', { enabled: 'yes' })).status, 400);
    assert.equal((await call('PUT', '/api/projections/sanity', { components: { blowout: 1 } })).status, 400);
    assert.equal((await call('PUT', '/api/projections/sanity', { components: { nope: true } })).status, 400);
  });
});

describe('GET /api/players/:slateId (live)', () => {
  test('adjusted projection with the RotoWire value and the reasons; off returns the stored rows', async () => {
    const on = Object.fromEntries((await call('GET', '/api/players/s1')).body.map(p => [p.name, p]));
    assert.ok(on['Dog Starter'].projected_points < 34);
    assert.equal(on['Dog Starter'].projection_raw, 34);
    assert.equal(on['Dog Starter'].rotowire_projection, 34);
    assert.match(on['Dog Starter'].projection_reasons[0], /^blowout \+16\.0/);
    assert.equal(on['Steady Wing'].projected_points, 30);
    // stored row untouched
    assert.equal((await db.get(`SELECT projected_points FROM players WHERE player_id = '1'`)).projected_points, 34);

    setting.setProjectionSanity(false);
    const off = Object.fromEntries((await call('GET', '/api/players/s1')).body.map(p => [p.name, p]));
    assert.equal(off['Dog Starter'].projected_points, 34);
    assert.equal(off['Dog Starter'].projection_sanity, undefined);
  });
});
