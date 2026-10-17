import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import LineupStudioPage from './LineupStudioPage'
import { useSlate } from '../context/SlateContext'
import { exportAPI, lineupsAPI, optimizerAPI, playersAPI } from '../services/api'
import { FALLBACK_SITE } from '../features/lineupStudio/lineupMath'

vi.mock('../context/SlateContext', () => ({ useSlate: vi.fn() }))
vi.mock('../services/api', () => ({
  playersAPI: { getBySlateId: vi.fn(), recalculateProjections: vi.fn(), resetProjections: vi.fn() },
  optimizerAPI: { generate: vi.fn(), reviewLineup: vi.fn(), slateBreakdown: vi.fn() },
  lineupsAPI: { create: vi.fn() },
  exportAPI: { lineups: vi.fn() },
}))

const POS = ['PG', 'SG', 'SF', 'PF', 'C', 'PG/SG', 'SF/PF', 'C']
const PLAYERS = POS.map((position, i) => ({
  id: i + 1,
  name: `Player ${i + 1}`,
  position,
  team: i % 2 ? 'BOS' : 'NYK',
  opponent: i % 2 ? 'NYK' : 'BOS',
  salary: 6000,
  projected_points: 40 - i,
  rostership: 10,
}))
const SLOTS = ['PG', 'SG', 'SF', 'PF', 'C', 'G', 'F', 'UTIL']
const lineupOf = (n, ids) => ({
  lineupNumber: n,
  players: ids.map((id, i) => ({ position: SLOTS[i], player: PLAYERS[id - 1] })),
})

function renderStudio(slate = { slate_id: '42', name: 'Main' }, path = '/optimizer') {
  useSlate.mockReturnValue({
    slate,
    slateId: slate ? slate.slate_id : null,
    site: 'draftkings',
    siteConfig: FALLBACK_SITE,
    loadingSlates: false,
  })
  return render(
    <MemoryRouter initialEntries={[path]}>
      <LineupStudioPage />
    </MemoryRouter>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  playersAPI.getBySlateId.mockResolvedValue({ data: PLAYERS })
  URL.createObjectURL = vi.fn(() => 'blob:x')
  URL.revokeObjectURL = vi.fn()
  // jsdom can't follow the download link
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
})

describe('LineupStudioPage', () => {
  it('shows an empty state when no slate is selected', () => {
    renderStudio(null)
    expect(screen.getByText('No slate selected', { selector: 'h4' })).toBeInTheDocument()
    expect(playersAPI.getBySlateId).not.toHaveBeenCalled()
  })

  it('shows a retryable error when players fail to load', async () => {
    playersAPI.getBySlateId.mockRejectedValueOnce(new Error('boom'))
    renderStudio()
    expect(await screen.findByText("Couldn't load players")).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText('No lineups yet')).toBeInTheDocument()
  })

  it('generates lineups, shows exposure and exports for the site', async () => {
    optimizerAPI.generate.mockResolvedValue({
      data: { lineups: [lineupOf(1, [1, 2, 3, 4, 5, 6, 7, 8]), lineupOf(2, [1, 2, 3, 4, 8, 6, 7, 5])], warnings: [] },
    })
    exportAPI.lineups.mockResolvedValue({ data: { csv: 'PG\n1', filename: 'dk.csv', count: 2, warnings: [] } })

    renderStudio()
    await screen.findByText('No lineups yet')
    fireEvent.change(screen.getByLabelText('Contest type'), { target: { value: 'max20' } })
    fireEvent.click(screen.getByRole('button', { name: /Generate 20 lineups/ }))

    expect(await screen.findByText('#1')).toBeInTheDocument()
    expect(screen.getByText('#2')).toBeInTheDocument()
    const request = optimizerAPI.generate.mock.calls[0][0]
    expect(request).toMatchObject({ slateId: '42', site: 'draftkings', numLineups: 20, maxExposure: 60, minUniqueness: 2, randomness: 15 })
    expect(request.stackRules).toEqual([{ type: 'gameStack', min: 3, bringBack: 1, percentOfLineups: 60 }])

    // Salary used / projection / ownership sum on the card
    const card = screen.getByText('#1').closest('article')
    expect(within(card).getByText('$48,000')).toBeInTheDocument()
    expect(within(card).getByText('80%')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Export 2 for DraftKings' }))
    await waitFor(() => expect(exportAPI.lineups).toHaveBeenCalled())
    const payload = exportAPI.lineups.mock.calls[0][0]
    expect(payload.site).toBe('draftkings')
    expect(payload.lineups[0].players[0]).toEqual({ slot: 'PG', playerId: 1 })
    expect(await screen.findByText(/Exported 2 lineups/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('tab', { name: 'Exposure' }))
    const row = (await screen.findByText('Player 1')).closest('tr')
    expect(within(row).getByText('100.0%')).toBeInTheDocument()
  })

  it('saves a single lineup with its site', async () => {
    optimizerAPI.generate.mockResolvedValue({ data: { lineups: [lineupOf(1, [1, 2, 3, 4, 5, 6, 7, 8])] } })
    lineupsAPI.create.mockResolvedValue({ data: {} })
    renderStudio()
    await screen.findByText('No lineups yet')
    fireEvent.click(screen.getByRole('button', { name: /Generate lineup/ }))
    const card = (await screen.findByText('#1')).closest('article')
    fireEvent.click(within(card).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(lineupsAPI.create).toHaveBeenCalledTimes(1))
    const body = lineupsAPI.create.mock.calls[0][0]
    expect(body).toMatchObject({ slateId: '42', site: 'draftkings', name: 'Cash #1' })
    expect(body.players).toHaveLength(8)
    expect(body.players[5]).toMatchObject({ id: 6, positionSlot: 'G', projectedPoints: 35 })
    expect(await within(card).findByRole('button', { name: 'Saved' })).toBeDisabled()
  })

  it('shows the optimizer error with details', async () => {
    optimizerAPI.generate.mockRejectedValue({ response: { data: { error: 'Invalid stack rules', details: ['stackRules[0].min bad'] } } })
    renderStudio()
    await screen.findByText('No lineups yet')
    fireEvent.click(screen.getByRole('button', { name: /Generate lineup/ }))
    expect(await screen.findByText('Optimization failed')).toBeInTheDocument()
    expect(screen.getByText('Invalid stack rules')).toBeInTheDocument()
    expect(screen.getByText('stackRules[0].min bad')).toBeInTheDocument()
  })

  it('blocks Generate while a stack rule is invalid', async () => {
    renderStudio()
    await screen.findByText('No lineups yet')
    fireEvent.change(screen.getByLabelText('Add stack rule'), { target: { value: 'team' } })
    expect(screen.getByText('Pick at least one team')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Generate lineup/ })).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Add teams'), { target: { value: 'BOS' } })
    expect(screen.queryByText('Pick at least one team')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Generate lineup/ })).toBeEnabled()
  })

  it('manual builder fills eligible slots and tracks salary remaining', async () => {
    renderStudio(undefined, '/optimizer?mode=manual')
    const slots = await screen.findByRole('list', { name: 'Roster slots' })
    expect(screen.getByText('$50,000')).toBeInTheDocument()

    // Player 6 is PG/SG: goes to PG first, never to C
    fireEvent.click(screen.getByText('Player 6'))
    expect(within(slots).getByText('Player 6')).toBeInTheDocument()
    expect(screen.getByText('$44,000')).toBeInTheDocument()
    expect(screen.getByText('$6,286 / open slot')).toBeInTheDocument()

    // Player 1 (PG) can't take the filled PG slot, so it goes to G (not UTIL)
    fireEvent.click(screen.getByText('Player 1'))
    const rows = within(slots).getAllByRole('listitem')
    expect(within(rows[0]).getByText('Player 6')).toBeInTheDocument()
    expect(within(rows[5]).getByText('Player 1')).toBeInTheDocument()
    expect(screen.getAllByText('In lineup')).toHaveLength(2)
    expect(screen.getByRole('button', { name: 'Save lineup' })).toBeDisabled()
  })
})
