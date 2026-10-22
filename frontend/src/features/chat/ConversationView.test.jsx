import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import ConversationView from './ConversationView'

// Count markdown renders by content to see which messages re-render
const renders = vi.hoisted(() => [])
vi.mock('react-markdown', () => ({
  default: ({ children }) => {
    renders.push(children)
    return <div>{children}</div>
  },
}))

beforeEach(() => {
  renders.length = 0
})

const idle = { isStreaming: false, content: '', timeline: null }
const MESSAGES = [
  { role: 'user', content: 'Best value?', created_at: '2026-10-22T20:00:00Z' },
  { role: 'assistant', content: 'Max Christie.', created_at: '2026-10-22T20:00:05Z' },
]

// jsdom has no layout; give the scroller fixed metrics and a writable scrollTop
function fakeLayout(el, { clientHeight = 400 } = {}) {
  const box = { scrollHeight: 1000, scrollTop: 0 }
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => clientHeight })
  Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => box.scrollHeight })
  Object.defineProperty(el, 'scrollTop', {
    configurable: true,
    get: () => box.scrollTop,
    set: (v) => {
      box.scrollTop = Math.min(v, box.scrollHeight - clientHeight)
    },
  })
  return box
}

const view = (props) => <ConversationView messages={MESSAGES} stream={idle} showReasoning headshots={{}} welcome={<p>Welcome!</p>} {...props} />

describe('ConversationView auto-scroll', () => {
  it('follows streaming text, pauses when the user scrolls up, and resumes via Jump to latest', () => {
    const { rerender } = render(view())
    const scroller = screen.getByTestId('conversation-scroll')
    const box = fakeLayout(scroller)

    rerender(view({ stream: { ...idle, isStreaming: true, content: 'Jokic' } }))
    expect(box.scrollTop).toBe(600)
    expect(screen.queryByRole('button', { name: 'Jump to latest' })).not.toBeInTheDocument()

    // user scrolls up -> following stops
    box.scrollTop = 100
    fireEvent.scroll(scroller)
    box.scrollHeight = 1400
    rerender(view({ stream: { ...idle, isStreaming: true, content: 'Jokic is the top play tonight' } }))
    expect(box.scrollTop).toBe(100)

    fireEvent.click(screen.getByRole('button', { name: 'Jump to latest' }))
    expect(box.scrollTop).toBe(1000)
    expect(screen.queryByRole('button', { name: 'Jump to latest' })).not.toBeInTheDocument()

    box.scrollHeight = 1600
    rerender(view({ stream: { ...idle, isStreaming: true, content: 'Jokic is the top play tonight, then Doncic' } }))
    expect(box.scrollTop).toBe(1200)
  })

  it('resumes following when the user scrolls back to the bottom', () => {
    const { rerender } = render(view())
    const scroller = screen.getByTestId('conversation-scroll')
    const box = fakeLayout(scroller)

    box.scrollTop = 0
    fireEvent.scroll(scroller)
    expect(screen.getByRole('button', { name: 'Jump to latest' })).toBeInTheDocument()

    box.scrollTop = 590
    fireEvent.scroll(scroller)
    expect(screen.queryByRole('button', { name: 'Jump to latest' })).not.toBeInTheDocument()
    box.scrollHeight = 1200
    rerender(view({ stream: { ...idle, isStreaming: true, content: 'More' } }))
    expect(box.scrollTop).toBe(800)
  })

  it('shows a skeleton while history loads', () => {
    render(view({ messages: [], loading: true }))
    expect(screen.getByRole('status', { name: 'Loading conversation' })).toBeInTheDocument()
    expect(screen.queryByText('Welcome!')).not.toBeInTheDocument()
  })
})

describe('ConversationView states', () => {
  it('shows the welcome screen for an empty chat, scrolled to the top', () => {
    const { rerender } = render(view())
    const box = fakeLayout(screen.getByTestId('conversation-scroll'))
    box.scrollTop = 600
    rerender(view({ messages: [] }))
    expect(screen.getByText('Welcome!')).toBeInTheDocument()
    expect(box.scrollTop).toBe(0)
  })

  it('shows an error with retry when a saved chat fails to load', () => {
    const retry = vi.fn()
    render(view({ messages: [], historyError: 'Server down', onRetryHistory: retry }))
    expect(screen.getByText("Couldn't load this conversation")).toBeInTheDocument()
    expect(screen.queryByText('Welcome!')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(retry).toHaveBeenCalled()
  })

  it('re-renders only the live message as tokens stream in', () => {
    const live = (content) => ({ isStreaming: true, content, timeline: null })
    const { rerender } = render(view({ stream: live('Str') }))
    // User prompts are plain bubbles, so only the answer and the live message use markdown
    expect(renders).toEqual(['Max Christie.', 'Str'])

    renders.length = 0
    rerender(view({ stream: live('Streaming') }))
    rerender(view({ stream: live('Streaming more') }))
    expect(renders).toEqual(['Streaming', 'Streaming more'])
  })
})
