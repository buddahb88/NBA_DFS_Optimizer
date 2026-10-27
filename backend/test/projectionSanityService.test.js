import { test, describe, vi, beforeAll as before, afterAll as after, beforeEach } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

// The sanity layer on slate reads (slateSource.loadSlatePlayers): own rate from
// games before the slate date only, adjusted projection with the posted one
// kept, snapshots never written, on/off per call and by setting.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nba-dfs-sanity-'));
process.env.DATABASE_TYPE = 'sqlite';
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');
delete process.env.PROJECTION_SANITY;

const addDays = (date, n) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

let db;
let slateSource;
let sanity;
let setting;
let SANITY_CONFIG;
let playerKey;

const SLATE_DATE = '2026-12-20';
const NOW = new Date('2026-12-25T16:00:00Z');
const GAMES = 20;
const gameDate = (g) => addDays(SLATE_DATE, -2 * (GAMES + 1 - g));

async function box(name, team, opp, date, minutes, fp) {
  const gameId = `${date}-${[team, opp].sort().join('-')}`;
  for (const [t, o] of [[team, opp], [opp, team]]) {
    await db.run(`INSERT OR IGNORE INTO team_game_stats (game_id, game_date, season, season_type, team, opponent,
      minutes, fgm, fga, fta, tov, oreb, dreb, possessions) VALUES (?, ?, '2026-27', 'regular', ?, ?, 240, 40, 90, 25, 14, 10, 35, 100)`,
    gameId, date, t, o);
  }
  await db.run(`INSERT INTO historical_games (player_name, player_key, team, opponent, game_id, game_date, season, season_type,
      minutes, points, fg_made, fg_attempted, is_starter, dk_fantasy_points, fd_fantasy_points, yahoo_fantasy_points)
    VALUES (?, ?, ?, ?, ?, ?, '2026-27', 'regular', ?, 10, 4, 10, 1, ?, ?, ?)`,
  name, playerKey(name), team, opp, gameId, date, minutes, fp, fp, fp);
}

async function snapshot(name, team, opp, { projected, minutes, spread, salary = 6000 }) {
  await db.run(`INSERT INTO slate_player_snapshots (snapshot_date, game_date, site, slate_id, player_key, player_name, team, opponent,
      position, salary, projected_points, projected_minutes, floor, ceiling, rostership, vegas_implied_total, vegas_spread, over_under, value)
    VALUES (?, ?, 'draftkings', 'S1', ?, ?, ?, ?, 'SF', ?, ?, ?, ?, ?, 10, 113, ?, 226, ?)`,
  SLATE_DATE, SLATE_DATE, playerKey(name), name, team, opp, salary, projected, minutes, projected * 0.7, projected * 1.4, spread,
  projected / (salary / 1000));
}

async function seed() {
  for (let g = 1; g <= GAMES; g++) {
    await box('Hot Wing', 'BOS', 'NYK', gameDate(g), 30, 24); // 0.8 FPPM
    await box('Steady Big', 'NYK', 'BOS', gameDate(g), 30, 30); // 1.0 FPPM
  }
  // The slate night itself must never feed the own rate
  await box('Hot Wing', 'BOS', 'NYK', SLATE_DATE, 30, 90);
  // Posted 40 on 30 min = 1.33 FPPM vs own 0.8: shrunk. Steady Big: 1.0 = own, but a 16-point underdog starter
  await snapshot('Hot Wing', 'BOS', 'NYK', { projected: 40, minutes: 30, spread: -3 });
  await snapshot('Steady Big', 'NYK', 'BOS', { projected: 34, minutes: 34, spread: 16 });
}

before(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  db = (await import('../src/config/database.js')).default;
  await (await import('../src/config/schema.js')).createTables(db);
  slateSource = await import('../src/services/slateSource.js');
  sanity = await import('../src/services/projections/sanityService.js');
  setting = await import('../src/config/projectionSanity.js');
  ({ SANITY_CONFIG } = await import('../src/services/projections/sanityLayer.js'));
  ({ playerKey } = await import('../src/utils/playerKey.js'));
  await seed();
});

after(() => {
  vi.restoreAllMocks();
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  sanity.clearSanityCache();
  setting.setProjectionSanity(null);
  setting.setProjectionSanityComponents(null);
  for (const k of ['PROJECTION_SANITY', 'PROJECTION_SANITY_FPPM', 'PROJECTION_SANITY_BLOWOUT']) delete process.env[k];
});

const source = () => slateSource.resolveSlate({ slateDate: SLATE_DATE, site: 'draftkings', now: NOW });
const byName = (players) => Object.fromEntries(players.map(p => [p.name, p]));
const shrunk = () => 40 - SANITY_CONFIG.fppm.overFraction * (40 - 24);

describe('loadSlatePlayers with the sanity layer', () => {
  test('both components: adjusted projected_points, the posted value kept, the reasons', async () => {
    setting.setProjectionSanityComponents({ fppm: true, blowout: true });
    const { 'Hot Wing': wing, 'Steady Big': big } = byName(await slateSource.loadSlatePlayers(await source(), { sanity: true }));

    // own 0.8 (games before the slate only; the 90-point night is excluded): ratio 1.67 -> full shrink
    assert.equal(wing.projection_raw, 40);
    assert.equal(wing.projected_points, shrunk());
    assert.equal(wing.projection_adjustment, shrunk() - 40);
    assert.equal(wing.projection_sanity, true);
    assert.deepEqual(wing.projection_reasons, [`FPPM 1.33 vs own 0.80: -${(40 - shrunk()).toFixed(1)}`]);
    // value and range follow the projection
    assert.ok(Math.abs(wing.value - shrunk() / 6) < 0.01);
    assert.ok(Math.abs(wing.floor - 28 * shrunk() / 40) < 0.01);

    // Underdog starter: minutes and points trimmed
    assert.equal(big.projected_minutes_raw, 34);
    assert.ok(big.projected_minutes < 34);
    assert.ok(big.projected_points < 34);
    assert.match(big.projection_reasons[0], /^blowout \+16\.0: -\d\.\d min, -\d\.\d pts$/);
  });

  test('defaults (from the backtest): on, blowout trim only - the FPPM shrink is opt-in', async () => {
    const status = setting.projectionSanityStatus();
    assert.equal(status.enabled, true);
    assert.deepEqual(status.components, { fppm: false, blowout: true });
    const { 'Hot Wing': wing, 'Steady Big': big } = byName(await slateSource.loadSlatePlayers(await source()));
    assert.equal(wing.projected_points, 40);
    assert.deepEqual(wing.projection_reasons, []);
    assert.ok(big.projected_points < 34);
  });

  test('sanity: false, or the setting off, leaves the posted projection', async () => {
    setting.setProjectionSanityComponents({ fppm: true });
    const off = byName(await slateSource.loadSlatePlayers(await source(), { sanity: false }));
    assert.equal(off['Hot Wing'].projected_points, 40);
    assert.equal(off['Hot Wing'].projection_sanity, undefined);

    const on = byName(await slateSource.loadSlatePlayers(await source()));
    assert.equal(on['Hot Wing'].projected_points, shrunk());
    setting.setProjectionSanity(false);
    const offAgain = byName(await slateSource.loadSlatePlayers(await source()));
    assert.equal(offAgain['Steady Big'].projected_points, 34);
  });

  test('an unadjusted player keeps every number as it was (no rounding, null minutes stay null)', () => {
    const p = { name: 'Plain', projected_points: 21.337, projected_minutes: null, floor: 14.1234, ceiling: 30.987, value: 4.2671, vegas_spread: 2 };
    const r = sanity.adjustPlayer(p, null, setting.projectionSanityConfig());
    for (const k of ['projected_points', 'projected_minutes', 'floor', 'ceiling', 'value']) assert.equal(r[k], p[k], k);
    assert.equal(r.projection_raw, 21.337);
    assert.equal(r.projection_adjustment, 0);
    assert.deepEqual(r.projection_reasons, []);
  });

  test('never writes the snapshot rows', async () => {
    setting.setProjectionSanityComponents({ fppm: true });
    await slateSource.loadSlatePlayers(await source(), { sanity: true });
    const row = await db.get(`SELECT projected_points, projected_minutes FROM slate_player_snapshots WHERE player_name = 'Hot Wing'`);
    assert.equal(row.projected_points, 40);
    assert.equal(row.projected_minutes, 30);
  });

  test('setting: runtime > env > default, for the switch and each component', () => {
    assert.equal(setting.projectionSanityStatus().source, 'default');
    process.env.PROJECTION_SANITY = 'off';
    assert.deepEqual([setting.projectionSanityEnabled(), setting.projectionSanityStatus().source], [false, 'env']);
    setting.setProjectionSanity(true);
    assert.deepEqual([setting.projectionSanityEnabled(), setting.projectionSanityStatus().source], [true, 'runtime']);
    assert.equal(setting.projectionSanityStatus().default, false); // what a reset returns to

    process.env.PROJECTION_SANITY_FPPM = 'on';
    assert.equal(setting.projectionSanityStatus().components.fppm, true);
    setting.setProjectionSanityComponents({ fppm: false });
    assert.equal(setting.projectionSanityStatus().components.fppm, false);
    assert.equal(setting.projectionSanityConfig().fppm.enabled, false);
    assert.equal(setting.projectionSanityConfig().blowout.enabled, true);
  });
});
