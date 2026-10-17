import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import optimizerService from '../src/services/optimizerService.js';
import { buildPlayerPool } from './fixtures/playerPool.js';

const DK_SLOTS = ['PG', 'SG', 'SF', 'PF', 'C', 'G', 'F', 'UTIL'];
const SALARY_CAP = 50000;

// Which positions may fill each DK slot
const SLOT_ELIGIBILITY = {
  PG: ['PG'],
  SG: ['SG'],
  SF: ['SF'],
  PF: ['PF'],
  C: ['C'],
  G: ['PG', 'SG'],
  F: ['SF', 'PF'],
  UTIL: ['PG', 'SG', 'SF', 'PF', 'C'],
};

// Deterministic PRNG so the randomness used for lineup diversity is reproducible
function mulberry32(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function expectValidLineup(lineup) {
  expect(lineup.isValid).toBe(true);
  expect(lineup.players.map((s) => s.position)).toEqual(DK_SLOTS);

  lineup.players.forEach(({ position, player }) => {
    expect(player).toBeTruthy();
    const playerPositions = player.position.split(',').map((p) => p.trim());
    expect(playerPositions.some((p) => SLOT_ELIGIBILITY[position].includes(p))).toBe(true);
  });

  const ids = lineup.players.map((s) => s.player.id);
  expect(new Set(ids).size).toBe(8);

  const salary = lineup.players.reduce((sum, s) => sum + s.player.salary, 0);
  expect(salary).toBe(lineup.totalSalary);
  expect(salary).toBeLessThanOrEqual(SALARY_CAP);
}

describe('optimizerService.optimize', () => {
  let players;

  beforeEach(() => {
    players = buildPlayerPool();
    vi.spyOn(Math, 'random').mockImplementation(mulberry32(42));
    // The optimizer logs heavily; keep test output readable
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('builds a single valid cash lineup', () => {
    const result = optimizerService.optimize(players, { mode: 'cash', numLineups: 1 });

    expect(result.lineups).toHaveLength(1);
    expectValidLineup(result.lineups[0]);
    expect(result.exposureStats).toBeNull();
  });

  it('builds a valid GPP lineup', () => {
    const result = optimizerService.optimize(players, { mode: 'gpp', numLineups: 1 });

    expect(result.lineups).toHaveLength(1);
    expectValidLineup(result.lineups[0]);
  });

  function lineupHashes(lineups) {
    return lineups.map((l) => l.players.map((s) => s.player.id).sort((a, b) => a - b).join('-'));
  }

  it.each([3, 5])('returns only unique valid lineups when %i are requested', (n) => {
    const result = optimizerService.optimize(players, { mode: 'gpp', numLineups: n });

    expect(result.lineups.length).toBeGreaterThan(1);
    expect(result.lineups.length).toBeLessThanOrEqual(n);
    result.lineups.forEach(expectValidLineup);
    expect(new Set(lineupHashes(result.lineups)).size).toBe(result.lineups.length);
    expect(result.exposureStats).not.toBeNull();
  });

  // KNOWN BUG: optimize() advances its loop counter on duplicate/failed solves,
  // so each retry consumes one of the requested lineups and fewer than N come back.
  // With this fixture + seed a duplicate is hit on the 3rd solve. When the loop is
  // fixed to retry until N lineups exist, this will start passing: flip it.fails -> it.
  it.fails.each([3])('returns exactly %i unique lineups when that many are requested', (n) => {
    const result = optimizerService.optimize(players, { mode: 'gpp', numLineups: n });

    expect(result.lineups).toHaveLength(n);
    expect(new Set(lineupHashes(result.lineups)).size).toBe(n);
  });

  it('honors locked and excluded players', () => {
    const locked = players.find((p) => p.position === 'PF,C').id;
    const excluded = players.find((p) => p.position === 'PG').id;

    const result = optimizerService.optimize(players, {
      numLineups: 1,
      lockedPlayers: [locked],
      excludedPlayers: [excluded],
    });

    const ids = result.lineups[0].players.map((s) => s.player.id);
    expect(ids).toContain(locked);
    expect(ids).not.toContain(excluded);
  });

  it('returns an error when the filtered pool is too small', () => {
    const result = optimizerService.optimize(players.slice(0, 10), { numLineups: 1 });

    expect(result.lineups).toEqual([]);
    expect(result.error).toBe('Insufficient players');
  });
});
