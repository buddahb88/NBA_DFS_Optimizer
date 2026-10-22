import { describe, it, expect } from 'vitest'
import { filterSessions, groupSessionsByDate, sessionDate } from './sessionGroups'

// Local-time "now" so day boundaries don't depend on the machine's zone
const NOW = new Date(2026, 9, 22, 15, 0, 0)
const at = (daysAgo, hour = 12) => {
  const d = new Date(NOW)
  d.setDate(d.getDate() - daysAgo)
  d.setHours(hour, 0, 0, 0)
  return d.toISOString()
}

describe('sessionDate', () => {
  it('reads sqlite UTC timestamps without a zone as UTC', () => {
    expect(sessionDate({ updated_at: '2026-10-22 17:05:00' }).toISOString()).toBe('2026-10-22T17:05:00.000Z')
  })

  it('prefers updated_at and falls back to created_at', () => {
    expect(sessionDate({ created_at: '2026-10-01T00:00:00Z' }).toISOString()).toBe('2026-10-01T00:00:00.000Z')
    expect(sessionDate({ created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-02T00:00:00Z' }).toISOString()).toBe(
      '2026-10-02T00:00:00.000Z',
    )
    expect(sessionDate({})).toBeNull()
  })
})

describe('groupSessionsByDate', () => {
  it('buckets sessions into Today / Yesterday / Previous 7 days / Older in that order', () => {
    const sessions = [
      { id: 1, updated_at: at(0, 9) },
      { id: 2, updated_at: at(1, 23) },
      { id: 3, updated_at: at(1, 0) },
      { id: 4, updated_at: at(3) },
      { id: 5, updated_at: at(7) },
      { id: 6, updated_at: at(8) },
      { id: 7, updated_at: at(40) },
    ]
    const groups = groupSessionsByDate(sessions, NOW)
    expect(groups.map((g) => [g.label, g.sessions.map((s) => s.id)])).toEqual([
      ['Today', [1]],
      ['Yesterday', [2, 3]],
      ['Previous 7 days', [4, 5]],
      ['Older', [6, 7]],
    ])
  })

  it('omits empty groups and sorts newest first within a group', () => {
    const groups = groupSessionsByDate(
      [
        { id: 'a', updated_at: at(0, 8) },
        { id: 'b', updated_at: at(0, 14) },
      ],
      NOW,
    )
    expect(groups).toHaveLength(1)
    expect(groups[0].key).toBe('today')
    expect(groups[0].sessions.map((s) => s.id)).toEqual(['b', 'a'])
  })

  it('puts sessions without a usable date under Older', () => {
    const groups = groupSessionsByDate([{ id: 1 }, { id: 2, updated_at: 'nope' }], NOW)
    expect(groups.map((g) => g.key)).toEqual(['older'])
    expect(groups[0].sessions).toHaveLength(2)
  })

  it('returns no groups for no sessions', () => {
    expect(groupSessionsByDate([], NOW)).toEqual([])
    expect(groupSessionsByDate(undefined, NOW)).toEqual([])
  })
})

describe('filterSessions', () => {
  const sessions = [
    { id: 1, title: 'Lakers stack ideas' },
    { id: 2, title: 'Value plays under 5k' },
    { id: 3, title: null },
  ]

  it('matches titles case-insensitively', () => {
    expect(filterSessions(sessions, 'lakers').map((s) => s.id)).toEqual([1])
    expect(filterSessions(sessions, '  VALUE ').map((s) => s.id)).toEqual([2])
  })

  it('returns everything for a blank query', () => {
    expect(filterSessions(sessions, '')).toHaveLength(3)
    expect(filterSessions(sessions, '   ')).toHaveLength(3)
  })
})
