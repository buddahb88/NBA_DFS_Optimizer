import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import ChatPage from '../../pages/ChatPage'
import { chatAPI, playerSettingsAPI, playersAPI } from '../../services/api'
import { useSlate } from '../../context/SlateContext'
import useMediaQuery from '../../hooks/useMediaQuery'

vi.mock('../../services/api', () => ({
  chatAPI: { getSessions: vi.fn(), getSessionHistory: vi.fn(), deleteSession: vi.fn(), renameSession: vi.fn(), sendFeedback: vi.fn(), getSuggestions: vi.fn() },
  playersAPI: { getBySlateId: vi.fn() },
  playerSettingsAPI: { getBySlateId: vi.fn(), save: vi.fn() },
  lineupsAPI: { create: vi.fn() },
}))
vi.mock('../../context/SlateContext', () => ({ useSlate: vi.fn() }))
vi.mock('../../hooks/useMediaQuery', () => ({ default: vi.fn() }))

const SLATE = { slate_id: '42', name: 'Main 7:10 PM ET', start_time: '2026-10-22T23:10:00Z' }
const tip = (iso) => JSON.stringify({ game: { dateTime: iso } })
const PLAYERS = [
  { id: 1, player_id: 'p1', name: 'A One', team: 'LAL', opponent: 'GSW', position: 'PG', salary: 9000, projected_points: 45, raw_data: tip('2026-10-23T02:10:00Z') },
  { name: 'B Two', team: 'GSW', opponent: 'LAL', raw_data: tip('2026-10-23T02:10:00Z') },
  { name: 'C Three', team: 'BOS', opponent: 'NYK', raw_data: tip('2026-10-22T23:10:00Z'), headshot: 'c.png' },
]

// SSE response that ends immediately
const emptyStream = () => ({ ok: true, body: { getReader: () => ({ read: async () => ({ done: true }) }) } })
// SSE response that sends `events` ([type, data]) in one chunk
const sseStream = (events) => {
  const bytes = new TextEncoder().encode(events.map(([type, data]) => `event: ${type}
data: ${JSON.stringify(data)}

`).join(''))
  let sent = false
  return { ok: true, body: { getReader: () => ({ read: async () => (sent ? { done: true } : ((sent = true), { done: false, value: bytes })) }) } }
}
const renderPage = () => render(<MemoryRouter><ChatPage /></MemoryRouter>)

// SSE response that streams one answer and finishes
const answerStream = (text, sessionId = 7) => {
  const sse = [
    `event: message
data: ${JSON.stringify({ text, isComplete: true })}

`,
    `event: done
data: ${JSON.stringify({ sessionId, toolsUsed: [], agentsUsed: [], iterations: 1 })}

`,
  ].join('')
  let sent = false
  return {
    ok: true,
    body: {
      getReader: () => ({
        read: async () => {
          if (sent) return { done: true }
          sent = true
          return { done: false, value: new TextEncoder().encode(sse) }
        },
      }),
    },
  }
}

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
  playerSettingsAPI.getBySlateId.mockResolvedValue({ data: [] })
  chatAPI.getSuggestions.mockResolvedValue({ data: { success: true, suggestions: [] } })
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
    renderPage()
    expect(screen.getByRole('heading', { name: 'New chat' })).toBeInTheDocument()
    const bar = screen.getByRole('region', { name: 'Slate context' })
    expect(within(bar).getByText('Main 7:10 PM ET')).toBeInTheDocument()
    expect(within(bar).getByText('DraftKings')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('region', { name: 'Slate context' })).toHaveTextContent('2 games'))
    const lock = new Date('2026-10-22T23:10:00Z').toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    expect(within(screen.getByRole('region', { name: 'Slate context' })).getByText(/^Lock/)).toHaveTextContent(`Lock ${lock}`)
    expect(playersAPI.getBySlateId).toHaveBeenCalledWith('42')
  })

  it('sends the selected Cash/GPP mode with chat requests', async () => {
    renderPage()
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
    const { unmount } = renderPage()
    const rail = screen.getByRole('complementary', { name: 'Conversations' })
    expect(await within(rail).findByRole('button', { name: /^Lakers stack ideas/ })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Collapse conversations' }))
    expect(screen.queryByRole('searchbox', { name: 'Search conversations' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Lakers stack ideas/ })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Expand conversations' })).toBeInTheDocument()
    expect(localStorage.getItem('nba-dfs:chat-rail-collapsed')).toBe('1')

    unmount()
    renderPage()
    expect(screen.getByRole('button', { name: 'Expand conversations' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Expand conversations' }))
    expect(screen.getByRole('searchbox', { name: 'Search conversations' })).toBeInTheDocument()
  })

  it('on mobile the rail is a slide-over that closes after picking a chat', async () => {
    mediaMatches = false
    renderPage()
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
    renderPage()
    fireEvent.click(screen.getByRole('button', { name: 'Chat settings' }))
    const dialog = screen.getByRole('dialog', { name: 'Chat settings' })
    const toggle = within(dialog).getByRole('switch', { name: /show reasoning/i })
    expect(toggle).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-checked', 'false')
  })

  it('welcome screen shows suggestions generated for the slate; clicking one sends it', async () => {
    chatAPI.getSuggestions.mockResolvedValue({
      data: {
        success: true,
        suggestions: [
          { id: 'game_stack', kind: 'game_stack', label: 'Game stack', prompt: 'Build me a BOS vs NYK game stack.' },
          { id: 'value_play', kind: 'value_play', label: 'Value play', prompt: 'Is Cheap Wing ($4,000, 7x) a safe value play tonight?' },
          { id: 'archetype_edge', kind: 'archetype_edge', label: 'Matchup edge', prompt: "Break down C Three's matchup vs NYK tonight." },
          { id: 'score_lineup', kind: 'score_lineup', label: 'Score a lineup', prompt: 'Score my lineup from last night (2026-10-21).' },
        ],
      },
    })
    render(<ChatPage />)
    expect(chatAPI.getSuggestions).toHaveBeenCalledWith('42')
    const prompts = screen.getByRole('region', { name: 'Suggested prompts' })
    const stack = await within(prompts).findByRole('button', { name: /BOS vs NYK game stack/ })
    expect(within(prompts).getAllByRole('button')).toHaveLength(4)

    fireEvent.click(stack)
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
    expect(sentBody()).toMatchObject({ message: 'Build me a BOS vs NYK game stack.', slateId: '42' })
    expect(screen.queryByRole('region', { name: 'Suggested prompts' })).not.toBeInTheDocument()
  })

  it('welcome screen falls back to static prompts when suggestions fail to load', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    chatAPI.getSuggestions.mockRejectedValue(new Error('Network Error'))
    render(<ChatPage />)
    const prompts = screen.getByRole('region', { name: 'Suggested prompts' })
    expect(await within(prompts).findByRole('button', { name: /top value plays under \$6,000/ })).toBeInTheDocument()
    expect(within(prompts).getAllByRole('button')).toHaveLength(4)
  })

  it('shows an error with retry when a saved chat fails to load', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    chatAPI.getSessionHistory.mockRejectedValueOnce(new Error('boom'))
    render(<ChatPage />)
    fireEvent.click(await screen.findByRole('button', { name: /^Lakers stack ideas/ }))
    expect(await screen.findByText("Couldn't load this conversation")).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByText('Who is chalk?')).toBeInTheDocument()
    expect(chatAPI.getSessionHistory).toHaveBeenCalledTimes(2)
  })

  it('toggles the context drawer', () => {
    renderPage()
    expect(screen.queryByRole('complementary', { name: 'Context' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Toggle context panel' }))
    expect(screen.getByRole('complementary', { name: 'Context' })).toHaveTextContent(/nothing pinned yet/i)
    fireEvent.click(screen.getByRole('button', { name: 'Close context panel' }))
    expect(screen.queryByRole('complementary', { name: 'Context' })).not.toBeInTheDocument()
  })

  it('regenerate replaces the last answer by re-sending the previous prompt', async () => {
    fetch.mockResolvedValueOnce(answerStream('First take: Jokic.')).mockResolvedValueOnce(answerStream('Second take: Doncic.'))
    render(<ChatPage />)
    send('Who is the top C?')
    expect(await screen.findByText('First take: Jokic.')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Regenerate response' }))
    expect(await screen.findByText('Second take: Doncic.')).toBeInTheDocument()
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(sentBody()).toMatchObject({ message: 'Who is the top C?', sessionId: 7 })
    expect(screen.queryByText('First take: Jokic.')).not.toBeInTheDocument()
    expect(screen.getAllByText('Who is the top C?')).toHaveLength(1)
  })

  it('posts thumbs feedback for an answer', async () => {
    fetch.mockResolvedValueOnce(answerStream('Fade the chalk.'))
    chatAPI.sendFeedback.mockResolvedValue({ data: { success: true, id: 1 } })
    render(<ChatPage />)
    send('Leverage spots?')
    await screen.findByText('Fade the chalk.')

    fireEvent.click(screen.getByRole('button', { name: 'Bad response' }))
    await waitFor(() =>
      expect(chatAPI.sendFeedback).toHaveBeenCalledWith({ rating: 'down', sessionId: 7, messageId: undefined, content: 'Fade the chalk.' }),
    )
    expect(screen.getByRole('button', { name: 'Bad response' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('shows a loading skeleton while a conversation loads', async () => {
    let resolveHistory
    chatAPI.getSessionHistory.mockReturnValue(new Promise((r) => (resolveHistory = r)))
    render(<ChatPage />)
    fireEvent.click(await screen.findByRole('button', { name: /^Lakers stack ideas/ }))
    expect(await screen.findByRole('status', { name: 'Loading conversation' })).toBeInTheDocument()
    resolveHistory({ data: { success: true, messages: [{ role: 'user', content: 'Who is chalk?', created_at: new Date().toISOString() }] } })
    expect(await screen.findByText('Who is chalk?')).toBeInTheDocument()
    expect(screen.queryByRole('status', { name: 'Loading conversation' })).not.toBeInTheDocument()
  })

  it('stop aborts the stream and keeps the partial answer marked as stopped', async () => {
    let signal
    const chunk = new TextEncoder().encode('event: session_created\ndata: {"sessionId":9}\n\nevent: message\ndata: {"text":"Partial answer"}\n\n')
    fetch.mockImplementation((url, init) => {
      signal = init.signal
      let sent = false
      const read = () => {
        if (!sent) {
          sent = true
          return Promise.resolve({ done: false, value: chunk })
        }
        return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))))
      }
      return Promise.resolve({ ok: true, body: { getReader: () => ({ read }) } })
    })

    render(<ChatPage />)
    send('Who is chalk tonight?')
    expect(await screen.findByText('Partial answer')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Send message' })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Stop generating' }))
    expect(signal.aborted).toBe(true)
    expect(await screen.findByText('Stopped')).toBeInTheDocument()
    expect(screen.getByText('Partial answer')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled()
    // The session the backend created is adopted so the next message continues it
    await waitFor(() => expect(chatAPI.getSessions).toHaveBeenCalledTimes(2))
    send('And the pivots?')
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))
    expect(sentBody()).toMatchObject({ message: 'And the pivots?', sessionId: 9 })
  })

  it('restores the composer draft per session after a reload', async () => {
    const { unmount } = render(<ChatPage />)
    fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: 'half-written thought' } })
    expect(JSON.parse(localStorage.getItem('nba-dfs:chat-draft:new'))).toMatchObject({ text: 'half-written thought' })

    unmount()
    render(<ChatPage />)
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('half-written thought')

    localStorage.setItem('nba-dfs:chat-draft:7', JSON.stringify({ text: 'session 7 draft', mentions: [] }))
    fireEvent.click(await screen.findByRole('button', { name: /^Lakers stack ideas/ }))
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('session 7 draft'))
    fireEvent.click(screen.getByRole('button', { name: /new chat/i }))
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('half-written thought')
  })

  it('ignores broken draft storage', () => {
    localStorage.setItem('nba-dfs:chat-draft:new', '{not json')
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota')
    })
    render(<ChatPage />)
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('')
    fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: 'still typable' } })
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('still typable')
    setItem.mockRestore()
  })

  it('clears the draft on send, sends mentions, and Up arrow recalls the last message', async () => {
    render(<ChatPage />)
    const box = screen.getByRole('textbox', { name: 'Message' })
    await waitFor(() => expect(playersAPI.getBySlateId).toHaveBeenCalled())
    fireEvent.change(box, { target: { value: 'Fade @C T', selectionStart: 9 } })
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(box).toHaveValue('Fade C Three ')
    fireEvent.keyDown(box, { key: 'Enter' })
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
    expect(sentBody()).toMatchObject({ message: 'Fade C Three', mentions: [{ name: 'C Three', team: 'BOS', player_key: 'c three' }] })
    expect(box).toHaveValue('')
    expect(localStorage.getItem('nba-dfs:chat-draft:new')).toBeNull()

    fireEvent.keyDown(box, { key: 'ArrowUp' })
    expect(box).toHaveValue('Fade C Three')
  })
})

describe('ChatPage agent timeline', () => {
  const sse = (type, data) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`
  const T = (ms) => new Date(Date.UTC(2026, 9, 22, 20, 0, 0, ms)).toISOString()
  const streamOf = (text) => {
    const chunks = [new TextEncoder().encode(text)]
    return { ok: true, body: { getReader: () => ({ read: async () => (chunks.length ? { done: false, value: chunks.shift() } : { done: true }) }) } }
  }

  it('keeps the finished timeline on the answer as a summary chip with a step-limit callout', async () => {
    fetch.mockResolvedValue(
      streamOf(
        sse('agent_spawn', { agent: 'research', task: 'Rank value', timestamp: T(0) }) +
          sse('tool_call', { tool: 'get_archetype_matchups', args: {}, timestamp: T(10) }) +
          sse('tool_result', { tool: 'get_archetype_matchups', result: [], success: true, timestamp: T(400) }) +
          sse('agent_complete', { agent: 'research', result: { success: true, maxIterationsReached: true }, timestamp: T(500) }) +
          sse('message', { text: 'Here are the plays.', isComplete: true, timestamp: T(600) }) +
          sse('done', { sessionId: 7, toolsUsed: [], agentsUsed: ['research'], iterations: 2, timestamp: T(700) }),
      ),
    )
    render(<ChatPage />)
    send('Value plays?')
    await waitFor(() => expect(screen.getByText('Here are the plays.')).toBeInTheDocument())
    expect(screen.getByRole('button', { name: /^Used 1 tool across 1 agent · / })).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByRole('note', { name: 'Agent warnings' })).toHaveTextContent('Research agent hit its step limit before finishing')
  })

  it('renders saved tool/agent metadata for history messages', async () => {
    chatAPI.getSessionHistory.mockResolvedValue({
      data: {
        success: true,
        messages: [
          { role: 'user', content: 'Who is chalk?', created_at: new Date().toISOString() },
          {
            role: 'assistant',
            content: 'Chalk list.',
            created_at: new Date().toISOString(),
            metadata: { toolsUsed: [{ name: 'get_current_slate', args: {} }, { name: 'delegate_to_agent', args: { agent: 'analyst', task: 'Ownership' } }], agentsUsed: ['analyst'] },
          },
        ],
      },
    })
    render(<ChatPage />)
    fireEvent.click(await screen.findByText('Lakers stack ideas'))
    const chip = await screen.findByRole('button', { name: 'Used 1 tool across 1 agent' })
    fireEvent.click(chip)
    const list = screen.getByRole('list', { name: 'Agent activity' })
    expect(list).toHaveTextContent('Loading the current slate')
    expect(list).toHaveTextContent('Analyst agent')
  })
})

// ui_block events as the backend streams them ({ messageId, block }, chatTools/uiBlocks.js)
const PLAYER_BLOCK = {
  messageId: 'm1',
  block: {
    version: 1, id: 'call_1:0', tool: 'get_archetype_matchups', type: 'player_list', title: 'Top values',
    players: [{ name: 'A One', team: 'LAL', opponent: 'GSW', salary: 9000, projection: 45, archetype_label: 'Primary Creator', flags: [] }],
  },
}
const LINEUP_BLOCK = {
  messageId: 'm1',
  block: { version: 1, id: 'call_2:0', tool: 'build_lineup', type: 'lineup', title: 'Chat build', slots: [{ slot: 'PG', player: { name: 'A One' } }], totals: {} },
}

describe('ChatPage ui blocks', () => {
  it('renders streamed blocks on the assistant message, pins to the drawer and shows the lineup there', async () => {
    fetch.mockResolvedValueOnce(sseStream([
      ['ui_block', PLAYER_BLOCK],
      ['ui_block', LINEUP_BLOCK],
      ['ui_block', { messageId: 'm1', block: { version: 1, id: 'call_3:0', type: 'mystery', title: 'Mystery' } }],
      ['message', { text: "Here are tonight's values.", isComplete: true }],
      ['done', { sessionId: 7, messageId: 'm1', toolsUsed: ['get_archetype_matchups'] }],
    ]))
    renderPage()
    send('Values?')

    const card = await screen.findByRole('article', { name: 'A One' })
    expect(within(card).getByText('Primary Creator')).toBeInTheDocument()
    expect(within(card).getByText('5.00x')).toBeInTheDocument()
    expect(screen.getByRole('article', { name: 'Chat build' })).toBeInTheDocument()
    expect(screen.getByRole('note')).toHaveTextContent('Mystery')
    expect(screen.getByText("Here are tonight's values.")).toBeInTheDocument()

    fireEvent.click(within(card).getByRole('button', { name: 'Pin A One' }))
    const toggle = screen.getByRole('button', { name: 'Toggle context panel' })
    expect(toggle).toHaveTextContent('1')
    fireEvent.click(toggle)
    const drawer = screen.getByRole('complementary', { name: 'Context' })
    expect(within(within(drawer).getByRole('region', { name: 'Pinned players' })).getByText('A One')).toBeInTheDocument()
    expect(within(drawer).getByRole('article', { name: 'Chat build' })).toBeInTheDocument()

    // Unpin from the drawer
    fireEvent.click(within(drawer).getByRole('button', { name: 'Unpin A One' }))
    expect(within(drawer).getByRole('region', { name: 'Pinned players' })).toHaveTextContent(/use the pin/i)
  })

  it('renders blocks persisted on history messages', async () => {
    chatAPI.getSessionHistory.mockResolvedValue({
      data: { success: true, messages: [{ role: 'assistant', content: 'Saved earlier.', uiBlocks: [PLAYER_BLOCK.block], created_at: new Date().toISOString() }] },
    })
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: /^Lakers stack ideas/ }))
    expect(await screen.findByRole('article', { name: 'A One' })).toBeInTheDocument()
    expect(screen.getByText('Saved earlier.')).toBeInTheDocument()
  })
})
