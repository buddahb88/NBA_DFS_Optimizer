import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, within, waitFor, act } from '@testing-library/react'
import LineupCard from '../lineupStudio/LineupCard'
import VerdictPills from './VerdictPills'
import useSlateVerdicts, { clearSlateVerdicts, verdictLookup } from './useSlateVerdicts'
import { lineupVerdictSummary, verdictForScore } from './cardFormat'
import { playersAPI } from '../../services/api'

vi.mock('../../services/api', () => ({ playersAPI: { getVerdicts: vi.fn() } }))

const v = (verdict, score, confidence) => ({ verdict, score, confidence })
const VERDICTS = {
  slateId: 's1',
  thresholds: { core: 66, playable: 54, pivot: 42 },
  players: {
    1: { id: 1, player_id: 'p1', name: 'Nikola Jokic', cash: v('Core play', 70, 68), gpp: v('Playable', 60, 54), headline: 'Minutes up 4.0 over L5.' },
    2: { id: 2, player_id: 'p2', name: 'Derrick White', cash: v('Fade', 30, 68), gpp: v('Pivot', 45, 47), headline: 'Our model is 6.5 below RotoWire.' },
  },
}
const PLAYERS = [
  { id: 1, player_id: 'p1', name: 'Nikola Jokic', team: 'DEN', salary: 11800, projected_points: 60, rostership: 30 },
  { id: 2, player_id: 'p2', name: 'Derrick White', team: 'BOS', salary: 6200, projected_points: 31, rostership: 6 },
  { id: 9, player_id: 'p9', name: 'No Verdict', team: 'BOS', salary: 3000, projected_points: 10, rostership: 1 },
]
const lineup = (n) => ({ key: `l${n}`, number: n, slots: PLAYERS.map((player, i) => ({ slot: ['C', 'G', 'UTIL'][i], player })) })

function Studio({ slateId = 's1', slateDate = null, count = 3 }) {
  const verdicts = useSlateVerdicts({ slateId, slateDate })
  return (
    <div>
      {Array.from({ length: count }, (_, i) => (
        <LineupCard
          key={i}
          lineup={lineup(i + 1)}
          salaryCap={50000}
          selected={false}
          onToggleSelect={() => {}}
          verdictFor={verdicts.lookup}
          verdictThresholds={verdicts.data?.thresholds}
        />
      ))}
    </div>
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  clearSlateVerdicts()
  playersAPI.getVerdicts.mockResolvedValue({ data: VERDICTS })
})

describe('VerdictPills', () => {
  it('shows Cash / GPP confidence pills toned by verdict, with an accessible label', () => {
    render(<VerdictPills entry={VERDICTS.players[1]} />)
    const cash = screen.getByTestId('verdict-cash')
    const gpp = screen.getByTestId('verdict-gpp')
    expect(cash).toHaveTextContent('C68')
    expect(cash).toHaveAttribute('data-tone', 'positive')
    expect(gpp).toHaveTextContent('G54')
    expect(gpp).toHaveAttribute('data-tone', 'info')
    expect(screen.getByRole('img', { name: 'Cash Core play 68, GPP Playable 54' })).toBeInTheDocument()
  })

  it('Fade is negative and Pivot caution (the player card palette)', () => {
    render(<VerdictPills entry={VERDICTS.players[2]} />)
    expect(screen.getByTestId('verdict-cash')).toHaveAttribute('data-tone', 'negative')
    expect(screen.getByTestId('verdict-gpp')).toHaveAttribute('data-tone', 'caution')
  })

  it('phone width: each pill has a dot twin shown below sm, the pill hidden below sm', () => {
    const { container } = render(<VerdictPills entry={VERDICTS.players[1]} />)
    expect(screen.getByTestId('verdict-cash').className).toMatch(/hidden .*sm:inline-flex/)
    const dots = container.querySelectorAll('span.rounded-full.sm\\:hidden')
    expect(dots).toHaveLength(2)
    expect([...dots].map((d) => d.dataset.tone)).toEqual(['positive', 'info'])
  })

  it('tooltip shows both verdict labels and the headline', async () => {
    render(<VerdictPills entry={VERDICTS.players[2]} />)
    act(() => screen.getByRole('img').focus())
    const tip = await screen.findByRole('tooltip')
    expect(tip).toHaveTextContent('Cash: Fade (68)')
    expect(tip).toHaveTextContent('GPP: Pivot (47)')
    expect(tip).toHaveTextContent('Our model is 6.5 below RotoWire.')
  })

  it('no entry renders an aligned placeholder, not pills', () => {
    const { container } = render(<VerdictPills entry={null} />)
    expect(screen.queryByTestId('verdict-cash')).toBeNull()
    expect(container.firstChild).toHaveAttribute('aria-hidden', 'true')
  })
})

describe('lineup verdict column', () => {
  it('generated lineup cards show the column per row and one request serves every card', async () => {
    render(<Studio count={3} />)
    await waitFor(() => expect(screen.getAllByTestId('verdict-cash')).toHaveLength(6))
    expect(playersAPI.getVerdicts).toHaveBeenCalledTimes(1)
    expect(playersAPI.getVerdicts).toHaveBeenCalledWith('s1', {})
    const card = screen.getAllByRole('article')[0]
    expect(within(card).getByRole('img', { name: 'Cash Core play 68, GPP Playable 54' })).toBeInTheDocument()
    expect(within(card).getByRole('img', { name: 'Cash Fade 68, GPP Pivot 47' })).toBeInTheDocument()
  })

  it('lineup summary: average confidence of the players with a verdict, toned by the average score', async () => {
    render(<Studio count={1} />)
    const cash = await screen.findByTestId('lineup-verdict-cash')
    expect(cash).toHaveTextContent('Cash 68')
    expect(screen.getByTestId('lineup-verdict-gpp')).toHaveTextContent('GPP 51')
    expect(screen.getByLabelText('Average verdict confidence: cash 68, GPP 51')).toBeInTheDocument()
  })

  it('a second view of the same slate reuses the request; another date is its own request', async () => {
    const { unmount } = render(<Studio count={1} />)
    await screen.findAllByTestId('verdict-cash')
    unmount()
    render(<Studio count={2} />)
    await screen.findAllByTestId('verdict-cash')
    expect(playersAPI.getVerdicts).toHaveBeenCalledTimes(1)
    render(<Studio count={1} slateDate="2026-10-28" />)
    await waitFor(() => expect(playersAPI.getVerdicts).toHaveBeenCalledTimes(2))
    expect(playersAPI.getVerdicts).toHaveBeenLastCalledWith('s1', { slateDate: '2026-10-28' })
  })

  it('clearSlateVerdicts refetches for mounted views (projection source change)', async () => {
    render(<Studio count={1} />)
    await screen.findAllByTestId('verdict-cash')
    act(() => clearSlateVerdicts())
    await waitFor(() => expect(playersAPI.getVerdicts).toHaveBeenCalledTimes(2))
  })

  it('a failed request leaves the lineup readable without pills', async () => {
    playersAPI.getVerdicts.mockRejectedValue(new Error('boom'))
    render(<Studio count={1} />)
    await waitFor(() => expect(playersAPI.getVerdicts).toHaveBeenCalledTimes(1))
    expect(screen.getByText('Nikola Jokic')).toBeInTheDocument()
    expect(screen.queryByTestId('verdict-cash')).toBeNull()
  })

  it('without verdictFor the card has no verdict column (unchanged)', () => {
    render(<LineupCard lineup={lineup(1)} salaryCap={50000} selected={false} onToggleSelect={() => {}} />)
    expect(screen.queryByTestId('lineup-verdict-cash')).toBeNull()
  })
})

describe('verdict helpers', () => {
  it('lookup by slate row id, then site player_id', () => {
    const lookup = verdictLookup(VERDICTS)
    expect(lookup({ id: 1 }).name).toBe('Nikola Jokic')
    expect(lookup({ id: 'x', player_id: 'p2' }).name).toBe('Derrick White')
    expect(lookup({ id: 9 })).toBeNull()
    expect(lookup(null)).toBeNull()
  })

  it('verdictForScore mirrors the backend thresholds', () => {
    expect(verdictForScore(66)).toBe('Core play')
    expect(verdictForScore(54)).toBe('Playable')
    expect(verdictForScore(42)).toBe('Pivot')
    expect(verdictForScore(41.9)).toBe('Fade')
    expect(verdictForScore(60, { core: 60, playable: 50, pivot: 40 })).toBe('Core play')
  })

  it('lineupVerdictSummary ignores players without a verdict', () => {
    const s = lineupVerdictSummary([VERDICTS.players[1], null, VERDICTS.players[2]])
    expect(s.n).toBe(2)
    expect(s.cash).toEqual({ confidence: 68, score: 50, verdict: 'Pivot' })
    expect(lineupVerdictSummary([null])).toBeNull()
  })
})
