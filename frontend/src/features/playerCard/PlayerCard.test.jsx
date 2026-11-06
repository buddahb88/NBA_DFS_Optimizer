import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest'
import { render, screen, within, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import PlayerCardView from './PlayerCardView'
import PlayerCardProvider from './PlayerCardProvider'
import { clearPlayerCardCache } from './usePlayerCardData'
import { fadeCard, rookieCard } from './fixtures'
import PlayerPoolPage from '../../pages/PlayerPoolPage'
import PlayerPoolTable from '../lineupStudio/PlayerPoolTable'
import ManualBuilder from '../lineupStudio/ManualBuilder'
import { playersAPI, playerSettingsAPI } from '../../services/api'
import { useSlate } from '../../context/SlateContext'

vi.mock('../../services/api', () => ({
  slatesAPI: { importSalaries: vi.fn() },
  playersAPI: { getBySlateId: vi.fn(), getCard: vi.fn() },
  playerSettingsAPI: { getBySlateId: vi.fn(), save: vi.fn(), clear: vi.fn() },
}))
vi.mock('../../context/SlateContext', () => ({ useSlate: vi.fn() }))

beforeAll(() => {
  // recharts' ResponsiveContainer needs a ResizeObserver
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
})

const PLAYERS = [
  { id: 1, player_id: 'p1', name: 'Nikola Jokic', team: 'DEN', opponent: 'LAL', position: 'C', salary: 11800, projected_points: 60, projected_minutes: 36, rostership: 32 },
  { id: 2, player_id: 'p2', name: 'Derrick White', team: 'BOS', opponent: 'NYK', position: 'PG/SG', salary: 6200, projected_points: 31, projected_minutes: 33, rostership: 6 },
]

const cardFor = (p) => {
  const c = fadeCard()
  return { ...c, slate: { ...c.slate, isBacktest: false, slateId: 's1', slateDate: null, settingsKey: 's1' }, actual: null, player: { ...c.player, id: p.id, player_id: p.player_id, name: p.name } }
}

beforeEach(() => {
  vi.clearAllMocks()
  clearPlayerCardCache()
  useSlate.mockReturnValue({
    slate: { slate_id: 's1', name: 'Main Slate', site: 'draftkings' }, slateId: 's1', workSlateId: 's1', slateParams: {},
    site: 'draftkings', setSite: vi.fn(), refreshSlates: vi.fn(), loadingSlates: false,
  })
  playersAPI.getBySlateId.mockResolvedValue({ data: PLAYERS })
  playersAPI.getCard.mockImplementation((slateId, playerId) =>
    Promise.resolve({ data: cardFor(PLAYERS.find((p) => String(p.id) === String(playerId))) }))
  playerSettingsAPI.getBySlateId.mockResolvedValue({ data: [] })
  playerSettingsAPI.save.mockImplementation((slateId, playerId, body) => Promise.resolve({ data: { playerId, ...body } }))
})

const withCard = (ui) => render(<MemoryRouter><PlayerCardProvider>{ui}</PlayerCardProvider></MemoryRouter>)

describe('PlayerCardView', () => {
  it('renders verdicts, blurb, fade badge, sections and the backtest result', () => {
    render(<MemoryRouter><PlayerCardView card={fadeCard()} onClose={() => {}} /></MemoryRouter>)
    expect(screen.getByRole('heading', { name: 'Test Guard' })).toBeInTheDocument()
    expect(screen.getByLabelText('Cash: Playable, confidence 52')).toBeInTheDocument()
    expect(screen.getByLabelText('GPP: Core play, confidence 64')).toBeInTheDocument()
    expect(screen.getByText(/trust the fade/)).toBeInTheDocument()
    expect(screen.getByText(/FADE -6.5/)).toBeInTheDocument()
    expect(screen.getByText('What actually happened')).toBeInTheDocument()
    expect(screen.getByText('+5.3 vs proj')).toBeInTheDocument()
    expect(screen.getByText('Reasons for')).toBeInTheDocument()
    expect(screen.getByText(/minutes when Tyrese Haliburton is out/)).toBeInTheDocument()
    expect(screen.getByText('vs WAS: Primary Creators')).toBeInTheDocument()
    expect(screen.getByText('Grade A · #2/30')).toBeInTheDocument()
    expect(screen.getByRole('table', { name: 'Opponent allowed vs expectation' })).toBeInTheDocument()
    expect(screen.getByText('Projection track record')).toBeInTheDocument()
    expect(screen.getByText('Backtest 2026-10-28')).toBeInTheDocument()
  })

  it('says when the slate size changed the call, and stays quiet when it did not', () => {
    const c = fadeCard()
    const changed = {
      ...c,
      verdict: {
        ...c.verdict,
        slate: {
          gameCount: 2, sizeBucket: 'small', label: '2-game slate', changed: true,
          legacy: { cash: 'Fade', gpp: 'Pivot' }, note: 'No viable pivot within $500 on a 2-game slate - a Pivot, not a Fade',
        },
      },
    }
    const { unmount } = render(<MemoryRouter><PlayerCardView card={changed} onClose={() => {}} /></MemoryRouter>)
    const note = screen.getByTestId('verdict-slate-note')
    expect(note).toHaveTextContent('Slate size changed the call.')
    expect(note).toHaveTextContent('No viable pivot within $500 on a 2-game slate')
    expect(note).toHaveTextContent('any slate size: cash Fade, GPP Pivot')
    unmount()

    const same = { ...c, verdict: { ...c.verdict, slate: { ...changed.verdict.slate, changed: false, note: null } } }
    render(<MemoryRouter><PlayerCardView card={same} onClose={() => {}} /></MemoryRouter>)
    expect(screen.queryByTestId('verdict-slate-note')).toBeNull()
  })

  it('shows the minutes upside section: score, reasons, band and the correction', () => {
    render(<MemoryRouter><PlayerCardView card={fadeCard()} onClose={() => {}} /></MemoryRouter>)
    const section = screen.getByRole('heading', { name: 'Minutes upside' }).closest('section')
    expect(within(section).getByText('62')).toBeInTheDocument()
    expect(within(section).getByText('RotoWire +6.5 min')).toBeInTheDocument()
    expect(within(section).getByText('teammate out')).toBeInTheDocument()
    expect(within(section).getByText('RotoWire +6.5 min vs ours')).toBeInTheDocument()
    expect(within(section).getByRole('img', { name: 'Minutes: ours 31.5, p10 24.1 to p90 37.8, RotoWire 33.0' })).toBeInTheDocument()
    expect(within(section).getByText('Before correction')).toBeInTheDocument()
    expect(within(section).getByText('80%')).toBeInTheDocument()
    expect(within(section).getByText('Actual 36')).toBeInTheDocument()
  })

  it('handles a rookie with no history or model rows', () => {
    render(<MemoryRouter><PlayerCardView card={rookieCard()} onClose={() => {}} /></MemoryRouter>)
    expect(screen.getByText('No games yet this season or last')).toBeInTheDocument()
    expect(screen.getByText('No minutes history')).toBeInTheDocument()
    expect(screen.getByText('No role profile yet')).toBeInTheDocument()
    expect(screen.getByText(/No saved slates with a result/)).toBeInTheDocument()
    expect(screen.queryByText('What actually happened')).not.toBeInTheDocument()
    expect(screen.getByText(/Some data unavailable: own model/)).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Minutes upside' })).not.toBeInTheDocument()
  })
})

describe('injury-tag risk badges', () => {
  const risk = { injury_tag: 'QUES', injury_risk: 'medium', injury_play_prob: 0.68, injury_tag_play_prob: 0.68, injury_discount: 0.68, projection_if_plays: 22.5 }

  it('player card header: Q-risk badge from the projection fields', () => {
    const card = fadeCard()
    card.player.injury_status = 'QUES'
    Object.assign(card.projection, risk)
    render(<MemoryRouter><PlayerCardView card={card} onClose={() => {}} /></MemoryRouter>)
    expect(screen.getByText('Q 68%')).toHaveAttribute('aria-label', 'Questionable: plays ~68% of the time; projection shown x0.68 (if he plays: 22.5)')
  })

  it('studio player pool: badge next to the name', () => {
    const players = [{ id: 7, player_id: 'p7', name: 'Cheap Guard', position: 'PG', team: 'BOS', opponent: 'NYK', salary: 4500, projected_points: 15.3, rostership: 5, injury_status: 'QUES', ...risk }]
    withCard(<PlayerPoolTable players={players} locked={new Set()} excluded={new Set()} onToggleLock={() => {}} onToggleExclude={() => {}} onClear={() => {}} />)
    const row = screen.getByRole('button', { name: 'Open Cheap Guard card' }).closest('tr')
    expect(within(row).getByText('Q 68%')).toHaveAttribute('data-risk', 'medium')
  })
})

describe('opening the card', () => {
  it('player pool: name opens the card; row lock / exclude still work and do not open it', async () => {
    withCard(<PlayerPoolPage />)
    await screen.findByRole('button', { name: 'Open Nikola Jokic card' })

    // Lock in the row saves the control, no card
    fireEvent.click(screen.getByRole('button', { name: 'Lock Derrick White' }))
    await waitFor(() => expect(playerSettingsAPI.save).toHaveBeenCalledWith('s1', 'p2', expect.objectContaining({ lock: true })))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Exclude Nikola Jokic' }))
    await waitFor(() => expect(playerSettingsAPI.save).toHaveBeenCalledWith('s1', 'p1', expect.objectContaining({ exclude: true })))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Open Nikola Jokic card' }))
    const dialog = await screen.findByRole('dialog', { name: 'Nikola Jokic card' })
    expect(playersAPI.getCard).toHaveBeenCalledWith('s1', '1', {})
    expect(await within(dialog).findByLabelText(/^Cash:/)).toBeInTheDocument()

    // Lock from the card goes through the page's controls (and clears the exclusion)
    playerSettingsAPI.save.mockClear()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Lock' }))
    await waitFor(() => expect(playerSettingsAPI.save).toHaveBeenCalledWith('s1', 'p1', expect.objectContaining({ lock: true, exclude: false })))
    expect(within(dialog).getByRole('button', { name: 'Locked' })).toHaveAttribute('aria-pressed', 'true')

    fireEvent.click(within(dialog).getByRole('button', { name: 'Close player card' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('lineup studio pool: lock / exclude buttons unchanged, name opens the card, card lock toggles the table set', async () => {
    const onToggleLock = vi.fn()
    const onToggleExclude = vi.fn()
    withCard(
      <PlayerPoolTable players={PLAYERS} locked={new Set()} excluded={new Set()} onToggleLock={onToggleLock} onToggleExclude={onToggleExclude} onClear={() => {}} />,
    )
    const row = screen.getByRole('button', { name: 'Open Derrick White card' }).closest('tr')
    fireEvent.click(within(row).getByRole('button', { name: 'Lock' }))
    expect(onToggleLock).toHaveBeenCalledWith(2)
    fireEvent.click(within(row).getByRole('button', { name: 'Exclude' }))
    expect(onToggleExclude).toHaveBeenCalledWith(2)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Open Derrick White card' }))
    const dialog = await screen.findByRole('dialog', { name: 'Derrick White card' })
    await within(dialog).findByLabelText(/^Cash:/)
    onToggleLock.mockClear()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Lock' }))
    expect(onToggleLock).toHaveBeenCalledWith(2)
    // No exposure input when the table has no exposure control
    expect(within(dialog).queryByLabelText('Max exposure %')).not.toBeInTheDocument()
  })

  it('manual builder: row click still places the player; the info button opens the card instead', async () => {
    const onSlotsChange = vi.fn()
    const siteConfig = { salaryCap: 50000, rosterSlots: [{ slot: 'PG', eligible: ['PG'] }, { slot: 'C', eligible: ['C'] }, { slot: 'UTIL', eligible: ['PG', 'SG', 'C'] }] }
    withCard(
      <ManualBuilder siteConfig={siteConfig} players={PLAYERS} slots={[null, null, null]} onSlotsChange={onSlotsChange} onSave={() => {}} onExport={() => {}} />,
    )
    fireEvent.click(screen.getByText('Nikola Jokic'))
    expect(onSlotsChange).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Open Derrick White card' }))
    expect(await screen.findByRole('dialog', { name: 'Derrick White card' })).toBeInTheDocument()
    expect(onSlotsChange).toHaveBeenCalledTimes(1)
  })

  it('shows a skeleton while loading and an error with retry', async () => {
    let fail = true
    playersAPI.getCard.mockImplementation(() => (fail ? Promise.reject(new Error('boom')) : Promise.resolve({ data: cardFor(PLAYERS[0]) })))
    withCard(<PlayerPoolTable players={PLAYERS} locked={new Set()} excluded={new Set()} onToggleLock={() => {}} onToggleExclude={() => {}} onClear={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'Open Nikola Jokic card' }))
    expect(screen.getByLabelText('Loading Nikola Jokic card')).toBeInTheDocument()
    expect(await screen.findByText("Couldn't load the player card")).toBeInTheDocument()
    fail = false
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByLabelText(/^Cash:/)).toBeInTheDocument()
  })
})
