import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import Markdown from './Markdown'
import { ChatMessage, StreamingMessage } from './ChatMessage'
import { PlayerHeadshotsContext } from './chatFormat'
import { parseNumber } from './markdownTable'

const TABLE = `
| Player | Salary | Proj | Value |
|---|---|---|---|
| Luka Doncic | $11,200 | 58.1 | 5.2x |
| Austin Reaves | $6,400 | 31.4 | 4.9x |
| Max Christie | $3,600 | 21.9 | 6.1x |
`

const bodyNames = (table) =>
  within(table)
    .getAllByRole('row')
    .slice(1)
    .map((r) => within(r).getAllByRole('cell')[0].querySelector('.font-medium').textContent)

beforeEach(() => {
  vi.restoreAllMocks()
  Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn().mockResolvedValue() }, configurable: true })
})

describe('parseNumber', () => {
  it('reads salaries, signed deltas, percentages and multipliers', () => {
    expect(parseNumber('$11,200')).toBe(11200)
    expect(parseNumber('$7.2K')).toBe(7200)
    expect(parseNumber('+3.1')).toBe(3.1)
    expect(parseNumber('−2.5')).toBe(-2.5)
    expect(parseNumber('24%')).toBe(24)
    expect(parseNumber('5.2x')).toBe(5.2)
    expect(parseNumber('-')).toBeNull()
    expect(parseNumber('LAL')).toBeNull()
  })
})

describe('Markdown tables', () => {
  it('renders as a DataTable with numeric columns right-aligned and sortable', () => {
    render(
      <PlayerHeadshotsContext.Provider value={{ 'Luka Doncic': 'luka.png' }}>
        <Markdown>{TABLE}</Markdown>
      </PlayerHeadshotsContext.Provider>,
    )
    const table = screen.getByRole('table')
    expect(bodyNames(table)).toEqual(['Luka Doncic', 'Austin Reaves', 'Max Christie'])

    // headshot + name cell, initials fallback without a headshot
    const lukaRow = within(table).getByText('Luka Doncic').closest('tr')
    expect(lukaRow.querySelector('img')).toHaveAttribute('src', 'luka.png')
    expect(within(table).getByText('Austin Reaves').closest('tr')).toHaveTextContent('AR')

    // numeric cells: tabular digits, right-aligned
    const salaryCell = within(lukaRow).getByText('$11,200').closest('td')
    expect(salaryCell).toHaveClass('num', 'text-right')

    // numbers sort by value (descending first), not as text
    const salaryHeader = within(table).getByRole('columnheader', { name: /salary/i })
    fireEvent.click(within(salaryHeader).getByRole('button'))
    expect(salaryHeader).toHaveAttribute('aria-sort', 'descending')
    expect(bodyNames(table)).toEqual(['Luka Doncic', 'Austin Reaves', 'Max Christie'])
    fireEvent.click(within(salaryHeader).getByRole('button'))
    expect(salaryHeader).toHaveAttribute('aria-sort', 'ascending')
    expect(bodyNames(table)).toEqual(['Max Christie', 'Austin Reaves', 'Luka Doncic'])

    fireEvent.click(within(within(table).getByRole('columnheader', { name: /player/i })).getByRole('button'))
    expect(bodyNames(table)).toEqual(['Austin Reaves', 'Luka Doncic', 'Max Christie'])
  })

  it('colors value multipliers above the 5x target', () => {
    render(<Markdown>{TABLE}</Markdown>)
    expect(screen.getByText('6.1x')).toHaveClass('text-positive')
    expect(screen.getByText('4.9x')).not.toHaveClass('text-positive')
  })
})

describe('Markdown prose', () => {
  it('styles inline code and gives fenced code a copy button', async () => {
    render(<Markdown>{'Use `player_key`.\n\n```sql\nSELECT 1;\n```'}</Markdown>)
    expect(screen.getByText('player_key').tagName).toBe('CODE')
    expect(screen.getByText('sql')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Copy code' }))
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith('SELECT 1;'))
    expect(await screen.findByRole('button', { name: 'Copied code' })).toBeInTheDocument()
  })
})

describe('ChatMessage', () => {
  const answer = { id: 12, role: 'assistant', content: 'Play **Jokic**.', created_at: new Date().toISOString() }

  it('renders user prompts as a bubble without the assistant mark', () => {
    render(<ChatMessage message={{ role: 'user', content: 'Who is chalk?', created_at: answer.created_at }} />)
    const turn = screen.getByRole('article', { name: 'You' })
    expect(turn).toHaveTextContent('Who is chalk?')
    expect(screen.queryByText('DFS Assistant')).not.toBeInTheDocument()
  })

  it('copies the answer text', async () => {
    render(<ChatMessage message={answer} />)
    fireEvent.click(screen.getByRole('button', { name: 'Copy message' }))
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith('Play **Jokic**.'))
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument()
  })

  it('offers regenerate only on the last answer', () => {
    const onRegenerate = vi.fn()
    const { rerender } = render(<ChatMessage message={answer} onRegenerate={onRegenerate} />)
    expect(screen.queryByRole('button', { name: 'Regenerate response' })).not.toBeInTheDocument()
    rerender(<ChatMessage message={answer} isLast onRegenerate={onRegenerate} />)
    fireEvent.click(screen.getByRole('button', { name: 'Regenerate response' }))
    expect(onRegenerate).toHaveBeenCalled()
  })

  it('records thumbs feedback and reverts when saving fails', async () => {
    const onFeedback = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false)
    render(<ChatMessage message={answer} onFeedback={onFeedback} />)
    const up = screen.getByRole('button', { name: 'Good response' })
    const down = screen.getByRole('button', { name: 'Bad response' })

    await act(async () => fireEvent.click(up))
    expect(onFeedback).toHaveBeenLastCalledWith(answer, 'up')
    expect(up).toHaveAttribute('aria-pressed', 'true')

    await act(async () => fireEvent.click(down))
    expect(onFeedback).toHaveBeenLastCalledWith(answer, 'down')
    expect(up).toHaveAttribute('aria-pressed', 'true')
    expect(down).toHaveAttribute('aria-pressed', 'false')
  })
})

describe('StreamingMessage', () => {
  it('shows the working timeline chip, then streams text into a polite live region with a caret', () => {
    const timeline = { steps: [], startedAt: Date.now() }
    const { container, rerender } = render(<StreamingMessage content="" timeline={timeline} showReasoning isStreaming />)
    expect(screen.getByRole('button', { name: /working/i })).toBeInTheDocument()

    rerender(<StreamingMessage content="Jokic is the" timeline={timeline} showReasoning isStreaming />)
    const live = container.querySelector('[aria-live="polite"]')
    expect(live).toHaveTextContent('Jokic is the')
    expect(live.querySelector('.chat-md')).toHaveClass('is-streaming')
  })
})
