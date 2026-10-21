import { describe, it, expect } from 'vitest'
import {
  DEFAULT_WINDOW,
  fmt,
  hasHistory,
  money,
  signed,
  validateRange,
  windowKey,
  windowParams,
} from './insights'

describe('windowParams', () => {
  it('maps each window to the backend params', () => {
    expect(windowParams(DEFAULT_WINDOW)).toEqual({})
    expect(windowParams({ mode: 'last30' })).toEqual({ lastNDays: 30 })
    expect(windowParams({ mode: 'last14' })).toEqual({ lastNDays: 14 })
    expect(windowParams({ mode: 'custom', startDate: '2026-10-01', endDate: '2026-10-20' })).toEqual({
      startDate: '2026-10-01',
      endDate: '2026-10-20',
    })
  })

  it('ignores dates outside custom mode and blank custom dates', () => {
    expect(windowParams({ mode: 'last30', startDate: '2026-10-01' })).toEqual({ lastNDays: 30 })
    expect(windowParams({ mode: 'custom', startDate: '', endDate: '2026-10-20' })).toEqual({ endDate: '2026-10-20' })
  })

  it('gives a stable key per window', () => {
    expect(windowKey({ mode: 'custom', startDate: 'a', endDate: 'b' })).toBe(windowKey({ endDate: 'b', startDate: 'a', mode: 'custom' }))
    expect(windowKey({ mode: 'last30' })).not.toBe(windowKey({ mode: 'last14' }))
  })
})

describe('validateRange', () => {
  it('requires both dates in order', () => {
    expect(validateRange('2026-10-01', '2026-10-20')).toBeNull()
    expect(validateRange('2026-10-20', '2026-10-20')).toBeNull()
    expect(validateRange('', '2026-10-20')).toMatch(/both/i)
    expect(validateRange('2026-10-21', '2026-10-20')).toMatch(/before/i)
  })
})

describe('formatters', () => {
  it('shows zero values instead of hiding them', () => {
    expect(fmt(0)).toBe('0.0')
    expect(fmt(0, 0)).toBe('0')
    expect(signed(0)).toBe('0')
    expect(signed(0, '%')).toBe('0%')
    expect(money(0)).toBe('$0')
  })

  it('renders missing values as a dash', () => {
    expect(fmt(null)).toBe('—')
    expect(fmt(undefined)).toBe('—')
    expect(fmt('n/a')).toBe('—')
    expect(signed(null)).toBe('—')
    expect(money(null)).toBe('—')
  })

  it('formats numbers and numeric strings', () => {
    expect(fmt('12.34')).toBe('12.3')
    expect(signed(12.5, '%')).toBe('+12.5%')
    expect(signed(-3, '%')).toBe('-3%')
    expect(money(11800)).toBe('$11.8K')
  })
})

describe('hasHistory', () => {
  it('is false only when the summary says there are no games', () => {
    expect(hasHistory({ totalGames: 0 })).toBe(false)
    expect(hasHistory({ totalGames: 12 })).toBe(true)
    expect(hasHistory(null)).toBe(true)
  })
})
