import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import ArchetypesPage from './ArchetypesPage'
import { archetypesAPI, historicalAPI } from '../../services/api'
import { useSlate } from '../../context/SlateContext'
import { PlayerCardContext } from '../playerCard/playerCardContext'

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
const EDGE = (adjusted_edge, extra = {}) => ({
  adjusted_edge, flags: [], last_team: null, projected_minutes: 34,
  minutes: { projected: 34, last_season: 33, current: null, current_games: 0, change: 1, basis: 'projected' },
  crowding: { count: 0, teammates: [] },
  components: { volume: 1, role_factor: 1, minutes_confidence: 1, crowding_factor: 1 },
  ...extra,
})
const TONIGHT = {
  season: '2025-26', grouping: 'archetype', slatePlayers: 3, matchedPlayers: 2, defenseRows: 1,
  edgeConfig: { fullMinutes: 32, penalties: { new_team: 0.85, role_down: 0.8, role_up: 0.9, no_history: 0.85 }, crowdingPenalty: 0.25 },
  players: [
    {
      player_id: '1', name: 'Guard One', position: 'PG', team: 'MIA', opponent: 'NYK', label: 'Scoring Guard / Wing', salary: 8000, projected_points: 40, matchup_delta: 2.4, rank: 1, teams: 30,
      ...EDGE(0.8, {
        projected_minutes: 24, last_team: 'BOS', flags: ['new_team', 'role_down', 'crowded'],
        minutes: { projected: 24, last_season: 32.1, current: null, current_games: 0, change: -8.1, basis: 'projected' },
        crowding: { count: 1, teammates: ['Guard Three'] },
        components: { volume: 0.75, role_factor: 0.68, minutes_confidence: 0.51, crowding_factor: 0.8 },
      }),
    },
    { player_id: '2', name: 'Wing Two', position: 'SF', team: 'BOS', opponent: 'PHX', label: 'Scoring Guard / Wing', salary: 9000, projected_points: 30, matchup_delta: 1.1, rank: 4, teams: 30, ...EDGE(1.1) },
  ],
}
const GAMES = {
  summary: { games: 8, player_games: 12, avg_fp: 40, avg_expected_fp: 37.6, fp_over_expectation: 2.4 },
  games: [{ game_id: 'g1', player_key: 'a', game_date: '2026-01-05', player_name: 'Some Guard', team: 'MIA', minutes: 33, fp: 45, expected_fp: 38, fp_over_expectation: 7, pts_delta: 3, reb_delta: 1, ast_delta: 0, fg3m_delta: 1 }],
}

const renderPage = (url = '/archetypes') => render(<MemoryRouter initialEntries={[url]}><ArchetypesPage /></MemoryRouter>)

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
    expect(archetypesAPI.getCellGames).toHaveBeenCalledWith('NYK', 'scoring_guard', { season: '2025-26', grouping: 'archetype', site: 'fanduel' })
  })

  it('opens the drill-down from a deep link (Player Pool matchup)', async () => {
    renderPage('/archetypes?season=2025-26&grouping=archetype&team=NYK&group=scoring_guard')
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('NYK vs Scoring Guard / Wing')).toBeInTheDocument()
    expect(archetypesAPI.getDefense).toHaveBeenCalledWith({ season: '2025-26', grouping: 'archetype', site: 'fanduel' })
    expect(archetypesAPI.getCellGames).toHaveBeenCalledWith('NYK', 'scoring_guard', { season: '2025-26', grouping: 'archetype', site: 'fanduel' })
    expect(await within(dialog).findByText('Some Guard')).toBeInTheDocument()
  })

  it('passes the position toggle and season filter to the grid', async () => {
    renderPage()
    await screen.findByRole('button', { name: /NYK vs Scoring Guard/ })
    fireEvent.click(screen.getByRole('tab', { name: 'Position (G/F/C)' }))
    expect(archetypesAPI.getDefense).toHaveBeenLastCalledWith({ grouping: 'position', site: 'fanduel', seasonFallback: true })
    fireEvent.change(await screen.findByLabelText('Season'), { target: { value: '2025-26' } })
    expect(archetypesAPI.getDefense).toHaveBeenLastCalledWith({ season: '2025-26', grouping: 'position', site: 'fanduel' })
  })

  it('says when the heatmap shows last season because the current one is thin', async () => {
    archetypesAPI.getDefense.mockResolvedValue({
      data: { ...DEFENSE, fallback: { from: '2026-27', qualifiedDefenses: 0, minDefenses: 20, minGames: 10 } },
    })
    renderPage()
    const note = await screen.findByRole('note')
    expect(note).toHaveTextContent('Showing 2025-26')
    expect(note).toHaveTextContent('only 0 defenses have 10+ games in 2026-27 (20 needed)')
    expect(screen.getByText(/^2025-26 · full season/)).toBeInTheDocument()
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
    // Adjusted edge first by default; raw matchup on the toggle
    expect(await names()).toEqual(['Wing Two', 'Guard One'])
    fireEvent.click(screen.getByRole('tab', { name: 'Raw matchup' }))
    expect(await names()).toEqual(['Guard One', 'Wing Two'])
    fireEvent.click(screen.getByRole('tab', { name: 'Adjusted edge' }))
    expect(await names()).toEqual(['Wing Two', 'Guard One'])
    expect(screen.getByText('$8,000')).toBeInTheDocument()
    expect(screen.getByText('+2.40')).toBeInTheDocument()
    expect(screen.getByText('+0.80')).toBeInTheDocument()
    // Minutes: projection with change vs last season
    expect(screen.getByText('-8.1')).toBeInTheDocument()

    // Numeric columns sort high-to-low first
    fireEvent.click(screen.getByRole('button', { name: 'Salary' }))
    expect(await names()).toEqual(['Wing Two', 'Guard One'])
    fireEvent.click(screen.getByRole('button', { name: 'Salary' }))
    expect(await names()).toEqual(['Guard One', 'Wing Two'])
  })

  it('flags new team, role and crowding with explanatory tooltips', async () => {
    renderPage()
    fireEvent.click(screen.getByRole('tab', { name: 'Tonight' }))
    const row = (await screen.findByText('Guard One')).closest('tr')
    expect(screen.queryByRole('columnheader', { name: /Result/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('columnheader', { name: /Actual/ })).not.toBeInTheDocument()
    expect(within(row).getByText('New team')).toBeInTheDocument()
    expect(within(row).getByText('Role ↓')).toBeInTheDocument()
    const crowded = within(row).getByText('Crowded')
    fireEvent.mouseEnter(crowded.parentElement)
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Shares Scoring Guard / Wing vs NYK with Guard Three: edge x0.80.')
    fireEvent.mouseLeave(crowded.parentElement)

    fireEvent.mouseEnter(within(row).getByText('New team').parentElement)
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Was BOS last season (32.1 min).')
    fireEvent.mouseLeave(within(row).getByText('New team').parentElement)

    // The edge explains itself
    fireEvent.mouseEnter(within(row).getByText('+0.80'))
    expect(await screen.findByRole('tooltip')).toHaveTextContent('+2.40 matchup x 0.75 minutes (24 min) x 0.68 role x 0.80 crowding = +0.80')

    // A steady player has no badges
    const steady = screen.getByText('Wing Two').closest('tr')
    expect(within(steady).queryByText('Crowded')).not.toBeInTheDocument()
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

  it('Tonight in backtest mode ranks the saved night and shows actual points', async () => {
    const BACKTEST = { slateDate: '2026-10-21', slateId: '29805', site: 'fanduel', players: 242 }
    useSlate.mockReturnValue({
      ...slateContext({ slate_id: 's1', name: 'Main' }),
      backtests: [BACKTEST], backtest: BACKTEST, isBacktest: true, setBacktestDate: vi.fn(),
      rangeMode: 'model', setRangeMode: vi.fn(), workSlateId: '29805',
    })
    archetypesAPI.getTonight.mockResolvedValue({
      data: {
        ...TONIGHT, isBacktest: true, slateDate: '2026-10-21', endDate: '2026-10-20',
        players: TONIGHT.players.map((p, i) => ({
          ...p, actualPoints: [52.5, 0][i], actualMinutes: [36, 0][i], resultStatus: ['PLAYED', 'DNP'][i],
          injury_status: [null, 'GTD'][i],
        })),
      },
    })
    renderPage()
    fireEvent.click(screen.getByRole('tab', { name: 'Tonight' }))

    expect(await screen.findByText('52.5')).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: /Actual/ })).toBeInTheDocument()
    // Result: what happened that night; the injury tag is pre-lock info
    expect(screen.getByRole('columnheader', { name: /Result/ })).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: /Pre-lock status/ })).toBeInTheDocument()
    expect(within(screen.getByText('Guard One').closest('tr')).getByText('Played · 36 min')).toBeInTheDocument()
    const dnp = screen.getByText('Wing Two').closest('tr')
    expect(within(dnp).getByText('DNP')).toBeInTheDocument()
    expect(within(dnp).getByText('GTD')).toBeInTheDocument()
    expect(screen.getByTestId('backtest-badge')).toHaveTextContent('Backtest 2026-10-21')
    expect(screen.getByText(/Defense through 2026-10-20/)).toBeInTheDocument()
    expect(archetypesAPI.getTonight).toHaveBeenLastCalledWith(expect.objectContaining({ slateId: '29805', slateDate: '2026-10-21' }))
  })
})

describe('ArchetypesPage team filter', () => {
  const TWO_TEAMS = {
    ...DEFENSE,
    rows: [
      ...DEFENSE.rows,
      { team: 'BOS', group_key: 'scoring_guard', fp_over_expectation: -1.2, games: 8, player_games: 10 },
      { team: 'LAL', group_key: 'scoring_guard', fp_over_expectation: 0.6, games: 8, player_games: 10 },
    ],
  }
  // Slate: MIA @ NYK, BOS @ PHX (LAL not playing)
  const ROSTER = [{ player_id: '1', player_key: 'guard one', name: 'Guard One', team: 'MIA' }, { player_id: '2', player_key: 'wing two', name: 'Wing Two', team: 'BOS' }]

  let location
  function LocationProbe() {
    location = useLocation()
    return null
  }
  const renderAt = (url) =>
    render(<MemoryRouter initialEntries={[url]}><ArchetypesPage /><LocationProbe /></MemoryRouter>)
  const rowTeams = () => within(screen.getByRole('table')).getAllByRole('rowheader').map((h) => h.textContent)
  const teamsParam = () => new URLSearchParams(location.search).get('teams')

  beforeEach(() => {
    archetypesAPI.getDefense.mockResolvedValue({ data: TWO_TEAMS })
    archetypesAPI.getTonight.mockResolvedValue({ data: { ...TONIGHT, slateId: 's1', roster: ROSTER } })
  })

  it('shows every team by default', async () => {
    renderAt('/archetypes')
    await screen.findByRole('button', { name: /NYK vs Scoring Guard/ })
    expect(rowTeams()).toEqual(['BOS', 'LAL', 'NYK'])
    expect(screen.getByRole('button', { name: 'Teams: All teams' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Clear team filter' })).toBeNull()
    expect(teamsParam()).toBeNull()
  })

  it('restores ?teams= from the link, keeps colors league-wide, and hints opponents', async () => {
    renderAt('/archetypes?teams=nyk,LAL')
    const nyk = await screen.findByRole('button', { name: /NYK vs Scoring Guard \/ Wing: \+2\.4 FP/ })
    await waitFor(() => expect(screen.getByRole('rowheader', { name: 'NYK vs MIA' })).toBeInTheDocument())
    expect(rowTeams()).toEqual(['LAL', 'NYK vs MIA'])
    // BOS (hidden) does not change the scale: NYK's +2.4 is still the max
    expect(nyk.style.backgroundColor).toBe('rgb(var(--info) / 0.8)')
    expect(screen.getByText('±2.4 FP')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Teams: 2 teams' })).toBeInTheDocument()
    // Normalized back into the URL
    expect(teamsParam()).toBe('LAL,NYK')
    // The filter never refetches the grid
    expect(archetypesAPI.getDefense).toHaveBeenCalledTimes(1)
  })

  it('picking teams filters the rows and writes the link; clear resets both', async () => {
    renderAt('/archetypes?season=2025-26')
    await screen.findByRole('button', { name: /NYK vs Scoring Guard/ })
    fireEvent.click(screen.getByRole('button', { name: 'Teams: All teams' }))
    const menu = screen.getByRole('group', { name: 'Pick teams' })
    expect(within(menu).getAllByRole('checkbox').map((c) => c.parentElement.textContent)).toEqual(['BOS', 'LAL', 'NYK'])
    fireEvent.click(within(menu).getByRole('checkbox', { name: 'BOS' }))
    fireEvent.click(within(menu).getByRole('checkbox', { name: 'NYK' }))
    expect(rowTeams()).toEqual(['BOS vs PHX', 'NYK vs MIA'])
    expect(teamsParam()).toBe('BOS,NYK')
    // Other params survive
    expect(new URLSearchParams(location.search).get('season')).toBe('2025-26')
    expect(screen.getByRole('button', { name: 'Teams: 2 teams' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Clear team filter' }))
    expect(rowTeams()).toEqual(['BOS', 'LAL', 'NYK'])
    expect(teamsParam()).toBeNull()
  })

  it('Tonight’s slate shortcut selects the slate’s teams and round-trips as ?teams=tonight', async () => {
    renderAt('/archetypes')
    await screen.findByRole('button', { name: /NYK vs Scoring Guard/ })
    fireEvent.click(screen.getByRole('button', { name: 'Teams: All teams' }))
    const shortcut = screen.getByRole('button', { name: 'Tonight’s slate' })
    await waitFor(() => expect(shortcut).toBeEnabled())
    fireEvent.click(shortcut)
    // MIA/NYK/BOS/PHX play; LAL doesn't; MIA and PHX have no defense rows here
    expect(rowTeams()).toEqual(['BOS vs PHX', 'NYK vs MIA'])
    expect(teamsParam()).toBe('tonight')
    expect(screen.getByRole('button', { name: 'Teams: Tonight · 4 teams' })).toBeInTheDocument()
    const menu = screen.getByRole('group', { name: 'Pick teams' })
    expect(within(menu).getByRole('checkbox', { name: 'MIA' })).toBeChecked()
    expect(within(menu).getByRole('checkbox', { name: 'LAL' })).not.toBeChecked()
    // Unticking a team turns the shortcut into an explicit list
    fireEvent.click(within(menu).getByRole('checkbox', { name: 'NYK' }))
    expect(teamsParam()).toBe('BOS,MIA,PHX')
    expect(rowTeams()).toEqual(['BOS vs PHX'])
  })

  it('opens straight onto tonight’s teams from a link; the shortcut is off without a slate', async () => {
    const { unmount } = renderAt('/archetypes?teams=tonight')
    await waitFor(() => expect(rowTeams()).toEqual(['BOS vs PHX', 'NYK vs MIA']))
    unmount()

    useSlate.mockReturnValue(slateContext(null))
    renderAt('/archetypes')
    await screen.findByRole('button', { name: /NYK vs Scoring Guard/ })
    fireEvent.click(screen.getByRole('button', { name: 'Teams: All teams' }))
    expect(screen.getByRole('button', { name: 'Tonight’s slate' })).toBeDisabled()
  })

  it('empty state when the filter removes every row, with a way back', async () => {
    renderAt('/archetypes?teams=DEN')
    expect(await screen.findByText('No defenses match the team filter')).toBeInTheDocument()
    expect(screen.queryByRole('table')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Show all teams' }))
    expect(rowTeams()).toEqual(['BOS', 'LAL', 'NYK'])
    expect(teamsParam()).toBeNull()
  })

  it('Tonight tab ignores the team filter and says so', async () => {
    renderAt('/archetypes?teams=LAL')
    fireEvent.click(screen.getByRole('tab', { name: 'Tonight' }))
    expect(await screen.findByText('Guard One')).toBeInTheDocument()
    expect(screen.getByText('Wing Two')).toBeInTheDocument()
    expect(screen.getByText('The team filter applies to the heatmap only.')).toBeInTheDocument()
  })
})

describe('ArchetypesPage player card links', () => {
  const ROSTER = [
    { player_id: '1', player_key: 'guard one', name: 'Guard One', team: 'MIA', headshot: 'g1.png' },
    { player_id: '2', player_key: 'wing two', name: 'Wing Two', team: 'BOS', headshot: null },
    { player_id: '3', player_key: 'bench three', name: 'Bench Three', team: 'MIA', headshot: null },
  ]
  const CELL_GAMES = {
    ...GAMES,
    games: [
      { ...GAMES.games[0], game_id: 'g1', player_key: 'guard one', player_name: 'Guard One' },
      { ...GAMES.games[0], game_id: 'g2', player_key: 'gone guy', player_name: 'Gone Guy' },
    ],
  }
  const renderWithCard = () => {
    const open = vi.fn()
    render(
      <PlayerCardContext.Provider value={{ open, close: vi.fn(), target: null }}>
        <MemoryRouter initialEntries={['/archetypes']}><ArchetypesPage /></MemoryRouter>
      </PlayerCardContext.Provider>,
    )
    return open
  }

  beforeEach(() => {
    archetypesAPI.getTonight.mockResolvedValue({ data: { ...TONIGHT, slateId: 's1', isBacktest: false, roster: ROSTER } })
    archetypesAPI.getCellGames.mockResolvedValue({ data: CELL_GAMES })
  })

  it('Tonight names open the card on the shown slate; sorting still works', async () => {
    const open = renderWithCard()
    fireEvent.click(screen.getByRole('tab', { name: 'Tonight' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Open Guard One card' }))
    expect(open).toHaveBeenCalledWith({ playerId: '1', slateId: 's1', slateDate: null, name: 'Guard One', headshot: null, team: 'MIA' })

    const names = () => screen.getAllByRole('row').slice(1).map((r) => within(r).getAllByRole('cell')[0].textContent)
    fireEvent.click(screen.getByRole('button', { name: 'Salary' }))
    expect(names()).toEqual(['Wing Two', 'Guard One'])
    fireEvent.click(screen.getByRole('button', { name: 'Salary' }))
    expect(names()).toEqual(['Guard One', 'Wing Two'])
    expect(open).toHaveBeenCalledTimes(1)
  })

  it('backtest: Tonight names open the card for that night', async () => {
    const BACKTEST = { slateDate: '2026-10-21', slateId: '29805', site: 'fanduel', players: 242 }
    useSlate.mockReturnValue({
      ...slateContext({ slate_id: 's1', name: 'Main' }),
      backtests: [BACKTEST], backtest: BACKTEST, isBacktest: true, setBacktestDate: vi.fn(),
      rangeMode: 'model', setRangeMode: vi.fn(), workSlateId: '29805',
    })
    archetypesAPI.getTonight.mockResolvedValue({
      data: { ...TONIGHT, slateId: '29805', isBacktest: true, slateDate: '2026-10-21', endDate: '2026-10-20', roster: ROSTER },
    })
    const open = renderWithCard()
    fireEvent.click(screen.getByRole('tab', { name: 'Tonight' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Open Wing Two card' }))
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ playerId: '2', slateId: '29805', slateDate: '2026-10-21' }))
  })

  it('drill-down links only players on the slate', async () => {
    const open = renderWithCard()
    // Tonight (and its roster) loads with the page, before the Tonight tab is opened
    await waitFor(() => expect(archetypesAPI.getTonight).toHaveBeenCalled())
    fireEvent.click(await screen.findByRole('button', { name: /NYK vs Scoring Guard \/ Wing: \+2\.4 FP/ }))
    const dialog = await screen.findByRole('dialog')
    const link = await within(dialog).findByRole('button', { name: 'Open Guard One card' })
    expect(within(dialog).getByText('Gone Guy').closest('button')).toBeNull()
    expect(within(dialog).queryByRole('button', { name: 'Open Gone Guy card' })).not.toBeInTheDocument()

    fireEvent.click(link)
    expect(open).toHaveBeenCalledWith({ playerId: '1', slateId: 's1', slateDate: null, name: 'Guard One', headshot: 'g1.png', team: 'MIA' })
    // The drill-down stays open under the card
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })
})
