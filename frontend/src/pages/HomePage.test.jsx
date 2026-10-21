import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import HomePage from './HomePage'
import useSlateDashboard from './home/useSlateDashboard'
import { useSlate } from '../context/SlateContext'

vi.mock('./home/useSlateDashboard', () => ({ default: vi.fn() }))
vi.mock('../context/SlateContext', () => ({ useSlate: vi.fn() }))

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
