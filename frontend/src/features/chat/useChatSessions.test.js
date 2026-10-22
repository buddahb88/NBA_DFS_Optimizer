import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import useChatSessions from './useChatSessions'
import { chatAPI } from '../../services/api'

vi.mock('../../services/api', () => ({
  chatAPI: { getSessions: vi.fn(), getSessionHistory: vi.fn(), deleteSession: vi.fn(), renameSession: vi.fn() },
}))

const SESSIONS = [
  { id: 1, title: 'First', updated_at: '2026-10-22 10:00:00', message_count: 2 },
  { id: 2, title: 'Second', updated_at: '2026-10-21 10:00:00', message_count: 4 },
]
const MESSAGES = [{ role: 'user', content: 'hi', created_at: '2026-10-22 10:00:00' }]

beforeEach(() => {
  vi.clearAllMocks()
  chatAPI.getSessions.mockResolvedValue({ data: { success: true, sessions: SESSIONS } })
  chatAPI.getSessionHistory.mockResolvedValue({ data: { success: true, messages: MESSAGES } })
  chatAPI.deleteSession.mockResolvedValue({ data: { success: true } })
  chatAPI.renameSession.mockResolvedValue({ data: { success: true, session: { id: 2, title: 'Renamed' } } })
})

const load = async () => {
  const hook = renderHook(() => useChatSessions())
  await waitFor(() => expect(hook.result.current.loading).toBe(false))
  return hook
}

describe('useChatSessions', () => {
  it('loads sessions on mount', async () => {
    const { result } = await load()
    expect(result.current.sessions).toEqual(SESSIONS)
    expect(result.current.activeSessionId).toBeNull()
    expect(result.current.error).toBeNull()
  })

  it('reports a load failure', async () => {
    chatAPI.getSessions.mockRejectedValue(new Error('down'))
    const { result } = await load()
    expect(result.current.sessions).toEqual([])
    expect(result.current.error).toMatch(/could not load/i)
  })

  it('selectSession fetches the history and marks the session active', async () => {
    const { result } = await load()
    let messages
    await act(async () => {
      messages = await result.current.selectSession(2)
    })
    expect(chatAPI.getSessionHistory).toHaveBeenCalledWith(2)
    expect(messages).toEqual(MESSAGES)
    expect(result.current.activeSessionId).toBe(2)
  })

  it('deleteSession removes the row and clears the active session when it was active', async () => {
    const { result } = await load()
    await act(async () => {
      await result.current.selectSession(1)
    })
    let outcome
    await act(async () => {
      outcome = await result.current.deleteSession(1)
    })
    expect(chatAPI.deleteSession).toHaveBeenCalledWith(1)
    expect(outcome).toEqual({ ok: true, wasActive: true })
    expect(result.current.sessions.map((s) => s.id)).toEqual([2])
    expect(result.current.activeSessionId).toBeNull()
  })

  it('renameSession updates the title in place from the server response', async () => {
    const { result } = await load()
    let ok
    await act(async () => {
      ok = await result.current.renameSession(2, 'Renamed')
    })
    expect(ok).toBe(true)
    expect(chatAPI.renameSession).toHaveBeenCalledWith(2, 'Renamed')
    expect(result.current.sessions.find((s) => s.id === 2).title).toBe('Renamed')
  })

  it('renameSession leaves the list alone when the server rejects it', async () => {
    chatAPI.renameSession.mockRejectedValue(new Error('nope'))
    const { result } = await load()
    let ok
    await act(async () => {
      ok = await result.current.renameSession(2, 'Renamed')
    })
    expect(ok).toBe(false)
    expect(result.current.sessions.find((s) => s.id === 2).title).toBe('Second')
  })
})
