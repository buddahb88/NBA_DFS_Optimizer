import { describe, it, expect, vi, afterEach } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useAgentStream } from './useAgentStream'

const sse = (type, data) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`
const T = (ms) => new Date(Date.UTC(2026, 9, 22, 20, 0, 0, ms)).toISOString()

// Body whose reader yields each chunk once, splitting one event across chunks
function streamOf(text) {
  const enc = new TextEncoder()
  const chunks = [text.slice(0, 40), text.slice(40)].map((c) => enc.encode(c))
  return { ok: true, body: { getReader: () => ({ read: async () => (chunks.length ? { done: false, value: chunks.shift() } : { done: true }) }) } }
}

afterEach(() => vi.unstubAllGlobals())

describe('useAgentStream timeline', () => {
  it('builds ordered timeline steps from the SSE events', async () => {
    const body =
      sse('connected', { timestamp: T(0) }) +
      sse('agent_spawn', { agent: 'research', task: 'Rank value', timestamp: T(10) }) +
      sse('tool_call', { tool: 'get_archetype_matchups', args: { team: 'LAL' }, timestamp: T(20) }) +
      sse('tool_result', { tool: 'get_archetype_matchups', result: [1, 2], success: true, timestamp: T(820) }) +
      sse('agent_complete', { agent: 'research', result: { success: true, maxIterationsReached: true }, timestamp: T(900) }) +
      sse('message', { text: 'Done.', isComplete: true, timestamp: T(950) }) +
      sse('done', { sessionId: 3, toolsUsed: [], agentsUsed: ['research'], iterations: 2, timestamp: T(1000) })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(streamOf(body)))

    const { result } = renderHook(() => useAgentStream())
    await act(() => result.current.startStream('hi'))

    const { timeline } = result.current
    expect(timeline.steps.map((s) => s.kind)).toEqual(['agent', 'tool'])
    expect(timeline.steps[1]).toMatchObject({ tool: 'get_archetype_matchups', agent: 'research', status: 'success', preview: '2 rows' })
    expect(timeline.steps[1].endedAt - timeline.steps[1].startedAt).toBe(800)
    expect(timeline.steps[0].stepLimitHit).toBe(true)
    expect(timeline.endedAt).not.toBeNull()
    expect(result.current.message).toBe('Done.')

    act(() => result.current.reset())
    expect(result.current.timeline.steps).toEqual([])
  })
})
