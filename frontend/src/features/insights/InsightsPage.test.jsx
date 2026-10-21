import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import InsightsPage from './InsightsPage'
import { historicalAPI, playersAPI } from '../../services/api'
import { useSlate } from '../../context/SlateContext'

vi.mock('../../services/api', () => ({
  playersAPI: { getBySlateId: vi.fn() },
  historicalAPI: {
    getSummary: vi.fn(),
    getSlateInsights: vi.fn(),
    getUsageBumps: vi.fn(),
    getMissingPlayers: vi.fn(),
    getHotStreaks: vi.fn(),
    getColdStreaks: vi.fn(),
    getConsistencyLeaders: vi.fn(),
    getBoomBustPlayers: vi.fn(),
  },
}))
vi.mock('../../context/SlateContext', () => ({ useSlate: vi.fn() }))

const slateContext = (slate) => ({
  slate,
  slateId: slate?.slate_id ?? null,
  site: 'fanduel',
  siteConfig: { key: 'fanduel', name: 'FanDuel' },
  loadingSlates: false,
})

const SUMMARY = { totalGames: 7000, uniquePlayers: 400, dateRange: { earliest: '2026-10-01', latest: '2026-10-20' } }

const renderPage = () =>
  render(
    <MemoryRouter>
      <InsightsPage />
    </MemoryRouter>,
  )

beforeEach(() => {
  vi.clearAllMocks()
  useSlate.mockReturnValue(slateContext({ slate_id: 's1', name: 'Main' }))
  playersAPI.getBySlateId.mockResolvedValue({ data: [{ name: 'Nikola Jokic', team: 'DEN', opponent: 'LAL' }] })
  historicalAPI.getSummary.mockResolvedValue({ data: { summary: SUMMARY } })
  historicalAPI.getSlateInsights.mockResolvedValue({
    data: { insights: { hotStreaks: [{ name: 'Nikola Jokic', team: 'DEN', opponent: 'LAL', hotStreakPct: 22.5, last3Avg: 70 }] } },
  })
  historicalAPI.getUsageBumps.mockResolvedValue({ data: { usageBumps: [] } })
  historicalAPI.getMissingPlayers.mockRejectedValue({ response: { data: { error: 'missing-players exploded' } } })
  historicalAPI.getHotStreaks.mockResolvedValue({ data: { hotStreaks: [{ player_key: 'k', player_name: 'League Heater', team: 'OKC', hot_streak_pct: 30 }] } })
  historicalAPI.getColdStreaks.mockResolvedValue({ data: { coldStreaks: [] } })
  historicalAPI.getConsistencyLeaders.mockResolvedValue({ data: { leaders: [] } })
  historicalAPI.getBoomBustPlayers.mockResolvedValue({ data: { players: [] } })
})

describe('InsightsPage', () => {
  it('renders slate cards with per-card errors and loads league trends only when their tab opens', async () => {
    renderPage()
    expect(await screen.findByText('+22.5%')).toBeInTheDocument()
    expect(screen.getByText('7,000 games · 400 players · 2026-10-01 to 2026-10-20')).toBeInTheDocument()
    expect(await screen.findByText('missing-players exploded')).toBeInTheDocument()
    expect(screen.getByText('No teammate bumps from tonight’s missing regulars.')).toBeInTheDocument()
    expect(historicalAPI.getSlateInsights).toHaveBeenCalledWith(
      [expect.objectContaining({ name: 'Nikola Jokic', team: 'DEN' })],
      { site: 'fanduel', slateId: 's1' },
    )
    expect(historicalAPI.getHotStreaks).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('tab', { name: 'League trends' }))
    expect(await screen.findByText('League Heater')).toBeInTheDocument()
    expect(historicalAPI.getHotStreaks).toHaveBeenCalledWith(15, 5, { site: 'fanduel' })

    fireEvent.click(screen.getByRole('tab', { name: 'Tonight’s slate' }))
    fireEvent.click(screen.getByRole('tab', { name: 'League trends' }))
    expect(historicalAPI.getHotStreaks).toHaveBeenCalledTimes(1)
  })

  it('refetches with the chosen window', async () => {
    renderPage()
    await screen.findByText('+22.5%')
    fireEvent.change(screen.getByLabelText('Date window'), { target: { value: 'last14' } })
    await waitFor(() =>
      expect(historicalAPI.getSlateInsights).toHaveBeenLastCalledWith(expect.any(Array), { lastNDays: 14, site: 'fanduel', slateId: 's1' }),
    )
    expect(historicalAPI.getSummary).toHaveBeenLastCalledWith({ lastNDays: 14 })
  })

  it('links to data status when there is no historical data', async () => {
    historicalAPI.getSummary.mockResolvedValue({ data: { summary: { totalGames: 0, uniquePlayers: 0, dateRange: {} } } })
    renderPage()
    expect(await screen.findByText('No historical game logs')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Open data status & sync' })).toHaveAttribute('href', '/data-status')
  })

  it('asks for a slate when none is selected but still offers league trends', async () => {
    useSlate.mockReturnValue(slateContext(null))
    renderPage()
    expect(await screen.findByText('No slate selected')).toBeInTheDocument()
    expect(playersAPI.getBySlateId).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('tab', { name: 'League trends' }))
    expect(await screen.findByText('League Heater')).toBeInTheDocument()
  })

  it('shows a summary error instead of only logging it', async () => {
    historicalAPI.getSummary.mockRejectedValue(new Error('Network Error'))
    renderPage()
    expect(await screen.findByText('Couldn’t load the historical summary: Network Error')).toBeInTheDocument()
  })
})
