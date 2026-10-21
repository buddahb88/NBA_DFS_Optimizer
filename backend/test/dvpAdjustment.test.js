import { test, describe, beforeAll as before, afterAll as after } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Keep the service off the real DB file
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nba-dfs-dvp-adjustment-'));
let db;
let dvp;
let projectionService;

before(async () => {
  process.env.DATABASE_TYPE = 'sqlite';
  process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');
  db = (await import('../src/config/database.js')).default;
  await (await import('../src/config/schema.js')).createTables(db);
  dvp = await import('../src/services/dvpAdjustment.js');
  projectionService = (await import('../src/services/projectionService.js')).default;
});

after(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const close = (actual, expected, msg) => assert.ok(Math.abs(actual - expected) < 1e-9, `${msg ?? ''} ${actual} != ${expected}`);

const CONFIG = { mode: 'archetype', weight: 0.5, cap: 2 };

function context() {
  return dvp.buildDvpContext({
    defenseRows: [
      { group_by: 'archetype', team: 'BOS', group_key: 'rim_running_big', fp_over_expectation: -3 },
      { group_by: 'archetype', team: 'GSW', group_key: 'primary_creator', fp_over_expectation: 2.4 },
      { group_by: 'archetype', team: 'NOP', group_key: 'stretch_big', fp_over_expectation: 10 },
      { group_by: 'position', team: 'BOS', group_key: 'C', fp_over_expectation: -1.2 },
      { group_by: 'position', team: 'GSW', group_key: 'F', fp_over_expectation: 0.8 },
    ],
    archetypes: new Map([
      ['nikola jokic', 'primary_creator'],
      ['walker kessler', 'rim_running_big'],
      ['rookie guy', 'unclassified'],
      ['vet guy', 'unclassified'],
    ]),
    priorArchetypes: new Map([
      ['vet guy', 'primary_creator'],
      ['old big', 'stretch_big'],
    ]),
  });
}

describe('archetypeDvpAdjustment', () => {
  test('uses the archetype x opponent cell scaled by the weight', () => {
    const r = dvp.archetypeDvpAdjustment({ name: 'Walker Kessler', opponent: 'BOS', position: 'C,UTIL' }, context(), CONFIG);
    assert.equal(r.source, 'archetype');
    assert.equal(r.group, 'rim_running_big');
    close(r.raw, -3);
    close(r.value, -1.5);
  });

  test('normalizes the opponent code and the player name', () => {
    const r = dvp.archetypeDvpAdjustment({ name: 'Nikola Jokić', opponent: 'GS', position: 'C' }, context(), CONFIG);
    assert.equal(r.source, 'archetype');
    close(r.value, 1.2);
  });

  test('falls back to the prior-season archetype when this season is unclassified', () => {
    const r = dvp.archetypeDvpAdjustment({ name: 'Vet Guy', opponent: 'GSW', position: 'PG,G,UTIL' }, context(), CONFIG);
    assert.equal(r.source, 'archetype');
    assert.equal(r.group, 'primary_creator');
    close(r.value, 1.2);
  });

  test('falls back to the G/F/C position when the archetype is unclassified', () => {
    const r = dvp.archetypeDvpAdjustment({ name: 'Rookie Guy', opponent: 'BOS', position: 'C,UTIL' }, context(), CONFIG);
    assert.equal(r.source, 'position');
    assert.equal(r.group, 'C');
    close(r.value, -0.6);
  });

  test('falls back to the position when the archetype has no cell for the opponent', () => {
    const r = dvp.archetypeDvpAdjustment({ name: 'Nikola Jokic', opponent: 'BOS', position: 'C' }, context(), CONFIG);
    assert.equal(r.source, 'position');
    close(r.value, -0.6);
  });

  test('falls back to 0 when neither archetype nor position has a cell', () => {
    const none = dvp.archetypeDvpAdjustment({ name: 'Unknown', opponent: 'BOS', position: 'PG' }, context(), CONFIG);
    assert.equal(none.source, 'none');
    assert.equal(none.value, 0);
    assert.equal(dvp.archetypeDvpAdjustment({ name: 'Unknown', opponent: null, position: 'C' }, context(), CONFIG).value, 0);
    assert.equal(dvp.archetypeDvpAdjustment({ name: 'Unknown', opponent: 'BOS', position: null }, context(), CONFIG).value, 0);
    assert.equal(dvp.archetypeDvpAdjustment({ name: 'Walker Kessler', opponent: 'BOS', position: 'C' }, null, CONFIG).value, 0);
  });

  test('caps the adjustment in both directions', () => {
    const up = dvp.archetypeDvpAdjustment({ name: 'Old Big', opponent: 'NO', position: 'C' }, context(), CONFIG);
    assert.equal(up.source, 'archetype');
    close(up.value, 2);
    const down = dvp.archetypeDvpAdjustment({ name: 'Walker Kessler', opponent: 'BOS', position: 'C' }, context(), { ...CONFIG, weight: 1, cap: 1 });
    close(down.value, -1);
  });

  test('weight 0 turns the signal off', () => {
    const r = dvp.archetypeDvpAdjustment({ name: 'Walker Kessler', opponent: 'BOS', position: 'C' }, context(), { ...CONFIG, weight: 0 });
    assert.equal(r.value, 0);
  });
});

describe('resolveDvpConfig', () => {
  test('defaults, overrides and env', () => {
    const base = dvp.resolveDvpConfig({}, {});
    assert.deepEqual(base, dvp.DEFAULT_DVP_CONFIG);
    assert.deepEqual(dvp.resolveDvpConfig({ weight: 0.3 }, {}), { ...dvp.DEFAULT_DVP_CONFIG, weight: 0.3 });
    const env = { DVP_ADJUSTMENT_MODE: 'legacy', DVP_ARCHETYPE_WEIGHT: '0.75', DVP_ARCHETYPE_CAP: '4' };
    assert.deepEqual(dvp.resolveDvpConfig({}, env), { mode: 'legacy', weight: 0.75, cap: 4 });
    // Overrides beat env
    assert.equal(dvp.resolveDvpConfig({ mode: 'off' }, env).mode, 'off');
  });

  test('rejects bad values', () => {
    assert.throws(() => dvp.resolveDvpConfig({ mode: 'nope' }, {}), /mode/);
    assert.throws(() => dvp.resolveDvpConfig({ weight: -1 }, {}), /weight/);
    assert.throws(() => dvp.resolveDvpConfig({ cap: 'x' }, {}), /cap/);
  });
});

describe('projectionService.getDvpAdjustment', () => {
  test('archetype mode reads the loaded context', () => {
    const value = projectionService.getDvpAdjustment(
      { name: 'Walker Kessler', opponent: 'BOS', position: 'C', dvp_pts_allowed: 30 },
      { config: CONFIG, context: context() },
    );
    close(value, -1.5);
  });

  test('legacy mode keeps the Hashtag points-allowed formula', () => {
    const player = { name: 'Walker Kessler', opponent: 'BOS', position: 'C', dvp_pts_allowed: 25 };
    close(projectionService.getDvpAdjustment(player, { config: { ...CONFIG, mode: 'legacy' }, context: context() }), 1);
    close(projectionService.getLegacyDvpAdjustment('BOS', 'C', 25), 1);
  });

  test('off mode is 0', () => {
    const player = { name: 'Walker Kessler', opponent: 'BOS', position: 'C', dvp_pts_allowed: 25 };
    assert.equal(projectionService.getDvpAdjustment(player, { config: { ...CONFIG, mode: 'off' }, context: context() }), 0);
  });

  test('recalculate and enhanced fallback paths apply the same DVP value', async () => {
    const player = { name: 'Walker Kessler', opponent: 'BOS', team: 'UTA', position: 'C', projected_points: 30 };
    const dvpOptions = { config: CONFIG, context: context() };
    const adjusted = await projectionService.calculateAdjustedProjection(player, { dvp: dvpOptions });
    close(adjusted.adjustments.dvp, -1.5);
    // No box scores in the test DB -> enhanced falls back to calculateAdjustedProjection
    const enhanced = await projectionService.calculateEnhancedProjection(player, { dvp: dvpOptions });
    assert.equal(enhanced.enhanced, false);
    close(enhanced.adjustments.dvp, -1.5);
  });
});

describe('loadDvpContext', () => {
  const insertDefense = (season, site, groupBy, team, key, fpoe) => db.sqliteDb.prepare(`
    INSERT INTO team_archetype_defense (season, site, group_by, team, group_key, games, fp_over_expectation)
    VALUES (?, ?, ?, ?, ?, 10, ?)`).run(season, site, groupBy, team, key, fpoe);
  const insertArchetype = (season, key, archetype) => db.sqliteDb.prepare(`
    INSERT INTO player_archetypes (season, player_key, archetype) VALUES (?, ?, ?)`)
    .run(season, key, archetype);

  test('reads the slate season for the site, falling back to the prior season when it has no rows', async () => {
    insertDefense('2025-26', 'draftkings', 'archetype', 'BOS', 'rim_running_big', -3);
    insertDefense('2025-26', 'fanduel', 'archetype', 'BOS', 'rim_running_big', -9);
    insertDefense('2025-26', 'draftkings', 'position', 'BOS', 'C', -1);
    insertArchetype('2025-26', 'walker kessler', 'rim_running_big');
    insertArchetype('2026-27', 'walker kessler', 'unclassified');

    const ctx = await dvp.loadDvpContext({ slateDate: '2026-10-21', site: 'draftkings' });
    assert.equal(ctx.season, '2025-26');
    const r = dvp.archetypeDvpAdjustment({ name: 'Walker Kessler', opponent: 'BOS', position: 'C' }, ctx, { ...CONFIG, weight: 1, cap: 5 });
    assert.equal(r.source, 'archetype');
    close(r.value, -3);

    insertDefense('2026-27', 'draftkings', 'position', 'BOS', 'C', -0.4);
    const current = await dvp.loadDvpContext({ slateDate: '2026-10-21', site: 'draftkings' });
    assert.equal(current.season, '2026-27');
    const p = dvp.archetypeDvpAdjustment({ name: 'Walker Kessler', opponent: 'BOS', position: 'C' }, current, { ...CONFIG, weight: 1, cap: 5 });
    assert.equal(p.source, 'position');
    close(p.value, -0.4);
  });
});
