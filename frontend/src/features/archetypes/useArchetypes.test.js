import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import useArchetypes from './useArchetypes'
import { archetypesAPI, historicalAPI } from '../../services/api'

vi.mock('../../services/api', () => ({
  historicalAPI: { getSeasons: vi.fn() },
  archetypesAPI: {
    getDefinitions: vi.fn(),
    getDefense: vi.fn(),
    getCellGames: vi.fn(),
    getTonight: vi.fn(),
  },
}))

const DEFINITIONS = { archetypes: [{ key: 'scoring_guard', label: 'Scoring Guard / Wing', description: 'Scores' }], positions: [] }
const SEASONS = { current: '2026-27', seasons: [{ value: '2026-27', current: true }, { value: '2025-26', current: false }] }
const DEFENSE = { season: '2026-27', site: 'fanduel', grouping: 'archetype', source: 'precomputed', rows: [{ team: 'NYK', group_key: 'scoring_guard', fp_over_expectation: 2 }] }
const TONIGHT = { slatePlayers: 10, matchedPlayers: 8, players: [{ player_id: '1', name: 'Guard One', matchup_delta: 2 }] }
const GAMES = { summary: { player_games: 2 }, games: [{ game_id: 'g1', player_key: 'a' }] }

const FILTERS = { season: '', grouping: 'archetype', lastNGames: '', stat: 'fp' }
const ARGS = { site: 'fanduel', slateId: 's1', filters: FILTERS }

beforeEach(() => {
  vi.clearAllMocks()
  archetypesAPI.getDefinitions.mockResolvedValue({ data: DEFINITIONS })
  historicalAPI.getSeasons.mockResolvedValue({ data: SEASONS })
  archetypesAPI.getDefense.mockResolvedValue({ data: DEFENSE })
  archetypesAPI.getTonight.mockResolvedValue({ data: TONIGHT })
  archetypesAPI.getCellGames.mockResolvedValue({ data: GAMES })
})

describe('useArchetypes', () => {
  it('loads definitions, seasons, the defense grid and tonight with site and filters', async () => {
    const { result } = renderHook(() => useArchetypes(ARGS))
    expect(result.current.defense.status).toBe('loading')

    await waitFor(() => expect(result.current.tonight.status).toBe('ready'))
    await waitFor(() => expect(result.current.defense.status).toBe('ready'))
    expect(result.current.definitions.data).toEqual(DEFINITIONS)
    expect(result.current.seasons.data).toEqual(SEASONS)
    expect(result.current.defense.data).toEqual(DEFENSE)
    expect(result.current.tonight.data).toEqual(TONIGHT)

    expect(archetypesAPI.getDefense).toHaveBeenCalledWith({ grouping: 'archetype', site: 'fanduel' })
    expect(archetypesAPI.getTonight).toHaveBeenCalledWith({ grouping: 'archetype', site: 'fanduel', slateId: 's1', stat: 'fp' })
  })

  it('refetches for new filters, but a stat change only refetches tonight', async () => {
    const { result, rerender } = renderHook((props) => useArchetypes(props), { initialProps: ARGS })
    await waitFor(() => expect(result.current.tonight.status).toBe('ready'))

    rerender({ ...ARGS, filters: { ...FILTERS, stat: 'reb' } })
    await waitFor(() => expect(archetypesAPI.getTonight).toHaveBeenCalledTimes(2))
    expect(archetypesAPI.getDefense).toHaveBeenCalledTimes(1)
    expect(archetypesAPI.getTonight).toHaveBeenLastCalledWith(expect.objectContaining({ stat: 'reb' }))

    rerender({ ...ARGS, filters: { ...FILTERS, stat: 'reb', season: '2025-26', grouping: 'position', lastNGames: '10' } })
    await waitFor(() => expect(archetypesAPI.getDefense).toHaveBeenCalledTimes(2))
    expect(archetypesAPI.getDefense).toHaveBeenLastCalledWith({ season: '2025-26', grouping: 'position', lastNGames: 10, site: 'fanduel' })
  })

  it('skips tonight without a slate', async () => {
    const { result } = renderHook(() => useArchetypes({ ...ARGS, slateId: null }))
    await waitFor(() => expect(result.current.defense.status).toBe('ready'))
    expect(result.current.tonight.status).toBe('idle')
    expect(archetypesAPI.getTonight).not.toHaveBeenCalled()
  })

  it('reports errors per section', async () => {
    archetypesAPI.getDefense.mockRejectedValue({ response: { data: { error: 'season must look like 2025-26' } } })
    const { result } = renderHook(() => useArchetypes(ARGS))
    await waitFor(() => expect(result.current.defense.status).toBe('error'))
    expect(result.current.defense.error).toBe('season must look like 2025-26')
    await waitFor(() => expect(result.current.tonight.status).toBe('ready'))
  })

  it('opens a cell drill-down with the grid filters and closes it', async () => {
    const { result } = renderHook(() => useArchetypes({ ...ARGS, filters: { ...FILTERS, lastNGames: '5' } }))
    await waitFor(() => expect(result.current.defense.status).toBe('ready'))

    act(() => result.current.openCell({ team: 'NYK', group: 'scoring_guard', label: 'Scoring Guard / Wing' }))
    expect(result.current.cell).toMatchObject({ team: 'NYK', group: 'scoring_guard', status: 'loading' })
    await waitFor(() => expect(result.current.cell.status).toBe('ready'))
    expect(result.current.cell.data).toEqual(GAMES)
    expect(archetypesAPI.getCellGames).toHaveBeenCalledWith('NYK', 'scoring_guard', { grouping: 'archetype', lastNGames: 5, site: 'fanduel' })

    act(() => result.current.closeCell())
    expect(result.current.cell).toBeNull()
  })

  it('ignores a drill-down response for a cell that was closed', async () => {
    let resolve
    archetypesAPI.getCellGames.mockReturnValue(new Promise((r) => { resolve = r }))
    const { result } = renderHook(() => useArchetypes(ARGS))
    act(() => result.current.openCell({ team: 'NYK', group: 'scoring_guard' }))
    act(() => result.current.closeCell())
    await act(async () => resolve({ data: GAMES }))
    expect(result.current.cell).toBeNull()
  })

  it('reload refetches the grid and tonight', async () => {
    const { result } = renderHook(() => useArchetypes(ARGS))
    await waitFor(() => expect(result.current.tonight.status).toBe('ready'))
    act(() => result.current.reload())
    await waitFor(() => expect(archetypesAPI.getDefense).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(archetypesAPI.getTonight).toHaveBeenCalledTimes(2))
  })
})
