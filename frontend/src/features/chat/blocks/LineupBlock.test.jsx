import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { lineupsAPI, playerSettingsAPI } from '../../../services/api'
import ChatBlock from './ChatBlock'
import { normalizeBlock } from './blockModel'
import { currentLocation, renderWithBlocks } from './renderBlock.testUtils'

vi.mock('../../../services/api', () => ({
  playerSettingsAPI: { getBySlateId: vi.fn(), save: vi.fn() },
  lineupsAPI: { create: vi.fn() },
}))

// Backend lineup block (uiBlocks.js): slots of { slot, player }
const lineup = (slots) =>
  normalizeBlock({ version: 1, type: 'lineup', title: 'GPP core', slots, totals: { salary: null, projection: null, remaining_salary: null, ownership: null } })
const slot = (slot, name, extra = {}) => ({ slot, player: { name, ...extra } })
const CORE = [slot('PG', 'Guard One'), slot('SF', 'Wing Two'), slot('C', 'Big Three')]

beforeEach(() => {
  vi.clearAllMocks()
  playerSettingsAPI.getBySlateId.mockResolvedValue({ data: [] })
  lineupsAPI.create.mockResolvedValue({ data: { id: 9 } })
})

describe('LineupBlock', () => {
  it('shows slots with slate salaries and totals', () => {
    renderWithBlocks(<ChatBlock block={lineup(CORE)} />)
    const card = screen.getByRole('article', { name: 'GPP core' })
    expect(within(card).getByText('$21,000')).toBeInTheDocument()
    expect(within(card).getByText('110.0')).toBeInTheDocument()
    expect(within(card).getByText('$8,000')).toBeInTheDocument()
  })

  it('saves through lineupsAPI.create with slate player ids and slots', async () => {
    renderWithBlocks(<ChatBlock block={lineup(CORE)} />)
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(lineupsAPI.create).toHaveBeenCalledTimes(1))
    const body = lineupsAPI.create.mock.calls[0][0]
    expect(body).toMatchObject({ slateId: '42', site: 'draftkings', name: 'GPP core' })
    expect(body.players.map((p) => [p.id, p.positionSlot, p.projectedPoints])).toEqual([[1, 'PG', 44], [2, 'SF', 30], [3, 'C', 36]])
    expect(await screen.findByRole('button', { name: 'Saved' })).toBeDisabled()
    expect(screen.getByRole('status')).toHaveTextContent('Saved "GPP core"')
  })

  it('toasts a failed save and lets you retry', async () => {
    lineupsAPI.create.mockRejectedValueOnce({ response: { data: { error: 'Invalid lineup' } } })
    renderWithBlocks(<ChatBlock block={lineup(CORE)} />)
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Save failed: Invalid lineup'))
    expect(screen.getByRole('button', { name: 'Save' })).not.toBeDisabled()
  })

  it('blocks saving when a player is not on the slate', () => {
    renderWithBlocks(<ChatBlock block={lineup([...CORE, slot('UTIL', 'Ghost Guy', { salary: 3000 })])} />)
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
  })

  it('opens the manual builder with the lineup in router state', () => {
    renderWithBlocks(<ChatBlock block={lineup(CORE)} />)
    fireEvent.click(screen.getByRole('button', { name: /Open in Optimizer/ }))
    const loc = currentLocation()
    expect(loc.pathname).toBe('/optimizer')
    expect(loc.search).toBe('?mode=manual')
    expect(loc.state.chatLineup.slots).toEqual([
      { slot: 'PG', id: 1, playerId: 'p1', name: 'Guard One' },
      { slot: 'SF', id: 2, playerId: 'p2', name: 'Wing Two' },
      { slot: 'C', id: 3, playerId: 'p3', name: 'Big Three' },
    ])
  })
})
