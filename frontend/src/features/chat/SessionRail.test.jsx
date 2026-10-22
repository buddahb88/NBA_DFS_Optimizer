import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import SessionRail from './SessionRail'

const NOW = new Date(2026, 9, 22, 15, 0, 0)
const daysAgo = (n) => {
  const d = new Date(NOW)
  d.setDate(d.getDate() - n)
  return d.toISOString()
}
const SESSIONS = [
  { id: 1, title: 'Lakers stack ideas', updated_at: daysAgo(0), message_count: 4 },
  { id: 2, title: 'Value plays', updated_at: daysAgo(1), message_count: 2 },
  { id: 3, title: 'Cash core', updated_at: daysAgo(4), message_count: 6 },
  { id: 4, title: 'Old slate', updated_at: daysAgo(30), message_count: 1 },
]

const props = (over = {}) => ({
  sessions: SESSIONS,
  loading: false,
  error: null,
  activeSessionId: 2,
  onToggleCollapse: vi.fn(),
  onNewChat: vi.fn(),
  onSelect: vi.fn(),
  onRename: vi.fn().mockResolvedValue(true),
  onDelete: vi.fn().mockResolvedValue(undefined),
  ...over,
})

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
})
afterEach(() => vi.useRealTimers())

const groupTitles = (group) => within(group).getAllByRole('listitem').map((li) => within(li).getAllByRole('button')[0].textContent)

describe('SessionRail', () => {
  it('groups sessions under Today / Yesterday / Previous 7 days / Older', () => {
    render(<SessionRail {...props()} />)
    const groups = screen.getAllByRole('region')
    expect(groups.map((g) => within(g).getByRole('heading').textContent)).toEqual(['Today', 'Yesterday', 'Previous 7 days', 'Older'])
    expect(groupTitles(groups[0])[0]).toMatch('Lakers stack ideas')
    expect(groupTitles(groups[3])[0]).toMatch('Old slate')
    expect(screen.getByRole('button', { name: /^value plays/i })).toHaveAttribute('aria-current', 'true')
  })

  it('filters by the search box', () => {
    render(<SessionRail {...props()} />)
    fireEvent.change(screen.getByRole('searchbox', { name: /search conversations/i }), { target: { value: 'cash' } })
    expect(screen.getAllByRole('region')).toHaveLength(1)
    expect(screen.getByRole('button', { name: /^cash core/i })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^lakers stack ideas/i })).not.toBeInTheDocument()

    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'zzz' } })
    expect(screen.getByText(/no chats match/i)).toBeInTheDocument()
  })

  it('selects a session and starts a new chat', () => {
    const p = props()
    render(<SessionRail {...p} />)
    fireEvent.click(screen.getByRole('button', { name: /^cash core/i }))
    expect(p.onSelect).toHaveBeenCalledWith(3)
    fireEvent.click(screen.getByRole('button', { name: /^new chat/i }))
    expect(p.onNewChat).toHaveBeenCalled()
  })

  it('renames inline: Enter saves through onRename, Escape cancels', async () => {
    const p = props()
    render(<SessionRail {...p} />)
    fireEvent.click(screen.getByRole('button', { name: 'Rename Old slate' }))
    const field = screen.getByRole('textbox', { name: /conversation title/i })
    fireEvent.change(field, { target: { value: '  Opening night  ' } })
    fireEvent.keyDown(field, { key: 'Enter' })
    await waitFor(() => expect(p.onRename).toHaveBeenCalledWith(4, 'Opening night'))

    fireEvent.click(screen.getByRole('button', { name: 'Rename Cash core' }))
    fireEvent.keyDown(screen.getByRole('textbox', { name: /conversation title/i }), { key: 'Escape' })
    expect(screen.queryByRole('textbox', { name: /conversation title/i })).not.toBeInTheDocument()
    expect(p.onRename).toHaveBeenCalledTimes(1)
  })

  it('asks for confirmation before deleting', async () => {
    const p = props()
    render(<SessionRail {...p} />)
    fireEvent.click(screen.getByRole('button', { name: 'Delete Value plays' }))
    const dialog = screen.getByRole('dialog', { name: /delete conversation/i })
    expect(p.onDelete).not.toHaveBeenCalled()

    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(p.onDelete).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Delete Value plays' }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(p.onDelete).toHaveBeenCalledWith(2))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('collapsed: renders an icon rail with expand and new chat, no list', () => {
    const p = props({ collapsed: true })
    render(<SessionRail {...p} />)
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^lakers/i })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Expand conversations' }))
    expect(p.onToggleCollapse).toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'New chat' }))
    expect(p.onNewChat).toHaveBeenCalled()
  })
})
