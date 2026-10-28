import { test, describe, beforeAll as before, beforeEach, afterAll as after } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Every live slate we snapshot also lands in slate_catalog, so a past night
// is a backtestable main slate without a RotoWire backfill run.

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nba-dfs-slate-catalog-'));
process.env.DATABASE_TYPE = 'sqlite';
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');

let db;
let snapshots;
let catalog;
let source;

before(async () => {
  db = (await import('../src/config/database.js')).default;
  await (await import('../src/config/schema.js')).createTables(db);
  snapshots = await import('../src/services/slateSnapshotService.js');
  catalog = await import('../src/services/slateCatalogService.js');
  source = await import('../src/services/slateSource.js');
});

after(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(async () => {
  for (const t of ['slates', 'players', 'slate_player_snapshots', 'slate_catalog']) await db.run(`DELETE FROM ${t}`);
});

const NOW = new Date('2026-10-27T20:00:00Z');
const MATCHUPS = [['BOS', 'NYK', '19:30'], ['LAL', 'GSW', '22:00'], ['MIA', 'ORL', '19:00'], ['DEN', 'PHX', '21:00']];

// A synced live slate: slates row plus two players per game (RotoWire raw_data carries the ET game time)
async function seedLiveSlate(slateId, games, { site = 'draftkings', name = 'All', date = '2026-10-27', positions = 'PG' } = {}) {
  await db.run(`INSERT INTO slates (slate_id, name, sport, start_time, site) VALUES (?, ?, 'NBA', NULL, ?)`, slateId, name, site);
  for (const [away, home, time] of MATCHUPS.slice(0, games)) {
    for (const [team, opp] of [[away, home], [home, away]]) {
      await db.run(`INSERT INTO players (slate_id, player_id, name, team, opponent, position, salary, projected_points, raw_data)
        VALUES (?, ?, ?, ?, ?, ?, 6000, 30, ?)`,
      slateId, `${slateId}-${team}`, `${team} Starter`, team, opp, positions,
      JSON.stringify({ game: { dateTime: `${date} ${time}:00` } }));
    }
  }
}

const rows = () => db.all(`SELECT * FROM slate_catalog ORDER BY game_date, slate_id`);

describe('live snapshots catalog their slate', () => {
  test('snapshotSlate creates the slate_catalog row (date, games, lock, main)', async () => {
    await seedLiveSlate('29931', 2);
    await snapshots.snapshotSlate('29931', { now: NOW });

    const [row, ...rest] = await rows();
    assert.equal(rest.length, 0);
    assert.equal(row.site, 'draftkings');
    assert.equal(row.slate_id, '29931');
    assert.equal(row.game_date, '2026-10-27');
    assert.equal(row.games, 2);
    assert.equal(row.players, 4);
    assert.equal(row.contest_type, 'classic');
    assert.equal(row.first_game_time, '2026-10-27T23:30:00.000Z');
    assert.equal(row.is_main, 1);
    assert.equal(row.source, 'live');
    assert.equal(row.name, 'Main · 2 games · 7:30 PM ET');
  });

  test('a later slate on the same date with more games becomes main and demotes the first', async () => {
    await seedLiveSlate('29931', 2);
    await snapshots.snapshotSlate('29931', { now: NOW });
    await seedLiveSlate('29940', 4);
    await snapshots.snapshotSlate('29940', { now: NOW });

    const byId = Object.fromEntries((await rows()).map(r => [r.slate_id, r]));
    assert.equal(byId['29940'].is_main, 1);
    assert.equal(byId['29931'].is_main, 0);
    assert.equal(byId['29931'].name, 'Classic · 2 games · 7:30 PM ET', 'a live row is renamed with its new flag');
    assert.equal(byId['29940'].first_game_time, '2026-10-27T23:00:00.000Z');
  });

  test('re-running a snapshot is a no-op for the catalog', async () => {
    await seedLiveSlate('29931', 2);
    await snapshots.snapshotSlate('29931', { now: NOW });
    const first = await rows();
    await snapshots.snapshotSlate('29931', { now: new Date('2026-10-27T21:00:00Z') });
    assert.deepEqual(await rows(), first);
  });

  test('a showdown slate is cataloged but never main', async () => {
    await seedLiveSlate('29931', 2);
    await snapshots.snapshotSlate('29931', { now: NOW });
    await seedLiveSlate('29950', 4, { positions: 'CPT' });
    await db.run(`UPDATE players SET roster_positions = 'CPT/UTIL' WHERE slate_id = '29950'`);
    await snapshots.snapshotSlate('29950', { now: NOW });

    const byId = Object.fromEntries((await rows()).map(r => [r.slate_id, r]));
    assert.equal(byId['29950'].contest_type, 'showdown');
    assert.equal(byId['29950'].is_main, 0);
    assert.equal(byId['29931'].is_main, 1);
  });

  test('a backfill-sourced row keeps its name and richer fields; main is still recomputed for the date', async () => {
    await db.run(`INSERT INTO slate_catalog (site, slate_id, game_date, name, contest_type, games, players, first_game_time, is_main, source, updated_at)
      VALUES ('draftkings', '29931', '2026-10-27', 'Main · 2 games · 7:30 PM ET', 'classic', 2, 70, '2026-10-27T23:30:00.000Z', 1, 'rotowire', 'x')`);
    await seedLiveSlate('29931', 2);
    await snapshots.snapshotSlate('29931', { now: NOW });

    let [row] = await rows();
    assert.equal(row.name, 'Main · 2 games · 7:30 PM ET');
    assert.equal(row.players, 70, 'RotoWire player count is not replaced by the projected-only count');
    assert.equal(row.source, 'rotowire');
    assert.equal(row.updated_at, 'x', 'nothing changed');

    await seedLiveSlate('29940', 4);
    await snapshots.snapshotSlate('29940', { now: NOW });
    const byId = Object.fromEntries((await rows()).map(r => [r.slate_id, r]));
    assert.equal(byId['29940'].is_main, 1);
    assert.equal(byId['29931'].is_main, 0);
    assert.equal(byId['29931'].name, 'Main · 2 games · 7:30 PM ET', 'backfill names are kept');
  });

  test('cataloging the backfill way still leaves exactly one main per date', async () => {
    await seedLiveSlate('29940', 4);
    await snapshots.snapshotSlate('29940', { now: NOW });
    // The backfill only sees its own slates and marks one of them main
    await catalog.upsertCatalogSlate({
      site: 'draftkings', slate_id: '29931', game_date: '2026-10-27', name: 'Main · 2 games · 7:30 PM ET', contest_type: 'classic',
      games: 2, players: 70, first_game_time: '2026-10-27T23:30:00.000Z', is_main: 1, source: 'rotowire'
    }, { now: NOW });

    const byId = Object.fromEntries((await rows()).map(r => [r.slate_id, r]));
    assert.equal(byId['29940'].is_main, 1);
    assert.equal(byId['29931'].is_main, 0);
  });
});

describe('catalogMissingSlates (one-time fix)', () => {
  test('catalogs every snapshotted or synced slate without a catalog row; a re-run is a no-op', async () => {
    await seedLiveSlate('29931', 2);
    await snapshots.snapshotSlate('29931', { now: NOW });
    await db.run(`DELETE FROM slate_catalog`);
    await db.run(`INSERT INTO slate_catalog (site, slate_id, game_date, name, contest_type, games, players, first_game_time, is_main, source, updated_at)
      VALUES ('draftkings', '29910', '2026-10-26', 'Main · 7 games · 7:00 PM ET', 'classic', 7, 200, '2026-10-26T23:00:00.000Z', 1, 'rotowire', 'x')`);

    const first = await catalog.catalogMissingSlates({ now: NOW });
    assert.deepEqual(first.cataloged, [{ site: 'draftkings', slateId: '29931', gameDate: '2026-10-27' }]);
    const [backfilled, live] = await rows();
    assert.equal(backfilled.updated_at, 'x');
    assert.equal(live.slate_id, '29931');
    assert.equal(live.is_main, 1);

    const before = await rows();
    const second = await catalog.catalogMissingSlates({ now: NOW });
    assert.deepEqual(second.cataloged, []);
    assert.deepEqual(await rows(), before);
  });

  test('a synced slate with no snapshots is cataloged from its players rows', async () => {
    await seedLiveSlate('29931', 2);
    const { cataloged } = await catalog.catalogMissingSlates({ now: NOW });
    assert.deepEqual(cataloged, [{ site: 'draftkings', slateId: '29931', gameDate: '2026-10-27' }]);
    assert.equal((await db.get(`SELECT COUNT(*) n FROM slate_player_snapshots`)).n, 0, 'no snapshot rows written');
  });

  test('the backtest picker lists the night as its main slate', async () => {
    await seedLiveSlate('29931', 2);
    await snapshots.snapshotSlate('29931', { now: NOW });
    const list = await source.listBacktestSlates({ now: new Date('2026-10-28T15:00:00Z') });
    const night = list.find(s => s.slateDate === '2026-10-27');
    assert.equal(night.isMain, true);
    assert.equal(night.name, 'Main · 2 games · 7:30 PM ET');
  });
});
