import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { SlateProvider, useSlate } from '../../context/SlateContext'
import SlateModeSelect from './SlateModeSelect'
import { sitesAPI, slatesAPI } from '../../services/api'

vi.mock('../../services/api', () => ({
  sitesAPI: { getAll: vi.fn() },
  slatesAPI: { getAll: vi.fn(), getBacktests: vi.fn() },
}))

const BACKTESTS = [
  { slateDate: '2026-10-21', slateId: '29805', site: 'draftkings', players: 242 },
  { slateDate: '2026-10-20', slateId: '29794', site: 'draftkings', players: 65 },
]

function Probe() {
  const { workSlateId, slateParams, settingsKey, isBacktest } = useSlate()
  return <div data-testid="probe">{JSON.stringify({ workSlateId, slateParams, settingsKey, isBacktest })}</div>
}

const probe = () => JSON.parse(screen.getByTestId('probe').textContent)

function renderSelect(props) {
  return render(
    <SlateProvider>
      <SlateModeSelect {...props} />
      <Probe />
    </SlateProvider>,
  )
}

describe('SlateModeSelect', () => {
  beforeEach(() => {
    localStorage.clear()
    sitesAPI.getAll.mockResolvedValue({ data: { draftkings: { key: 'draftkings', name: 'DraftKings', salaryCap: 50000, rosterSlots: [] } } })
    slatesAPI.getAll.mockResolvedValue({ data: [{ slate_id: '29806', name: 'Tonight' }] })
    slatesAPI.getBacktests.mockResolvedValue({ data: BACKTESTS })
  })

  it('starts Live: no badge, requests go to the live slate', async () => {
    renderSelect()
    const select = await screen.findByLabelText('Slate mode')
    expect(select).toHaveValue('')
    expect(screen.getByRole('option', { name: 'Backtest: 2026-10-21 (242 players)' })).toBeInTheDocument()
    expect(screen.queryByTestId('backtest-badge')).not.toBeInTheDocument()
    await waitFor(() => expect(probe().workSlateId).toBe('29806'))
    expect(probe()).toMatchObject({ slateParams: {}, settingsKey: '29806', isBacktest: false })
  })

  it('picking a date shows the Backtest badge and switches requests to the saved slate', async () => {
    renderSelect({ showRanges: true })
    fireEvent.change(await screen.findByLabelText('Slate mode'), { target: { value: '2026-10-21' } })
    expect(screen.getByTestId('backtest-badge')).toHaveTextContent('Backtest 2026-10-21')
    expect(probe()).toMatchObject({
      workSlateId: '29805',
      slateParams: { slateDate: '2026-10-21', ranges: 'model' },
      settingsKey: 'backtest:2026-10-21:29805',
      isBacktest: true,
    })

    // Range toggle: pre-lock ranges
    fireEvent.click(screen.getByRole('tab', { name: 'Pre-lock ranges' }))
    expect(probe().slateParams).toEqual({ slateDate: '2026-10-21', ranges: 'original' })

    // Back to Live
    fireEvent.change(screen.getByLabelText('Slate mode'), { target: { value: '' } })
    expect(screen.queryByTestId('backtest-badge')).not.toBeInTheDocument()
    expect(probe().workSlateId).toBe('29806')
  })

  it('hides itself when there is no saved slate to backtest', async () => {
    slatesAPI.getBacktests.mockResolvedValue({ data: [] })
    renderSelect()
    await waitFor(() => expect(probe().workSlateId).toBe('29806'))
    expect(screen.queryByLabelText('Slate mode')).not.toBeInTheDocument()
  })
})
