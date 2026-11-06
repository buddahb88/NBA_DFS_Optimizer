import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, createEvent, fireEvent, render, screen, within } from '@testing-library/react'
import ArchetypeHeatmap, { popoverPosition } from './ArchetypeHeatmap'
import { slateCellPlayers } from './archetypes'
import { PlayerCardContext } from '../playerCard/playerCardContext'

const DEFINITIONS = {
  archetypes: [
    { key: 'primary_creator', label: 'Primary Creator' },
    { key: 'scoring_guard', label: 'Scoring Guard / Wing' },
  ],
  positions: [{ key: 'G', label: 'Guards' }, { key: 'C', label: 'Centers' }],
}

const ROWS = [
  { team: 'NYK', group_key: 'scoring_guard', fp_over_expectation: 3, pts_delta: 1.2, games: 8, player_games: 12 },
  { team: 'BOS', group_key: 'scoring_guard', fp_over_expectation: -1.5, pts_delta: -0.5, games: 7, player_games: 9 },
  { team: 'BOS', group_key: 'primary_creator', fp_over_expectation: 0, pts_delta: 0, games: 4, player_games: 4 },
]

const renderMap = (props = {}) =>
  render(<ArchetypeHeatmap rows={ROWS} definitions={DEFINITIONS} grouping="archetype" stat="fp" onCellClick={vi.fn()} {...props} />)

describe('ArchetypeHeatmap', () => {
  it('renders teams as rows and archetypes as columns', () => {
    renderMap()
    const table = screen.getByRole('table')
    const headers = within(table).getAllByRole('columnheader').map((h) => h.textContent)
    expect(headers).toEqual(['Team', 'Primary Creator', 'Scoring Guard / Wing'])
    const rowHeaders = within(table).getAllByRole('rowheader').map((h) => h.textContent)
    expect(rowHeaders).toEqual(['BOS', 'NYK'])
  })

  it('colors cells on a diverging scale and prints the value', () => {
    renderMap()
    const weak = screen.getByRole('button', { name: /NYK vs Scoring Guard \/ Wing: \+3\.0 FP/ })
    expect(weak).toHaveTextContent('+3.0')
    expect(weak.style.backgroundColor).toBe('rgb(var(--info) / 0.8)')
    const tough = screen.getByRole('button', { name: /BOS vs Scoring Guard \/ Wing: -1\.5 FP/ })
    expect(tough.style.backgroundColor).toBe('rgb(var(--negative) / 0.44)')
    // Missing cell: no button, just a dash
    expect(screen.queryByRole('button', { name: /NYK vs Primary Creator/ })).toBeNull()
    expect(screen.getByText('±3.0 FP')).toBeInTheDocument()
  })

  it('switches to the selected stat', () => {
    renderMap({ stat: 'pts' })
    expect(screen.getByRole('button', { name: /NYK vs Scoring Guard \/ Wing: \+1\.2 PTS/ })).toHaveTextContent('+1.2')
  })

  it('uses G/F/C columns for the position grouping', () => {
    const rows = [{ team: 'NYK', group_key: 'C', fp_over_expectation: 2, games: 3 }]
    renderMap({ rows, grouping: 'position' })
    expect(screen.getByRole('columnheader', { name: 'Centers' })).toBeInTheDocument()
    expect(screen.queryByRole('columnheader', { name: 'Guards' })).toBeNull()
  })

  it('reports the clicked cell', () => {
    const onCellClick = vi.fn()
    renderMap({ onCellClick })
    fireEvent.click(screen.getByRole('button', { name: /BOS vs Scoring Guard/ }))
    expect(onCellClick).toHaveBeenCalledWith({ team: 'BOS', group: 'scoring_guard', label: 'Scoring Guard / Wing' })
  })

  it('filters rows to the selected teams without shifting colors', () => {
    renderMap({ teams: ['BOS'] })
    const table = screen.getByRole('table')
    expect(within(table).getAllByRole('rowheader').map((h) => h.textContent)).toEqual(['BOS'])
    // Same color as unfiltered: NYK's +3.0 still sets the scale
    const tough = screen.getByRole('button', { name: /BOS vs Scoring Guard \/ Wing: -1\.5 FP/ })
    expect(tough.style.backgroundColor).toBe('rgb(var(--negative) / 0.44)')
    expect(screen.getByText('±3.0 FP')).toBeInTheDocument()
    expect(screen.getByText('1 of 2 teams · colors scaled to all teams')).toBeInTheDocument()
    // All columns stay
    expect(within(table).getAllByRole('columnheader')).toHaveLength(3)
  })

  it('hints tonight’s opponent next to a filtered team', () => {
    const opponents = new Map([['BOS', 'MIA'], ['MIA', 'BOS']])
    const { unmount } = renderMap({ teams: ['BOS', 'NYK'], opponents })
    expect(screen.getByRole('rowheader', { name: 'BOS vs MIA' })).toBeInTheDocument()
    expect(screen.getByRole('rowheader', { name: 'NYK' })).toBeInTheDocument()
    unmount()
    // Unfiltered: no hints
    renderMap({ opponents })
    expect(screen.getByRole('rowheader', { name: 'BOS' })).toBeInTheDocument()
  })

  it('shows the filtered empty state when the filter hides every row', () => {
    renderMap({ teams: ['LAL'], emptyState: <p>No data</p>, filteredEmptyState: <p>No teams match</p> })
    expect(screen.queryByRole('table')).toBeNull()
    expect(screen.getByText('No teams match')).toBeInTheDocument()
    expect(screen.queryByText('No data')).toBeNull()
  })

  it('shows the empty state when there are no rows', () => {
    renderMap({ rows: [], emptyState: <p>Nothing to show</p> })
    expect(screen.queryByRole('table')).toBeNull()
    expect(screen.getByText('Nothing to show')).toBeInTheDocument()
  })
})

describe('ArchetypeHeatmap slate popover', () => {
  // Three defenses vs scoring guards: NYK target (top third, +), BOS avoid (bottom third, -), MIA neutral
  const POP_ROWS = [
    ...ROWS,
    { team: 'MIA', group_key: 'scoring_guard', fp_over_expectation: 0.4, games: 6, player_games: 8 },
  ]
  const ROSTER = [
    { player_id: '1', name: 'Guard One', team: 'MIA', opponent: 'NYK', group_key: 'scoring_guard', salary: 7000, projected_points: 30, rostership: 12.34 },
    { player_id: '2', name: 'Guard Two', team: 'MIA', opponent: 'NYK', group_key: 'scoring_guard', salary: 8200, projected_points: 41.5, rostership: 25 },
    { player_id: '3', name: 'Celtic Killer', team: 'LAL', opponent: 'BOS', group_key: 'scoring_guard', salary: 6000, projected_points: 28, rostership: 4, injury_status: 'GTD' },
  ]
  const slateFor = (extra = {}) => ({
    status: 'ready',
    byCell: slateCellPlayers({ grouping: 'archetype', roster: ROSTER }, 'archetype'),
    teams: new Set(['MIA', 'NYK', 'LAL', 'BOS']),
    isBacktest: false,
    cardTarget: (p) => ({ playerId: p.player_id, name: p.name }),
    verdictFor: null,
    ...extra,
  })
  const renderPop = (props = {}) =>
    render(<ArchetypeHeatmap rows={POP_ROWS} definitions={DEFINITIONS} grouping="archetype" stat="fp" onCellClick={vi.fn()} slate={slateFor()} {...props} />)
  const cell = (team) => screen.getByRole('button', { name: new RegExp(`^${team} vs Scoring Guard`) })
  const hover = (el) => {
    fireEvent.pointerEnter(el)
    act(() => vi.advanceTimersByTime(150))
  }
  const popover = () => screen.queryByTestId('cell-popover')

  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('badges cells that slate players face, with the count, and keeps the colors', () => {
    renderPop()
    expect(within(cell('NYK')).getByTestId('slate-badge')).toHaveTextContent('2')
    expect(within(cell('BOS')).getByTestId('slate-badge')).toHaveTextContent('1')
    expect(within(cell('MIA')).queryByTestId('slate-badge')).toBeNull()
    expect(cell('NYK')).toHaveAccessibleName(/2 slate players$/)
    expect(cell('NYK').style.backgroundColor).toBe('rgb(var(--info) / 0.8)')
    expect(screen.getAllByTestId('slate-badge')).toHaveLength(2)
  })

  it('no badges without slate data', () => {
    renderPop({ slate: { status: 'none' } })
    expect(screen.queryByTestId('slate-badge')).toBeNull()
  })

  it('hover opens after a short delay: target header and players by projection', () => {
    renderPop()
    fireEvent.pointerEnter(cell('NYK'))
    act(() => vi.advanceTimersByTime(100))
    expect(popover()).toBeNull()
    act(() => vi.advanceTimersByTime(50))
    expect(screen.getByTestId('cell-popover-header')).toHaveTextContent('NYK vs Scoring Guard / Wing · +3.0 FP/player-game · target')
    expect(within(popover()).getByText('target')).toHaveAttribute('data-tier', 'target')
    const rows = within(popover()).getAllByTestId('cell-popover-player')
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringMatching(/^Guard TwoMIA\$8\.2K41\.525\.0%$/),
      expect.stringMatching(/^Guard OneMIA\$7\.0K30\.012\.3%$/),
    ])
    expect(cell('NYK')).toHaveAttribute('aria-describedby', popover().id)
  })

  it('a strong defense reads avoid, a middling one neutral, with the empty message', () => {
    renderPop()
    hover(cell('BOS'))
    expect(screen.getByTestId('cell-popover-header')).toHaveTextContent('BOS vs Scoring Guard / Wing · -1.5 FP/player-game · avoid')
    expect(within(popover()).getByText('Celtic Killer')).toBeInTheDocument()
    expect(within(popover()).getByText('GTD')).toBeInTheDocument()
    fireEvent.pointerLeave(cell('BOS'))
    hover(cell('MIA'))
    expect(screen.getByTestId('cell-popover-header')).toHaveTextContent('MIA vs Scoring Guard / Wing · +0.4 FP/player-game · neutral')
    expect(screen.getByTestId('cell-popover-empty')).toHaveTextContent('No Scoring Guard / Wings face MIA on this slate')
  })

  it('says when the defending team is not on the slate, or no slate is selected', () => {
    const miaOnly = ROSTER.filter((p) => p.team === 'MIA')
    const { unmount } = renderPop({
      slate: slateFor({ teams: new Set(['NYK', 'MIA']), byCell: slateCellPlayers({ grouping: 'archetype', roster: miaOnly }, 'archetype') }),
    })
    hover(cell('BOS'))
    expect(screen.getByTestId('cell-popover-empty')).toHaveTextContent('BOS is not on this slate')
    unmount()
    renderPop({ slate: { status: 'none' } })
    hover(cell('NYK'))
    expect(screen.getByTestId('cell-popover-header')).toHaveTextContent('target')
    expect(screen.getByTestId('cell-popover-empty')).toHaveTextContent(/No slate selected/)
  })

  it('closes on leave (but not while the pointer is on the popover) and on Escape', () => {
    renderPop()
    hover(cell('NYK'))
    fireEvent.pointerLeave(cell('NYK'))
    fireEvent.pointerEnter(popover())
    act(() => vi.advanceTimersByTime(500))
    expect(popover()).not.toBeNull()
    fireEvent.pointerLeave(popover())
    act(() => vi.advanceTimersByTime(150))
    expect(popover()).toBeNull()

    hover(cell('NYK'))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(popover()).toBeNull()
  })

  it('keyboard focus opens it too', () => {
    renderPop()
    fireEvent.focus(cell('BOS'))
    act(() => vi.advanceTimersByTime(150))
    expect(screen.getByTestId('cell-popover-header')).toHaveTextContent('avoid')
    fireEvent.blur(cell('BOS'))
    act(() => vi.advanceTimersByTime(150))
    expect(popover()).toBeNull()
  })

  it('mouse click still opens the drill-down and closes the popover', () => {
    const onCellClick = vi.fn()
    renderPop({ onCellClick })
    hover(cell('NYK'))
    fireEvent.click(cell('NYK'))
    expect(onCellClick).toHaveBeenCalledWith({ team: 'NYK', group: 'scoring_guard', label: 'Scoring Guard / Wing' })
    expect(popover()).toBeNull()
  })

  it('touch: first tap previews, second tap (or the link) opens the drill-down', () => {
    const onCellClick = vi.fn()
    renderPop({ onCellClick })
    const tap = (el) => {
      const down = createEvent.pointerDown(el)
      Object.defineProperty(down, 'pointerType', { value: 'touch' })
      fireEvent(el, down)
      fireEvent.click(el)
    }
    tap(cell('NYK'))
    expect(onCellClick).not.toHaveBeenCalled()
    expect(within(popover()).getByText('Guard Two')).toBeInTheDocument()
    tap(cell('NYK'))
    expect(onCellClick).toHaveBeenCalledTimes(1)
    expect(popover()).toBeNull()

    tap(cell('BOS'))
    fireEvent.click(within(popover()).getByRole('button', { name: /View this cell’s games/ }))
    expect(onCellClick).toHaveBeenLastCalledWith({ team: 'BOS', group: 'scoring_guard', label: 'Scoring Guard / Wing' })
    expect(popover()).toBeNull()
  })

  it('stays open across a grid rebuild, closes when the team filter hides its row', () => {
    const props = { rows: POP_ROWS, definitions: DEFINITIONS, grouping: 'archetype', stat: 'fp', slate: slateFor() }
    const { rerender } = render(<ArchetypeHeatmap {...props} />)
    hover(cell('NYK'))
    rerender(<ArchetypeHeatmap {...props} definitions={{ ...DEFINITIONS }} />)
    expect(popover()).not.toBeNull()
    rerender(<ArchetypeHeatmap {...props} teams={['BOS']} />)
    expect(popover()).toBeNull()
  })

  it('tapping outside closes it', () => {
    renderPop()
    hover(cell('NYK'))
    fireEvent.pointerDown(document.body)
    expect(popover()).toBeNull()
  })

  it('player names open the card and close the popover', () => {
    const open = vi.fn()
    render(
      <PlayerCardContext.Provider value={{ open, close: vi.fn(), target: null }}>
        <ArchetypeHeatmap rows={POP_ROWS} definitions={DEFINITIONS} grouping="archetype" stat="fp" slate={slateFor()} />
      </PlayerCardContext.Provider>,
    )
    hover(cell('NYK'))
    fireEvent.click(within(popover()).getByRole('button', { name: 'Open Guard Two card' }))
    expect(open).toHaveBeenCalledWith({ playerId: '2', name: 'Guard Two' })
    expect(popover()).toBeNull()
  })

  it('backtest: shows actual points; verdict pills when available', () => {
    const roster = ROSTER.map((p, i) => ({ ...p, actualPoints: [33.5, 50, 12][i] }))
    const verdict = { cash: { verdict: 'Play', confidence: 70 }, gpp: { verdict: 'Fade', confidence: 40 } }
    renderPop({
      slate: slateFor({
        isBacktest: true,
        byCell: slateCellPlayers({ grouping: 'archetype', roster }, 'archetype'),
        verdictFor: (p) => (p.player_id === '2' ? verdict : null),
      }),
    })
    hover(cell('NYK'))
    expect(within(popover()).getByRole('columnheader', { name: 'Act' })).toBeInTheDocument()
    const [two, one] = within(popover()).getAllByTestId('cell-popover-player')
    expect(two).toHaveTextContent('50.0')
    expect(one).toHaveTextContent('33.5')
    expect(within(two).getByRole('img', { name: 'Cash Play 70, GPP Fade 40' })).toBeInTheDocument()
    expect(within(one).queryByRole('img')).toBeNull()
    expect(within(popover()).getByText('Backtest slate')).toBeInTheDocument()
  })

  it('popoverPosition keeps the popover on screen', () => {
    const viewport = { width: 400, height: 300 }
    const pop = { width: 200, height: 100 }
    // Room below: under the cell
    expect(popoverPosition({ top: 20, bottom: 40, left: 10 }, pop, viewport)).toEqual({ top: 44, left: 10 })
    // No room below: above it
    expect(popoverPosition({ top: 250, bottom: 270, left: 10 }, pop, viewport)).toEqual({ top: 146, left: 10 })
    // Right edge: pulled left
    expect(popoverPosition({ top: 20, bottom: 40, left: 380 }, pop, viewport)).toEqual({ top: 44, left: 192 })
  })
})
