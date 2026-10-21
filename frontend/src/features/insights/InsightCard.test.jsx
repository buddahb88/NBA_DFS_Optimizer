import { describe, it, expect, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import InsightCard from './InsightCard'
import InsightsFilters from './InsightsFilters'
import { LEAGUE_CARDS, SLATE_CARDS } from './cards'

const card = (id, cards = SLATE_CARDS) => cards.find((c) => c.id === id)
const hot = card('hotStreaks')

const renderCard = (props) => render(<InsightCard card={hot} rows={[]} status="ready" {...props} />)

describe('InsightCard', () => {
  it('shows a spinner while loading with no rows', () => {
    renderCard({ status: 'loading' })
    expect(screen.getByRole('status', { name: 'Loading Hot streaks' })).toBeInTheDocument()
  })

  it('shows the error with a retry button', () => {
    const onRetry = vi.fn()
    renderCard({ status: 'error', error: 'startDate must be on or before endDate', onRetry })
    expect(screen.getByText('startDate must be on or before endDate')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(onRetry).toHaveBeenCalled()
  })

  it('shows the card empty text when there are no rows', () => {
    renderCard()
    expect(screen.getByText('Nobody on the slate is running hot.')).toBeInTheDocument()
  })

  it('renders zero values instead of hiding them', () => {
    const rows = [{ name: 'Flat Guy', team: 'DEN', opponent: 'LAL', salary: 0, last3Avg: 0, hotStreakPct: 0, reason: 'r' }]
    renderCard({ rows })
    const item = screen.getByText('Flat Guy').closest('li')
    expect(within(item).getByText('0%')).toBeInTheDocument()
    expect(within(item).getByText('0.0 L3')).toBeInTheDocument()
    expect(within(item).getByText('DEN · vs LAL · $0')).toBeInTheDocument()
  })

  it('keeps rows keyed by player, not index, across reorders', () => {
    const a = { name: 'A', team: 'DEN', hotStreakPct: 20, last3Avg: 40 }
    const b = { name: 'B', team: 'LAL', hotStreakPct: 18, last3Avg: 35 }
    const { rerender } = renderCard({ rows: [a, b] })
    const nodeA = screen.getByText('A').closest('li')
    rerender(<InsightCard card={hot} rows={[b, a]} status="ready" />)
    expect(screen.getByText('A').closest('li')).toBe(nodeA)
    expect(screen.getAllByRole('listitem').map((li) => li.textContent[0])).toEqual(['B', 'A'])
  })

  it('flattens the missing-players report into keyed rows', () => {
    const missing = card('missing')
    const rows = missing.rows([{ team: 'DEN', missingPlayers: [{ name: 'Jamal Murray', avgDk: 0, avgMin: 31, games: 9 }] }])
    render(<InsightCard card={missing} rows={rows} status="ready" />)
    expect(screen.getByText('Jamal Murray')).toBeInTheDocument()
    expect(screen.getByText('0.0')).toBeInTheDocument()
    expect(missing.getKey(rows[0])).toBe('DEN|Jamal Murray')
  })

  it('renders league rows by player_name', () => {
    const consistent = card('consistencyLeaders', LEAGUE_CARDS)
    const rows = [{ player_key: 'k1', player_name: 'Steady Eddie', team: 'BOS', games: 10, avg_dk: 30, floor: 25, ceiling: 35, consistency_score: 0 }]
    render(<InsightCard card={consistent} rows={rows} status="ready" />)
    const item = screen.getByText('Steady Eddie').closest('li')
    expect(within(item).getByText('0')).toBeInTheDocument()
    expect(within(item).getByText('30.0 avg · 25.0–35.0 range')).toBeInTheDocument()
  })
})

describe('InsightsFilters', () => {
  const base = { mode: 'default', startDate: '', endDate: '' }

  it('applies preset windows immediately', () => {
    const onChange = vi.fn()
    render(<InsightsFilters value={base} onChange={onChange} siteName="FanDuel" />)
    fireEvent.change(screen.getByLabelText('Date window'), { target: { value: 'last30' } })
    expect(onChange).toHaveBeenCalledWith({ mode: 'last30', startDate: '', endDate: '' })
    expect(screen.getByText('FanDuel scoring')).toBeInTheDocument()
  })

  it('prefills a custom range from the data range and validates before applying', () => {
    const onChange = vi.fn()
    render(<InsightsFilters value={base} onChange={onChange} range={{ earliest: '2026-10-01', latest: '2026-10-20T00:00:00.000Z' }} />)
    fireEvent.change(screen.getByLabelText('Date window'), { target: { value: 'custom' } })
    expect(onChange).not.toHaveBeenCalled()
    expect(screen.getByLabelText('From')).toHaveValue('2026-10-01')
    expect(screen.getByLabelText('To')).toHaveValue('2026-10-20')

    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-10-25' } })
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    expect(screen.getByRole('alert')).toHaveTextContent(/before the end date/)
    expect(onChange).not.toHaveBeenCalled()

    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-10-05' } })
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    expect(onChange).toHaveBeenCalledWith({ mode: 'custom', startDate: '2026-10-05', endDate: '2026-10-20' })
  })
})
