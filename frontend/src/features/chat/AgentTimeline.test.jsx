import { describe, it, expect } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import AgentTimeline from './AgentTimeline'
import { createTimeline, timelineFromMetadata, timelineReducer } from './timelineSteps'

const T0 = Date.parse('2026-10-22T20:00:00.000Z')
const ts = (ms) => new Date(T0 + ms).toISOString()

function build(events, { end = true } = {}) {
  let state = timelineReducer(createTimeline(), { type: 'start', now: T0 })
  for (const [event, data] of events) state = timelineReducer(state, { type: 'event', event, data, now: T0 })
  return end ? timelineReducer(state, { type: 'end', now: T0 + 3200 }) : state
}

const FINISHED = build([
  ['tool_call', { tool: 'get_current_slate', args: {}, timestamp: ts(0) }],
  ['tool_result', { tool: 'get_current_slate', result: { games: 7 }, success: true, timestamp: ts(300) }],
  ['agent_spawn', { agent: 'research', task: 'Rank value plays', timestamp: ts(400) }],
  ['tool_call', { tool: 'get_archetype_matchups', args: { team: 'LAL' }, timestamp: ts(500) }],
  ['tool_result', { tool: 'get_archetype_matchups', result: { players: [{}, {}, {}] }, success: true, timestamp: ts(1700) }],
  ['agent_complete', { agent: 'research', result: { success: true, maxIterationsReached: true }, timestamp: ts(2000) }],
  ['agent_spawn', { agent: 'optimizer', task: 'Build lineup', timestamp: ts(2100) }],
  ['tool_call', { tool: 'build_lineup', args: {}, timestamp: ts(2200) }],
  ['tool_result', { tool: 'build_lineup', result: { success: false, error: 'salary cap exceeded' }, success: false, timestamp: ts(2400) }],
  ['tool_call', { tool: 'score_lineup', args: {}, timestamp: ts(2500) }],
  ['tool_result', { tool: 'score_lineup', result: [], success: true, timestamp: ts(2600) }],
  ['agent_complete', { agent: 'optimizer', result: { success: true }, timestamp: ts(3000) }],
])

describe('AgentTimeline', () => {
  it('shows the live steps in order with spinners for running work', () => {
    const live = build(
      [
        ['agent_spawn', { agent: 'research', task: 'Rank value plays', timestamp: ts(0) }],
        ['tool_call', { tool: 'get_archetype_matchups', args: { team: 'LAL' }, timestamp: ts(100) }],
        ['tool_result', { tool: 'get_archetype_matchups', result: [1], success: true, timestamp: ts(1300) }],
        ['tool_call', { tool: 'get_usage_bumps', args: {}, timestamp: ts(1400) }],
      ],
      { end: false },
    )
    render(<AgentTimeline timeline={live} isStreaming showReasoning />)
    const list = screen.getByRole('list', { name: 'Agent activity' })
    const items = within(list).getAllByRole('listitem')
    expect(items.map((li) => li.textContent)).toEqual([
      expect.stringContaining('Research agent'),
      expect.stringContaining('Checking archetype matchups'),
      expect.stringContaining('Checking usage bumps'),
    ])
    expect(items[1]).toHaveTextContent('1.2s')
    expect(within(items[2]).getByRole('status', { name: 'Running' })).toBeInTheDocument()
    expect(within(items[0]).getByRole('status', { name: 'Running' })).toBeInTheDocument()
  })

  it('collapses to a summary chip when done and expands on click', () => {
    render(<AgentTimeline timeline={FINISHED} showReasoning />)
    const chip = screen.getByRole('button', { name: /Used 4 tools across 2 agents · 3\.2s/ })
    expect(chip).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('list', { name: 'Agent activity' })).not.toBeInTheDocument()

    fireEvent.click(chip)
    expect(chip).toHaveAttribute('aria-expanded', 'true')
    expect(within(screen.getByRole('list', { name: 'Agent activity' })).getAllByRole('listitem')).toHaveLength(6)
  })

  it('surfaces step-limit hits and tool errors as a caution callout even when collapsed', () => {
    render(<AgentTimeline timeline={FINISHED} showReasoning />)
    const callout = screen.getByRole('note', { name: 'Agent warnings' })
    expect(callout).toHaveTextContent('Research agent hit its step limit before finishing - results may be partial')
    expect(callout).toHaveTextContent('Building a lineup failed: salary cap exceeded')
  })

  it('shows only the summary chip while streaming when reasoning is hidden', () => {
    const live = build([['tool_call', { tool: 'get_player_pool', args: {}, timestamp: ts(0) }]], { end: false })
    render(<AgentTimeline timeline={live} isStreaming showReasoning={false} />)
    expect(screen.queryByRole('list', { name: 'Agent activity' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Working.*1 tool/ })).toHaveAttribute('aria-expanded', 'false')
  })

  it('reveals tool arguments and a result preview on demand', () => {
    render(<AgentTimeline timeline={FINISHED} showReasoning />)
    fireEvent.click(screen.getByRole('button', { name: /Used 4 tools/ }))
    const row = screen.getByRole('button', { name: /Checking archetype matchups/ })
    expect(row).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(row)
    expect(row).toHaveAttribute('aria-expanded', 'true')
    const details = screen.getByRole('region', { name: 'Checking archetype matchups details' })
    expect(details).toHaveTextContent('"team": "LAL"')
    expect(details).toHaveTextContent('3 rows')
  })

  it('renders history metadata without durations', () => {
    const tl = timelineFromMetadata({ toolsUsed: [{ name: 'get_current_slate', args: {} }], agentsUsed: ['analyst'] })
    render(<AgentTimeline timeline={tl} showReasoning />)
    expect(screen.getByRole('button', { name: 'Used 1 tool across 1 agent' })).toBeInTheDocument()
  })

  it('renders nothing for an empty finished timeline', () => {
    const { container } = render(<AgentTimeline timeline={createTimeline()} showReasoning />)
    expect(container).toBeEmptyDOMElement()
  })
})
