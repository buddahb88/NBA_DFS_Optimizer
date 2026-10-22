import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { playerSettingsAPI } from '../../../services/api'
import ChatBlock from './ChatBlock'
import { normalizeBlock } from './blockModel'
import { renderWithBlocks } from './renderBlock.testUtils'

vi.mock('../../../services/api', () => ({
  playerSettingsAPI: { getBySlateId: vi.fn(), save: vi.fn(), clear: vi.fn() },
  lineupsAPI: { create: vi.fn() },
}))

// Backend ui block shape (backend/src/services/chatTools/uiBlocks.js)
const block = normalizeBlock({
  version: 1,
  id: 'call_1:0',
  type: 'player_list',
  title: 'Best matchups',
  players: [
    {
      name: 'Guard One', player_key: 'guard one', team: 'BOS', opponent: 'NYK', position: 'PG', salary: 8000, projection: 44,
      archetype: 'primary_creator', archetype_label: 'Primary Creator', matchup_edge: 3.1, adjusted_edge: 2.4,
      projected_minutes: 34, last_season_minutes: 30, flags: ['role_down', 'crowded'], injury_status: 'GTD',
    },
    { name: 'Wing Two', team: 'BOS', opponent: 'NYK', position: 'SF', salary: 6000, projection: 30, matchup_edge: -2, flags: [] },
    { name: 'Off Slate', team: 'MIA', opponent: 'ORL', salary: 4000, projection: 18, flags: [] },
  ],
})

beforeEach(() => {
  vi.clearAllMocks()
  playerSettingsAPI.getBySlateId.mockResolvedValue({ data: [{ playerId: 'p2', exclude: true }] })
  playerSettingsAPI.save.mockResolvedValue({ data: {} })
})

const card = (name) => screen.getByRole('article', { name })

describe('PlayerCardList', () => {
  it('renders a card per player with salary, projection, value, archetype, edge, minutes and flags', async () => {
    renderWithBlocks(<ChatBlock block={block} />)
    const c = card('Guard One')
    expect(within(c).getByText('BOS · vs NYK · PG')).toBeInTheDocument()
    expect(within(c).getByText('$8,000')).toBeInTheDocument()
    expect(within(c).getByText('44.0')).toBeInTheDocument()
    expect(within(c).getByText('5.50x')).toBeInTheDocument()
    expect(within(c).getByText('Primary Creator')).toBeInTheDocument()
    expect(within(c).getByText('+2.4')).toHaveClass('text-positive')
    expect(within(c).getByText('34 min')).toBeInTheDocument()
    expect(within(c).getByText(/\+4\.0 vs last season/)).toBeInTheDocument()
    for (const label of ['Role ↓', 'Crowded', 'GTD']) expect(within(c).getByText(label)).toBeInTheDocument()
    expect(within(card('Wing Two')).getByText('-2.0')).toHaveClass('text-negative')

    // Flag tooltips on focus
    fireEvent.focus(within(c).getByText('Crowded').parentElement)
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Teammates share this archetype matchup.')
  })

  it('toggles to a table view and back', () => {
    renderWithBlocks(<ChatBlock block={block} />)
    fireEvent.click(screen.getByRole('button', { name: 'Table view' }))
    expect(screen.getByRole('button', { name: 'Table view' })).toHaveAttribute('aria-pressed', 'true')
    const table = screen.getByRole('table')
    expect(within(table).getAllByRole('row')).toHaveLength(4)
    expect(within(table).getByText('5.50x')).toBeInTheDocument()
    expect(screen.queryByRole('article', { name: 'Guard One' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Card view' }))
    expect(card('Guard One')).toBeInTheDocument()
  })

  it('reflects saved controls and locks / excludes through playerSettingsAPI.save', async () => {
    renderWithBlocks(<ChatBlock block={block} />)
    expect(playerSettingsAPI.getBySlateId).toHaveBeenCalledWith('42')
    // Wing Two is already excluded on the slate
    await waitFor(() => expect(within(card('Wing Two')).getByRole('button', { name: 'Include Wing Two' })).toHaveAttribute('aria-pressed', 'true'))

    fireEvent.click(within(card('Guard One')).getByRole('button', { name: 'Lock Guard One' }))
    expect(within(card('Guard One')).getByRole('button', { name: 'Unlock Guard One' })).toHaveAttribute('aria-pressed', 'true')
    await waitFor(() => expect(playerSettingsAPI.save).toHaveBeenCalledWith('42', 'p1', { lock: true, exclude: false }))
    expect(screen.getByRole('status')).toHaveTextContent('Locked Guard One')

    // Locking an excluded player clears the exclude
    fireEvent.click(within(card('Wing Two')).getByRole('button', { name: 'Lock Wing Two' }))
    await waitFor(() => expect(playerSettingsAPI.save).toHaveBeenLastCalledWith('42', 'p2', { exclude: false, lock: true }))
    expect(within(card('Wing Two')).getByRole('button', { name: 'Exclude Wing Two' })).toHaveAttribute('aria-pressed', 'false')
  })

  it('rolls back and shows an error toast when the save fails', async () => {
    playerSettingsAPI.getBySlateId.mockResolvedValue({ data: [] })
    playerSettingsAPI.save.mockRejectedValue({ response: { data: { error: 'db down' } } })
    renderWithBlocks(<ChatBlock block={block} />)
    await waitFor(() => expect(playerSettingsAPI.getBySlateId).toHaveBeenCalledTimes(1))

    fireEvent.click(within(card('Guard One')).getByRole('button', { name: 'Exclude Guard One' }))
    expect(within(card('Guard One')).getByRole('button', { name: 'Include Guard One' })).toHaveAttribute('aria-pressed', 'true')
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent("Couldn't save: db down"))
    // Reloaded from the server -> back to not excluded
    await waitFor(() => expect(within(card('Guard One')).getByRole('button', { name: 'Exclude Guard One' })).toHaveAttribute('aria-pressed', 'false'))
  })

  it('disables Lock / Exclude for players not on the slate', () => {
    renderWithBlocks(<ChatBlock block={block} />)
    const lock = within(card('Off Slate')).getByRole('button', { name: 'Lock Off Slate' })
    expect(lock).toHaveAttribute('aria-disabled', 'true')
    fireEvent.click(lock)
    expect(playerSettingsAPI.save).not.toHaveBeenCalled()
  })

  it('pins and unpins players to the session context', () => {
    renderWithBlocks(<ChatBlock block={block} />)
    const pinned = screen.getByRole('list', { name: 'Pinned' })
    fireEvent.click(within(card('Off Slate')).getByRole('button', { name: 'Pin Off Slate' }))
    expect(within(pinned).getByText('Off Slate')).toBeInTheDocument()
    expect(within(card('Off Slate')).getByRole('button', { name: 'Unpin Off Slate' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('status')).toHaveTextContent('Pinned Off Slate to context')
    fireEvent.click(within(card('Off Slate')).getByRole('button', { name: 'Unpin Off Slate' }))
    expect(within(pinned).queryByText('Off Slate')).not.toBeInTheDocument()
  })

  it('renders usage bumps and streaks with their notes', () => {
    renderWithBlocks(
      <>
        <ChatBlock
          block={normalizeBlock({
            version: 1,
            type: 'usage_bumps',
            title: 'Usage bumps',
            bumps: [
              {
                player: { name: 'Wing Two', team: 'BOS', salary: 6000, projection: 30 },
                missing_player: 'Star Guy', avg_with: 24, avg_without: 30, minutes_with: 28, minutes_without: 33, bumped_projection: 36,
              },
            ],
          })}
        />
        <ChatBlock block={normalizeBlock({ version: 1, type: 'streaks', kind: 'hot', players: [{ name: 'Big Three', team: 'NYK', season_avg: 36, last3_avg: 48 }] })} />
      </>,
    )
    expect(screen.getByRole('heading', { name: /Usage bumps/ })).toBeInTheDocument()
    expect(within(card('Wing Two')).getByText('+6.0 FP without Star Guy')).toBeInTheDocument()
    expect(within(card('Wing Two')).getByText('6.00x')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: /Hot streaks/ })).toBeInTheDocument()
    expect(within(card('Big Three')).getByText('Last 3: 48 vs 36 season')).toBeInTheDocument()
    // Streak rows have no salary; the slate fills it in
    expect(within(card('Big Three')).getByText('$7,000')).toBeInTheDocument()
  })
})
