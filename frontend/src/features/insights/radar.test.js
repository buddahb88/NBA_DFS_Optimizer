import { describe, it, expect } from 'vitest'
import { DEFAULT_RADAR_FILTERS, RADAR_METRICS, filterRadarRows, scoreBreakdown, scoreTone, validationSummary } from './radar'

const metric = (id) => RADAR_METRICS.find((m) => m.id === id)

const ROWS = [
  { name: 'A', salary: 5000, position: 'PG/SG', score: 70 },
  { name: 'B', salary: 7000, position: 'SF', score: 55 },
  { name: 'C', salary: 9000, position: 'C', score: 40 },
  { name: 'D', salary: 6000, position: 'PF/C', score: null },
]

describe('filterRadarRows', () => {
  it('keeps everything by default', () => {
    expect(filterRadarRows(ROWS, DEFAULT_RADAR_FILTERS)).toHaveLength(4)
  })

  it('filters by salary range, position (any listed) and minimum score', () => {
    const names = (f) => filterRadarRows(ROWS, { ...DEFAULT_RADAR_FILTERS, ...f }).map((r) => r.name)
    expect(names({ minSalary: '5500', maxSalary: '8500' })).toEqual(['B', 'D'])
    expect(names({ position: 'C' })).toEqual(['C', 'D'])
    expect(names({ position: 'SG' })).toEqual(['A'])
    expect(names({ minScore: '50' })).toEqual(['A', 'B'])
  })
})

describe('metric cells', () => {
  it('minutes trend: signed delta, positive / negative at ±3, tooltip with sample sizes', () => {
    const m = metric('min_trend')
    const row = { min_delta_l3: 6.2, min_l3: 32.1, min_l5: 30, min_season: 25.9, games_l3: 3, games_season: 12, projected_minutes: 33 }
    expect(m.format(m.value(row))).toBe('+6.2')
    expect(m.tone(row)).toBe('positive')
    expect(m.tone({ min_delta_l3: -4 })).toBe('negative')
    expect(m.tip(row)).toBe('Minutes L3 32.1 / L5 30.0 vs season 25.9 (3 games L3, 12 games baseline). Projected tonight: 33.')
    expect(m.format(m.value({}))).toBe('—')
  })

  it('vacated usage: absorbed share with the outs and the sample; thin is a caution', () => {
    const m = metric('vacated')
    const row = {
      team_out_names: ['Jalen Duren'], team_vacated_usage: 0.21, teammate_out_names: ['Jalen Duren'],
      teammate_sample: 'confirmed', teammate_absorbed_pct: 0.474, teammate_play_share_delta: 0.065, teammate_min_delta: 7.8, teammate_games_without: 9,
    }
    expect(m.format(m.value(row))).toBe('47%')
    expect(m.tone(row)).toBe('positive')
    expect(m.tone({ ...row, teammate_sample: 'thin' })).toBe('caution')
    expect(m.tip(row)).toBe(
      'Jalen Duren OUT: 21.0% of team plays vacated. Without Jalen Duren: absorbs 47% of it (play share +6.5 pts, +7.8 min) over 9 games without, confirmed sample.',
    )
    expect(m.value({ team_out_names: [] })).toBeNull()
    expect(m.tip({ team_out_names: [] })).toBe('No regulars ruled out before lock on his team.')
  })

  it('environment: blowout or back-to-back is a caution', () => {
    const m = metric('environment')
    expect(m.tone({ implied_total: 121 })).toBe('positive')
    expect(m.tone({ implied_total: 121, blowout: true })).toBe('caution')
    expect(m.tone({ implied_total: 105 })).toBe('negative')
  })

  it('projection gap explains a missing rate projection', () => {
    const m = metric('proj_gap')
    expect(m.tip({ rate_projection: null, rate_reason: 'no_projected_minutes' })).toBe('No projected minutes: no rate projection.')
    expect(m.tone({ rate_gap: 4.5 })).toBe('positive')
  })
})

describe('score helpers', () => {
  it('tones: 60+ positive, under 45 negative', () => {
    expect(scoreTone(64)).toBe('positive')
    expect(scoreTone(50)).toBe('neutral')
    expect(scoreTone(40)).toBe('negative')
  })

  it('breakdown lists weighted components, heaviest first, then coverage', () => {
    const lines = scoreBreakdown({ components: { minutes: 0.9, leverage: 0.2, floor: null }, coverage: 0.85 }, { minutes: 0.12, leverage: 0.16, floor: 0 })
    expect(lines).toEqual(['Leverage vs ownership (16%): 20', 'Minutes trend (12%): 90', 'Data coverage 85% of weight (missing = neutral 50)'])
  })

  it('validation summary', () => {
    const v = { players: 242, top: { players: 25, hits: 12, hitRate: 0.48 }, slate: { players: 242, hits: 78, hitRate: 0.322 }, lift: 1.49 }
    expect(validationSummary(v)).toEqual({ top: '12/25 (48%)', slate: '78/242 (32%)', lift: '1.49×' })
    expect(validationSummary({ players: 0 })).toBeNull()
  })
})
