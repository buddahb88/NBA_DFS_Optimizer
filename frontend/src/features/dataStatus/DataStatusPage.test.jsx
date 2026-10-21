import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import DataStatusPage from './DataStatusPage'
import { POLL_MS } from './useDataStatus'
import { historicalAPI } from '../../services/api'

vi.mock('../../services/api', () => ({
  historicalAPI: {
    getDataStatus: vi.fn(),
    getSyncStatus: vi.fn(),
    startIncrementalSync: vi.fn(),
    backfillSeason: vi.fn(),
  },
}))

const run = (o) => ({ source: 'espn', season: '2026-27', started_at: '2026-10-21T10:00:00Z', finished_at: '2026-10-21T10:01:05Z', games_inserted: 4, error: null, status: 'complete', ...o })

const STATUS = {
  success: true,
  currentSeason: '2026-27',
  coverage: {
    error: null,
    seasons: [
      { season: '2026-27', current: true, games: 3, playerGames: 68, players: 68, earliestGame: '2026-10-20', latestGame: '2026-10-20' },
      { season: '2025-26', current: false, games: 0, playerGames: 0, players: 0, earliestGame: null, latestGame: null },
      { season: '2024-25', current: false, games: 1321, playerGames: 28348, players: 575, earliestGame: '2024-10-22', latestGame: '2025-06-22' },
    ],
    totals: { games: 1324, playerGames: 28416, players: 590, earliestGame: '2024-10-22', latestGame: '2026-10-20' },
  },
  sync: {
    error: null,
    isSyncing: false,
    lastRun: run({ id: 9 }),
    lastSuccess: run({ id: 9 }),
    lastError: run({ id: 7, season: '2025-26', status: 'error', error: '2 failed (first: 2026-01-01 g9: HTTP 500)' }),
    recentRuns: [run({ id: 9 }), run({ id: 7, season: '2025-26', status: 'error', error: '2 failed (first: 2026-01-01 g9: HTTP 500)' })],
  },
  snapshots: {
    error: null,
    rows: 4,
    slates: 3,
    players: 2,
    gameDates: 2,
    earliestGameDate: '2026-10-20',
    latestGameDate: '2026-10-21',
    lastCapturedAt: '2026-10-21 18:00:00',
    bySite: [{ site: 'draftkings', rows: 3, slates: 2, gameDates: 2, latestGameDate: '2026-10-21' }],
  },
}

const renderPage = () =>
  render(
    <MemoryRouter>
      <DataStatusPage />
    </MemoryRouter>,
  )

beforeEach(() => {
  vi.clearAllMocks()
  historicalAPI.getDataStatus.mockResolvedValue({ data: STATUS })
})
afterEach(() => vi.useRealTimers())

const coverageRow = (season) => screen.getByRole('button', { name: `Backfill ${season}` }).closest('tr')

describe('DataStatusPage', () => {
  it('shows coverage by season, the last sync run and error, and snapshot coverage', async () => {
    renderPage()
    expect(await screen.findByText('Game logs by season')).toBeInTheDocument()

    const current = within(coverageRow('2026-27'))
    expect(current.getByText('Current')).toBeInTheDocument()
    expect(current.getAllByText('68')).toHaveLength(2) // player games and players
    expect(within(coverageRow('2025-26')).getByText('No games')).toBeInTheDocument()
    expect(within(coverageRow('2024-25')).getByText('2024-10-22 → 2025-06-22')).toBeInTheDocument()
    expect(screen.getByText('28,416')).toBeInTheDocument()

    expect(screen.getByText('Last error')).toBeInTheDocument()
    expect(screen.getAllByText(/HTTP 500/).length).toBeGreaterThan(0)
    expect(screen.getByText('#9')).toBeInTheDocument()
    expect(screen.getAllByText('1m 05s')).toHaveLength(2) // both runs in the table

    expect(screen.getByText(/4 player rows · 3 slates · 2 players/)).toBeInTheDocument()
    expect(screen.getByText('draftkings')).toBeInTheDocument()
  })

  it('shows a failed section instead of hiding it', async () => {
    historicalAPI.getDataStatus.mockResolvedValue({
      data: { ...STATUS, sync: { error: 'no such table: sync_runs' }, snapshots: { error: 'no such table: slate_player_snapshots' } },
    })
    renderPage()
    expect(await screen.findByText('Couldn’t load sync history: no such table: sync_runs')).toBeInTheDocument()
    expect(screen.getByText('Couldn’t load snapshot coverage: no such table: slate_player_snapshots')).toBeInTheDocument()
    expect(screen.getByText('Game logs by season')).toBeInTheDocument()
  })

  it('reports a failed load and retries', async () => {
    historicalAPI.getDataStatus.mockRejectedValueOnce({ response: { data: { error: 'database is locked' } } })
    renderPage()
    expect(await screen.findByText('database is locked')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByText('Game logs by season')).toBeInTheDocument()
    expect(historicalAPI.getDataStatus).toHaveBeenCalledTimes(2)
  })

  it('Sync now runs the incremental sync, polls progress and reports the result', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    historicalAPI.startIncrementalSync.mockResolvedValue({ data: { success: true, runId: 10, upToDate: false } })
    historicalAPI.getSyncStatus
      .mockResolvedValueOnce({ data: { isSyncing: true, progress: { status: 'syncing', message: 'Syncing espn 2026-27: 2 games so far' } } })
      .mockResolvedValueOnce({ data: { isSyncing: false, progress: { status: 'complete', message: 'Synced 4 games (espn 2026-27) in 3.0s' } } })
    renderPage()
    await screen.findByText('Game logs by season')

    fireEvent.click(screen.getByRole('button', { name: 'Sync now' }))
    await waitFor(() => expect(historicalAPI.startIncrementalSync).toHaveBeenCalledTimes(1))
    expect(await screen.findByText('Sync running…')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Backfill 2024-25' })).toBeDisabled()

    await act(() => vi.advanceTimersByTimeAsync(POLL_MS))
    expect(await screen.findByText('Syncing espn 2026-27: 2 games so far')).toBeInTheDocument()

    await act(() => vi.advanceTimersByTimeAsync(POLL_MS))
    expect(await screen.findByText('Synced 4 games (espn 2026-27) in 3.0s')).toBeInTheDocument()
    await waitFor(() => expect(historicalAPI.getDataStatus).toHaveBeenCalledTimes(2))
    expect(screen.getByRole('button', { name: 'Sync now' })).toBeEnabled()
  })

  it('a sync that ends in error is shown as a failure', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    historicalAPI.startIncrementalSync.mockResolvedValue({ data: { success: true, runId: 10 } })
    historicalAPI.getSyncStatus.mockResolvedValue({ data: { isSyncing: false, progress: { status: 'error', error: 'ESPN scoreboard HTTP 503' } } })
    renderPage()
    await screen.findByText('Game logs by season')

    fireEvent.click(screen.getByRole('button', { name: 'Sync now' }))
    await screen.findByText('Sync running…')
    await act(() => vi.advanceTimersByTimeAsync(POLL_MS))
    expect(await screen.findByRole('alert')).toHaveTextContent('Sync failed: ESPN scoreboard HTTP 503')
  })

  it('says when there is nothing to sync', async () => {
    historicalAPI.startIncrementalSync.mockResolvedValue({ data: { success: true, runId: null, upToDate: true } })
    renderPage()
    await screen.findByText('Game logs by season')
    fireEvent.click(screen.getByRole('button', { name: 'Sync now' }))
    expect(await screen.findByText(/already up to date/)).toBeInTheDocument()
    expect(historicalAPI.getSyncStatus).not.toHaveBeenCalled()
  })

  it('shows a sync that fails to start', async () => {
    historicalAPI.startIncrementalSync.mockRejectedValue({ response: { status: 500, data: { error: 'database is locked' } } })
    renderPage()
    await screen.findByText('Game logs by season')
    fireEvent.click(screen.getByRole('button', { name: 'Sync now' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Couldn’t start the sync: database is locked')
    expect(screen.getByRole('button', { name: 'Sync now' })).toBeEnabled()
  })

  it('follows a sync that is already running (409)', async () => {
    historicalAPI.startIncrementalSync.mockRejectedValue({
      response: { status: 409, data: { error: 'Sync already in progress', progress: { message: 'Syncing espn-scheduled 2026-27: 1 games so far' } } },
    })
    historicalAPI.getSyncStatus.mockResolvedValue({ data: { isSyncing: true, progress: { status: 'syncing' } } })
    renderPage()
    await screen.findByText('Game logs by season')
    fireEvent.click(screen.getByRole('button', { name: 'Sync now' }))
    expect(await screen.findByText('Sync running…')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Syncing…/ })).toBeDisabled()
  })

  it('picks up a sync already running when the page opens', async () => {
    historicalAPI.getDataStatus.mockResolvedValue({ data: { ...STATUS, sync: { ...STATUS.sync, isSyncing: true } } })
    historicalAPI.getSyncStatus.mockResolvedValue({ data: { isSyncing: true, progress: { status: 'syncing' } } })
    renderPage()
    expect(await screen.findByText('Sync running…')).toBeInTheDocument()
  })

  it('backfills a single season', async () => {
    historicalAPI.backfillSeason.mockResolvedValue({ data: { success: true, runId: 11 } })
    historicalAPI.getSyncStatus.mockResolvedValue({ data: { isSyncing: true, progress: { status: 'syncing' } } })
    renderPage()
    await screen.findByText('Game logs by season')
    fireEvent.click(screen.getByRole('button', { name: 'Backfill 2025-26' }))
    await waitFor(() => expect(historicalAPI.backfillSeason).toHaveBeenCalledWith('2025-26'))
    expect(historicalAPI.startIncrementalSync).not.toHaveBeenCalled()
    expect(await screen.findByText('Sync running…')).toBeInTheDocument()
  })
})
