import { test, describe, vi, beforeAll as before, afterAll as after, beforeEach } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { buildPlayerPool } from './fixtures/playerPool.js';

// Projection source (RotoWire / ours / blend) on slate reads: the setting, the
// pure layer (fields, ranges, fade call), loadSlatePlayers with the own model
// (mocked here: its numbers come from ownModelService, tested in M4) incl.
// per-player and whole-slate fallback, past slates point-in-time, and
// RotoWire leaving the optimizer exactly as before.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nba-dfs-source-'));
process.env.DATABASE_TYPE = 'sqlite';
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');

const own = vi.hoisted(() => ({ impl: null, calls: [] }));
vi.mock('../src/services/modelEval/ownModelService.js', () => ({
  projectSlateOwnModel: async (slateId, options) => {
    own.calls.push({ slateId, options });
    if (!own.impl) throw new Error('own model not expected');
    return own.impl(slateId, options);
  }
}));

const PAST = '2026-10-21';
const TODAY = '2026-10-23';
const NOW = new Date(`${TODAY}T16:00:00Z`);

let db;
let slateSource;
let setting;
let layer;
let sourceService;
let sanity;
let playerModel;
let snapshots;
let generateLineupBatch;

const raw = (date) => JSON.stringify({ game: { dateTime: `${date} 19:30:00` }, isHome: true });

async function seedLiveSlate(slateId, date, pool = buildPlayerPool()) {
  await db.run(`INSERT INTO slates (slate_id, name, sport, start_time, site) VALUES (?, 'Main', 'NBA', '7:30 PM', 'draftkings')`, slateId);
  await playerModel.bulkCreateOrUpdate(slateId, pool.map(p => ({
    playerId: `rw${p.id}`, name: p.name, team: p.team, opponent: p.opponent, position: p.position,
    salary: p.salary, projectedPoints: p.projected_points, projectedMinutes: 30, floor: p.floor, ceiling: p.ceiling,
    rostership: p.rostership, stdDev: 8, boomProbability: 10, bustProbability: 30, rawData: raw(date)
  })));
}

/** Own-model rows for every player: ours = RotoWire + delta(p), blend halfway. */
function ownRows(players, { delta = () => -1, skip = () => false } = {}) {
  return players.filter(p => !skip(p)).map(p => {
    const rw = Number(p.projected_points);
    const ours = Math.max(0, rw + delta(p));
    const diff = ours - rw;
    const lean = diff <= -6 ? 'lower 6+' : diff <= -4 ? 'lower 4-6' : diff >= 4 ? 'higher 4-6' : 'agree';
    return {
      id: p.id, name: p.name, rotowire_points: rw, ours_minutes: 31.5, p_play: 0.97,
      ours_mean: ours, p10: ours * 0.6, p90: ours * 1.5, p_boom: 0.2,
      blend_point: (rw + ours) / 2, blend_p10: (rw + ours) / 2 * 0.65, blend_p90: (rw + ours) / 2 * 1.45, blend_p_boom: 0.25,
      disagreement: { points_diff: diff, lean, history: lean === 'lower 4-6' ? { n: 79, hitRate: 0.709, closerRate: 0.54 } : { n: 350, hitRate: 0.566 } }
    };
  });
}

before(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  db = (await import('../src/config/database.js')).default;
  await (await import('../src/config/schema.js')).createTables(db);
  slateSource = await import('../src/services/slateSource.js');
  setting = await import('../src/config/projectionSource.js');
  layer = await import('../src/services/projections/sourceLayer.js');
  sourceService = await import('../src/services/projections/sourceService.js');
  sanity = await import('../src/config/projectionSanity.js');
  playerModel = (await import('../src/models/playerModel.js')).default;
  snapshots = await import('../src/services/slateSnapshotService.js');
  ({ generateLineupBatch } = await import('../src/services/optimizer/constraints/exposure.js'));
});

after(() => {
  vi.restoreAllMocks();
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(async () => {
  own.impl = null;
  own.calls = [];
  setting.setProjectionSource(null);
  sourceService.clearSourceSummaries();
  for (const t of ['players', 'slates', 'slate_player_snapshots']) await db.run(`DELETE FROM ${t}`);
  await seedLiveSlate('past', PAST);
  await snapshots.snapshotSlate('past', { now: new Date(`${PAST}T15:00:00Z`) });
  await db.run('DELETE FROM players');
  await db.run('DELETE FROM slates');
  await seedLiveSlate('tonight', TODAY);
});

describe('projection source setting', () => {
  test('defaults to the blend; env, runtime and reset', () => {
    const saved = process.env.PROJECTION_SOURCE;
    try {
      delete process.env.PROJECTION_SOURCE;
      assert.deepEqual(setting.projectionSourceStatus(), { source: 'blend', origin: 'default', default: 'blend', options: ['rotowire', 'ours', 'blend'] });
      process.env.PROJECTION_SOURCE = 'Ours';
      assert.equal(setting.projectionSource(), 'ours');
      assert.equal(setting.projectionSourceStatus().origin, 'env');
      process.env.PROJECTION_SOURCE = 'nonsense';
      assert.equal(setting.projectionSource(), 'blend');
      assert.equal(setting.setProjectionSource('rotowire').origin, 'runtime');
      assert.equal(setting.projectionSource(), 'rotowire');
      assert.equal(setting.setProjectionSource(null).source, 'blend');
      assert.throws(() => setting.setProjectionSource('espn'), /rotowire, ours, blend/);
    } finally {
      process.env.PROJECTION_SOURCE = saved;
    }
  });
});

describe('sourceLayer', () => {
  const player = { id: 1, name: 'A', salary: 6000, projected_points: 30, value: 5, floor: 22, ceiling: 40, std_dev: 8, volatility: 0.27, boom_probability: 12, projected_minutes: 30 };
  const row = {
    ours_mean: 24, p10: 12, p90: 37.6, p_boom: 0.18, ours_minutes: 28.5, p_play: 0.96, rotowire_points: 30,
    blend_point: 27, blend_p10: 14, blend_p90: 40, blend_p_boom: 0.22,
    disagreement: { points_diff: -6, lean: 'lower 6+', history: { n: 77, hitRate: 0.688 } }
  };

  test('ours: mean, p10 / p90, boom in percent, width-based std_dev, value scaled; RotoWire kept alongside', () => {
    const p = layer.applySource(player, row, 'ours');
    assert.equal(p.projected_points, 24);
    assert.equal(p.floor, 12);
    assert.equal(p.ceiling, 37.6);
    assert.equal(p.boom_probability, 18);
    assert.equal(p.std_dev, Number((25.6 / 2.5632).toFixed(2)));
    assert.equal(p.value, 4);
    assert.equal(p.projected_minutes, 30);
    assert.equal(p.projection_source, 'ours');
    assert.equal(p.projection_fallback, false);
    assert.equal(p.projection_rotowire, 30);
    assert.equal(p.projection_ours, 24);
    assert.equal(p.projection_blend, 27);
    assert.equal(p.ours_minutes, 28.5);
    assert.equal(p.p_play, 0.96);
  });

  test('blend: the blend point with our distribution re-centered on it', () => {
    const p = layer.applySource(player, row, 'blend');
    assert.equal(p.projected_points, 27);
    assert.equal(p.floor, 14);
    assert.equal(p.ceiling, 40);
    assert.equal(p.boom_probability, 22);
    assert.equal(p.projection_source, 'blend');
  });

  test('missing row or missing number: RotoWire kept, flagged with the reason', () => {
    const missing = layer.applySource(player, null, 'ours');
    assert.equal(missing.projected_points, 30);
    assert.equal(missing.floor, 22);
    assert.equal(missing.projection_source, 'rotowire');
    assert.equal(missing.projection_requested, 'ours');
    assert.equal(missing.projection_fallback, true);
    assert.match(missing.projection_fallback_reason, /not in the own model/);
    const noBlend = layer.applySource(player, { ...row, blend_point: null }, 'blend');
    assert.equal(noBlend.projected_points, 30);
    assert.equal(noBlend.projection_fallback, true);
    assert.equal(noBlend.projection_ours, 24);
  });

  test('a player RotoWire rules out keeps his 0 (the pool is RotoWire\'s)', () => {
    const p = layer.applySource({ ...player, projected_points: 0 }, { ...row, ours_mean: 3 }, 'ours');
    assert.equal(p.projected_points, 0);
    assert.equal(p.projection_fallback, false);
  });

  test('fade: ours lower by 4+ only, with its bucket\'s hit rate', () => {
    const at = (diff) => layer.fadeCall({ ...row, ours_mean: 30 + diff, disagreement: { ...row.disagreement, points_diff: diff } });
    assert.equal(at(-3.99), null);
    assert.equal(at(4.5), null);
    assert.equal(at(9), null);
    const fade = at(-4);
    assert.equal(fade.points_diff, -4);
    assert.equal(fade.hit_rate, 0.688);
    assert.equal(fade.n, 77);
    assert.equal(fade.bucket, 'lower 6+');
    assert.equal(fade.text, 'Fade: ours 26.0 vs RotoWire 30.0 (-4.0). Ours lower 6+: actual below RotoWire 69% of 77 saved-slate calls.');
    assert.equal(layer.applySource(player, row, 'blend').projection_fade.points_diff, -6);
    assert.equal(layer.fadeCall({ ...row, disagreement: { points_diff: -5, lean: 'lower 4-6', history: null } }).text,
      'Fade: ours 24.0 vs RotoWire 30.0 (-5.0).');
  });
});

describe('loadSlatePlayers with a projection source', () => {
  const live = () => slateSource.resolveSlate({ now: NOW });

  test('rotowire: rows exactly as before and the own model is never run', async () => {
    const source = await live();
    setting.setProjectionSource('rotowire');
    const before = await slateSource.loadSlatePlayers(source, { projectionSource: 'rotowire', now: NOW });
    const viaSetting = await slateSource.loadSlatePlayers(source, { now: NOW });
    assert.deepEqual(viaSetting, before);
    assert.equal(own.calls.length, 0);
    assert.ok(before.every(p => !('projection_source' in p)));
  });

  test('ours / blend follow the setting; sanity first, then the source', async () => {
    const source = await live();
    const posted = await slateSource.loadSlatePlayers(source, { projectionSource: 'rotowire', now: NOW });
    own.impl = () => ({ players: ownRows(posted, { delta: (p) => (p.id % 2 ? -5 : 2) }), cached: false, date: TODAY });

    setting.setProjectionSource('ours');
    let summary;
    const ours = await slateSource.loadSlatePlayers(source, { now: NOW, onProjectionSource: (s) => { summary = s; } });
    const byName = new Map(posted.map(p => [p.name, p]));
    for (const p of ours) {
      assert.equal(p.projection_source, 'ours');
      assert.equal(p.projection_rotowire, byName.get(p.name).projected_points);
      assert.equal(p.projected_points, Number((p.projection_rotowire + (p.id % 2 ? -5 : 2)).toFixed(2)));
      assert.equal(Boolean(p.projection_fade), p.id % 2 === 1);
    }
    assert.equal(summary.applied, posted.length);
    assert.equal(summary.fallback, 0);
    assert.equal(summary.fades, ours.filter(p => p.id % 2).length);
    assert.equal(own.calls[0].options.source.slateId, 'tonight');

    const blend = await slateSource.loadSlatePlayers(source, { projectionSource: 'blend', now: NOW });
    assert.ok(blend.every(p => p.projection_source === 'blend' && p.projected_points === Number(p.projection_blend.toFixed(2))));
    // best value first, as before
    for (let i = 1; i < blend.length; i++) assert.ok(Number(blend[i - 1].value) >= Number(blend[i].value));
    assert.equal(sourceService.lastSummary(source).source, 'blend');
  });

  test('a player missing from the own model keeps RotoWire and is counted', async () => {
    const source = await live();
    const posted = await slateSource.loadSlatePlayers(source, { projectionSource: 'rotowire', now: NOW });
    own.impl = () => ({ players: ownRows(posted, { skip: (p) => p.name === 'Player 3' }) });
    let summary;
    const players = await slateSource.loadSlatePlayers(source, { projectionSource: 'ours', now: NOW, onProjectionSource: (s) => { summary = s; } });
    const p3 = players.find(p => p.name === 'Player 3');
    assert.equal(p3.projection_fallback, true);
    assert.equal(p3.projected_points, posted.find(p => p.name === 'Player 3').projected_points);
    assert.equal(summary.fallback, 1);
    assert.equal(summary.applied, posted.length - 1);
    assert.ok(console.warn.mock.calls.some(c => /1 player\(s\).*Player 3/.test(c[0])));
  });

  test('the own model failing never breaks the read: every player keeps RotoWire', async () => {
    const source = await live();
    const posted = await slateSource.loadSlatePlayers(source, { projectionSource: 'rotowire', now: NOW });
    own.impl = () => { throw new Error('feature store down'); };
    let summary;
    const players = await slateSource.loadSlatePlayers(source, { projectionSource: 'blend', now: NOW, onProjectionSource: (s) => { summary = s; } });
    assert.equal(players.length, posted.length);
    assert.deepEqual(players.map(p => p.projected_points).sort(), posted.map(p => p.projected_points).sort());
    assert.ok(players.every(p => p.projection_fallback && /feature store down/.test(p.projection_fallback_reason)));
    assert.equal(summary.error, 'feature store down');
    assert.equal(summary.fallback, posted.length);
    assert.ok(console.warn.mock.calls.some(c => /own model failed for slate tonight/.test(c[0])));
  });

  test('a past slate projects point-in-time: the own model gets the backtest source (its date), rows by snapshot id', async () => {
    const source = await slateSource.resolveSlate({ slateDate: PAST, now: NOW });
    assert.equal(source.isBacktest, true);
    const posted = await slateSource.loadSlatePlayers(source, { projectionSource: 'rotowire', now: NOW });
    own.impl = (slateId, { source: s }) => ({ date: s.slateDate, players: ownRows(posted, { delta: () => -2 }) });
    const players = await slateSource.loadSlatePlayers(source, { projectionSource: 'ours', now: NOW });
    const passed = own.calls[0].options.source;
    assert.equal(passed.isBacktest, true);
    assert.equal(passed.slateDate, PAST);
    assert.equal(passed.slateId, 'past');
    assert.ok(players.every(p => p.projection_source === 'ours' && p.game_date === PAST));
    assert.ok(players.every(p => Math.abs(p.projected_points - (p.projection_rotowire - 2)) < 1e-9));
  });

  test('concurrent cold reads share one own-model run', async () => {
    const source = await live();
    const posted = await slateSource.loadSlatePlayers(source, { projectionSource: 'rotowire', now: NOW });
    own.impl = async () => { await new Promise(r => setTimeout(r, 20)); return { players: ownRows(posted) }; };
    await Promise.all([1, 2, 3].map(() => slateSource.loadSlatePlayers(source, { projectionSource: 'ours', now: NOW })));
    assert.equal(own.calls.length, 1);
  });
});

describe('regression: RotoWire source leaves the optimizer as it was', () => {
  test('same players and the same lineups as the posted + sanity pipeline', async () => {
    const source = await slateSource.resolveSlate({ now: NOW });
    setting.setProjectionSource('rotowire');
    // Today's pipeline, by hand: posted rows (players table) + the sanity layer when it is on
    const { applyProjectionSanity } = await import('../src/services/projections/sanityService.js');
    const posted = await playerModel.getBySlateId('tonight', {});
    const all = await db.all('SELECT * FROM players WHERE slate_id = ?', 'tonight');
    const expected = sanity.projectionSanityEnabled()
      ? await applyProjectionSanity(source, posted, { projected: all.filter(p => p.projected_points > 0), all, now: NOW })
      : posted;
    const players = await slateSource.loadSlatePlayers(source, { now: NOW });
    const strip = (list) => list.map(p => ({ ...p, roster_positions: undefined })).sort((a, b) => a.id - b.id);
    assert.deepEqual(strip(players), strip(expected));

    const ids = (r) => r.lineups.map(l => l.players.map(s => s.player?.id).sort());
    for (const settings of [{ mode: 'cash', numLineups: 1 }, { mode: 'gpp', numLineups: 3, minUniqueness: 2 }]) {
      const ours = generateLineupBatch(players, { ...settings, site: 'draftkings' });
      const rosterPositions = new Map(players.map(p => [p.id, p.roster_positions]));
      const today = generateLineupBatch(expected.map(p => ({ ...p, roster_positions: p.roster_positions ?? rosterPositions.get(p.id) })),
        { ...settings, site: 'draftkings' });
      assert.deepEqual(ids(ours), ids(today));
    }
    assert.equal(own.calls.length, 0);
  });
});
