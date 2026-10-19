import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import optimizerService from '../src/services/optimizerService.js';
import {
  validateStackRules,
  resolveStackRules,
  lineupSatisfies,
  parseGameId,
  rankShootoutGames,
  usageBumpTeams
} from '../src/services/optimizer/constraints/stacking.js';
import { getSiteConfig } from '../src/config/sites.js';
import { makeSlate, withSeed } from './fixtures/slate.js';

// 5 games (BOS@NYK, GSW@LAL, DEN@PHX, MIA@MIL, DAL@OKC), 6 players per team.
// javascript-lp-solver run time swings a lot between slates; this one solves quickly.
const slate = () => makeSlate({ seed: 2, perTeam: 6 });
const run = (settings, { players = slate(), seed = 1 } = {}) =>
  withSeed(seed, () => optimizerService.optimize(players, { mode: 'cash', ...settings }));

const lineupPlayers = (lineup) => lineup.players.map(s => s.player);
const teamCounts = (lineup) => lineupPlayers(lineup).reduce((m, p) => ({ ...m, [p.team]: (m[p.team] || 0) + 1 }), {});
const gameOf = (p) => [p.team, p.opponent].sort().join('@');
const gameCounts = (lineup) => lineupPlayers(lineup).reduce((m, p) => ({ ...m, [gameOf(p)]: (m[gameOf(p)] || 0) + 1 }), {});
const maxValue = (obj) => Math.max(0, ...Object.values(obj));

describe('stacking rules in the optimizer', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('leaves lineups unchanged with no rules or the cash preset', () => {
    const base = run({});
    const empty = run({ stackRules: [] });
    const cash = run({ stackRules: [{ preset: 'cash' }] });
    const ids = (r) => lineupPlayers(r.lineups[0]).map(p => p.id);
    expect(ids(empty)).toEqual(ids(base));
    expect(ids(cash)).toEqual(ids(base));
  });

  it('team: min/max players from a specific team', () => {
    const base = teamCounts(run({}).lineups[0]);
    // pick a team the unconstrained lineup does not use
    const team = ['BOS', 'NYK', 'LAL', 'GSW', 'DEN', 'PHX', 'MIA', 'MIL', 'DAL', 'OKC'].find(t => !base[t]);

    const result = run({ stackRules: [{ type: 'team', teams: [team], min: 2, max: 3 }] });
    expect(result.lineups).toHaveLength(1);
    const count = teamCounts(result.lineups[0])[team] || 0;
    expect(count).toBeGreaterThanOrEqual(2);
    expect(count).toBeLessThanOrEqual(3);

    const capped = run({ stackRules: [{ type: 'team', teams: Object.keys(base), max: 0 }] });
    Object.keys(base).forEach(t => expect(teamCounts(capped.lineups[0])[t]).toBeUndefined());
  });

  it('teamStack: N players from one team (any team, or from a candidate list)', () => {
    const base = run({}).lineups[0];
    expect(maxValue(teamCounts(base))).toBeLessThan(4);

    const any = run({ stackRules: [{ type: 'teamStack', min: 4 }] }).lineups[0];
    expect(maxValue(teamCounts(any))).toBeGreaterThanOrEqual(4);

    const listed = run({ stackRules: [{ type: 'teamStack', teams: ['dal', 'okc'], min: 3, max: 3 }] }).lineups[0];
    const counts = teamCounts(listed);
    expect(Math.max(counts.DAL || 0, counts.OKC || 0)).toBe(3);
  });

  it('gameStack: N from one game with a bring-back from the opponent', () => {
    const lineup = run({ stackRules: [{ type: 'gameStack', gameId: 'nyk vs bos', min: 4, bringBack: 2 }] }).lineups[0];
    const counts = teamCounts(lineup);
    expect((counts.BOS || 0) + (counts.NYK || 0)).toBeGreaterThanOrEqual(4);
    expect(counts.BOS).toBeGreaterThanOrEqual(2);
    expect(counts.NYK).toBeGreaterThanOrEqual(2);

    const anyGame = run({ stackRules: [{ type: 'gameStack', min: 5, bringBack: 1 }] }).lineups[0];
    const stacked = Object.entries(gameCounts(anyGame)).find(([, n]) => n >= 5);
    expect(stacked).toBeTruthy();
    const [a, b] = stacked[0].split('@');
    expect(teamCounts(anyGame)[a]).toBeGreaterThanOrEqual(1);
    expect(teamCounts(anyGame)[b]).toBeGreaterThanOrEqual(1);
  });

  it('gameStack: teams picks the games those teams play in', () => {
    const lineup = run({ stackRules: [{ type: 'gameStack', teams: ['MIL'], min: 4 }] }).lineups[0];
    expect(gameCounts(lineup)['MIA@MIL']).toBeGreaterThanOrEqual(4);
  });

  it('maxPerTeam: caps players from every team', () => {
    const forced = run({ stackRules: [{ type: 'teamStack', min: 4 }] }).lineups[0];
    expect(maxValue(teamCounts(forced))).toBeGreaterThanOrEqual(4);

    // conflicting rules -> no lineup
    const conflict = run({ stackRules: [{ type: 'team', teams: ['BOS'], min: 3 }, { type: 'maxPerTeam', max: 2 }] });
    expect(conflict.lineups).toHaveLength(0);

    const capped = run({ stackRules: [{ type: 'maxPerTeam', max: 1 }] }).lineups[0];
    expect(maxValue(teamCounts(capped))).toBe(1);
  });

  it('minGames: lineup spans at least N distinct games', () => {
    const base = Object.keys(gameCounts(run({}).lineups[0])).length;
    expect(base).toBeLessThan(5);
    const lineup = run({ stackRules: [{ type: 'minGames', min: 5 }] }).lineups[0];
    expect(Object.keys(gameCounts(lineup))).toHaveLength(5);
  });

  it('avoidOpponent: no players facing a locked player', () => {
    const players = slate();
    const base = run({}, { players }).lineups[0];
    // lock a player whose opponent the base lineup uses
    const anchor = players.find(p => teamCounts(base)[p.opponent] && !lineupPlayers(base).some(b => b.id === p.id));

    const free = run({ lockedPlayers: [anchor.id] }, { players }).lineups[0];
    const avoided = run({ lockedPlayers: [anchor.id], stackRules: [{ type: 'avoidOpponent', playerIds: [anchor.id] }] }, { players }).lineups[0];

    expect(lineupPlayers(avoided).some(p => p.id === anchor.id)).toBe(true);
    expect(teamCounts(free)[anchor.opponent] || 0).toBeGreaterThan(0);
    expect(teamCounts(avoided)[anchor.opponent]).toBeUndefined();
  });

  it('avoidOpponent: has no effect when the anchor is not in the lineup', () => {
    const players = slate();
    const base = run({}, { players }).lineups[0];
    const outsider = players.find(p => !lineupPlayers(base).some(b => b.id === p.id) && teamCounts(base)[p.opponent]);
    const result = run({ stackRules: [{ type: 'avoidOpponent', playerIds: [outsider.id] }] }, { players }).lineups[0];
    expect(lineupPlayers(result).some(p => p.id === outsider.id)).toBe(false);
    expect(lineupPlayers(result).map(p => p.id)).toEqual(lineupPlayers(base).map(p => p.id));
  });

  it('percentOfLineups: rule applies to that share of lineups, the rest are free', () => {
    const rule = { type: 'gameStack', gameId: 'DAL@OKC', min: 4, bringBack: 1, percentOfLineups: 50 };
    const result = run({ numLineups: 4, maxExposure: 100, stackRules: [rule] });
    expect(result.lineups).toHaveLength(4);

    const [resolved] = resolveStackRules([rule], []);
    const stacked = result.lineups.filter(l => lineupSatisfies(resolved, lineupPlayers(l)));
    expect(stacked.length).toBeGreaterThanOrEqual(2); // ceil(50% of 4)
    expect(stacked.length).toBeLessThan(4);
    // the forced lineups come first
    expect(lineupSatisfies(resolved, lineupPlayers(result.lineups[0]))).toBe(true);
    expect(lineupSatisfies(resolved, lineupPlayers(result.lineups[1]))).toBe(true);
  });

  it('teamStacks is accepted as an alias', () => {
    const lineup = run({ teamStacks: [{ type: 'teamStack', min: 4 }] }).lineups[0];
    expect(maxValue(teamCounts(lineup))).toBeGreaterThanOrEqual(4);
  });

  it('shootout preset stacks the high-total, tight-spread game', () => {
    const vegas = { 'BOS@NYK': [238, 2], 'GSW@LAL': [241, 12], 'DEN@PHX': [226, 1], 'MIA@MIL': [215, 3], 'DAL@OKC': [222, 5] };
    const players = slate().map(p => {
      const [total, spread] = vegas[gameOf(p)];
      return { ...p, vegas_over_under: total, vegas_spread: p.team < p.opponent ? -spread : spread };
    });

    // GSW@LAL has the top total but a 12-point spread
    expect(rankShootoutGames(players).map(g => g.game)).toEqual(['BOS@NYK', 'DEN@PHX', 'DAL@OKC', 'MIA@MIL']);

    const lineup = run({ stackRules: [{ preset: 'shootout', topGames: 1, min: 4, bringBack: 1 }] }, { players }).lineups[0];
    const counts = teamCounts(lineup);
    expect((counts.BOS || 0) + (counts.NYK || 0)).toBeGreaterThanOrEqual(4);
    expect(counts.BOS).toBeGreaterThanOrEqual(1);
    expect(counts.NYK).toBeGreaterThanOrEqual(1);
  });

  it('usageBump preset stacks teammates of an OUT star', () => {
    const players = slate();
    const base = teamCounts(run({}, { players }).lineups[0]);
    const team = ['BOS', 'NYK', 'LAL', 'GSW', 'DEN', 'PHX', 'MIA', 'MIL', 'DAL', 'OKC'].find(t => !base[t]);
    const star = { ...players.find(p => p.team === team), id: 999, name: 'Injured Star', salary: 10000, injury_status: 'OUT' };

    const detected = run({ stackRules: [{ preset: 'usageBump', min: 3 }] }, { players: [...players, star] }).lineups[0];
    expect(teamCounts(detected)[team]).toBeGreaterThanOrEqual(3);
    expect(lineupPlayers(detected).some(p => p.id === 999)).toBe(false);

    // Star not in the pool: name the teams explicitly
    const explicit = run({ stackRules: [{ preset: 'usageBump', teams: [team], min: 3 }] }, { players }).lineups[0];
    expect(teamCounts(explicit)[team]).toBeGreaterThanOrEqual(3);
  });

  it('presets with nothing to stack are skipped', () => {
    const players = slate(); // no vegas lines, nobody OUT
    const base = run({}, { players }).lineups[0];
    const result = run({ stackRules: [{ preset: 'shootout' }, { preset: 'usageBump' }] }, { players }).lineups[0];
    expect(lineupPlayers(result).map(p => p.id)).toEqual(lineupPlayers(base).map(p => p.id));
  });

  it('works on FanDuel alongside the site team cap', () => {
    const lineup = run({ site: 'fanduel', minSalary: 0, stackRules: [{ type: 'teamStack', min: 4 }] }).lineups[0];
    expect(maxValue(teamCounts(lineup))).toBe(4); // FanDuel max 4 per team
  });
});

describe('validateStackRules', () => {
  it('accepts valid rules and presets', () => {
    expect(validateStackRules(undefined)).toEqual([]);
    expect(validateStackRules([
      { type: 'team', teams: ['BOS'], min: 1, max: 3 },
      { type: 'teamStack', min: 3, percentOfLineups: 50 },
      { type: 'gameStack', gameId: 'BOS@NYK', min: 3, bringBack: 1 },
      { type: 'maxPerTeam', max: 3 },
      { type: 'minGames', min: 3 },
      { type: 'avoidOpponent', playerIds: [12] },
      { preset: 'shootout', percentOfLineups: 25 },
      { preset: 'usageBump', outPlayers: ['Some Star'] },
      { preset: 'cash' }
    ])).toEqual([]);
  });

  it('rejects malformed rules', () => {
    expect(validateStackRules({})).toEqual(['stackRules must be an array']);
    const errors = validateStackRules([
      { type: 'bogus' },
      { type: 'team', teams: ['BOS'] },
      { type: 'teamStack' },
      { type: 'gameStack', gameId: 'BOS', min: 3 },
      { type: 'gameStack', min: 3, bringBack: 2 },
      { type: 'maxPerTeam' },
      { type: 'avoidOpponent' },
      { type: 'teamStack', min: 3, percentOfLineups: 150 },
      { type: 'team', teams: ['BOS'], min: 4, max: 2 },
      { preset: 'nope' }
    ]);
    expect(errors).toHaveLength(10);
    expect(() => resolveStackRules([{ type: 'bogus' }], [])).toThrow(/Invalid stack rules/);
  });
});

describe('stacking helpers', () => {
  it('parseGameId normalizes either team order', () => {
    expect(parseGameId('NYK@BOS')).toBe('BOS@NYK');
    expect(parseGameId('bos vs nyk')).toBe('BOS@NYK');
    expect(parseGameId('BOS-NYK')).toBe('BOS@NYK');
    expect(parseGameId('BOS')).toBeNull();
  });

  it('usageBumpTeams finds OUT stars by status, name or ID, ignoring cheap OUT players', () => {
    const dk = getSiteConfig('draftkings');
    const players = [
      { id: 1, name: 'Star A', team: 'BOS', salary: 9000, injury_status: 'OUT' },
      { id: 2, name: 'Bench B', team: 'NYK', salary: 3500, injury_status: 'Out' },
      { id: 3, name: 'Star C', team: 'LAL', salary: 9500, injury_status: 'GTD' },
      { id: 4, name: 'Star D', team: 'MIA', salary: 9500 }
    ];
    expect(usageBumpTeams(players, dk)).toEqual(['BOS']);
    expect(usageBumpTeams(players, dk, { outPlayers: ['star c', 4], teams: ['den'] }).sort()).toEqual(['BOS', 'DEN', 'LAL', 'MIA']);
  });

  it('lineupSatisfies checks each rule type', () => {
    const p = (id, team, opponent) => ({ id, team, opponent });
    const lineup = [p(1, 'BOS', 'NYK'), p(2, 'BOS', 'NYK'), p(3, 'BOS', 'NYK'), p(4, 'NYK', 'BOS'),
      p(5, 'LAL', 'GSW'), p(6, 'DEN', 'PHX'), p(7, 'PHX', 'DEN'), p(8, 'MIA', 'MIL')];
    const [teamStack, gameStack, bringBack3, maxPer, minGames, avoid] = resolveStackRules([
      { type: 'teamStack', min: 3 },
      { type: 'gameStack', gameId: 'BOS@NYK', min: 4, bringBack: 1 },
      { type: 'gameStack', gameId: 'BOS@NYK', min: 4, bringBack: 2 },
      { type: 'maxPerTeam', max: 2 },
      { type: 'minGames', min: 4 },
      { type: 'avoidOpponent', playerIds: [6] }
    ], lineup);
    expect(lineupSatisfies(teamStack, lineup)).toBe(true);
    expect(lineupSatisfies(gameStack, lineup)).toBe(true);
    expect(lineupSatisfies(bringBack3, lineup)).toBe(false);
    expect(lineupSatisfies(maxPer, lineup)).toBe(false);
    expect(lineupSatisfies(minGames, lineup)).toBe(true);
    expect(lineupSatisfies(avoid, lineup)).toBe(false);
  });
});
