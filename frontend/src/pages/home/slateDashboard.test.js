// Run with: npm test (vitest)
import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  buildGames,
  buildInjuryFeed,
  parseInjury,
  parseTimestamp,
  summarizeSlate,
  topChalk,
  topLeverage,
  topValuesByPosition,
  valuePerK,
} from './slateDashboard.js';

const p = (overrides) => ({
  name: 'Player',
  team: 'BOS',
  opponent: 'NYK',
  position: 'PG',
  salary: 5000,
  projected_points: 30,
  projected_minutes: 30,
  vegas_implied_total: 0,
  vegas_spread: 0,
  vegas_over_under: 0,
  rostership: 0,
  leverage_score: 0,
  injury_status: null,
  raw_data: null,
  ...overrides,
});

const slate = [
  p({ name: 'Jaylen Brown', team: 'BOS', opponent: 'NYK', vegas_implied_total: 117, vegas_spread: -5.5, vegas_over_under: 226,
    raw_data: JSON.stringify({ isHome: true, game: { dateTime: '2026-10-19T23:30:00Z' } }) }),
  p({ name: 'Jalen Brunson', team: 'NYK', opponent: 'BOS', vegas_implied_total: 109, vegas_spread: 5.5, vegas_over_under: 226, rostership: 32 }),
  p({ name: 'Big Fav Guy', team: 'OKC', opponent: 'WAS', position: 'C', salary: 4000, projected_points: 28, vegas_implied_total: 126, vegas_spread: -14, vegas_over_under: 238, leverage_score: 3.1, rostership: 4 }),
  p({ name: 'Bench Guy', team: 'WAS', opponent: 'OKC', position: 'SF,PF', salary: 3000, projected_points: 18, projected_minutes: 10 }),
  p({ name: 'Q Guy', team: 'WAS', opponent: 'OKC', position: 'SG', injury_status: 'GTD', leverage_score: 9, rostership: 2 }),
  p({ name: 'No Own Data', team: 'WAS', opponent: 'OKC', position: 'PG', leverage_score: 40 }),
  p({ name: 'Out Guy', team: 'NYK', opponent: 'BOS', injury_status: JSON.stringify({ status: 'OUT', note: 'Ankle' }), rostership: 50 }),
];

const teamStats = { teams: { BOS: { pace: 98 }, NYK: { pace: 96 }, OKC: { pace: 102 }, WAS: { pace: 104 } }, leagueAvgPace: 100 };

test('buildGames groups by matchup, sorts by total, and derives lines/pace/blowout', () => {
  const games = buildGames(slate, teamStats);
  assert.equal(games.length, 2);
  const [okc, bos] = games;
  assert.equal(okc.total, 238);
  assert.equal(okc.blowout, true);
  assert.equal(okc.favorite, 'OKC');
  assert.equal(okc.spread, 14);
  // WAS has no line on its rows; derived from OKC's side.
  const was = okc.away.team === 'WAS' ? okc.away : okc.home;
  assert.equal(was.spread, 14);
  assert.equal(was.impliedTotal, 238 - 126);
  assert.equal(okc.pace, 103);
  assert.equal(okc.paceDelta, 3);

  // BOS flagged home in raw data -> NYK @ BOS.
  assert.equal(bos.away.team, 'NYK');
  assert.equal(bos.home.team, 'BOS');
  assert.equal(bos.hasHomeAway, true);
  assert.equal(bos.blowout, false);
  assert.equal(bos.start.toISOString(), '2026-10-19T23:30:00.000Z');
});

test('buildGames tolerates missing team stats and lines', () => {
  const [g] = buildGames([p({ team: 'MIA', opponent: 'ORL' })]);
  assert.equal(g.total, null);
  assert.equal(g.pace, null);
  assert.equal(g.blowout, false);
  assert.equal(g.home.team, 'ORL');
});

test('parseInjury normalizes strings and JSON payloads', () => {
  assert.equal(parseInjury(null), null);
  assert.equal(parseInjury(''), null);
  assert.equal(parseInjury('null'), null);
  assert.equal(parseInjury('Q').label, 'GTD');
  assert.equal(parseInjury('DTD').label, 'GTD');
  assert.equal(parseInjury('Doubtful').label, 'DOUBT');
  assert.equal(parseInjury('Prob').tone, 'info');
  assert.deepEqual(parseInjury('{"status":"OUT","note":"Ankle"}'), { label: 'OUT', tone: 'negative', note: 'Ankle' });
});

test('value, leverage and chalk lists skip OUT players and low-minute values', () => {
  assert.equal(valuePerK(p({ salary: 4000, projected_points: 28 })), 7);
  const values = topValuesByPosition(slate, 2);
  assert.equal(values.C[0].name, 'Big Fav Guy');
  assert.equal(values.SF.length, 0); // Bench Guy plays 10 min
  assert.ok(!Object.values(values).flat().some((x) => x.name === 'Out Guy'));

  assert.deepEqual(topLeverage(slate).map((x) => x.name), ['Q Guy', 'Big Fav Guy']);
  assert.deepEqual(topChalk(slate).map((x) => x.name), ['Jalen Brunson', 'Big Fav Guy', 'Q Guy']);
});

test('buildInjuryFeed merges missing players, slate tags and usage bumps', () => {
  const missing = [{ team: 'BOS', missingPlayers: [{ name: 'Jayson Tatum', avgDk: 50.2, avgMin: 36 }] }];
  const bumps = [
    { player: 'Jaylen Brown', missingPlayer: 'Jayson Tatum', dkBump: 6.1, pctBump: 14 },
    { player: 'Derrick White', missingPlayer: 'Jayson Tatum', dkBump: 3.0, pctBump: 10 },
  ];
  const feed = buildInjuryFeed(slate, missing, bumps);
  assert.deepEqual(feed.map((i) => [i.name, i.status.label]), [
    ['Jayson Tatum', 'OUT'],
    ['Out Guy', 'OUT'],
    ['Q Guy', 'GTD'],
  ]);
  assert.deepEqual(feed[0].beneficiaries.map((b) => b.player), ['Jaylen Brown', 'Derrick White']);
  assert.equal(feed[2].beneficiaries.length, 0);
});

test('parseTimestamp treats zone-less sqlite timestamps as UTC', () => {
  assert.equal(parseTimestamp('2026-10-19 17:05:00').toISOString(), '2026-10-19T17:05:00.000Z');
  assert.equal(parseTimestamp('2026-10-19T17:05:00.000Z').toISOString(), '2026-10-19T17:05:00.000Z');
  assert.equal(parseTimestamp(null), null);
  assert.equal(parseTimestamp('garbage'), null);
});

test('summarizeSlate', () => {
  const games = buildGames(slate, teamStats);
  const s = summarizeSlate(slate, games);
  assert.equal(s.playerCount, 7);
  assert.equal(s.gameCount, 2);
  assert.equal(s.avgTotal, 232);
  assert.equal(s.firstLock.toISOString(), '2026-10-19T23:30:00.000Z');
});
