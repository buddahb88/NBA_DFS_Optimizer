import { test, describe, beforeAll as before, afterAll as after } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { buildData, nameOf, scheduleDates } from './helpers/modelEvalData.js';

// Projectors that fall back to the database must find an empty one, not the real file
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nba-dfs-model-eval-'));
let db;
let metrics;
let projectors;
let evaluate;
let featureStore;
let minutesModel;
let playerKey;

before(async () => {
  process.env.DATABASE_TYPE = 'sqlite';
  process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');
  db = (await import('../src/config/database.js')).default;
  await (await import('../src/config/schema.js')).createTables(db);
  metrics = await import('../src/services/modelEval/metrics.js');
  projectors = await import('../src/services/modelEval/projectors.js');
  evaluate = await import('../src/services/modelEval/evaluate.js');
  featureStore = await import('../src/services/modelEval/featureStore.js');
  minutesModel = await import('../src/services/minutesModel.js');
  ({ playerKey } = await import('../src/utils/playerKey.js'));
});

after(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);
const SEASON2 = scheduleDates('2025-11-01', 20);
const D = SEASON2[12];
const mean = (xs) => xs.reduce((s, v) => s + v, 0) / xs.length;

describe('metrics', () => {
  test('quantile interpolates', () => {
    assert.equal(metrics.quantile([1, 2, 3, 4, 5], 0.5), 3);
    close(metrics.quantile([0, 10], 0.1), 1);
    assert.equal(metrics.quantile([], 0.5), null);
  });

  test('coverage counts actuals below p10 / above p90', () => {
    const c = metrics.coverage([
      { p10: 10, p90: 20, actual: 5 }, { p10: 10, p90: 20, actual: 15 }, { p10: 10, p90: 20, actual: 25 }, { p10: 10, p90: 20, actual: 12 },
      { p10: null, p90: 20, actual: 1 }
    ]);
    assert.deepEqual(c, { n: 4, belowP10: 25, aboveP90: 25, within: 50, avgWidth: 10 });
  });

  test('paired bootstrap: deterministic, CI below 0 when A is always better', () => {
    const rows = Array.from({ length: 200 }, (_, i) => ({
      date: `d${i % 20}`, actual: { dk: 20 + (i % 7) }, preds: { a: { dk_points: 20 + (i % 7) + 1 }, b: { dk_points: 20 + (i % 7) + 3 + (i % 3) } }
    }));
    const r1 = metrics.pairedBootstrap(rows, 'a', 'b', { iterations: 300, seed: 7 });
    const r2 = metrics.pairedBootstrap(rows, 'a', 'b', { iterations: 300, seed: 7 });
    assert.deepEqual(r1, r2);
    close(r1.diff, 1 - mean(rows.map((_, i) => 3 + (i % 3))), 1e-3);
    assert.ok(r1.ci[1] < 0);
    assert.equal(r1.pBetter, 1);
    const clustered = metrics.pairedBootstrap(rows, 'a', 'b', { iterations: 300, seed: 7, cluster: r => r.date });
    close(clustered.diff, r1.diff, 1e-3);
    assert.ok(clustered.ci[1] < 0);
  });

  test('value hit rate: top N by projected value, hit = 5x salary', () => {
    const rows = [
      { group: 's1', salary: 4000, actual: { dk: 25 }, preds: { p: { dk_points: 30 } } }, // value 7.5, hit
      { group: 's1', salary: 5000, actual: { dk: 10 }, preds: { p: { dk_points: 30 } } }, // value 6, miss
      { group: 's1', salary: 8000, actual: { dk: 45 }, preds: { p: { dk_points: 30 } } }, // value 3.75, not top 2
      { group: 's2', salary: 3000, actual: { dk: 15 }, preds: { p: { dk_points: 20 } } }, // hit (exactly 5x)
      { group: 's2', salary: 3000, actual: { dk: 0 }, preds: { p: null } }
    ];
    const r = metrics.valueHitRate(rows, 'p', { top: 2, group: x => x.group });
    assert.equal(r.picks, 3);
    assert.equal(r.hits, 2);
    close(r.rate, 0.667);
  });

  test('scoreProjector: points, minutes, per-stat and coverage', () => {
    const rows = [
      { actual: { dk: 20, minutes: 30, pts: 10 }, preds: { p: { dk_points: 22, minutes: 28, stats: { pts: 12 }, p10: 10, p90: 30 } } },
      { actual: { dk: 40, minutes: 34, pts: 25 }, preds: { p: { dk_points: 30, minutes: 36, stats: { pts: 20 }, p10: 15, p90: 35 } } }
    ];
    const s = metrics.scoreProjector(rows, 'p');
    assert.equal(s.n, 2);
    close(s.mae, 6);
    close(s.bias, -4);
    close(s.minutes.mae, 2);
    close(s.stats.pts.mae, 3.5);
    assert.equal(s.coverage.aboveP90, 50);
  });
});

describe('projectors', () => {
  let store;
  const key = () => playerKey(nameOf('AAA', 'Star'));
  const ctxFor = (date, name = nameOf('AAA', 'Star'), extra = {}) => {
    const view = store.asOf(date);
    const day = store.gameDay(date);
    const players = day.players.map(p => evaluate.contextPlayer(p, view, day));
    const player = players.find(p => p.name === name);
    return { mode: 'replay', date, season: view.season, site: 'draftkings', view, day, players, shared: new Map(), slate: null, player, ...extra };
  };
  const run = async (name, ctx) => {
    const p = projectors.createProjector(name);
    await p.prepareDate?.(ctx);
    const out = await p.project(ctx);
    await p.finish?.();
    return out;
  };

  before(() => {
    store = featureStore.createFeatureStore(buildData());
  });

  test('registry lists the baselines with modes', () => {
    const names = projectors.listProjectors().map(p => p.name);
    for (const n of ['season_avg', 'last5_avg', 'l10_minutes_x_fppm', 'legacy', 'minutes_model', 'minutes_model_no_redistribution', 'rotowire_raw', 'rotowire_adjusted']) {
      assert.ok(names.includes(n), n);
    }
    assert.deepEqual(projectors.listProjectors().find(p => p.name === 'rotowire_raw').modes, ['slate']);
    assert.throws(() => projectors.createProjector('nope'), /Unknown projector/);
  });

  test('season_avg: season-to-date mean, last season before the first game', async () => {
    const games = store.asOf(D).playerGames(key(), { seasons: 'current' });
    const out = await run('season_avg', ctxFor(D));
    close(out.dk_points, mean(games.map(g => g.dk_fantasy_points)));
    close(out.minutes, mean(games.map(g => g.minutes)));
    close(out.stats.reb, mean(games.map(g => g.rebounds)));
    assert.ok(out.p10 <= out.dk_points && out.dk_points <= out.p90);
    const first = await run('season_avg', ctxFor(SEASON2[0]));
    const last = store.asOf(SEASON2[0]).playerGames(key(), { seasons: 'current+prior' });
    close(first.dk_points, mean(last.map(g => g.dk_fantasy_points)));
  });

  test('last5_avg and l10_minutes_x_fppm', async () => {
    const games = store.asOf(D).playerGames(key());
    const l5 = await run('last5_avg', ctxFor(D));
    close(l5.dk_points, mean(games.slice(0, 5).map(g => g.dk_fantasy_points)));
    const season = store.asOf(D).playerGames(key(), { seasons: 'current' });
    const fppm = season.reduce((s, g) => s + g.dk_fantasy_points, 0) / season.reduce((s, g) => s + g.minutes, 0);
    const l10 = mean(games.slice(0, 10).map(g => g.minutes));
    const out = await run('l10_minutes_x_fppm', ctxFor(D));
    close(out.minutes, l10);
    close(out.dk_points, l10 * fppm);
  });

  test('minutes model matches projectPlayers on the history before the date', async () => {
    const ctx = ctxFor(D);
    const out = await run('minutes_model', ctx);
    const logs = store.asOf(D).minutesLogs();
    assert.ok(logs.every(g => g.date < D));
    const direct = minutesModel.projectPlayers([{ id: 'x', name: ctx.player.name, team: 'AAA', opponent: 'BBB', isB2B: false }], logs, { redistribute: false });
    const noInj = await run('minutes_model_no_redistribution', ctxFor(D));
    close(noInj.dk_points, direct.get('x').points);
    close(noInj.minutes, direct.get('x').minutes);
    // Nobody is out, so redistribution changes nothing
    close(out.dk_points, noInj.dk_points);
  });

  test('legacy runs from the feature store (no database rows exist)', async () => {
    const out = await run('legacy', ctxFor(D));
    assert.ok(out && out.dk_points > 0, 'enhanced projection from primed history');
    const projectionService = (await import('../src/services/projectionService.js')).default;
    assert.equal(projectionService.defenseRankings, null, 'finish() restores the service');
  });

  test('rotowire projectors read the slate, and a known OUT player projects 0', async () => {
    const slate = { slateId: 's', salary: 5000, rotowire: 31.5, rotowireMinutes: 33, adjusted: 30.1, adjustedMinutes: 32, floor: 20, ceiling: 45, adjustedFloor: 19, adjustedCeiling: 43 };
    const ctx = ctxFor(D, nameOf('AAA', 'Star'), { mode: 'slate' });
    ctx.slate = slate;
    assert.deepEqual(await run('rotowire_raw', ctx), { dk_points: 31.5, minutes: 33, p10: 20, p90: 45 });
    assert.equal((await run('rotowire_adjusted', ctx)).dk_points, 30.1);
    ctx.player = { ...ctx.player, out: true };
    assert.deepEqual(await run('season_avg', ctx), { dk_points: 0, minutes: 0 });
  });
});

describe('evaluate', () => {
  let store;
  before(() => {
    store = featureStore.createFeatureStore(buildData());
  });

  test('projectors only ever see games before the date, and never the outcome', async () => {
    const seen = [];
    const spy = {
      name: 'spy', modes: ['replay'],
      project(ctx) {
        assert.equal(ctx.player.actual, undefined);
        assert.equal(ctx.player.played, undefined);
        assert.equal(ctx.player.isStarter, undefined);
        const games = ctx.view.playerGames(ctx.player.key, { seasons: 'all', played: false });
        seen.push({ date: ctx.date, latest: games[0]?.game_date ?? null });
        return { dk_points: 1, minutes: 1 };
      }
    };
    const { rows } = await evaluate.runReplay(store, [spy], { from: SEASON2[0] });
    assert.ok(rows.length > 300);
    assert.ok(seen.length === rows.length);
    assert.ok(seen.every(s => s.latest === null || s.latest < s.date));
  });

  test('summary: common rows, MAE vs a hand computation, segments by season', async () => {
    const oracle = { name: 'oracle', modes: ['replay'], project: (ctx) => ({ dk_points: 20 }) };
    const sometimes = { name: 'sometimes', modes: ['replay'], project: (ctx) => (ctx.player.team === 'AAA' ? { dk_points: 25 } : null) };
    const { rows } = await evaluate.runReplay(store, [oracle, sometimes], {});
    const summary = evaluate.summarizeRows(rows, ['oracle', 'sometimes'], { baseline: 'oracle', iterations: 50 });
    const common = rows.filter(r => r.team === 'AAA' && r.played);
    assert.equal(summary.played.common, common.length);
    const row = summary.played.leaderboard.find(l => l.projector === 'oracle');
    close(row.mae, Math.round(mean(common.map(r => Math.abs(20 - r.actual.dk))) * 1000) / 1000);
    assert.equal(summary.played.coverage.sometimes, common.length);
    assert.equal(summary.played.paired[0].projector, 'sometimes');
    assert.ok(summary.played.breakdowns.rest.length > 0);
    const segments = evaluate.segmentBySeason(rows, { train: ['2024-25'], validation: ['2025-26'] });
    assert.deepEqual(segments.map(s => [s.season, s.role]), [['2024-25', 'train'], ['2025-26', 'validation']]);
  });

  test('fit() gets a store holding only rows before the validation season', async () => {
    let fitted = null;
    const p = {
      name: 'fitter', modes: ['replay'],
      fit({ store: s, until }) { fitted = { until, latest: s.dates[s.dates.length - 1] }; },
      project: () => ({ dk_points: 1 })
    };
    await evaluate.fitProjectors(store, [p], { until: '2025-07-01', seasons: ['2024-25'] });
    assert.equal(fitted.until, '2025-07-01');
    assert.ok(fitted.latest < '2025-07-01');
  });
});

describe('slates, cache and service', () => {
  let store;
  before(() => {
    store = featureStore.createFeatureStore(buildData());
  });

  const slateFor = (date) => {
    const day = store.gameDay(date);
    return {
      date,
      slateId: 'main',
      players: day.players.map((p, i) => ({
        key: p.key, name: p.name, team: p.team, opponent: p.opponent, position: p.position, isHome: p.isHome,
        out: p.name === nameOf('AAA', 'Star'),
        slate: { salary: 3000 + 500 * i, rotowire: p.actual.dk + 1, rotowireMinutes: 30, adjusted: p.actual.dk + 0.5, adjustedMinutes: 30 },
        outcome: { played: p.played, status: p.status, actual: p.actual, isStarter: p.isStarter }
      }))
    };
  };

  test('runSlates: RotoWire head to head, OUT status projects 0 and is handed to teammates', async () => {
    const names = ['season_avg', 'minutes_model', 'rotowire_raw', 'rotowire_adjusted'];
    const projs = names.map(n => projectors.createProjector(n));
    const { rows } = await evaluate.runSlates(store, projs, [slateFor(D)]);
    const star = rows.find(r => r.name === nameOf('AAA', 'Star'));
    assert.deepEqual(star.preds.season_avg, { dk_points: 0, minutes: 0 });
    assert.equal(star.preds.minutes_model.dk_points, 0);
    const wing = rows.find(r => r.name === nameOf('AAA', 'Wing'));
    assert.equal(wing.tags.teammateOut, 'teammate out');
    assert.ok(wing.tags.salaryTier);
    const summary = evaluate.summarizeRows(rows, names, { baseline: 'rotowire_raw', iterations: 50 });
    const rw = summary.withDnp.leaderboard.find(l => l.projector === 'rotowire_adjusted');
    close(rw.mae, 0.5);
    assert.ok(summary.withDnp.breakdowns.salaryTier.length > 0);
  });

  test('prediction cache: a cached date skips prepareDate and project', async () => {
    let prepared = 0;
    let projected = 0;
    const inner = { name: 'c', modes: ['replay'], prepareDate() { prepared++; }, project() { projected++; return { dk_points: 3 }; } };
    const cache = new Map();
    await evaluate.runReplay(store, [evaluate.withPredictionCache(inner, cache)], { from: D, to: D });
    const first = { prepared, projected };
    assert.equal(first.prepared, 1);
    assert.equal(cache.size, first.projected);
    const again = await evaluate.runReplay(store, [evaluate.withPredictionCache(inner, cache)], { from: D, to: D });
    assert.deepEqual({ prepared, projected }, first);
    assert.equal(again.rows[0].preds.c.dk_points, 3);
  });

  test('runModelEval (replay) returns season segments and writes a report', async () => {
    const service = await import('../src/services/modelEval/modelEvalService.js');
    const report = await service.runModelEval({
      store, mode: 'replay', projectors: ['season_avg', 'last5_avg', 'minutes_model'], replayBaseline: 'season_avg', iterations: 50
    });
    assert.deepEqual(report.replay.segments.map(s => [s.season, s.role]), [['2024-25', 'train'], ['2025-26', 'validation']]);
    const val = report.replay.segments[1];
    assert.equal(val.played.leaderboard.length, 3);
    assert.equal(val.played.paired.length, 2);
    assert.ok(val.played.paired.every(p => p.vs === 'season_avg' && p.ci.length === 2));
    assert.ok(report.notes.length > 0);
    const file = service.writeReport(report, path.join(tmpDir, 'report.json'));
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).replay.dates, report.replay.dates);
  });
});
