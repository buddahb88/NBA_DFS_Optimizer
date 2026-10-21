import { describe, it, expect } from 'vitest'
import {
  DEFAULT_FILTERS,
  applyFilters,
  applyQuickView,
  archetypeDrilldownPath,
  archetypeOptions,
  bandTone,
  gameKey,
  injuryCode,
  isInjured,
  matchupTone,
  ownershipTone,
  slateStats,
  toOptimizerPlayers,
  validateSettings,
  withSettings,
} from './playerPool'

const player = (over) => ({
  id: 1,
  player_id: '100',
  name: 'Player',
  team: 'BOS',
  opponent: 'NYK',
  position: 'PG/SG',
  salary: 8000,
  projected_points: 40,
  projected_minutes: 34,
  floor: 30,
  ceiling: 55,
  rostership: 15,
  leverage_score: 2,
  boom_probability: 20,
  injury_status: null,
  ...over,
})

describe('withSettings', () => {
  it('computes value from the projection', () => {
    const row = withSettings(player(), null)
    expect(row.proj).toBe(40)
    expect(row.valueAdj).toBeCloseTo(5)
    expect(row.overridden).toBe(false)
  })

  it('applies a projection override and scales floor/ceiling', () => {
    const row = withSettings(player(), { projectionOverride: 50 })
    expect(row.proj).toBe(50)
    expect(row.overridden).toBe(true)
    expect(row.floorAdj).toBeCloseTo(37.5)
    expect(row.ceilingAdj).toBeCloseTo(68.75)
    expect(row.valueAdj).toBeCloseTo(6.25)
  })
})

describe('injuries', () => {
  it('normalizes codes, words and JSON', () => {
    expect(injuryCode(null)).toBeNull()
    expect(injuryCode('')).toBeNull()
    expect(injuryCode('Out')).toBe('OUT')
    expect(injuryCode('questionable')).toBe('Q')
    expect(injuryCode('{"status":"GTD"}')).toBe('GTD')
  })

  it('treats probable as healthy for hide-injured', () => {
    expect(isInjured(player({ injury_status: 'P' }))).toBe(false)
    expect(isInjured(player({ injury_status: 'Q' }))).toBe(true)
  })
})

describe('applyFilters', () => {
  const rows = [
    player({ id: 1, name: 'Guard', position: 'PG', salary: 9000 }),
    player({ id: 2, name: 'Big', position: 'C', team: 'LAL', opponent: 'DEN', salary: 5000, injury_status: 'OUT' }),
    player({ id: 3, name: 'Wing', position: 'SF/PF', team: 'NYK', opponent: 'BOS', salary: 6500 }),
  ]
  const run = (f) => applyFilters(rows, { ...DEFAULT_FILTERS, ...f }).map((r) => r.id)

  it('filters by search, position, game, team, salary and injury', () => {
    expect(run({ search: 'lal' })).toEqual([2])
    expect(run({ positions: ['PF', 'C'] })).toEqual([2, 3])
    expect(run({ game: gameKey(rows[0]) })).toEqual([1, 3])
    expect(run({ game: 'team:NYK' })).toEqual([3])
    expect(run({ salaryMin: '6000', salaryMax: '8000' })).toEqual([3])
    expect(run({ hideInjured: true })).toEqual([1, 3])
  })

  it('maps both sides of a game to one key', () => {
    expect(gameKey(rows[0])).toBe(gameKey(rows[2]))
  })
})

describe('tones and quick views', () => {
  const rows = Array.from({ length: 10 }, (_, i) =>
    withSettings(player({ id: i, player_id: String(i), projected_points: 20 + i * 3, rostership: i * 4, leverage_score: i }), null),
  )
  const stats = slateStats(rows)

  it('colours value and leverage by slate percentile', () => {
    expect(bandTone(rows[9].valueAdj, stats.value)).toBe('positive')
    expect(bandTone(rows[0].valueAdj, stats.value)).toBe('negative')
    expect(bandTone(rows[5].leverage_score, stats.leverage)).toBeNull()
  })

  it('flags chalk and low ownership', () => {
    expect(ownershipTone(30)).toBe('caution')
    expect(ownershipTone(3)).toBe('info')
    expect(ownershipTone(15)).toBeNull()
  })

  it('quick views narrow the pool', () => {
    expect(applyQuickView(rows, 'all', stats)).toHaveLength(10)
    const gpp = applyQuickView(rows, 'gpp', stats)
    expect(gpp.every((r) => r.rostership < 25)).toBe(true)
    const value = applyQuickView(rows, 'value', stats)
    expect(value.length).toBeLessThan(10)
    expect(value.every((r) => r.valueAdj >= stats.value.p60)).toBe(true)
  })
})

describe('toOptimizerPlayers', () => {
  it('maps saved controls (by player_id) to the optimizer contract (by id)', () => {
    const players = [player({ id: 11, player_id: 'a' }), player({ id: 12, player_id: 'b' }), player({ id: 13, player_id: 'c' })]
    const saved = {
      a: { lock: true, exclude: false, minExposure: null, maxExposure: null, projectionOverride: null },
      b: { lock: false, exclude: false, minExposure: 10, maxExposure: '60', projectionOverride: 42.5 },
      gone: { exclude: true },
    }
    expect(toOptimizerPlayers(players, saved)).toEqual([
      { id: 11, lock: true },
      { id: 12, minExposure: 10, maxExposure: 60, projectionOverride: 42.5 },
    ])
  })
})

describe('validateSettings', () => {
  it('mirrors backend validation', () => {
    expect(validateSettings({ minExposure: 50, maxExposure: 40 })).toMatch(/above max/)
    expect(validateSettings({ maxExposure: 140 })).toMatch(/0-100/)
    expect(validateSettings({ lock: true, exclude: true })).toMatch(/lock and exclude/)
    expect(validateSettings({ minExposure: 20, maxExposure: 40 })).toBeNull()
  })
})

describe('archetype matchups', () => {
  const matchup = (over) => ({
    season: '2025-26', site: 'draftkings', grouping: 'archetype', group_key: 'scoring_guard', label: 'Scoring Guard / Wing',
    opponent: 'NYK', delta: 2.4, rank: 3, teams: 30, grade: 'A', games: 8, ...over,
  })
  const rows = [
    player({ id: 1, archetype: 'scoring_guard', archetype_label: 'Scoring Guard / Wing', matchup: matchup() }),
    player({ id: 2, archetype: 'rim_running_big', archetype_label: 'Rim-Running Big', matchup: matchup({ grade: 'D', delta: -1 }) }),
    player({ id: 3, archetype: null, archetype_label: null, matchup: null }),
  ]
  const run = (f) => applyFilters(rows, { ...DEFAULT_FILTERS, ...f }).map((r) => r.id)

  it('filters by archetype and minimum matchup grade', () => {
    expect(run({ archetype: 'rim_running_big' })).toEqual([2])
    expect(run({ minGrade: 'B' })).toEqual([1])
    expect(run({ minGrade: 'D' })).toEqual([1, 2])
    expect(run({})).toEqual([1, 2, 3])
  })

  it('lists the pool archetypes by label', () => {
    expect(archetypeOptions(rows)).toEqual([
      { value: 'rim_running_big', label: 'Rim-Running Big' },
      { value: 'scoring_guard', label: 'Scoring Guard / Wing' },
    ])
  })

  it('tones grades: A/B good, D/F bad', () => {
    expect(matchupTone('A')).toBe('positive')
    expect(matchupTone('B')).toBe('positive')
    expect(matchupTone('C')).toBe('neutral')
    expect(matchupTone('F')).toBe('negative')
    expect(matchupTone(null)).toBe('neutral')
  })

  it('links to the Archetypes page drill-down for the cell', () => {
    expect(archetypeDrilldownPath(matchup())).toBe('/archetypes?season=2025-26&grouping=archetype&team=NYK&group=scoring_guard')
    expect(archetypeDrilldownPath(matchup({ grouping: 'position', group_key: 'G' }))).toBe('/archetypes?season=2025-26&grouping=position&team=NYK&group=G')
    expect(archetypeDrilldownPath(null)).toBeNull()
  })
})
