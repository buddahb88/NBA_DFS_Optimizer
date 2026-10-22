import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import ChatBlock from './ChatBlock'
import { normalizeBlock } from './blockModel'

// No provider: blocks render read-only with default context. Fixtures use the
// backend block shapes (backend/src/services/chatTools/uiBlocks.js).
const renderBlock = (raw) => render(<MemoryRouter><ChatBlock block={normalizeBlock({ version: 1, ...raw })} /></MemoryRouter>)

beforeEach(() => vi.spyOn(console, 'error').mockImplementation(() => {}))

describe('ChatBlock fallback', () => {
  it('shows a quiet note for unknown block types', () => {
    renderBlock({ type: 'weather_radar', title: 'Radar' })
    expect(screen.getByRole('note')).toHaveTextContent('Radar: "weather_radar" results aren\'t supported in this view yet.')
  })

  it('contains a block that throws while rendering', () => {
    renderBlock({ type: 'lineup_score', title: 'Broken', players: [null], totals: {} })
    expect(screen.getByRole('note')).toHaveTextContent("Broken: This result couldn't be displayed.")
  })

  it('renders player cards without actions outside the chat page', () => {
    renderBlock({ type: 'player_list', players: [{ name: 'Solo', salary: 5000, projection: 25, flags: [] }] })
    expect(screen.getByRole('article', { name: 'Solo' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Lock Solo/ })).not.toBeInTheDocument()
  })
})

const row = (group_key, label, fp, extra = {}) => ({
  team: 'BOS', group_key, label, fp_over_expectation: fp, pts_delta: 0, reb_delta: 0, ast_delta: 0, fg3m_delta: 0, stocks_delta: 0,
  rank: null, teams: 30, games: 22, player_games: 80, low_sample: false, ...extra,
})

const CONTEXT = { season: '2025-26', site: 'draftkings', team: 'BOS' }

describe('MatchupTableBlock', () => {
  it('heat-colors cells on the Archetypes scale, de-emphasizes low samples and links the drill-down', () => {
    renderBlock({
      type: 'matchup_table',
      title: 'BOS vs every archetype',
      context: CONTEXT,
      group_by: 'archetype',
      rows: [
        row('primary_creator', 'Primary Creator', 3.2, { pts_delta: 1.5, rank: 2 }),
        row('stretch_big', 'Stretch Big', -1.6, { rank: 28, games: 6, low_sample: true }),
        row('unclassified', 'Unclassified', -0.5),
      ],
    })
    expect(screen.getByRole('heading', { name: 'BOS vs every archetype' })).toBeInTheDocument()
    expect(screen.queryByText('Unclassified')).not.toBeInTheDocument()

    expect(screen.getByLabelText('BOS vs Primary Creator: +3.2 FP').style.backgroundColor).toContain('var(--info)')
    expect(screen.getByLabelText('BOS vs Stretch Big: -1.6 FP').style.backgroundColor).toContain('var(--negative)')

    expect(screen.getByRole('rowheader', { name: 'Stretch Big' }).closest('tr')).toHaveClass('opacity-60')
    expect(screen.getByRole('rowheader', { name: 'Primary Creator' }).closest('tr')).not.toHaveClass('opacity-60')

    expect(screen.getByRole('link', { name: 'Primary Creator' })).toHaveAttribute(
      'href',
      '/archetypes?grouping=archetype&team=BOS&group=primary_creator&season=2025-26',
    )
  })
})

describe('TeamDefenseBlock', () => {
  it('shows weakest / strongest groups with a tab per grouping', () => {
    renderBlock({
      type: 'team_defense',
      title: 'BOS defense',
      note: 'Defense numbers are from 2024-25.',
      context: CONTEXT,
      team: 'BOS',
      groups: [
        { group_by: 'archetype', weakest: [row('primary_creator', 'Primary Creator', 3.2)], strongest: [row('stretch_big', 'Stretch Big', -1.6)] },
        { group_by: 'position', weakest: [row('G', 'Guards', 1.1)], strongest: [] },
      ],
    })
    expect(screen.getByRole('heading', { name: 'BOS defense' })).toBeInTheDocument()
    expect(screen.getByText('Defense numbers are from 2024-25.')).toBeInTheDocument()
    expect(screen.getByText(/Weakest vs/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Primary Creator' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Stretch Big' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('tab', { name: 'G/F/C' }))
    expect(screen.getByRole('link', { name: 'Guards' })).toHaveAttribute('href', '/archetypes?grouping=position&team=BOS&group=G&season=2025-26')
    expect(screen.queryByText(/Strongest vs/)).not.toBeInTheDocument()
  })
})

describe('LineupScoreCard', () => {
  it('colors over/under per player, totals the lineup and marks 5x hits', () => {
    renderBlock({
      type: 'lineup_score',
      title: 'Lineup results 2026-10-21',
      context: { date: '2026-10-21', site: 'draftkings' },
      totals: { actual: 95, projected: 90, salary: 15000, value_per_1k: null },
      players: [
        { name: 'Smash', status: 'PLAYED', minutes: 36, actual: 55, salary: 9000, projected: 45, vs_projection: 10, value_per_1k: 6.11 },
        { name: 'Dud', status: 'PLAYED', minutes: 30, actual: 40, salary: 6000, projected: 45, vs_projection: -5, value_per_1k: 6.67 },
        { name: 'Scratch', status: 'DNP', status_reason: 'Inactive', actual: 0, salary: null, projected: null },
      ],
      not_found: ['Nobody'],
    })
    expect(screen.getByText('2026-10-21')).toBeInTheDocument()
    expect(screen.getByText('95.0')).toBeInTheDocument()
    expect(screen.getByText('+5.0 (90.0)')).toHaveClass('text-positive')
    expect(screen.getByText('6.33x')).toBeInTheDocument()
    expect(screen.getByText('2/3')).toBeInTheDocument()
    expect(screen.getByText('Not found: Nobody')).toBeInTheDocument()

    const [smash, dud, scratch] = screen.getAllByTestId('score-diff')
    expect(smash).toHaveTextContent('+10.0')
    expect(smash).toHaveClass('text-positive')
    expect(dud).toHaveTextContent('-5.0')
    expect(dud).toHaveClass('text-negative')
    expect(scratch).toHaveTextContent('—')
    expect(screen.getAllByLabelText('Hit 5x')).toHaveLength(2)
    expect(within(screen.getByRole('rowheader', { name: /Scratch/ })).getByText('DNP')).toBeInTheDocument()
  })
})
