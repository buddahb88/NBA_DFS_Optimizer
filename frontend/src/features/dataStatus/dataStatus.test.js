import { describe, it, expect } from 'vitest'
import { dateRange, daysSince, historyHealth, runDuration, runStatus, sourceLabel } from './dataStatus'

describe('runStatus', () => {
  it('uses the server status, else derives it from finished_at / error', () => {
    expect(runStatus({ status: 'error' })).toBe('error')
    expect(runStatus({ started_at: 'x', finished_at: null })).toBe('syncing')
    expect(runStatus({ finished_at: 'x', error: 'HTTP 500' })).toBe('error')
    expect(runStatus({ finished_at: 'x', error: null })).toBe('complete')
    expect(runStatus(null)).toBeNull()
  })
})

describe('runDuration', () => {
  it('formats seconds, minutes and hours', () => {
    const run = (secs) => ({ started_at: '2026-10-21T10:00:00Z', finished_at: new Date(Date.parse('2026-10-21T10:00:00Z') + secs * 1000).toISOString() })
    expect(runDuration(run(42))).toBe('42s')
    expect(runDuration(run(65))).toBe('1m 05s')
    expect(runDuration(run(3 * 3600 + 120))).toBe('3h 02m')
  })

  it('counts a running sync up to now', () => {
    expect(runDuration({ started_at: '2026-10-21T10:00:00Z', finished_at: null }, new Date('2026-10-21T10:00:30Z'))).toBe('30s')
    expect(runDuration({})).toBe('—')
  })
})

describe('labels', () => {
  it('names sync sources and date ranges', () => {
    expect(sourceLabel('espn-scheduled')).toBe('ESPN (scheduled)')
    expect(sourceLabel('mystery')).toBe('mystery')
    expect(dateRange('2024-10-22', '2025-06-22')).toBe('2024-10-22 → 2025-06-22')
    expect(dateRange('2026-10-20', '2026-10-20')).toBe('2026-10-20')
    expect(dateRange(null, null)).toBe('—')
  })

  it('counts whole local days since a date', () => {
    expect(daysSince('2026-10-20', new Date(2026, 9, 21, 9))).toBe(1)
    expect(daysSince(null)).toBeNull()
  })
})

describe('historyHealth', () => {
  it('flags failed, empty and stale game logs', () => {
    expect(historyHealth(null).state).toBe('loading')
    expect(historyHealth({ error: 'Network Error' }).state).toBe('unknown')
    expect(historyHealth({ hasData: false })).toEqual({ state: 'missing', label: 'Game logs: not synced' })
    expect(historyHealth({ hasData: true, latestGame: '2026-10-10', needsUpdate: true })).toEqual({
      state: 'stale',
      label: 'Game logs through 2026-10-10',
    })
    expect(historyHealth({ hasData: true, latestGame: '2026-10-20', needsUpdate: false }).state).toBe('current')
  })
})
