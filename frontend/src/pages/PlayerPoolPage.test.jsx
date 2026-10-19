import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, within, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import PlayerPoolPage from './PlayerPoolPage'
import { playersAPI, playerSettingsAPI } from '../services/api'
import { useSlate } from '../context/SlateContext'

vi.mock('../services/api', () => ({
  slatesAPI: { importSalaries: vi.fn() },
  playersAPI: { getBySlateId: vi.fn() },
  playerSettingsAPI: { getBySlateId: vi.fn(), save: vi.fn(), clear: vi.fn() },
}))

// The page reads the top-bar slate from SlateContext
vi.mock('../context/SlateContext', () => ({ useSlate: vi.fn() }))

const slateContext = (slate) => ({
  slate,
  slateId: slate?.slate_id ?? null,
  site: 'draftkings',
  setSite: vi.fn(),
  refreshSlates: vi.fn(),
  loadingSlates: false,
})

const PLAYERS = [
  { id: 1, player_id: 'p1', name: 'Nikola Jokic', team: 'DEN', opponent: 'LAL', position: 'C', salary: 11800, projected_points: 60, projected_minutes: 36, floor: 48, ceiling: 75, rostership: 32, leverage_score: 1, boom_probability: 30, vegas_implied_total: 118.5, injury_status: null },
  { id: 2, player_id: 'p2', name: 'Luka Doncic', team: 'LAL', opponent: 'DEN', position: 'PG/SG', salary: 11200, projected_points: 57, projected_minutes: 37, floor: 44, ceiling: 74, rostership: 20, leverage_score: 3, boom_probability: 28, vegas_implied_total: 116, injury_status: 'Q' },
  { id: 3, player_id: 'p3', name: 'Derrick White', team: 'BOS', opponent: 'NYK', position: 'PG/SG', salary: 6200, projected_points: 31, projected_minutes: 33, floor: 22, ceiling: 44, rostership: 6, leverage_score: 4, boom_probability: 18, vegas_implied_total: 112, injury_status: null },
]

const renderPage = () =>
  render(
    <MemoryRouter>
      <PlayerPoolPage />
    </MemoryRouter>,
  )

const rowFor = (name) => screen.getByText(name).closest('tr')

beforeEach(() => {
  vi.clearAllMocks()
  useSlate.mockReturnValue(slateContext({ slate_id: 's1', name: 'Main Slate', site: 'draftkings' }))
  playersAPI.getBySlateId.mockResolvedValue({ data: PLAYERS })
  playerSettingsAPI.getBySlateId.mockResolvedValue({
    data: [{ playerId: 'p3', lock: false, exclude: false, minExposure: null, maxExposure: 40, projectionOverride: 35 }],
  })
  playerSettingsAPI.save.mockImplementation((slateId, playerId, body) => Promise.resolve({ data: { playerId, ...body } }))
})

describe('PlayerPoolPage', () => {
  it('renders the pool with saved controls applied', async () => {
    renderPage()
    expect(await screen.findByText('Nikola Jokic')).toBeInTheDocument()
    expect(screen.getByText('Main Slate')).toBeInTheDocument()

    // Saved override drives projection + value; saved max exposure fills the input
    expect(await screen.findByText('35.0*')).toBeInTheDocument()
    const white = rowFor('Derrick White')
    expect(within(white).getByLabelText('Max exposure for Derrick White')).toHaveValue(40)
    expect(within(white).getByText('5.65x')).toBeInTheDocument()

    expect(within(rowFor('Luka Doncic')).getByText('Q')).toBeInTheDocument()
    expect(screen.getByText('1 projection overrides')).toBeInTheDocument()
  })

  it('filters by position chip and hide injured', async () => {
    renderPage()
    await screen.findByText('Nikola Jokic')

    fireEvent.click(screen.getByRole('button', { name: 'C' }))
    expect(screen.queryByText('Luka Doncic')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'C' }))

    fireEvent.click(screen.getByRole('switch'))
    expect(screen.queryByText('Luka Doncic')).not.toBeInTheDocument()
    expect(screen.getByText('Nikola Jokic')).toBeInTheDocument()
  })

  it('persists lock and exposure edits per slate', async () => {
    renderPage()
    await screen.findByText('Nikola Jokic')

    fireEvent.click(screen.getByRole('button', { name: 'Lock Nikola Jokic' }))
    await waitFor(() => expect(playerSettingsAPI.save).toHaveBeenCalledWith('s1', 'p1', expect.objectContaining({ lock: true, exclude: false })))
    expect(screen.getByRole('button', { name: 'Unlock Nikola Jokic' })).toHaveAttribute('aria-pressed', 'true')

    const min = screen.getByLabelText('Min exposure for Luka Doncic')
    fireEvent.change(min, { target: { value: '25' } })
    fireEvent.blur(min)
    await waitFor(() => expect(playerSettingsAPI.save).toHaveBeenCalledWith('s1', 'p2', expect.objectContaining({ minExposure: 25 })))
  })

  it('rejects min exposure above the saved max without saving', async () => {
    renderPage()
    await screen.findByDisplayValue('40') // saved max exposure loaded

    const min = screen.getByLabelText('Min exposure for Derrick White')
    fireEvent.change(min, { target: { value: '80' } })
    fireEvent.blur(min)
    expect(min).toHaveAttribute('aria-invalid', 'true')
    expect(playerSettingsAPI.save).not.toHaveBeenCalled()
  })

  it('shows an empty state without an active slate', async () => {
    useSlate.mockReturnValue(slateContext(null))
    renderPage()
    expect(await screen.findByRole('button', { name: 'Select a slate' })).toBeInTheDocument()
  })
})
