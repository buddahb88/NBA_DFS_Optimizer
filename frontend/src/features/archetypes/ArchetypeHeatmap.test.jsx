import { describe, it, expect, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import ArchetypeHeatmap from './ArchetypeHeatmap'

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

  it('shows the empty state when there are no rows', () => {
    renderMap({ rows: [], emptyState: <p>Nothing to show</p> })
    expect(screen.queryByRole('table')).toBeNull()
    expect(screen.getByText('Nothing to show')).toBeInTheDocument()
  })
})
