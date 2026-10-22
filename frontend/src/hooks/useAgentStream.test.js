import { describe, it, expect, vi, afterEach } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useAgentStream } from './useAgentStream'

const sse = (type, data) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`
const T = (ms) => new Date(Date.UTC(2026, 9, 22, 20, 0, 0, ms)).toISOString()
const block = (id, title) => ({ version: 1, type: 'streaks', id, title, kind: 'hot', players: [] })

// fetch() whose body streams `chunks` (strings) through a reader
function mockFetch(chunks) {
  const encoder = new TextEncoder()
  let i = 0
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true,
    body: {
      getReader: () => ({
        read: async () => (i < chunks.length ? { done: false, value: encoder.encode(chunks[i++]) } : { done: true }),
      }),
    },
  }))
}

afterEach(() => {
  vi.unstubAllGlobals()
})

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
    mockFetch([body.slice(0, 40), body.slice(40)])

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

describe('useAgentStream ui blocks', () => {
  it('collects ui_block events in order, skipping repeated ids, and exposes messageId', async () => {
    const all = [
      sse('connected', {}),
      sse('ui_block', { messageId: 'm1', block: block('call_1:0', 'A') }),
      sse('ui_block', { messageId: 'm1', block: block('call_1:0', 'A') }),
      sse('ui_block', { messageId: 'm1', block: block('call_2:0', 'B') }),
      sse('message', { text: 'Done [[block:call_1:0]]', isComplete: true }),
      sse('done', { sessionId: 7, messageId: 'm1', toolsUsed: [], agentsUsed: [], iterations: 1 }),
    ].join('')
    // Split mid-event to exercise buffering
    mockFetch([all.slice(0, 50), all.slice(50)])

    const { result } = renderHook(() => useAgentStream())
    await act(() => result.current.startStream('who is hot?'))

    expect(result.current.uiBlocks.map((b) => b.title)).toEqual(['A', 'B'])
    expect(result.current.metadata.messageId).toBe('m1')
    expect(result.current.message).toBe('Done [[block:call_1:0]]')

    act(() => result.current.reset())
    expect(result.current.uiBlocks).toEqual([])
  })

  it('no ui_block events leaves uiBlocks empty (markdown only)', async () => {
    mockFetch([sse('message', { text: 'Plain', isComplete: true }), sse('done', { sessionId: 1 })])
    const { result } = renderHook(() => useAgentStream())
    await act(() => result.current.startStream('hi'))
    expect(result.current.uiBlocks).toEqual([])
    expect(result.current.message).toBe('Plain')
  })
})
