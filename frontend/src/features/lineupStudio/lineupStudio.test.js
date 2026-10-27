import { describe, it, expect } from 'vitest'
import { createRule, describeRule, slateGames, toRequestRule, toRequestRules, validateDraftRules } from './stackRules'
import { CONTEST_PRESETS, minSalaryFor, settingsFromPreset } from './presets'
import { buildOptimizerRequest } from './request'
import {
  FALLBACK_SITE,
  computeExposure,
  eligibleSlotIndexes,
  emptySlots,
  lineupTotals,
  normalizeLineup,
  pickSlot,
  slotsFromHandoff,
  slotsFromLineup,
} from './lineupMath'

const DK = FALLBACK_SITE
const FD = {
  key: 'fanduel',
  name: 'FanDuel',
  salaryCap: 60000,
  rosterSlots: ['PG', 'PG', 'SG', 'SG', 'SF', 'SF', 'PF', 'PF', 'C'].map((slot) => ({ slot, eligible: [slot] })),
}

const p = (id, position, extra = {}) => ({ id, name: `P${id}`, position, team: 'BOS', opponent: 'NYK', salary: 5000, projected_points: 30, rostership: 10, ...extra })

describe('stackRules', () => {
  it('maps drafts to the stackRules request contract', () => {
    expect(toRequestRule(createRule('teamStack', { teams: ['BOS'], min: 3 }))).toEqual({ type: 'teamStack', teams: ['BOS'], min: 3 })
    expect(toRequestRule(createRule('gameStack', { games: ['BOS@NYK'], percentOfLineups: 25 }))).toEqual({
      type: 'gameStack',
      gameIds: ['BOS@NYK'],
      min: 3,
      bringBack: 1,
      percentOfLineups: 25,
    })
    expect(toRequestRule(createRule('avoidOpponent', { playerIds: [7] }))).toEqual({ type: 'avoidOpponent', playerIds: [7], max: 0 })
    expect(toRequestRule(createRule('minGames'))).toEqual({ type: 'minGames', min: 3 })
    expect(toRequestRule(createRule('preset:shootout'))).toEqual({ preset: 'shootout', min: 3, bringBack: 1, topGames: 2, maxSpread: 6 })
  })

  it('drops empty optional fields and fields the type does not use', () => {
    const rule = createRule('maxPerTeam', { min: 2, max: '', teams: [] })
    expect(toRequestRule(rule)).toEqual({ type: 'maxPerTeam' })
  })

  it('flags the same mistakes the server rejects', () => {
    const rules = [
      createRule('team'),
      createRule('teamStack', { min: 0 }),
      createRule('gameStack', { min: 3, bringBack: 2 }),
      createRule('maxPerTeam', { max: '' }),
      createRule('teamStack', { min: 4, max: 2 }),
      createRule('avoidOpponent'),
      createRule('minGames', { percentOfLineups: 140 }),
      createRule('teamStack', { min: 3 }),
    ]
    const errors = validateDraftRules(rules)
    expect(Object.keys(errors)).toHaveLength(7)
    expect(errors[rules[0].uid]).toContain('Pick at least one team')
    expect(errors[rules[2].uid]).toContain('Bring-back x 2 cannot exceed Min')
    expect(errors[rules[4].uid]).toContain('Min cannot exceed Max')
    expect(errors[rules[7].uid]).toBeUndefined()
  })

  it('describes rules in plain English', () => {
    expect(describeRule(createRule('gameStack', { games: ['BOS@NYK'], percentOfLineups: 50 }))).toBe(
      '3+ from one game (BOS@NYK), 1+ bring-back in 50% of lineups',
    )
    expect(describeRule(createRule('avoidOpponent', { playerIds: [1] }), () => 'Jokic')).toBe('Avoid opponents of Jokic')
  })

  it('builds game keys the server can parse', () => {
    expect(slateGames([p(1, 'PG'), p(2, 'C', { team: 'NYK', opponent: 'BOS' }), p(3, 'SF', { team: 'lal', opponent: 'den' })])).toEqual([
      'BOS@NYK',
      'DEN@LAL',
    ])
  })
})

describe('presets', () => {
  it.each(Object.keys(CONTEST_PRESETS))('%s preset yields valid settings', (key) => {
    const settings = settingsFromPreset(key, 50000)
    expect(settings.preset).toBe(key)
    expect(validateDraftRules(settings.stackRules)).toEqual({})
    expect(settings.minSalary).toBeLessThanOrEqual(50000)
  })

  it('scales min salary to the site cap', () => {
    expect(minSalaryFor(CONTEST_PRESETS.cash, 50000)).toBe(49000)
    expect(minSalaryFor(CONTEST_PRESETS.cash, 60000)).toBe(58800)
    expect(minSalaryFor(CONTEST_PRESETS.cash, 200)).toBe(196)
  })

  it('150-max request carries exposure, uniqueness, randomness and stack rules', () => {
    const settings = settingsFromPreset('max150', 50000)
    const body = buildOptimizerRequest({ slateId: 's1', site: 'draftkings', settings, locked: new Set([5]), excluded: [9] })
    expect(body).toMatchObject({
      slateId: 's1',
      site: 'draftkings',
      mode: 'gpp',
      numLineups: 150,
      randomness: 25,
      maxExposure: 40,
      minUniqueness: 3,
      lockedPlayers: [5],
      excludedPlayers: [9],
    })
    expect(body.stackRules).toEqual(toRequestRules(settings.stackRules))
    expect(body.stackRules[0]).toMatchObject({ preset: 'shootout', percentOfLineups: 50 })
  })

  it('presets leave the opportunity factor off; the request carries the weight', () => {
    for (const key of Object.keys(CONTEST_PRESETS)) expect(settingsFromPreset(key, 50000).opportunityWeight).toBe(0)
    const settings = { ...settingsFromPreset('cash', 50000), opportunityWeight: 0.4 }
    expect(buildOptimizerRequest({ slateId: 's', site: 'draftkings', settings }).opportunityWeight).toBe(0.4)
  })

  it('single-lineup requests ignore exposure and uniqueness', () => {
    const settings = { ...settingsFromPreset('cash', 50000), maxExposure: 30, minUniqueness: 4 }
    expect(buildOptimizerRequest({ slateId: 's', site: 'draftkings', settings })).toMatchObject({ maxExposure: 100, minUniqueness: 1, stackRules: [] })
  })
})

describe('lineupMath', () => {
  it('fills the most restrictive open slot first (DK)', () => {
    const guard = p(1, 'PG/SG')
    let slots = emptySlots(DK)
    const order = []
    for (let i = 0; i < 4; i++) {
      const idx = pickSlot(DK, slots, { ...guard, id: i })
      order.push(DK.rosterSlots[idx].slot)
      slots = slots.map((s, j) => (j === idx ? guard : s))
    }
    expect(order).toEqual(['PG', 'SG', 'G', 'UTIL'])
    expect(pickSlot(DK, slots, guard)).toBe(-1)
  })

  it('respects site eligibility (FanDuel has no flex slots)', () => {
    expect(eligibleSlotIndexes(FD, p(1, 'C'))).toEqual([8])
    expect(eligibleSlotIndexes(FD, p(1, 'PF/C'))).toEqual([6, 7, 8])
    expect(eligibleSlotIndexes(DK, p(1, 'C'))).toEqual([4, 7])
  })

  it('totals salary, projection and ownership', () => {
    const totals = lineupTotals([{ slot: 'PG', player: p(1, 'PG') }, { slot: 'SG', player: null }, null], 50000)
    expect(totals).toEqual({ salary: 5000, remaining: 45000, projection: 30, ownership: 10, filled: 1 })
  })

  it('computes player and team exposure', () => {
    const a = p(1, 'PG')
    const b = p(2, 'C', { team: 'NYK' })
    const c = p(3, 'SF', { team: 'BOS' })
    const { players, teams } = computeExposure([
      [{ slot: 'PG', player: a }, { slot: 'C', player: b }],
      [{ slot: 'PG', player: a }, { slot: 'SF', player: c }],
    ])
    expect(players.map((r) => [r.id, r.count, r.exposure])).toEqual([
      [1, 2, 100],
      [2, 1, 50],
      [3, 1, 50],
    ])
    expect(teams.find((t) => t.team === 'BOS')).toMatchObject({ lineups: 2, slots: 3, exposure: 100 })
    expect(teams.find((t) => t.team === 'NYK')).toMatchObject({ lineups: 1, exposure: 50 })
  })

  it('maps optimizer lineups onto the site roster by slot name', () => {
    const entries = normalizeLineup({
      players: [
        { position: 'PG', player: p(1, 'PG') },
        { position: 'PG', player: p(2, 'PG') },
        { position: 'C', player: p(3, 'C') },
      ],
    })
    const slots = slotsFromLineup(FD, entries)
    expect(slots.map((s) => s?.id ?? null)).toEqual([1, 2, null, null, null, null, null, null, 3])
  })
})

describe('slotsFromHandoff', () => {
  it('refills manual builder slots from a chat lineup by id, player_id or name', () => {
    const pool = [p(1, 'PG', { player_id: 'a' }), p(2, 'C', { player_id: 'b', name: 'Big Man' }), p(3, 'SF', { player_id: 'c' })]
    const handoff = {
      slots: [
        { slot: 'PG', id: 1, name: 'P1' },
        { slot: 'C', id: null, playerId: 'b', name: 'Big Man' },
        { slot: 'SF', id: 999, name: 'p3' },
        { slot: 'UTIL', name: 'Not In Pool' },
      ],
    }
    const { slots, missing } = slotsFromHandoff(DK, pool, handoff)
    expect(slots.map((s) => s?.id ?? null)).toEqual([1, null, 3, null, 2, null, null, null])
    expect(missing).toEqual(['Not In Pool'])
  })
})
