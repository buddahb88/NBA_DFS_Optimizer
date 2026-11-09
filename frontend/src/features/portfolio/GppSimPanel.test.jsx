import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import GppSimPanel from './GppSimPanel'
import { buildGppSimRequest, formError, isSmallSingleEntry, ratePct } from './gppSimMath'
import { makeGppResult } from './fixtures'
import { exportAPI } from '../../services/api'

vi.mock('../../services/api', () => ({ exportAPI: { lineups: vi.fn() } }))

const idle = () => ({ state: { status: 'idle' }, running: false, start: vi.fn(), cancel: vi.fn(), reset: vi.fn() })
const completed = (result, request = { slateId: '42' }) => ({ ...idle(), state: { status: 'completed', result, request } })

beforeEach(() => {
  vi.clearAllMocks()
  globalThis.URL.createObjectURL = vi.fn(() => 'blob:x')
  globalThis.URL.revokeObjectURL = vi.fn()
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
})

describe('gppSimMath', () => {
  it('builds single and multi requests', () => {
    expect(buildGppSimRequest({ contestSize: '14000', mode: 'single', entries: 20, chalkCap: true }, { slateId: '42', excluded: new Set([7]) })).toEqual({
      slateId: '42', contestSize: 14000, mode: 'single', entries: 1, chalkCap: true, cheapMinutesFloor: false, atLock: false, excludedPlayers: ['7'],
    })
    expect(buildGppSimRequest({ contestSize: 5000, mode: 'multi', entries: '20', cheapMinutesFloor: true }, {
      slateId: '42', slateParams: { slateDate: '2026-11-02', ranges: 'model' }, atLock: true,
    })).toMatchObject({ slateDate: '2026-11-02', mode: 'multi', entries: 20, cheapMinutesFloor: true, atLock: true })
  })

  it('validates the form and flags small single-entry contests', () => {
    expect(formError({ contestSize: 14000, mode: 'single' })).toBeNull()
    expect(formError({ contestSize: 50, mode: 'single' })).toMatch(/Contest size/)
    expect(formError({ contestSize: 14000, mode: 'multi', entries: 1 })).toMatch(/Entries/)
    expect(isSmallSingleEntry({ contestSize: 5000, mode: 'single' })).toBe(true)
    expect(isSmallSingleEntry({ contestSize: 14000, mode: 'single' })).toBe(false)
    expect(isSmallSingleEntry({ contestSize: 5000, mode: 'multi' })).toBe(false)
    expect(ratePct(0.0042)).toBe('0.42%')
    expect(ratePct(0.41)).toBe('41.0%')
  })
})

describe('GppSimPanel', () => {
  it('runs with the form settings and re-runs at lock', () => {
    const job = idle()
    render(<GppSimPanel job={job} slateId="42" excluded={new Set([3])} />)
    fireEvent.click(screen.getByRole('switch', { name: /Chalk cap/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Run GPP sim' }))
    expect(job.start).toHaveBeenLastCalledWith(expect.objectContaining({
      slateId: '42', contestSize: 14000, mode: 'single', entries: 1, chalkCap: true, cheapMinutesFloor: false, atLock: false, excludedPlayers: ['3'],
    }))

    fireEvent.click(screen.getByRole('tab', { name: 'Multi' }))
    fireEvent.change(screen.getByLabelText('Lineups'), { target: { value: '10' } })
    fireEvent.click(screen.getByRole('switch', { name: /minutes floor/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Re-run at lock' }))
    expect(job.start).toHaveBeenLastCalledWith(expect.objectContaining({ mode: 'multi', entries: 10, cheapMinutesFloor: true, atLock: true }))
  })

  it('shows the sharper-field caveat for small single-entry contests only', () => {
    render(<GppSimPanel job={idle()} slateId="42" />)
    expect(screen.queryByRole('note')).toBeNull()
    fireEvent.change(screen.getByLabelText('Contest size'), { target: { value: '3000' } })
    expect(screen.getByRole('note')).toHaveTextContent(/Single-entry fields are sharper than modeled/)
    fireEvent.click(screen.getByRole('tab', { name: 'Multi' }))
    expect(screen.queryByRole('note')).toBeNull()
  })

  it('blocks runs with a reason and shows progress with cancel', () => {
    const { rerender } = render(<GppSimPanel job={idle()} slateId="42" disabledReason="Waiting for the player pool." />)
    expect(screen.getByRole('button', { name: 'Run GPP sim' })).toBeDisabled()
    expect(screen.getByText('Waiting for the player pool.')).toBeInTheDocument()
    const running = { ...idle(), running: true, state: { status: 'running', stage: 'contest', progress: 0.62, request: { atLock: true } } }
    rerender(<GppSimPanel job={running} slateId="42" />)
    expect(screen.getByRole('progressbar', { name: 'GPP sim progress' })).toHaveAttribute('aria-valuenow', '62')
    expect(screen.getByRole('heading', { name: /Simulating the contest/ })).toHaveTextContent('(at lock)')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(running.cancel).toHaveBeenCalled()
  })

  it('shows picks with win / top 1% / cash, the comparison and exports for DraftKings', async () => {
    exportAPI.lineups.mockResolvedValue({ data: { filename: 'dk.csv', csv: 'x', count: 2, warnings: [] } })
    const onNotice = vi.fn()
    const result = makeGppResult({ entries: 2, atLock: true, ruledOut: [{ id: 99, name: 'Late Scratch', team: 'BOS', reason: 'RotoWire: OUT' }] })
    render(<GppSimPanel job={completed(result)} slateId="42" onNotice={onNotice} />)
    const cards = screen.getAllByTestId('gpp-lineup')
    expect(cards).toHaveLength(3) // 2 picks + max projection
    expect(within(cards[0]).getByText('0.42%')).toBeInTheDocument()
    expect(within(cards[0]).getByText('41.0%')).toBeInTheDocument()
    expect(within(cards[0]).getByText(/Best simulated win rate/)).toBeInTheDocument()
    expect(within(cards[2]).getByText('Max projection (comparison)')).toBeInTheDocument()
    expect(screen.getByText(/Late Scratch \(RotoWire: OUT\)/)).toBeInTheDocument()
    expect(screen.getByText(/412 candidates · 6,000 nights/)).toHaveTextContent('· at lock')

    fireEvent.click(screen.getByRole('button', { name: 'Export 2 for DraftKings' }))
    await waitFor(() => expect(exportAPI.lineups).toHaveBeenCalled())
    const body = exportAPI.lineups.mock.calls[0][0]
    expect(body).toMatchObject({ site: 'draftkings', slateId: '42' })
    expect(body.lineups).toHaveLength(2)
    expect(body.lineups[0].players[0]).toEqual({ slot: 'PG', playerId: 1 })
    await waitFor(() => expect(onNotice).toHaveBeenCalledWith(expect.objectContaining({ tone: 'positive' })))
  })

  it('backtest results show actual points and disable export; result caveat and failures are shown', () => {
    const result = makeGppResult({ caveat: 'Small single-entry contest: single-entry fields are sharper than the modeled field.' })
    result.lineups[0].actualPoints = 281.25
    const { rerender } = render(<GppSimPanel job={completed(result, { slateId: '42', slateDate: '2026-11-02' })} slateId="42" />)
    expect(screen.getByText('281.3')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Export 1 for DraftKings' })).toBeDisabled()
    expect(screen.getAllByRole('note')[0]).toHaveTextContent(/sharper than the modeled field/)
    rerender(<GppSimPanel job={{ ...idle(), state: { status: 'failed', error: 'No players found for this slate' } }} slateId="42" />)
    expect(screen.getByRole('alert')).toHaveTextContent('GPP sim failed: No players found for this slate')
  })
})
