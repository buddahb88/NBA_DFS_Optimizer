import { describe, it, expect } from 'vitest'
import {
  createTimeline,
  formatDuration,
  summarizeTimeline,
  timelineFromMetadata,
  timelineReducer,
  timelineWarnings,
  toolLabel,
} from './timelineSteps'

const T0 = Date.parse('2026-10-22T20:00:00.000Z')
const ts = (ms) => new Date(T0 + ms).toISOString()

// Scripted SSE sequence: orchestrator checks the slate, delegates to research
// (two tools, one fails) and then optimizer, which hits its step limit.
const SCRIPT = [
  ['thinking', { text: 'Analyzing your request...', timestamp: ts(0) }],
  ['iteration', { current: 1, max: 10, timestamp: ts(10) }],
  ['thinking', { text: 'Using get_current_slate...', timestamp: ts(20) }],
  ['tool_call', { tool: 'get_current_slate', args: {}, timestamp: ts(20) }],
  ['tool_result', { tool: 'get_current_slate', result: { slate_id: '42', games: 7 }, success: true, timestamp: ts(320) }],
  ['tool_call', { tool: 'delegate_to_agent', args: { agent: 'research', task: 'Rank value plays' }, timestamp: ts(400) }],
  ['agent_spawn', { agent: 'research', task: 'Rank value plays', timestamp: ts(410) }],
  ['thinking', { text: '[research] Using get_archetype_matchups tool...', timestamp: ts(500) }],
  ['tool_call', { tool: 'get_archetype_matchups', args: { team: 'LAL' }, timestamp: ts(500) }],
  ['tool_result', { tool: 'get_archetype_matchups', result: { players: [{}, {}, {}] }, success: true, timestamp: ts(1700) }],
  ['tool_call', { tool: 'get_usage_bumps', args: {}, timestamp: ts(1800) }],
  ['tool_result', { tool: 'get_usage_bumps', result: { success: false, error: 'no injuries table' }, success: false, timestamp: ts(1900) }],
  ['agent_complete', { agent: 'research', result: { success: true, message: 'ok' }, timestamp: ts(2000) }],
  ['tool_result', { tool: 'delegate_to_agent', result: { success: true }, success: true, timestamp: ts(2010) }],
  ['tool_call', { tool: 'delegate_to_agent', args: { agent: 'optimizer', task: 'Build lineup' }, timestamp: ts(2100) }],
  ['agent_spawn', { agent: 'optimizer', task: 'Build lineup', timestamp: ts(2110) }],
  ['tool_call', { tool: 'build_lineup', args: { locks: ['Luka Doncic'] }, timestamp: ts(2200) }],
  ['tool_result', { tool: 'build_lineup', result: [{}, {}], success: true, timestamp: ts(3000) }],
  ['agent_complete', { agent: 'optimizer', result: { success: true, maxIterationsReached: true }, timestamp: ts(3100) }],
  ['tool_result', { tool: 'delegate_to_agent', result: { success: true }, success: true, timestamp: ts(3110) }],
  ['done', { sessionId: 7, maxIterationsReached: false, timestamp: ts(3200) }],
]

function play(events = SCRIPT) {
  let state = timelineReducer(createTimeline(), { type: 'start', now: T0 })
  for (const [type, data] of events) state = timelineReducer(state, { type: 'event', event: type, data, now: 0 })
  return timelineReducer(state, { type: 'end', now: T0 + 3250 })
}

describe('timelineReducer', () => {
  it('keeps an ordered list of agent and tool steps, folding delegate_to_agent into the agent', () => {
    const { steps } = play()
    expect(steps.map((s) => [s.kind, s.kind === 'tool' ? s.tool : s.kind === 'agent' ? s.agent : s.text])).toEqual([
      ['thought', 'Analyzing your request...'],
      ['tool', 'get_current_slate'],
      ['agent', 'research'],
      ['tool', 'get_archetype_matchups'],
      ['tool', 'get_usage_bumps'],
      ['agent', 'optimizer'],
      ['tool', 'build_lineup'],
    ])
    expect(steps.filter((s) => s.kind === 'tool').map((s) => s.agent)).toEqual(['orchestrator', 'research', 'research', 'optimizer'])
  })

  it('records start/end timestamps from the events and derives durations', () => {
    const { steps, startedAt, endedAt } = play()
    const byName = Object.fromEntries(steps.filter((s) => s.kind !== 'thought').map((s) => [s.tool || s.agent, s]))
    expect(byName.get_current_slate.endedAt - byName.get_current_slate.startedAt).toBe(300)
    expect(byName.get_archetype_matchups.endedAt - byName.get_archetype_matchups.startedAt).toBe(1200)
    expect(byName.research.endedAt - byName.research.startedAt).toBe(1590)
    expect(endedAt - startedAt).toBe(3250)
  })

  it('marks success, tool errors and agent step-limit hits', () => {
    const { steps } = play()
    const find = (name) => steps.find((s) => s.tool === name || s.agent === name)
    expect(find('get_current_slate').status).toBe('success')
    expect(find('get_usage_bumps')).toMatchObject({ status: 'error', error: 'no injuries table' })
    expect(find('research')).toMatchObject({ status: 'success', stepLimitHit: false })
    expect(find('optimizer')).toMatchObject({ status: 'success', stepLimitHit: true })
  })

  it('stores a short result preview instead of the raw payload', () => {
    const { steps } = play()
    const find = (name) => steps.find((s) => s.tool === name)
    expect(find('get_archetype_matchups').preview).toBe('3 rows')
    expect(find('build_lineup').preview).toBe('2 rows')
    expect(find('get_current_slate').preview).toBe('{"slate_id":"42","games":7}')
    expect(find('get_current_slate').result).toBeUndefined()
  })

  it('treats a { success: false } payload as an error even when the event says success', () => {
    const { steps } = play([
      ['tool_call', { tool: 'sql_query', args: { sql: 'select 1' }, timestamp: ts(0) }],
      ['tool_result', { tool: 'sql_query', result: { success: false, error: 'syntax error' }, success: true, timestamp: ts(50) }],
    ])
    expect(steps[0]).toMatchObject({ status: 'error', error: 'syntax error' })
  })

  it('surfaces a delegation that never spawned an agent as a failed agent step', () => {
    const { steps } = play([
      ['tool_call', { tool: 'delegate_to_agent', args: { agent: 'scout', task: 'x' }, timestamp: ts(0) }],
      ['tool_result', { tool: 'delegate_to_agent', result: { success: false, error: 'Unknown agent: scout' }, success: true, timestamp: ts(5) }],
    ])
    expect(steps).toHaveLength(1)
    expect(steps[0]).toMatchObject({ kind: 'agent', agent: 'scout', status: 'error', error: 'Unknown agent: scout' })
  })

  it('flags steps still running when the stream ends as interrupted', () => {
    const { steps } = play([['tool_call', { tool: 'get_player_pool', args: {}, timestamp: ts(0) }]])
    expect(steps[0].status).toBe('interrupted')
    expect(steps[0].endedAt).toBe(T0 + 3250)
  })

  it('records the orchestrator step limit from done', () => {
    const state = play([['done', { maxIterationsReached: true, timestamp: ts(10) }]])
    expect(state.maxIterationsReached).toBe(true)
  })
})

describe('summarizeTimeline', () => {
  it('counts tools and sub-agents with the total duration', () => {
    expect(summarizeTimeline(play())).toBe('Used 4 tools across 2 agents · 3.3s')
  })

  it('handles singulars, no agents and missing durations', () => {
    const one = play([
      ['tool_call', { tool: 'sql_query', args: {}, timestamp: ts(0) }],
      ['tool_result', { tool: 'sql_query', result: [], success: true, timestamp: ts(10) }],
    ])
    expect(summarizeTimeline(one)).toBe('Used 1 tool · 3.3s')
    expect(summarizeTimeline(timelineFromMetadata({ toolsUsed: [{ name: 'delegate_to_agent', args: { agent: 'research' } }], agentsUsed: ['research'] }))).toBe(
      'Used 1 agent',
    )
  })
})

describe('timelineWarnings', () => {
  it('turns step-limit hits and errors into caution callouts', () => {
    expect(timelineWarnings(play())).toEqual([
      'Checking usage bumps failed: no injuries table',
      'Optimizer agent hit its step limit before finishing - results may be partial',
    ])
  })

  it('warns when the assistant itself ran out of steps', () => {
    expect(timelineWarnings(play([['done', { maxIterationsReached: true, timestamp: ts(10) }]]))).toEqual([
      'The assistant hit its step limit before finishing - results may be partial',
    ])
  })
})

describe('timelineFromMetadata', () => {
  it('rebuilds agent and tool steps from saved message metadata', () => {
    const tl = timelineFromMetadata({
      toolsUsed: [
        { name: 'get_current_slate', args: {} },
        { name: 'delegate_to_agent', args: { agent: 'research', task: 'Rank value' } },
      ],
      agentsUsed: ['research'],
      maxIterationsReached: true,
    })
    expect(tl.steps).toMatchObject([
      { kind: 'tool', tool: 'get_current_slate', status: 'success', agent: 'orchestrator' },
      { kind: 'agent', agent: 'research', task: 'Rank value', status: 'success' },
    ])
    expect(tl.maxIterationsReached).toBe(true)
    expect(summarizeTimeline(tl)).toBe('Used 1 tool across 1 agent')
  })

  it('accepts plain tool-name strings and adds agents without a delegate entry', () => {
    const tl = timelineFromMetadata({ toolsUsed: ['sql_query'], agentsUsed: ['analyst'] })
    expect(tl.steps.map((s) => s.tool || s.agent)).toEqual(['sql_query', 'analyst'])
  })

  it('returns null when nothing was recorded', () => {
    expect(timelineFromMetadata(null)).toBeNull()
    expect(timelineFromMetadata({ toolsUsed: [], agentsUsed: [] })).toBeNull()
  })
})

describe('labels and formatting', () => {
  it('maps tool names to friendly labels with a readable fallback', () => {
    expect(toolLabel('get_archetype_matchups')).toBe('Checking archetype matchups')
    expect(toolLabel('get_brand_new_thing')).toBe('Brand new thing')
  })

  it('formats durations', () => {
    expect(formatDuration(420)).toBe('420ms')
    expect(formatDuration(3249)).toBe('3.2s')
    expect(formatDuration(65_000)).toBe('1m 05s')
    expect(formatDuration(null)).toBe('')
  })
})
