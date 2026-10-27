import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import OpportunityRadarTab from './OpportunityRadarTab'
import { opportunityAPI } from '../../services/api'
import { useSlate } from '../../context/SlateContext'

vi.mock('../../services/api', () => ({ opportunityAPI: { getRadar: vi.fn() } }))
vi.mock('../../context/SlateContext', () => ({ useSlate: vi.fn() }))

const player = (over) => ({
  id: 1,
  player_key: 'k',
  name: 'Paul Reed',
  position: 'C',
  team: 'DET',
  opponent: 'PHI',
  salary: 4200,
  projected_points: 24.5,
  score: 76.6,
  cash_score: 70,
  gpp_score: 76.6,
  components: { minutes: 0.9 },
  coverage: 0.95,
  reason: '+7.8 min L3, absorbs ~47% of Duren usage (OUT)',
  min_delta_l3: 7.8,
  usg_delta: 0.02,
  teammate_sample: 'confirmed',
  teammate_absorbed_pct: 0.474,
  team_out_names: ['Jalen Duren'],
  teammate_out_names: ['Jalen Duren'],
  rate_gap: 3.7,
  hit5x_l10: 0.6,
  value_games_l10: 10,
  min_sd_l10: 4.1,
  implied_total: 114,
  ...over,
})

const LIVE = {
  success: true,
  isBacktest: false,
  slateId: 's1',
  mode: 'cash',
  weights: { minutes: 0.12 },
  count: 3,
  validation: null,
  players: [
    player(),
    player({ id: 2, name: 'Jaylen Brown', position: 'SF/PF', team: 'PHI', opponent: 'DET', salary: 7900, score: 52.6, reason: '', min_delta_l3: -4 }),
    player({ id: 3, name: 'Cade Cunningham', position: 'PG', salary: 10200, score: 61, reason: 'hit 5x in 7/10' }),
  ],
}

const slateContext = (over = {}) => ({
  slate: { slate_id: 's1', name: 'Main' },
  slateId: 's1',
  site: 'draftkings',
  loadingSlates: false,
  backtest: null,
  workSlateId: 's1',
  ...over,
})

const renderTab = () =>
  render(
    <MemoryRouter>
      <OpportunityRadarTab />
    </MemoryRouter>,
  )

// Player names in table order (the name cell also shows the position)
const bodyNames = () =>
  screen.getAllByRole('row').slice(1).map((r) => r.textContent.match(/Paul Reed|Jaylen Brown|Cade Cunningham/)?.[0])

beforeEach(() => {
  vi.clearAllMocks()
  useSlate.mockReturnValue(slateContext())
  opportunityAPI.getRadar.mockImplementation((params) => Promise.resolve({ data: { ...LIVE, mode: params.mode } }))
})

describe('OpportunityRadarTab', () => {
  it('renders the scored table, best first, with reason lines and color-coded metric cells', async () => {
    renderTab()
    expect(await screen.findByText('Paul Reed')).toBeInTheDocument()
    expect(opportunityAPI.getRadar).toHaveBeenCalledWith({ slateId: 's1', site: 'draftkings', mode: 'cash' })
    expect(bodyNames()).toEqual(['Paul Reed', 'Cade Cunningham', 'Jaylen Brown'])
    expect(screen.getByText('+7.8 min L3, absorbs ~47% of Duren usage (OUT)')).toBeInTheDocument()
    for (const header of ['Score', 'Min Δ', 'Usg Δ', 'Vacated', 'Proj gap', 'Hit 5x', 'Min SD', 'Env']) {
      expect(screen.getByRole('columnheader', { name: new RegExp(header) })).toBeInTheDocument()
    }
    expect(screen.getAllByText('+7.8')[0]).toHaveClass('text-positive')
    expect(screen.getAllByText('-4.0')[0]).toHaveClass('text-negative')
    expect(screen.getAllByText('47%')[0]).toHaveClass('text-positive')
    expect(screen.queryByRole('columnheader', { name: /Actual/ })).not.toBeInTheDocument()
    expect(screen.getByText('3 of 3 players · Cash weighting · hover a cell for its sample')).toBeInTheDocument()
  })

  it('filters by salary range, position and minimum score', async () => {
    renderTab()
    await screen.findByText('Paul Reed')
    fireEvent.change(screen.getByLabelText('Min salary'), { target: { value: '5500' } })
    fireEvent.change(screen.getByLabelText('Max salary'), { target: { value: '8500' } })
    expect(bodyNames()).toEqual(['Jaylen Brown'])
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }))
    fireEvent.change(screen.getByLabelText('Position'), { target: { value: 'PG' } })
    expect(bodyNames()).toEqual(['Cade Cunningham'])
    fireEvent.change(screen.getByLabelText('Position'), { target: { value: '' } })
    fireEvent.change(screen.getByLabelText('Min score'), { target: { value: '60' } })
    expect(bodyNames()).toEqual(['Paul Reed', 'Cade Cunningham'])
    fireEvent.change(screen.getByLabelText('Min score'), { target: { value: '90' } })
    expect(screen.getByText('No players match the filters')).toBeInTheDocument()
  })

  it('refetches with the GPP weighting', async () => {
    renderTab()
    await screen.findByText('Paul Reed')
    fireEvent.click(screen.getByRole('tab', { name: 'GPP' }))
    await waitFor(() => expect(opportunityAPI.getRadar).toHaveBeenLastCalledWith({ slateId: 's1', site: 'draftkings', mode: 'gpp' }))
    expect(await screen.findByText(/GPP weighting/)).toBeInTheDocument()
  })

  it('backtest: requests the saved night, adds Actual / Result columns and the top-decile check', async () => {
    useSlate.mockReturnValue(slateContext({ backtest: { slateDate: '2026-10-21', slateId: '29805' }, workSlateId: '29805' }))
    opportunityAPI.getRadar.mockResolvedValue({
      data: {
        ...LIVE,
        isBacktest: true,
        slateDate: '2026-10-21',
        players: [player({ actualPoints: 31.5, actualMinutes: 30, resultStatus: 'PLAYED' }), player({ id: 2, name: 'Jaylen Brown', score: 50, actualPoints: 0, actualMinutes: 0, resultStatus: 'DNP' })],
        validation: {
          cash: { players: 242, multiple: 5, top: { players: 25, hits: 12, hitRate: 0.48 }, slate: { players: 242, hits: 78, hitRate: 0.322 }, lift: 1.49 },
          gpp: { players: 242, multiple: 5, top: { players: 25, hits: 9, hitRate: 0.36 }, slate: { players: 242, hits: 78, hitRate: 0.322 }, lift: 1.12 },
        },
      },
    })
    renderTab()
    expect(await screen.findByText('31.5')).toBeInTheDocument()
    expect(opportunityAPI.getRadar).toHaveBeenCalledWith({ slateId: '29805', slateDate: '2026-10-21', site: 'draftkings', mode: 'cash' })
    expect(screen.getByRole('columnheader', { name: /Actual/ })).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: /Result/ })).toBeInTheDocument()
    expect(screen.getByText('Played · 30 min')).toBeInTheDocument()
    expect(screen.getByText('DNP')).toBeInTheDocument()
    const strip = screen.getByTestId('radar-validation')
    expect(within(strip).getByText('12/25 (48%)')).toBeInTheDocument()
    expect(within(strip).getByText('1.49×')).toBeInTheDocument()
  })

  it('no slate: empty state, no request', () => {
    useSlate.mockReturnValue(slateContext({ slate: null, slateId: null, workSlateId: null }))
    renderTab()
    expect(screen.getByText('No slate selected')).toBeInTheDocument()
    expect(opportunityAPI.getRadar).not.toHaveBeenCalled()
  })
})
