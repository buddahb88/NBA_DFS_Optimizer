import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  generateLineupBatch,
  parseExposureSettings,
  planExposure,
  applyRandomness,
  ExposureConfigError,
} from './exposure.js';
import { buildPlayerPool } from '../../../../test/fixtures/playerPool.js';

function mulberry32(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const idsOf = (lineup) => lineup.players.map((s) => s.player.id);

function counts(lineups) {
  const c = new Map();
  lineups.forEach((l) => idsOf(l).forEach((id) => c.set(id, (c.get(id) || 0) + 1)));
  return c;
}

// The fixture pool is small, so relax the salary floor to leave room for exposure caps
const BASE = { mode: 'gpp', minSalary: 45000 };

describe('exposure constraints', () => {
  let players;
  let rng;

  beforeEach(() => {
    players = buildPlayerPool();
    rng = mulberry32(7);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('20 lineups with a 30% global max never use a player more than 6 times', () => {
    const result = generateLineupBatch(players, { ...BASE, numLineups: 20, maxExposure: 30 }, { rng });

    expect(result.lineups).toHaveLength(20);
    expect(result.warnings).toEqual([]);
    counts(result.lineups).forEach((n) => expect(n).toBeLessThanOrEqual(6));
    result.exposureSummary.players.forEach((p) => {
      expect(p.maxCount).toBe(6);
      expect(p.count).toBeLessThanOrEqual(6);
    });
  });

  it('meets per-player minimums and respects per-player max overrides', () => {
    const cheap = players.find((p) => p.position === 'PF,C').id;
    const star = players.find((p) => p.position === 'PG').id;
    const result = generateLineupBatch(
      players,
      {
        ...BASE,
        numLineups: 10,
        maxExposure: 60,
        players: [
          { id: cheap, minExposure: 70 },
          { id: star, maxExposure: 20 },
        ],
      },
      { rng }
    );

    expect(result.lineups).toHaveLength(10);
    const c = counts(result.lineups);
    expect(c.get(cheap)).toBeGreaterThanOrEqual(7);
    expect(c.get(star) || 0).toBeLessThanOrEqual(2);
    const row = result.exposureSummary.players.find((p) => p.playerId === cheap);
    expect(row).toMatchObject({ minCount: 7, maxCount: 7 });
  });

  it('honors lock and exclude (new contract and legacy arrays)', () => {
    const locked = players.find((p) => p.position === 'C').id;
    const excluded = players.find((p) => p.position === 'SG').id;
    const legacyExcluded = players.find((p) => p.position === 'SF').id;
    const result = generateLineupBatch(
      players,
      {
        ...BASE,
        numLineups: 5,
        maxExposure: 50,
        players: [{ id: locked, lock: true }, { id: excluded, exclude: true }],
        excludedPlayers: [legacyExcluded],
      },
      { rng }
    );

    expect(result.lineups).toHaveLength(5);
    result.lineups.forEach((l) => {
      expect(idsOf(l)).toContain(locked);
      expect(idsOf(l)).not.toContain(excluded);
      expect(idsOf(l)).not.toContain(legacyExcluded);
    });
  });

  it('every lineup differs from every prior lineup by at least minUniqueness players', () => {
    const K = 3;
    const result = generateLineupBatch(players, { ...BASE, numLineups: 8, minUniqueness: K }, { rng });

    expect(result.lineups).toHaveLength(8);
    const sets = result.lineups.map((l) => new Set(idsOf(l)));
    for (let i = 0; i < sets.length; i++) {
      for (let j = 0; j < i; j++) {
        const shared = [...sets[i]].filter((id) => sets[j].has(id)).length;
        expect(8 - shared).toBeGreaterThanOrEqual(K);
      }
    }
  });

  it('caps the share of lineups containing a team', () => {
    const result = generateLineupBatch(
      players,
      { ...BASE, numLineups: 10, teams: [{ team: 'DDD', maxExposure: 40 }] },
      { rng }
    );

    expect(result.lineups).toHaveLength(10);
    const withDDD = result.lineups.filter((l) => l.players.some((s) => s.player.team === 'DDD')).length;
    expect(withDDD).toBeLessThanOrEqual(4);
    const row = result.exposureSummary.teams.find((t) => t.team === 'DDD');
    expect(row).toMatchObject({ lineups: withDDD, maxCount: 4 });
  });

  it('applies projectionOverride before optimizing', () => {
    const bench = players.find((p) => p.position === 'SF,PF' && p.team === 'AAA');
    const result = generateLineupBatch(
      players,
      { mode: 'cash', minSalary: 45000, numLineups: 1, players: [{ id: bench.id, projectionOverride: 80 }] },
      { rng }
    );

    const picked = result.lineups[0].players.find((s) => s.player.id === bench.id);
    expect(picked).toBeTruthy();
    expect(picked.player.projected_points).toBe(80);
  });

  it('rejects impossible configs up front', () => {
    const id = players[0].id;
    const plan = (body) => planExposure(players, parseExposureSettings(body));

    expect(() => plan({ numLineups: 10, players: [{ id, minExposure: 50, maxExposure: 30 }] }))
      .toThrow(ExposureConfigError);
    // Min 50% of 10 = 5 lineups, but team max 30% only allows 3 lineups with that team
    expect(() => plan({ numLineups: 10, players: [{ id, minExposure: 50 }], teams: [{ team: players[0].team, maxExposure: 30 }] }))
      .toThrow(/Team/);
    const locks = players.slice(0, 8).map((p) => ({ id: p.id, lock: true }));
    expect(() => plan({ numLineups: 2, players: locks })).toThrow(/minUniqueness/);
  });

  it('randomness draws stay inside each player\'s floor/ceiling range', () => {
    const noisy = applyRandomness(players, 100, rng);
    noisy.forEach((p, i) => {
      const orig = players[i];
      expect(p.adjustedProjection).toBeGreaterThanOrEqual(orig.floor - 1e-9);
      expect(p.adjustedProjection).toBeLessThanOrEqual(orig.ceiling + 1e-9);
    });
    expect(noisy.some((p, i) => p.adjustedProjection !== players[i].projected_points)).toBe(true);
    applyRandomness(players, 0, rng).forEach((p, i) => {
      expect(p.adjustedProjection).toBe(players[i].projected_points);
    });
  });
});
