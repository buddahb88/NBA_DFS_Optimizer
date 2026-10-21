import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import useInsights from './useInsights'
import { historicalAPI, playersAPI } from '../../services/api'

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

const PLAYERS = [
  { id: 1, player_id: 'p1', name: 'Nikola Jokic', team: 'DEN', opponent: 'LAL', position: 'C', salary: 11800, projected_points: 60, projected_minutes: 36, rostership: 30, raw_data: '{}' },
]
const TRIMMED = [
  { name: 'Nikola Jokic', team: 'DEN', opponent: 'LAL', position: 'C', salary: 11800, projected_points: 60, projected_minutes: 36 },
]
const SUMMARY = { totalGames: 7000, uniquePlayers: 400, dateRange: { earliest: '2026-10-01', latest: '2026-10-20' } }
const INSIGHTS = { hotStreaks: [{ name: 'Nikola Jokic', team: 'DEN', hotStreakPct: 0 }], coldStreaks: [] }

const deferred = () => {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const DEFAULT_ARGS = { slateId: 's1', site: 'fanduel', dateWindow: { mode: 'last30' }, leagueEnabled: false }

beforeEach(() => {
  vi.clearAllMocks()
  playersAPI.getBySlateId.mockResolvedValue({ data: PLAYERS })
  historicalAPI.getSummary.mockResolvedValue({ data: { summary: SUMMARY } })
  historicalAPI.getSlateInsights.mockResolvedValue({ data: { insights: INSIGHTS } })
  historicalAPI.getUsageBumps.mockResolvedValue({ data: { usageBumps: [{ player: 'A', team: 'DEN', missingPlayer: 'B' }] } })
  historicalAPI.getMissingPlayers.mockResolvedValue({ data: { report: [{ team: 'DEN', missingPlayers: [] }] } })
  historicalAPI.getHotStreaks.mockResolvedValue({ data: { hotStreaks: [{ player_key: 'a' }] } })
  historicalAPI.getColdStreaks.mockResolvedValue({ data: { coldStreaks: [] } })
  historicalAPI.getConsistencyLeaders.mockResolvedValue({ data: { leaders: [{ player_key: 'b' }] } })
  historicalAPI.getBoomBustPlayers.mockResolvedValue({ data: { players: [{ player_key: 'c' }] } })
})

describe('useInsights', () => {
  it('loads summary and slate cards with the trimmed payload, site and window', async () => {
    const { result } = renderHook(() => useInsights(DEFAULT_ARGS))
    expect(result.current.summary.status).toBe('loading')
    expect(result.current.slate.status).toBe('loading')

    await waitFor(() => expect(result.current.missing.status).toBe('ready'))
    expect(result.current.summary.data).toEqual(SUMMARY)
    expect(result.current.slate.data).toEqual(INSIGHTS)
    expect(result.current.usageBumps.data).toHaveLength(1)
    expect(result.current.playerCount).toBe(1)

    const params = { lastNDays: 30, site: 'fanduel', slateId: 's1' }
    expect(historicalAPI.getSummary).toHaveBeenCalledWith({ lastNDays: 30 })
    expect(historicalAPI.getSlateInsights).toHaveBeenCalledWith(TRIMMED, params)
    expect(historicalAPI.getUsageBumps).toHaveBeenCalledWith(TRIMMED, 8, 25, params)
    expect(historicalAPI.getMissingPlayers).toHaveBeenCalledWith(TRIMMED, 5, 20, params)
    // League trends wait for their tab
    expect(historicalAPI.getHotStreaks).not.toHaveBeenCalled()
    expect(result.current.league.hotStreaks.status).toBe('idle')
  })

  it('fires the slate requests in parallel and updates each card as it lands', async () => {
    const insights = deferred()
    historicalAPI.getSlateInsights.mockReturnValue(insights.promise)
    const { result } = renderHook(() => useInsights(DEFAULT_ARGS))

    await waitFor(() => expect(result.current.usageBumps.status).toBe('ready'))
    expect(historicalAPI.getMissingPlayers).toHaveBeenCalled()
    expect(result.current.slate.status).toBe('loading')

    await act(async () => insights.resolve({ data: { insights: INSIGHTS } }))
    expect(result.current.slate.status).toBe('ready')
  })

  it('lazy-loads league trends once enabled and caches them per site and window', async () => {
    const { result, rerender } = renderHook((args) => useInsights(args), { initialProps: DEFAULT_ARGS })
    await waitFor(() => expect(result.current.missing.status).toBe('ready'))

    rerender({ ...DEFAULT_ARGS, leagueEnabled: true })
    await waitFor(() => expect(result.current.league.boomBustPlayers.status).toBe('ready'))
    const params = { lastNDays: 30, site: 'fanduel' }
    expect(historicalAPI.getHotStreaks).toHaveBeenCalledWith(15, 5, params)
    expect(historicalAPI.getColdStreaks).toHaveBeenCalledWith(15, 5, params)
    expect(historicalAPI.getConsistencyLeaders).toHaveBeenCalledWith(15, 8, params)
    expect(historicalAPI.getBoomBustPlayers).toHaveBeenCalledWith(15, 8, params)
    expect(result.current.league.hotStreaks.data).toEqual([{ player_key: 'a' }])
    expect(result.current.league.coldStreaks.data).toEqual([])

    // Leaving and re-opening the tab, or switching slates, does not refetch
    rerender({ ...DEFAULT_ARGS, leagueEnabled: false })
    rerender({ ...DEFAULT_ARGS, slateId: 's2', leagueEnabled: true })
    await waitFor(() => expect(playersAPI.getBySlateId).toHaveBeenCalledWith('s2'))
    expect(historicalAPI.getHotStreaks).toHaveBeenCalledTimes(1)

    // A new window does
    rerender({ ...DEFAULT_ARGS, dateWindow: { mode: 'last14' }, leagueEnabled: true })
    await waitFor(() => expect(historicalAPI.getHotStreaks).toHaveBeenCalledTimes(2))
    expect(historicalAPI.getHotStreaks).toHaveBeenLastCalledWith(15, 5, { lastNDays: 14, site: 'fanduel' })
  })

  it('reports errors per card', async () => {
    historicalAPI.getUsageBumps.mockRejectedValue({ response: { data: { error: 'lastNDays must be a positive integer' } } })
    historicalAPI.getSummary.mockRejectedValue(new Error('Network Error'))
    const { result } = renderHook(() => useInsights(DEFAULT_ARGS))

    await waitFor(() => expect(result.current.usageBumps.status).toBe('error'))
    expect(result.current.usageBumps.error).toBe('lastNDays must be a positive integer')
    await waitFor(() => expect(result.current.summary.status).toBe('error'))
    expect(result.current.summary.error).toBe('Network Error')
    await waitFor(() => expect(result.current.slate.status).toBe('ready'))
    expect(result.current.missing.status).toBe('ready')
  })

  it('fails every slate card when the player pool cannot load', async () => {
    playersAPI.getBySlateId.mockRejectedValue(new Error('Slate not found'))
    const { result } = renderHook(() => useInsights(DEFAULT_ARGS))
    await waitFor(() => expect(result.current.slate.status).toBe('error'))
    for (const key of ['slate', 'usageBumps', 'missing']) {
      expect(result.current[key]).toMatchObject({ status: 'error', error: 'Slate not found' })
    }
    expect(historicalAPI.getSlateInsights).not.toHaveBeenCalled()
  })

  it('leaves slate cards idle without a slate and empty for an empty slate', async () => {
    const { result, rerender } = renderHook((args) => useInsights(args), { initialProps: { ...DEFAULT_ARGS, slateId: null } })
    await waitFor(() => expect(result.current.summary.status).toBe('ready'))
    expect(result.current.slate.status).toBe('idle')
    expect(playersAPI.getBySlateId).not.toHaveBeenCalled()

    playersAPI.getBySlateId.mockResolvedValue({ data: [] })
    rerender({ ...DEFAULT_ARGS, slateId: 's3' })
    await waitFor(() => expect(result.current.slate.status).toBe('ready'))
    expect(result.current.slate.data).toBeNull()
    expect(result.current.usageBumps.data).toEqual([])
    expect(historicalAPI.getSlateInsights).not.toHaveBeenCalled()
  })

  it('drops responses from a superseded request', async () => {
    const first = deferred()
    historicalAPI.getSlateInsights.mockReturnValueOnce(first.promise)
    const { result, rerender } = renderHook((args) => useInsights(args), { initialProps: DEFAULT_ARGS })
    await waitFor(() => expect(historicalAPI.getSlateInsights).toHaveBeenCalledTimes(1))

    rerender({ ...DEFAULT_ARGS, dateWindow: { mode: 'last14' } })
    await waitFor(() => expect(result.current.slate.status).toBe('ready'))
    await act(async () => first.resolve({ data: { insights: { hotStreaks: ['stale'] } } }))
    expect(result.current.slate.data).toEqual(INSIGHTS)
  })

  it('reload refetches the open sections', async () => {
    const { result } = renderHook(() => useInsights({ ...DEFAULT_ARGS, leagueEnabled: true }))
    await waitFor(() => expect(result.current.league.hotStreaks.status).toBe('ready'))
    await waitFor(() => expect(result.current.missing.status).toBe('ready'))

    act(() => result.current.reload())
    await waitFor(() => expect(historicalAPI.getHotStreaks).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(historicalAPI.getSlateInsights).toHaveBeenCalledTimes(2))
    expect(historicalAPI.getSummary).toHaveBeenCalledTimes(2)
  })
})
