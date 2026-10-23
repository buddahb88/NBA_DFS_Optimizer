import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import HomePage from './HomePage'
import useSlateDashboard from './home/useSlateDashboard'
import { useSlate } from '../context/SlateContext'

vi.mock('./home/useSlateDashboard', () => ({ default: vi.fn() }))
vi.mock('../context/SlateContext', () => ({ useSlate: vi.fn() }))
vi.mock('../services/api', () => ({ slatesAPI: { getAvailableSlates: vi.fn(() => new Promise(() => {})) } }))

const dashboard = (overrides = {}) => ({
  status: 'ready',
  error: null,
  slate: { slate_id: 's1', name: 'Main', updated_at: '2026-10-21T17:00:00Z' },
  players: [],
  teamStats: null,
  historyStatus: { hasData: true, latestGame: '2026-10-20', needsUpdate: false },
  news: { loading: false, error: null, missing: [], bumps: [] },
  syncing: false,
  syncError: null,
  reload: vi.fn(),
  syncSlate: vi.fn(),
  refresh: vi.fn(),
  ...overrides,
})

const renderHome = () =>
  render(
    <MemoryRouter>
      <HomePage />
    </MemoryRouter>,
  )

beforeEach(() => {
  vi.clearAllMocks()
  useSlate.mockReturnValue({ site: 'draftkings', siteConfig: { key: 'draftkings', name: 'DraftKings' } })
})

describe('HomePage game log health', () => {
  it('links to Data Status when game logs are missing', () => {
    useSlateDashboard.mockReturnValue(dashboard({ historyStatus: { hasData: false } }))
    renderHome()
    expect(screen.getByText('Game logs: not synced')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Sync game logs' })).toHaveAttribute('href', '/data-status')
  })

  it('links to Data Status when game logs are stale or their status failed', () => {
    useSlateDashboard.mockReturnValue(dashboard({ historyStatus: { hasData: true, latestGame: '2026-10-10', needsUpdate: true } }))
    const { unmount } = renderHome()
    expect(screen.getByText('Game logs through 2026-10-10')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Update' })).toHaveAttribute('href', '/data-status')
    unmount()

    useSlateDashboard.mockReturnValue(dashboard({ historyStatus: { error: 'Network Error' } }))
    renderHome()
    expect(screen.getByRole('link', { name: 'Check data status' })).toHaveAttribute('href', '/data-status')
  })

  it('shows no link when game logs are current', () => {
    useSlateDashboard.mockReturnValue(dashboard())
    renderHome()
    expect(screen.getByText('Game logs through 2026-10-20')).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /sync game logs|update|check data status/i })).toBeNull()
  })

  it('points to Data Status from the no-slate screen', () => {
    useSlateDashboard.mockReturnValue(dashboard({ status: 'empty', slate: null, historyStatus: null }))
    renderHome()
    expect(screen.getByRole('link', { name: 'Data Status' })).toHaveAttribute('href', '/data-status')
  })
})

describe('HomePage stale slate', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-23T16:00:00Z'))
  })
  afterEach(() => vi.useRealTimers())

  it('cautions that the slate is from an earlier night and opens the slate loader to sync', () => {
    useSlateDashboard.mockReturnValue(dashboard({ slate: { slate_id: '29805', name: 'All', slate_date: '2026-10-21', updated_at: '2026-10-21T21:24:37Z' } }))
    renderHome()
    expect(screen.getByRole('status')).toHaveTextContent("Slate is from Wed, Oct 21 - sync tonight's slate")
    fireEvent.click(screen.getByRole('button', { name: 'Sync slate' }))
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument()
  })

  it("shows no caution for tonight's slate", () => {
    useSlateDashboard.mockReturnValue(dashboard({ slate: { slate_id: '29900', name: 'All', slate_date: '2026-10-23', updated_at: '2026-10-23T15:00:00Z' } }))
    renderHome()
    expect(screen.queryByText(/slate is from/i)).toBeNull()
  })

  it('turns off refresh (re-sync) while the slate selector is on a backtest', () => {
    useSlate.mockReturnValue({ site: 'draftkings', siteConfig: { key: 'draftkings', name: 'DraftKings' }, isBacktest: true })
    useSlateDashboard.mockReturnValue(dashboard())
    renderHome()
    expect(screen.getByRole('button', { name: 'Refresh data' })).toBeDisabled()
  })
})

