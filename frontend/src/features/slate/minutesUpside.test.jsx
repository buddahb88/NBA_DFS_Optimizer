import { describe, it, expect, vi, beforeAll } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { HIGH_UPSIDE, upsideNote, upsideTone } from './minutesUpside'
import MinutesUpsideCell from './MinutesUpsideCell'
import PlayerPoolTable from '../lineupStudio/PlayerPoolTable'
import PlayerCardProvider from '../playerCard/PlayerCardProvider'

vi.mock('../../services/api', () => ({ playersAPI: { getCard: vi.fn() } }))
vi.mock('../../context/SlateContext', () => ({ useSlate: vi.fn(() => ({ slateId: 's1', workSlateId: 's1', slateParams: {}, site: 'draftkings' })) }))

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
})

const UPSIDE = {
  name: 'Bench Wing',
  projected_minutes: 28,
  ours_minutes: 25.1,
  ours_minutes_p10: 14.2,
  ours_minutes_p90: 32.6,
  rw_minutes_gap: 8.4,
  minutes_upside: 72,
  minutes_upside_reasons: ['RotoWire +8.4 min', 'teammate out'],
}

describe('upsideNote / upsideTone', () => {
  it('summarizes the score, our band, RotoWire and the reasons', () => {
    expect(upsideNote(UPSIDE)).toEqual({
      score: 72, tone: 'positive', high: true,
      text: 'Minutes upside 72/100. Ours 25.1 min (p10–p90 14.2–32.6). RotoWire 28.0 (+8.4 vs ours). RotoWire +8.4 min, teammate out',
    })
    expect(upsideNote({ minutes_upside: 10, rw_minutes_gap: -3, projected_minutes: 20 }).text).toBe('Minutes upside 10/100. RotoWire 20.0 (-3.0 vs ours)')
    expect(upsideNote({ name: 'RotoWire read' })).toBeNull()
    expect(upsideNote({ minutes_upside: null })).toBeNull()
  })

  it('tones by score', () => {
    expect(upsideTone(HIGH_UPSIDE)).toBe('positive')
    expect(upsideTone(30)).toBe('info')
    expect(upsideTone(5)).toBe('neutral')
    expect(upsideTone(null)).toBe('neutral')
  })
})

describe('MinutesUpsideCell', () => {
  it('a badge when high, a number otherwise, a dash without a score', () => {
    const { rerender } = render(<MinutesUpsideCell player={UPSIDE} />)
    expect(screen.getByTestId('minutes-upside')).toHaveTextContent('↑72')
    expect(screen.getByTestId('minutes-upside')).toHaveAttribute('aria-label', expect.stringContaining('RotoWire 28.0 (+8.4 vs ours)'))
    rerender(<MinutesUpsideCell player={{ ...UPSIDE, minutes_upside: 31 }} />)
    expect(screen.getByTestId('minutes-upside')).toHaveTextContent(/^31$/)
    rerender(<MinutesUpsideCell player={{ name: 'x' }} />)
    expect(screen.queryByTestId('minutes-upside')).not.toBeInTheDocument()
    expect(screen.getByText('—')).toBeInTheDocument()
  })

  it('is a sortable column in the Lineup Studio pool', () => {
    const players = [
      { id: 1, name: 'Low', salary: 4000, projected_points: 20, rostership: 5, minutes_upside: 12 },
      { id: 2, name: 'None', salary: 4000, projected_points: 19, rostership: 5 },
      { id: 3, name: 'High', salary: 4000, projected_points: 18, rostership: 5, minutes_upside: 80 },
    ]
    render(
      <MemoryRouter>
        <PlayerCardProvider>
          <PlayerPoolTable players={players} locked={new Set()} excluded={new Set()} onToggleLock={() => {}} onToggleExclude={() => {}} onClear={() => {}} />
        </PlayerCardProvider>
      </MemoryRouter>,
    )
    const header = screen.getByRole('columnheader', { name: /Min↑/ })
    fireEvent.click(within(header).getByRole('button'))
    const names = () => screen.getAllByRole('row').slice(1).map((r) => within(r).getAllByRole('cell')[1].textContent)
    // Highest upside first; a player without a score last
    expect(names()).toEqual(['High', 'Low', 'None'])
    fireEvent.click(within(header).getByRole('button'))
    expect(names()).toEqual(['None', 'Low', 'High'])
  })
})
