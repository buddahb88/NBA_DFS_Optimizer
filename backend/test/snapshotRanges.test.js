import { test, describe, vi, beforeAll as before, beforeEach, afterAll as after } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Model ranges for saved slates: game logs strictly before the slate date,
// stored in *_model columns next to the untouched pre-lock ranges, used by
// rebuilds unless the original ranges are asked for.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nba-dfs-snapshot-ranges-'));
process.env.DATABASE_TYPE = 'sqlite';
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');

const DATE = '2026-10-21';
let db;
let service;
let outcome;
let source;

before(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  db = (await import('../src/config/database.js')).default;
  await (await import('../src/config/schema.js')).createTables(db);
  service = await import('../src/services/variance/snapshotRangeService.js');
  outcome = await import('../src/services/variance/outcomeRangeService.js');
  source = await import('../src/services/slateSource.js');
});

after(() => {
  vi.restoreAllMocks();
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const snapshot = (key, name, extra = {}) => db.run(
  `INSERT INTO slate_player_snapshots (snapshot_date, game_date, slate_id, site, player_key, player_name, team, opponent, position,
     salary, projected_points, projected_minutes, floor, ceiling, std_dev, boom_probability, bust_probability, rostership)
   VALUES (?, ?, 's1', 'draftkings', ?, ?, 'LAL', 'GSW', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  DATE, DATE, key, name, extra.position ?? 'PG', extra.salary ?? 9000, extra.projection ?? 45, extra.minutes ?? 34,
  extra.floor ?? 40, extra.ceiling ?? 50, extra.stdDev ?? 5, extra.boom ?? 3, extra.bust ?? 60, extra.own ?? 10);

const game = (key, date, fp, minutes = 34) => db.run(
  `INSERT INTO historical_games (player_name, player_key, team, opponent, game_date, minutes, points, dk_fantasy_points, season, season_type)
   VALUES (?, ?, 'LAL', 'GSW', ?, ?, 10, ?, '2025-26', 'regular')`, key, key, date, minutes, fp);

beforeEach(async () => {
  for (const t of ['slate_player_snapshots', 'historical_games']) await db.run(`DELETE FROM ${t}`);
  await snapshot('luka doncic', 'Luka Doncic');
  await snapshot('rookie guy', 'Rookie Guy', { projection: 18, salary: 4000, minutes: 20, position: 'SF' });
  // Volatile history before the slate
  const fps = [20, 70, 35, 60, 25, 65, 30, 55, 40, 50];
  for (let i = 0; i < fps.length; i++) await game('luka doncic', `2026-04-${String(i + 1).padStart(2, '0')}`, fps[i]);
});

const row = (key) => db.get(`SELECT * FROM slate_player_snapshots WHERE player_key = ?`, key);

describe('recomputeSnapshotRanges', () => {
  test('stores model ranges and leaves the pre-lock ranges alone', async () => {
    const report = await service.recomputeSnapshotRanges(DATE);
    assert.equal(report.rows, 2);
    assert.equal(report.version, service.RANGE_MODEL_VERSION);

    const luka = await row('luka doncic');
    assert.equal(luka.floor, 40);
    assert.equal(luka.ceiling, 50);
    assert.equal(luka.std_dev, 5);
    assert.equal(luka.boom_probability, 3);
    assert.ok(luka.floor_model < luka.ceiling_model);
    assert.ok(luka.std_dev_model > 0);
    assert.ok(luka.boom_model >= 0 && luka.bust_model >= 0);
    assert.equal(luka.leverage_model, outcome.leverageScore(luka.boom_model, 10));
    assert.equal(luka.range_model_version, service.RANGE_MODEL_VERSION);
    assert.ok(luka.range_model_at);

    // Same numbers as the live model given the same inputs and the pre-slate log
    const logs = await outcome.loadGameLogs(['luka doncic'], { beforeDate: DATE });
    const expected = outcome.rangeForPlayer({ name: 'Luka Doncic', position: 'PG', salary: 9000, projection: 45, minutes: 34, gameDate: DATE }, logs);
    assert.ok(Math.abs(luka.floor_model - expected.floor) < 1e-9);
    assert.ok(Math.abs(luka.ceiling_model - expected.ceiling) < 1e-9);

    // No history: position prior only, still a range
    const rookie = await row('rookie guy');
    assert.ok(rookie.ceiling_model > rookie.floor_model);
  });

  test('no lookahead: games on or after the slate date do not change the range', async () => {
    await service.recomputeSnapshotRanges(DATE);
    const before = await row('luka doncic');
    // The slate's own game and a later one, both extreme
    await game('luka doncic', DATE, 150);
    await game('luka doncic', '2026-10-25', 0, 40);
    await service.recomputeSnapshotRanges(DATE);
    const after = await row('luka doncic');
    for (const c of ['floor_model', 'ceiling_model', 'std_dev_model', 'boom_model', 'bust_model']) {
      assert.equal(after[c], before[c], c);
    }
  });

  test('only touches the requested date', async () => {
    await db.run(`UPDATE slate_player_snapshots SET game_date = '2026-10-20' WHERE player_key = 'rookie guy'`);
    const report = await service.recomputeSnapshotRanges(DATE);
    assert.equal(report.rows, 1);
    assert.equal((await row('rookie guy')).floor_model, null);
  });
});

describe('rebuilds use model ranges by default', () => {
  test('SlateSource swaps in the model ranges and keeps the originals; ranges=original keeps the pre-lock ones', async () => {
    await service.recomputeSnapshotRanges(DATE);
    const stored = await row('luka doncic');
    const s = await source.resolveSlate({ slateDate: DATE, now: new Date('2026-10-23T16:00:00Z') });

    const [model] = (await source.loadSlatePlayers(s)).filter(p => p.name === 'Luka Doncic');
    assert.equal(model.range_source, 'model');
    assert.equal(model.floor, stored.floor_model);
    assert.equal(model.ceiling, stored.ceiling_model);
    assert.equal(model.std_dev, stored.std_dev_model);
    assert.equal(model.boom_probability, stored.boom_model);
    assert.equal(model.leverage_score, stored.leverage_model);
    assert.equal(model.floor_original, 40);
    assert.equal(model.ceiling_original, 50);

    const [original] = (await source.loadSlatePlayers(s, { ranges: 'original' })).filter(p => p.name === 'Luka Doncic');
    assert.equal(original.range_source, 'original');
    assert.equal(original.floor, 40);
    assert.equal(original.ceiling, 50);
    assert.equal(original.std_dev, 5);
    assert.equal(original.floor_model, stored.floor_model);
  });

  test('snapshots without model ranges fall back to the originals', async () => {
    const s = await source.resolveSlate({ slateDate: DATE, now: new Date('2026-10-23T16:00:00Z') });
    const [p] = (await source.loadSlatePlayers(s)).filter(x => x.name === 'Luka Doncic');
    assert.equal(p.range_source, 'original');
    assert.equal(p.floor, 40);
  });
});
