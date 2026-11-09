import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import ModelLogPage from './ModelLogPage'
import { cashResult, nightLabel, parseScore, sourceLabel } from './modelLog'
import { pickLogAPI } from '../../services/api'

vi.mock('../../services/api', () => ({
  pickLogAPI: {
    getReport: vi.fn(),
    logNow: vi.fn(),
    score: vi.fn(),
    saveNight: vi.fn(),
  },
}))

const player = (name, o = {}) => ({ player_key: name.toLowerCase(), name, slot: 'UTIL', salary: 6000, projected_points: 30, ...o })

const scoredPick = {
  id: 1,
  slateId: '30127',
  gameDate: '2026-11-07',
  site: 'draftkings',
  source: 'max_projection',
  isForward: true,
  projectedPoints: 268.4,
  actualPoints: 251.25,
  dnpCount: 1,
  fieldPercentile: 71.4,
  scoredAt: '2026-11-08T10:00:00Z',
  lineup: [player('Alpha One', { actual_points: 40, status: 'PLAYED' }), player('Beta Two', { actual_points: 0, status: 'DNP' })],
}
const pendingPick = {
  ...scoredPick,
  id: 2,
  slateId: '30148',
  gameDate: '2026-11-08',
  actualPoints: null,
  dnpCount: null,
  fieldPercentile: null,
  scoredAt: null,
  lineup: [player('Gamma Three')],
}
const backfillPick = { ...scoredPick, id: 3, slateId: '29805', gameDate: '2026-10-21', source: 'max_projection_backfill', isForward: false, actualPoints: 240 }

const REPORT = {
  success: true,
  sources: ['max_projection'],
  nights: [
    { gameDate: '2026-11-08', site: 'draftkings', slateId: '30148', contest: null, picks: [pendingPick] },
    { gameDate: '2026-11-07', site: 'draftkings', slateId: '30127', contest: { cashLine: 245, winningScore: 330 }, picks: [scoredPick] },
    { gameDate: '2026-10-21', site: 'draftkings', slateId: '29805', contest: null, picks: [backfillPick] },
  ],
  summary: [
    { source: 'max_projection', isForward: true, logged: 2, nights: 1, avgActual: 251.25, avgProjected: 268.4, best: { gameDate: '2026-11-07', actualPoints: 251.25 }, worst: { gameDate: '2026-11-07', actualPoints: 251.25 }, avgDnp: 1, avgFieldPercentile: 71.4, nightsWithCashLine: 1, cashed: 1 },
    { source: 'max_projection_backfill', isForward: false, logged: 1, nights: 1, avgActual: 240, avgProjected: 268.4, best: { gameDate: '2026-10-21', actualPoints: 240 }, worst: { gameDate: '2026-10-21', actualPoints: 240 }, avgDnp: 1, avgFieldPercentile: 50, nightsWithCashLine: 0, cashed: 0 },
  ],
}

const renderPage = () => render(<MemoryRouter><ModelLogPage /></MemoryRouter>)

beforeEach(() => {
  vi.clearAllMocks()
  pickLogAPI.getReport.mockResolvedValue({ data: REPORT })
})

describe('modelLog helpers', () => {
  it('labels sources and flags backfill', () => {
    expect(sourceLabel('max_projection')).toBe('Max projection')
    expect(sourceLabel('max_projection_backfill')).toBe('Max projection (backfill)')
    expect(sourceLabel('custom_thing')).toBe('custom_thing')
  })
  it('cash result needs an entered line and a score', () => {
    expect(cashResult({ actualPoints: 250 }, { cashLine: 245 })).toBe('cashed')
    expect(cashResult({ actualPoints: 240 }, { cashLine: 245 })).toBe('missed')
    expect(cashResult({ actualPoints: 240 }, null)).toBeNull()
    expect(cashResult({ actualPoints: null }, { cashLine: 245 })).toBeNull()
  })
  it('parses scores and formats nights without a timezone shift', () => {
    expect(parseScore('')).toBeNull()
    expect(parseScore(' 245.5 ')).toBe(245.5)
    expect(parseScore('abc')).toBeNaN()
    expect(parseScore('-3')).toBeNaN()
    expect(nightLabel('2026-11-07')).toBe('Sat, Nov 7')
  })
})

describe('ModelLogPage', () => {
  it('shows running totals per source, with forward and backfill flagged', async () => {
    renderPage()
    const forward = await screen.findByTestId('summary-max_projection')
    expect(within(forward).getByText('Forward')).toBeInTheDocument()
    expect(within(forward).getByText('251.3')).toBeInTheDocument()
    expect(within(forward).getByText('1/1')).toBeInTheDocument()
    expect(within(forward).getByText(/\+1 pending/)).toBeInTheDocument()
    const backfill = screen.getByTestId('summary-max_projection_backfill')
    expect(within(backfill).getByText('Backfill')).toBeInTheDocument()
  })

  it('shows each night: score, DNPs, estimated percentile, cash badge, pending nights and the lineup', async () => {
    renderPage()
    const scored = await screen.findByTestId('night-2026-11-07')
    expect(within(scored).getByText('251.3')).toBeInTheDocument()
    expect(within(scored).getByText('71%')).toBeInTheDocument()
    expect(within(scored).getByText('Cashed')).toBeInTheDocument()
    expect(within(scored).getByText(/Entered: cash line 245.0, winning score 330.0/)).toBeInTheDocument()

    fireEvent.click(within(scored).getByRole('button', { name: 'Lineup' }))
    const lineup = within(scored).getByRole('table', { name: 'Max projection lineup' })
    expect(within(lineup).getByText('Beta Two')).toBeInTheDocument()
    expect(within(lineup).getByText('DNP')).toBeInTheDocument()

    const pending = screen.getByTestId('night-2026-11-08')
    expect(within(pending).getByText('Awaiting box scores')).toBeInTheDocument()
    expect(within(pending).getByText(/Cash line not entered: field percentiles are estimates/)).toBeInTheDocument()

    expect(within(screen.getByTestId('night-2026-10-21')).getByText('Not forward')).toBeInTheDocument()
  })

  it('hiding backfill asks for forward picks only', async () => {
    renderPage()
    await screen.findByTestId('summary-max_projection')
    fireEvent.click(screen.getByRole('switch'))
    await waitFor(() => expect(pickLogAPI.getReport).toHaveBeenLastCalledWith({ forward: true }))
  })

  it('saves the real cash line and winning score for a night', async () => {
    pickLogAPI.saveNight.mockResolvedValue({ data: { success: true } })
    renderPage()
    const night = await screen.findByTestId('night-2026-11-08')
    const form = within(night).getByRole('form', { name: 'Contest results 2026-11-08' })
    fireEvent.change(within(form).getByLabelText('Cash line'), { target: { value: '262.5' } })
    fireEvent.change(within(form).getByLabelText('Winning score'), { target: { value: '355' } })
    fireEvent.click(within(form).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(pickLogAPI.saveNight).toHaveBeenCalledWith({
      site: 'draftkings', slateId: '30148', gameDate: '2026-11-08', cashLine: 262.5, winningScore: 355,
    }))
    expect(await screen.findByText('Saved contest results for 2026-11-08')).toBeInTheDocument()
    expect(pickLogAPI.getReport).toHaveBeenCalledTimes(2)
  })

  it('rejects a non-numeric score without calling the API', async () => {
    renderPage()
    const night = await screen.findByTestId('night-2026-11-08')
    const form = within(night).getByRole('form', { name: 'Contest results 2026-11-08' })
    fireEvent.change(within(form).getByLabelText('Cash line'), { target: { value: 'lots' } })
    fireEvent.click(within(form).getByRole('button', { name: 'Save' }))
    expect(await within(form).findByRole('alert')).toHaveTextContent('positive numbers')
    expect(pickLogAPI.saveNight).not.toHaveBeenCalled()
  })

  it('log now reports each picker; a locked slate error is shown', async () => {
    pickLogAPI.logNow.mockResolvedValueOnce({ data: { slateId: '30160', slateDate: '2026-11-09', results: [{ source: 'max_projection', status: 'logged' }] } })
    renderPage()
    await screen.findByTestId('summary-max_projection')
    fireEvent.click(screen.getByRole('button', { name: 'Log picks now' }))
    expect(await screen.findByText(/Slate 30160 \(2026-11-09\) — Max projection: logged/)).toBeInTheDocument()

    pickLogAPI.logNow.mockRejectedValueOnce({ response: { data: { error: 'Slate 30160 locked at 2026-11-10T00:00:00.000Z; picks are only logged before lock' } } })
    fireEvent.click(screen.getByRole('button', { name: 'Log picks now' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('picks are only logged before lock')
  })

  it('score now reports counts', async () => {
    pickLogAPI.score.mockResolvedValue({ data: { scored: 2, pending: 1, errors: [] } })
    renderPage()
    await screen.findByTestId('summary-max_projection')
    fireEvent.click(screen.getByRole('button', { name: 'Score now' }))
    expect(await screen.findByText('Scored 2, still pending 1')).toBeInTheDocument()
  })

  it('empty log and load errors', async () => {
    pickLogAPI.getReport.mockResolvedValueOnce({ data: { nights: [], summary: [], sources: ['max_projection'] } })
    const { unmount } = renderPage()
    expect(await screen.findByText('No picks logged yet')).toBeInTheDocument()
    unmount()
    pickLogAPI.getReport.mockRejectedValueOnce({ message: 'Network Error' })
    renderPage()
    expect(await screen.findByRole('alert')).toHaveTextContent('Couldn’t load the model log: Network Error')
  })
})
