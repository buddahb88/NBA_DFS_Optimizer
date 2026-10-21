import { describe, it, expect } from 'vitest'
import { buildHeatmap, cellColor, defenseParams, formatDelta, STATS } from './archetypes'

const DEFINITIONS = {
  archetypes: [
    { key: 'primary_creator', label: 'Primary Creator' },
    { key: 'scoring_guard', label: 'Scoring Guard / Wing' },
    { key: 'role_player', label: 'Role Player' },
    { key: 'unclassified', label: 'Unclassified' },
  ],
  positions: [{ key: 'G', label: 'Guards' }, { key: 'F', label: 'Forwards' }, { key: 'C', label: 'Centers' }],
}

const ROWS = [
  { team: 'NYK', group_key: 'scoring_guard', fp_over_expectation: 3, pts_delta: 1, games: 8 },
  { team: 'BOS', group_key: 'scoring_guard', fp_over_expectation: -2, pts_delta: -1, games: 8 },
  { team: 'BOS', group_key: 'primary_creator', fp_over_expectation: 0.5, pts_delta: 0, games: 6 },
  { team: 'BOS', group_key: 'unclassified', fp_over_expectation: 9, pts_delta: 9, games: 2 },
]

describe('buildHeatmap', () => {
  it('teams as rows (A-Z), archetypes as columns in definition order, unclassified dropped', () => {
    const map = buildHeatmap(ROWS, { definitions: DEFINITIONS, grouping: 'archetype', stat: 'fp' })
    expect(map.teams).toEqual(['BOS', 'NYK'])
    // Only archetypes with data show
    expect(map.groups.map((g) => g.key)).toEqual(['primary_creator', 'scoring_guard'])
    expect(map.cell('NYK', 'scoring_guard')).toMatchObject({ value: 3, row: ROWS[0] })
    expect(map.cell('NYK', 'primary_creator')).toBeNull()
    expect(map.maxAbs).toBe(3)
  })

  it('reads the selected stat column and G/F/C columns for the position grouping', () => {
    const rows = [{ team: 'NYK', group_key: 'C', fp_over_expectation: 1, reb_delta: -0.8 }, { team: 'NYK', group_key: 'G', reb_delta: 0.4 }]
    const map = buildHeatmap(rows, { definitions: DEFINITIONS, grouping: 'position', stat: 'reb' })
    expect(map.groups.map((g) => g.label)).toEqual(['Guards', 'Centers'])
    expect(map.cell('NYK', 'C').value).toBe(-0.8)
    expect(map.maxAbs).toBe(0.8)
  })

  it('handles no rows', () => {
    const map = buildHeatmap([], { definitions: DEFINITIONS, grouping: 'archetype', stat: 'fp' })
    expect(map.teams).toEqual([])
    expect(map.groups).toEqual([])
  })
})

describe('cellColor', () => {
  it('diverges: info hue above zero, negative below, alpha by magnitude, neutral at zero', () => {
    expect(cellColor(3, 3)).toBe('rgb(var(--info) / 0.8)')
    expect(cellColor(-1.5, 3)).toBe('rgb(var(--negative) / 0.44)')
    expect(cellColor(0, 3)).toBe('transparent')
    expect(cellColor(null, 3)).toBe('transparent')
    // Beyond the scale clamps
    expect(cellColor(10, 3)).toBe('rgb(var(--info) / 0.8)')
  })
})

describe('formatDelta', () => {
  it('signs and rounds', () => {
    expect(formatDelta(2.345)).toBe('+2.3')
    expect(formatDelta(-0.04)).toBe('0.0')
    expect(formatDelta(-1.25, 2)).toBe('-1.25')
    expect(formatDelta(null)).toBe('—')
  })
})

describe('defenseParams', () => {
  it('drops empty filters and asks for the season fallback on Auto', () => {
    expect(defenseParams({ season: '2026-27', grouping: 'position', lastNGames: '', stat: 'fp' }, 'fanduel')).toEqual({
      season: '2026-27', grouping: 'position', site: 'fanduel',
    })
    // Auto season: the backend may fall back to last season while the current one is thin
    expect(defenseParams({ season: '', grouping: 'archetype', lastNGames: 10 }, 'draftkings')).toEqual({
      grouping: 'archetype', lastNGames: 10, site: 'draftkings', seasonFallback: true,
    })
  })

  it('every stat maps to a defense column', () => {
    expect(STATS.map((s) => s.value)).toEqual(['fp', 'pts', 'reb', 'ast', 'fg3m'])
  })
})
