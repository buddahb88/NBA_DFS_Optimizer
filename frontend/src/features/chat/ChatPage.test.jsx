import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import ChatPage from '../../pages/ChatPage'
import { chatAPI, playersAPI } from '../../services/api'
import { useSlate } from '../../context/SlateContext'
import useMediaQuery from '../../hooks/useMediaQuery'

vi.mock('../../services/api', () => ({
  chatAPI: { getSessions: vi.fn(), getSessionHistory: vi.fn(), deleteSession: vi.fn(), renameSession: vi.fn() },
  playersAPI: { getBySlateId: vi.fn() },
}))
vi.mock('../../context/SlateContext', () => ({ useSlate: vi.fn() }))
vi.mock('../../hooks/useMediaQuery', () => ({ default: vi.fn() }))

const SLATE = { slate_id: '42', name: 'Main 7:10 PM ET', start_time: '2026-10-22T23:10:00Z' }
const tip = (iso) => JSON.stringify({ game: { dateTime: iso } })
const PLAYERS = [
  { name: 'A One', team: 'LAL', opponent: 'GSW', raw_data: tip('2026-10-23T02:10:00Z') },
  { name: 'B Two', team: 'GSW', opponent: 'LAL', raw_data: tip('2026-10-23T02:10:00Z') },
  { name: 'C Three', team: 'BOS', opponent: 'NYK', raw_data: tip('2026-10-22T23:10:00Z'), headshot: 'c.png' },
]

// SSE response that ends immediately
const emptyStream = () => ({ ok: true, body: { getReader: () => ({ read: async () => ({ done: true }) }) } })

let mediaMatches
beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  mediaMatches = true
  useMediaQuery.mockImplementation(() => mediaMatches)
  useSlate.mockReturnValue({ slate: SLATE, slateId: '42', site: 'draftkings', siteConfig: { key: 'draftkings', name: 'DraftKings' } })
  chatAPI.getSessions.mockResolvedValue({
    data: { success: true, sessions: [{ id: 7, title: 'Lakers stack ideas', updated_at: new Date().toISOString(), message_count: 2 }] },
  })
  chatAPI.getSessionHistory.mockResolvedValue({ data: { success: true, messages: [{ role: 'user', content: 'Who is chalk?', created_at: new Date().toISOString() }] } })
  playersAPI.getBySlateId.mockResolvedValue({ data: PLAYERS })
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(emptyStream()))
})
afterEach(() => vi.unstubAllGlobals())

const sentBody = () => JSON.parse(fetch.mock.calls.at(-1)[1].body)
const send = (text) => {
  fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: text } })
  fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
}

describe('ChatPage shell', () => {
  it('renders the slate context bar from the slate and its players', async () => {
    render(<ChatPage />)
    expect(screen.getByRole('heading', { name: 'New chat' })).toBeInTheDocument()
    expect(screen.getByText('Main 7:10 PM ET')).toBeInTheDocument()
    expect(screen.getByText('DraftKings')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('region', { name: 'Slate context' })).toHaveTextContent('2 games'))
    const lock = new Date('2026-10-22T23:10:00Z').toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    expect(within(screen.getByRole('region', { name: 'Slate context' })).getByText(/^Lock/)).toHaveTextContent(`Lock ${lock}`)
    expect(playersAPI.getBySlateId).toHaveBeenCalledWith('42')
  })

  it('sends the selected Cash/GPP mode with chat requests', async () => {
    render(<ChatPage />)
    const modes = screen.getByRole('group', { name: 'Contest mode' })
    expect(within(modes).getByRole('tab', { name: 'GPP' })).toHaveAttribute('aria-selected', 'true')

    send('Best value plays?')
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
    expect(fetch.mock.calls[0][0]).toMatch(/\/chat\/stream$/)
    expect(sentBody()).toMatchObject({ message: 'Best value plays?', slateId: '42', maxIterations: 10, mode: 'gpp' })

    fireEvent.click(within(modes).getByRole('tab', { name: 'Cash' }))
    expect(within(modes).getByRole('tab', { name: 'Cash' })).toHaveAttribute('aria-selected', 'true')
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Message' })).not.toBeDisabled())
    send('Safe core?')
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))
    expect(sentBody()).toMatchObject({ message: 'Safe core?', mode: 'cash' })
  })

  it('collapses the session rail to an icon rail and remembers it', async () => {
    const { unmount } = render(<ChatPage />)
    const rail = screen.getByRole('complementary', { name: 'Conversations' })
    expect(await within(rail).findByRole('button', { name: /^Lakers stack ideas/ })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Collapse conversations' }))
    expect(screen.queryByRole('searchbox', { name: 'Search conversations' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Lakers stack ideas/ })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Expand conversations' })).toBeInTheDocument()
    expect(localStorage.getItem('nba-dfs:chat-rail-collapsed')).toBe('1')

    unmount()
    render(<ChatPage />)
    expect(screen.getByRole('button', { name: 'Expand conversations' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Expand conversations' }))
    expect(screen.getByRole('searchbox', { name: 'Search conversations' })).toBeInTheDocument()
  })

  it('on mobile the rail is a slide-over that closes after picking a chat', async () => {
    mediaMatches = false
    render(<ChatPage />)
    expect(screen.queryByRole('complementary', { name: 'Conversations' })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Open conversations' }))
    const dialog = screen.getByRole('dialog')
    fireEvent.click(await within(dialog).findByRole('button', { name: /^Lakers stack ideas/ }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(chatAPI.getSessionHistory).toHaveBeenCalledWith(7)
    expect(await screen.findByText('Who is chalk?')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Lakers stack ideas' })).toBeInTheDocument()
  })

  it('opens chat settings in a modal from the header', () => {
    render(<ChatPage />)
    fireEvent.click(screen.getByRole('button', { name: 'Chat settings' }))
    const dialog = screen.getByRole('dialog', { name: 'Chat settings' })
    const toggle = within(dialog).getByRole('switch', { name: /show reasoning/i })
    expect(toggle).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-checked', 'false')
  })

  it('toggles the context drawer', () => {
    render(<ChatPage />)
    expect(screen.queryByRole('complementary', { name: 'Context' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Toggle context panel' }))
    expect(screen.getByRole('complementary', { name: 'Context' })).toHaveTextContent(/nothing pinned yet/i)
    fireEvent.click(screen.getByRole('button', { name: 'Close context panel' }))
    expect(screen.queryByRole('complementary', { name: 'Context' })).not.toBeInTheDocument()
  })
})
