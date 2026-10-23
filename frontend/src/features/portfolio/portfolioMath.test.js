import { describe, it, expect } from 'vitest'
import {
  buildPortfolioRequest,
  dupeRisk,
  formFromPreset,
  histogramRows,
  leverageChartRows,
  lineupNames,
  lineupRows,
  toExportLineups,
  validatePortfolioForm,
} from './portfolioMath'
import { LIMITS, PRESETS, makeResult } from './fixtures'

describe('portfolio form', () => {
  it('fills defaults from a contest preset', () => {
    expect(formFromPreset(PRESETS, '20-max', LIMITS)).toEqual({
      contestPreset: '20-max',
      payoutPreset: '20-max',
      contestSize: 40000,
      entryFee: 5,
      maxEntries: 20,
      numLineups: 20,
      poolSize: 1000,
      iterations: 2000,
    })
  })

  it('validates ranges and cross-field rules', () => {
    const form = formFromPreset(PRESETS, '20-max', LIMITS)
    expect(validatePortfolioForm(form, LIMITS)).toEqual({})
    expect(validatePortfolioForm({ ...form, numLineups: 21 }, LIMITS)).toHaveProperty('numLineups', 'Max entries is 20')
    expect(validatePortfolioForm({ ...form, maxEntries: 40000 }, LIMITS)).toHaveProperty('maxEntries')
    expect(validatePortfolioForm({ ...form, entryFee: '0' }, LIMITS)).toHaveProperty('entryFee')
    expect(validatePortfolioForm({ ...form, iterations: '50' }, LIMITS)).toHaveProperty('iterations')
    expect(validatePortfolioForm({ ...form, iterations: '' }, LIMITS)).toHaveProperty('iterations')
    expect(validatePortfolioForm({ ...form, poolSize: 15 }, LIMITS)).toHaveProperty('poolSize', 'Must be at least the lineup count')
  })

  it('builds the build request with studio locks and the payout curve preset', () => {
    const form = { ...formFromPreset(PRESETS, '20-max', LIMITS), contestPreset: 'custom', contestSize: '1000', numLineups: '5' }
    const req = buildPortfolioRequest(form, {
      slateId: '42',
      presets: PRESETS,
      locked: new Set([3]),
      excluded: new Set([7, 8]),
      minSalary: 49000,
    })
    expect(req).toEqual({
      slateId: '42',
      contest: { preset: '20-max', label: 'Custom', contestSize: 1000, entryFee: 5, maxEntries: 20 },
      numLineups: 5,
      poolSize: 1000,
      iterations: 2000,
      lockedPlayers: [3],
      excludedPlayers: [7, 8],
      minSalary: 49000,
    })
    expect(buildPortfolioRequest(formFromPreset(PRESETS, '20-max', LIMITS), { slateId: '1', presets: PRESETS })).not.toHaveProperty('minSalary')
  })
})

describe('portfolio results', () => {
  const result = makeResult()

  it('ranks lineup rows by ROI and keeps their distribution index', () => {
    const rows = lineupRows(result)
    expect(rows.map((r) => [r.number, r.distIndex])).toEqual([[2, 1], [1, 0]])
    expect(rows[0]).toMatchObject({ roi: 0.25, cashRate: 0.25, salary: 48000 })
    expect(lineupRows(null)).toEqual([])
    expect(rows[0].actual).toBeNull()
  })

  it('backtest results carry the actual points of each lineup', () => {
    const scored = {
      ...result,
      portfolio: { ...result.portfolio, lineups: result.portfolio.lineups.map((l, i) => ({ ...l, actualPoints: 250 + i })) },
    }
    expect(lineupRows(scored).map((r) => [r.number, r.actual])).toEqual([[2, 251], [1, 250]])
  })

  it('buckets dupe risk', () => {
    expect([0.1, 1, 3].map((d) => dupeRisk(d).label)).toEqual(['Low', 'Med', 'High'])
  })

  it('picks the most under- and overowned players for the chart', () => {
    const over = leverageChartRows(result.players, 'over', 3)
    expect(over.map((p) => p.id)).toEqual([1, 2, 3])
    expect(over.every((p) => p.leverage > 0)).toBe(true)
    const under = leverageChartRows(result.players, 'under')
    expect(under[0].id).toBe(9)
    expect(under.every((p) => p.leverage < 0)).toBe(true)
  })

  it('pools histogram bins across selected lineups and overlays a focus lineup', () => {
    const dist = result.portfolio.scoreDistribution
    const rows = histogramRows(dist, 1)
    expect(rows).toHaveLength(4)
    expect(rows[0]).toMatchObject({ from: 200, to: 210, mid: 205, all: (150 / 800) * 100, focus: 12.5 })
    expect(rows.reduce((s, r) => s + r.all, 0)).toBeCloseTo(100)
    expect(histogramRows(dist, null, new Set([0]))[0]).toMatchObject({ all: 25, focus: undefined })
    expect(histogramRows(null)).toEqual([])
  })

  it('maps lineups to export API rows and names', () => {
    const rows = lineupRows(result)
    expect(toExportLineups(rows.slice(0, 1))[0].players.slice(0, 2)).toEqual([
      { slot: 'PG', playerId: 1 },
      { slot: 'SG', playerId: 2 },
    ])
    expect(lineupNames([{ player: { name: 'Gary Trent Jr.' } }, { player: { name: 'Jokic' } }])).toBe('Trent, Jokic')
  })
})
