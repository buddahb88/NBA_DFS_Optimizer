import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import ArchetypesPage from './ArchetypesPage'
import { archetypesAPI, historicalAPI } from '../../services/api'
import { useSlate } from '../../context/SlateContext'

vi.mock('../../services/api', () => ({
  historicalAPI: { getSeasons: vi.fn() },
  archetypesAPI: { getDefinitions: vi.fn(), getDefense: vi.fn(), getCellGames: vi.fn(), getTonight: vi.fn() },
}))
vi.mock('../../context/SlateContext', () => ({ useSlate: vi.fn() }))

const slateContext = (slate) => ({
  slate,
  slateId: slate?.slate_id ?? null,
  site: 'fanduel',
  siteConfig: { key: 'fanduel', name: 'FanDuel' },
  loadingSlates: false,
})

const DEFINITIONS = {
  archetypes: [{ key: 'scoring_guard', label: 'Scoring Guard / Wing', description: 'Non-center whose role is to score.' }],
  positions: [{ key: 'G', label: 'Guards' }],
}
const DEFENSE = {
  season: '2025-26', grouping: 'archetype', lastNGames: null,
  rows: [{ team: 'NYK', group_key: 'scoring_guard', fp_over_expectation: 2.4, games: 8, player_games: 12 }],
}
const TONIGHT = {
  season: '2025-26', grouping: 'archetype', slatePlayers: 3, matchedPlayers: 2, defenseRows: 1,
  players: [
    { player_id: '1', name: 'Guard One', position: 'PG', team: 'MIA', opponent: 'NYK', label: 'Scoring Guard / Wing', salary: 8000, projected_points: 40, matchup_delta: 2.4, rank: 1, teams: 30 },
    { player_id: '2', name: 'Wing Two', position: 'SF', team: 'BOS', opponent: 'PHX', label: 'Scoring Guard / Wing', salary: 9000, projected_points: 30, matchup_delta: 1.1, rank: 4, teams: 30 },
  ],
}
const GAMES = {
  summary: { games: 8, player_games: 12, avg_fp: 40, avg_expected_fp: 37.6, fp_over_expectation: 2.4 },
  games: [{ game_id: 'g1', player_key: 'a', game_date: '2026-01-05', player_name: 'Some Guard', team: 'MIA', minutes: 33, fp: 45, expected_fp: 38, fp_over_expectation: 7, pts_delta: 3, reb_delta: 1, ast_delta: 0, fg3m_delta: 1 }],
}

const renderPage = () => render(<MemoryRouter><ArchetypesPage /></MemoryRouter>)

beforeEach(() => {
  vi.clearAllMocks()
  useSlate.mockReturnValue(slateContext({ slate_id: 's1', name: 'Main' }))
  historicalAPI.getSeasons.mockResolvedValue({ data: { current: '2026-27', seasons: [{ value: '2026-27', current: true }, { value: '2025-26' }] } })
  archetypesAPI.getDefinitions.mockResolvedValue({ data: DEFINITIONS })
  archetypesAPI.getDefense.mockResolvedValue({ data: DEFENSE })
  archetypesAPI.getTonight.mockResolvedValue({ data: TONIGHT })
  archetypesAPI.getCellGames.mockResolvedValue({ data: GAMES })
})

describe('ArchetypesPage', () => {
  it('renders the heatmap and legend, and drills into a cell', async () => {
    renderPage()
    const cell = await screen.findByRole('button', { name: /NYK vs Scoring Guard \/ Wing: \+2\.4 FP/ })
    expect(screen.getByText('Non-center whose role is to score.')).toBeInTheDocument()

    fireEvent.click(cell)
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('NYK vs Scoring Guard / Wing')).toBeInTheDocument()
    expect(await within(dialog).findByText('Some Guard')).toBeInTheDocument()
    expect(archetypesAPI.getCellGames).toHaveBeenCalledWith('NYK', 'scoring_guard', { grouping: 'archetype', site: 'fanduel' })
  })

  it('passes the position toggle and season filter to the grid', async () => {
    renderPage()
    await screen.findByRole('button', { name: /NYK vs Scoring Guard/ })
    fireEvent.click(screen.getByRole('tab', { name: 'Position (G/F/C)' }))
    expect(archetypesAPI.getDefense).toHaveBeenLastCalledWith({ grouping: 'position', site: 'fanduel' })
    fireEvent.change(await screen.findByLabelText('Season'), { target: { value: '2025-26' } })
    expect(archetypesAPI.getDefense).toHaveBeenLastCalledWith({ season: '2025-26', grouping: 'position', site: 'fanduel' })
  })

  it('points to Data Status when there is no defense data', async () => {
    archetypesAPI.getDefense.mockResolvedValue({ data: { ...DEFENSE, season: '2026-27', rows: [] } })
    renderPage()
    expect(await screen.findByText('No archetype defense data for 2026-27')).toBeInTheDocument()
    expect(screen.getAllByRole('link', { name: /data status/i }).some((a) => a.getAttribute('href') === '/data-status')).toBe(true)
  })

  it('lists tonight’s weak-tier matchups, sortable', async () => {
    renderPage()
    fireEvent.click(screen.getByRole('tab', { name: 'Tonight' }))
    const names = async () => (await screen.findAllByRole('row')).slice(1).map((r) => within(r).getAllByRole('cell')[0].textContent)
    expect(await screen.findByText('Guard One')).toBeInTheDocument()
    expect(await names()).toEqual(['Guard One', 'Wing Two'])
    expect(screen.getByText('$8,000')).toBeInTheDocument()
    expect(screen.getByText('+2.40')).toBeInTheDocument()

    // Numeric columns sort high-to-low first
    fireEvent.click(screen.getByRole('button', { name: 'Salary' }))
    expect(await names()).toEqual(['Wing Two', 'Guard One'])
    fireEvent.click(screen.getByRole('button', { name: 'Salary' }))
    expect(await names()).toEqual(['Guard One', 'Wing Two'])
  })

  it('says when tonight is tiered on last season because the current one is thin', async () => {
    archetypesAPI.getTonight.mockResolvedValue({
      data: { ...TONIGHT, fallback: { from: '2026-27', qualifiedDefenses: 4, minDefenses: 20, minGames: 10 } },
    })
    renderPage()
    fireEvent.click(screen.getByRole('tab', { name: 'Tonight' }))
    const note = await screen.findByRole('note')
    expect(note).toHaveTextContent('Tiers use 2025-26')
    expect(note).toHaveTextContent('only 4 defenses have 10+ games in 2026-27 (20 needed)')
    expect(screen.getByText('Guard One')).toBeInTheDocument()
  })

  it('the season picker separates auto from an explicit current season', async () => {
    renderPage()
    const select = await screen.findByLabelText('Season')
    await screen.findByRole('option', { name: 'Auto (2026-27)' })
    expect(select).toHaveValue('')
    fireEvent.change(select, { target: { value: '2026-27' } })
    expect(archetypesAPI.getTonight).toHaveBeenLastCalledWith(expect.objectContaining({ season: '2026-27' }))
  })

  it('shows no fallback note when tonight uses the requested season', async () => {
    renderPage()
    fireEvent.click(screen.getByRole('tab', { name: 'Tonight' }))
    await screen.findByText('Guard One')
    expect(screen.queryByRole('note')).toBeNull()
  })

  it('tonight empty states: no slate, and no defense data', async () => {
    useSlate.mockReturnValue(slateContext(null))
    const { unmount } = renderPage()
    fireEvent.click(screen.getByRole('tab', { name: 'Tonight' }))
    expect(await screen.findByText('No slate selected')).toBeInTheDocument()
    expect(archetypesAPI.getTonight).not.toHaveBeenCalled()
    unmount()

    useSlate.mockReturnValue(slateContext({ slate_id: 's1' }))
    archetypesAPI.getTonight.mockResolvedValue({ data: { ...TONIGHT, season: '2026-27', defenseRows: 0, players: [] } })
    renderPage()
    fireEvent.click(screen.getByRole('tab', { name: 'Tonight' }))
    expect(await screen.findByText('No archetype defense data for 2026-27')).toBeInTheDocument()
  })
})
