import { test, describe, beforeAll as before } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { buildData, nameOf, poisonFrom, scheduleDates } from './helpers/modelEvalData.js';

// Services pull in the database module; keep it off the real DB
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nba-dfs-feature-store-'));
let fsMod;
let playerKey;

before(async () => {
  process.env.DATABASE_TYPE = 'sqlite';
  process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');
  fsMod = await import('../src/services/modelEval/featureStore.js');
  ({ playerKey } = await import('../src/utils/playerKey.js'));
});

const SEASON2 = scheduleDates('2025-11-01', 20);
const D = SEASON2[12];
const star = () => playerKey(nameOf('AAA', 'Star'));
const sixth = () => playerKey(nameOf('AAA', 'Sixth'));

/** Every feature a projector can read for `date`, as plain JSON. */
function snapshot(store, date) {
  const view = store.asOf(date);
  const keys = [...new Set(store.gameDay(date).players.map(p => p.key))].sort();
  const teams = ['AAA', 'BBB', 'CCC', 'DDD'];
  return JSON.parse(JSON.stringify({
    games: keys.map(k => view.playerGames(k, { seasons: 'all', played: false })),
    regular: keys.map(k => view.playerGames(k, { seasons: 'current+prior', regularOnly: true })),
    minutesLogs: view.minutesLogs().length,
    rest: teams.map(t => view.teamRest(t)),
    ratings: teams.map(t => view.teamRatings(t)),
    league: view.league(),
    profiles: [...view.profiles().entries()].sort(),
    archetypes: keys.map(k => view.archetype(k)),
    dvp: [...view.dvpContext().cells.entries()].sort(),
    prior: keys.map(k => view.priorSeasonProfile(k)),
    statuses: keys.map(k => view.playerStatuses(k)),
    teamGames: teams.map(t => view.teamGames(t, { seasons: 'all' })),
    teamPlayerRows: teams.map(t => view.teamPlayerRows(t, { games: 5 }))
  }));
}

describe('feature store: no lookahead', () => {
  test('features for date D ignore every game on or after D', () => {
    // A few DNP / inactive listings before and after D
    const listed = new Set([SEASON2[3], SEASON2[9], SEASON2[14]]);
    const data = buildData({ skip: (name, date) => (!listed.has(date) ? null : name === nameOf('AAA', 'Deep') ? 'dnp' : name === nameOf('BBB', 'Sixth') ? 'inactive' : null) });
    const clean = fsMod.createFeatureStore(data);
    const poisoned = fsMod.createFeatureStore(poisonFrom(data, D));
    const a = snapshot(clean, D);
    const b = snapshot(poisoned, D);
    assert.ok(a.games.flat().length > 100, 'history is non-trivial');
    assert.ok(a.dvp.length > 0, 'dvp cells exist');
    assert.equal(a.statuses.flat().length, 4, 'listings before D only');
    assert.ok(a.teamPlayerRows.every(rows => rows.length > 0 && rows.every(r => r.game_date < D)));
    assert.deepEqual(b, a);
    // The poison does change later dates, so the check has teeth
    const later = SEASON2[15];
    assert.notDeepEqual(snapshot(poisoned, later).games, snapshot(clean, later).games);
    assert.notDeepEqual(snapshot(poisoned, later).statuses, snapshot(clean, later).statuses);
  });

  test('player history is strictly before D, most recent first', () => {
    const store = fsMod.createFeatureStore(buildData());
    const games = store.asOf(D).playerGames(star(), { seasons: 'all' });
    assert.equal(games.length, 20 + 12);
    assert.ok(games.every(g => g.game_date < D));
    assert.equal(games[0].game_date, SEASON2[11]);
    assert.ok(games.every((g, i) => i === 0 || games[i - 1].game_date >= g.game_date));
    assert.equal(store.asOf(D).playerGames(star(), { seasons: 'current' }).length, 12);
    assert.equal(store.asOf(SEASON2[0]).playerGames(star(), { seasons: 'current' }).length, 0);
  });

  test('restrictTo(date) keeps only rows before the date', () => {
    const store = fsMod.createFeatureStore(buildData()).restrictTo(D);
    assert.ok(store.dates.every(d => d < D));
    assert.equal(store.asOf('2026-12-31').playerGames(star(), { seasons: 'all' }).length, 32);
  });
});

describe('feature store: as-of profiles and archetypes', () => {
  test('season-to-date profile counts only games before D', () => {
    const store = fsMod.createFeatureStore(buildData());
    const p = store.asOf(D).profiles().get(star());
    assert.equal(p.games, 12);
    assert.equal(p.starts, 12);
    assert.ok(p.usg_pct > 0 && p.usg_pct < 1);
    assert.equal(store.asOf(SEASON2[0]).profiles().size, 0);
  });

  test('below the archetype sample the prior season label is used', () => {
    const store = fsMod.createFeatureStore(buildData());
    // 3 games < MIN_SAMPLE.games (10): as-of label is unclassified, falls back to 2024-25
    const early = store.asOf(SEASON2[3]).archetype(star());
    assert.equal(early.source, 'prior-season');
    assert.notEqual(early.archetype, 'unclassified');
    const late = store.asOf(D).archetype(star());
    assert.equal(late.source, 'as-of');
    // First season has no prior: unclassified until the sample is reached
    assert.equal(store.asOf(scheduleDates('2024-11-01', 20)[3]).archetype(star()).source, 'none');
  });

  test('dvp context uses the prior season before the first game, the season after', () => {
    const store = fsMod.createFeatureStore(buildData());
    assert.equal(store.asOf(SEASON2[0]).dvpContext().season, '2024-25');
    assert.equal(store.asOf(D).dvpContext().season, '2025-26');
  });
});

describe('feature store: team context', () => {
  test('team ratings are season-to-date before D, shrunk to last season', () => {
    const data = buildData();
    const store = fsMod.createFeatureStore(data);
    const r = store.asOf(D).teamRatings('AAA');
    const rows = data.teamGames.filter(g => g.team === 'AAA' && g.season === '2025-26' && g.game_date < D);
    const pace = rows.reduce((s, g) => s + g.possessions, 0) / rows.length;
    assert.equal(r.games, 12);
    assert.ok(Math.abs(r.raw.pace - pace) < 1e-9);
    const opp = data.teamGames.filter(g => g.opponent === 'AAA' && g.season === '2025-26' && g.game_date < D);
    const defRtg = 100 * opp.reduce((s, g) => s + g.pts, 0) / opp.reduce((s, g) => s + g.possessions, 0);
    assert.ok(Math.abs(r.raw.defRtg - defRtg) < 1e-9);
    // Shrunk value lies between last season's and this season's
    const first = store.asOf(SEASON2[0]).teamRatings('AAA');
    assert.equal(first.games, 0);
    assert.ok(Math.abs(first.pace - first.prior.pace) < 1e-9);
  });

  test('rest days come from the team schedule', () => {
    const store = fsMod.createFeatureStore(buildData());
    assert.deepEqual(store.asOf(D).teamRest('AAA'), { restDays: 1, lastGame: SEASON2[11] });
    assert.equal(store.asOf(SEASON2[0]).teamRest('AAA').restDays, null);
  });
});

describe('feature store: game day', () => {
  const skip = (name, date) => {
    if (date !== D) return null;
    if (name === nameOf('AAA', 'Star')) return 'inactive';
    if (name === nameOf('AAA', 'Sixth')) return 'dnp';
    if (name === nameOf('BBB', 'Wing')) return 'missing';
    return null;
  };

  test('out list: inactive listings plus missing regulars, not coach DNPs', () => {
    const store = fsMod.createFeatureStore(buildData({ skip }));
    const day = store.gameDay(D);
    const aaa = day.teams.get('AAA');
    assert.deepEqual(aaa.out.map(o => [o.key, o.source]), [[star(), 'status']]);
    assert.ok(aaa.out[0].expectedMinutes > 30);
    const bbb = day.teams.get('BBB');
    assert.deepEqual(bbb.out.map(o => [o.key, o.source]), [[playerKey(nameOf('BBB', 'Wing')), 'inferred']]);
    assert.equal(day.teams.get('CCC').out.length, 0);
  });

  test('players: who played plus coach DNPs (0 points), inactive left out', () => {
    const store = fsMod.createFeatureStore(buildData({ skip }));
    const players = store.gameDay(D).players;
    assert.equal(players.length, 4 * 5 - 2);
    assert.ok(!players.some(p => p.key === star()));
    const dnp = players.find(p => p.key === sixth());
    assert.equal(dnp.played, false);
    assert.equal(dnp.actual.dk, 0);
    assert.equal(dnp.actual.minutes, 0);
    const played = players.find(p => p.key === playerKey(nameOf('AAA', 'Wing')));
    assert.equal(played.played, true);
    assert.ok(played.actual.dk > 0);
    assert.equal(played.opponent, 'BBB');
  });
});
