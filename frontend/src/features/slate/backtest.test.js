import { describe, it, expect } from 'vitest'
import {
  BACKTEST_DISABLED,
  backtestLabel,
  backtestOptions,
  findBacktest,
  formatActual,
  lineupActual,
  resultLabel,
  settingsKeyFor,
  slateRequestParams,
} from './backtest'

const BT = { slateDate: '2026-10-21', slateId: '29805', site: 'draftkings', players: 242 }

describe('backtest helpers', () => {
  it('labels and finds a backtest by date', () => {
    expect(backtestLabel(BT)).toBe('Backtest 2026-10-21')
    expect(backtestLabel(null)).toBe('Live')
    expect(findBacktest([BT], '2026-10-21')).toBe(BT)
    expect(findBacktest([BT], '2026-10-20')).toBeNull()
  })

  it('selector options: Live first, then each saved night', () => {
    expect(backtestOptions([BT, { ...BT, slateDate: '2026-10-20', players: 65 }])).toEqual([
      { value: '', label: 'Live' },
      { value: '2026-10-21', label: 'Backtest: 2026-10-21 (242 players)' },
      { value: '2026-10-20', label: 'Backtest: 2026-10-20 (65 players)' },
    ])
  })

  it('selector options: one per night, its main slate (listed first by the API)', () => {
    const early = { ...BT, slateId: '29808', players: 102, isMain: false, name: 'Classic · 3 games · 7:30 PM ET' }
    expect(backtestOptions([{ ...BT, isMain: true, name: 'Main · 11 games · 7:00 PM ET' }, early])).toEqual([
      { value: '', label: 'Live' },
      { value: '2026-10-21', label: 'Backtest: 2026-10-21 (242 players)' },
    ])
  })

  it('request params carry slateDate and ranges only for a backtest', () => {
    expect(slateRequestParams(null, 'model')).toEqual({})
    expect(slateRequestParams(BT, 'original')).toEqual({ slateDate: '2026-10-21', ranges: 'original' })
  })

  it('player settings never share the live slate key', () => {
    expect(settingsKeyFor('29806', null)).toBe('29806')
    expect(settingsKeyFor('29806', BT)).toBe('backtest:2026-10-21:29805')
  })

  it('lineup actual total is null until every player has a result', () => {
    const slot = (actualPoints) => ({ slot: 'PG', player: { actualPoints } })
    expect(lineupActual([slot(30), slot(12.5), slot(0)])).toBe(42.5)
    expect(lineupActual([slot(30), slot(null)])).toBeNull()
    expect(lineupActual([{ slot: 'PG', player: { projected_points: 20 } }])).toBeNull()
    expect(formatActual(42.25)).toBe('42.3')
    expect(formatActual(null)).toBe('—')
  })

  it('names why live-only actions are off in a backtest', () => {
    expect(BACKTEST_DISABLED).toMatch(/Live/)
  })

  it('result label: status with actual minutes, Pending without a box score', () => {
    expect(resultLabel({ resultStatus: 'PLAYED', actualMinutes: 35.6 })).toEqual({ label: 'Played · 36 min', tone: 'positive' })
    expect(resultLabel({ resultStatus: 'DNP', actualMinutes: 0 })).toEqual({ label: 'DNP', tone: 'negative' })
    expect(resultLabel({ resultStatus: 'INACTIVE', actualMinutes: 0 })).toEqual({ label: 'Inactive', tone: 'negative' })
    expect(resultLabel({ resultStatus: 'PENDING' })).toEqual({ label: 'Pending', tone: 'neutral' })
    expect(resultLabel({})).toBeNull()
  })
})
