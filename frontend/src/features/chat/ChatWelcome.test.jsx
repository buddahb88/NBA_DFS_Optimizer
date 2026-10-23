import { describe, it, expect, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import ChatWelcome from './ChatWelcome'
import { greeting } from './chatFormat'
import { buildGames } from '../../pages/home/slateDashboard'

const SLATE = { slate_id: '42', name: 'Main 7:10 PM ET' }
const tip = (iso, isHome) => JSON.stringify({ game: { dateTime: iso }, isHome })
const PLAYERS = [
  { name: 'A', team: 'BOS', opponent: 'NYK', vegas_over_under: 236.5, vegas_spread: -6.5, raw_data: tip('2026-10-22T23:10:00Z', false) },
  { name: 'B', team: 'NYK', opponent: 'BOS', vegas_over_under: 236.5, vegas_spread: 6.5, raw_data: tip('2026-10-22T23:10:00Z', true) },
  { name: 'C', team: 'LAL', opponent: 'GSW', raw_data: tip('2026-10-23T02:10:00Z') },
]
const SUGGESTIONS = [
  { id: 'usage_bump', kind: 'usage_bump', label: 'Usage bump', prompt: 'How much does Payton Pritchard gain with Jaylen Brown out tonight?' },
  { id: 'game_stack', kind: 'game_stack', label: 'Game stack', prompt: 'Build me a BOS vs NYK game stack.' },
]
const EVENING = new Date(2026, 9, 22, 19, 0)

const renderWelcome = (props = {}) => {
  const onSend = vi.fn()
  render(
    <ChatWelcome
      slate={SLATE}
      siteName="DraftKings"
      games={buildGames(PLAYERS)}
      firstLock={new Date('2026-10-22T23:10:00Z')}
      suggestions={SUGGESTIONS}
      onSend={onSend}
      now={EVENING}
      {...props}
    />,
  )
  return onSend
}

describe('ChatWelcome', () => {
  it('greets by time of day', () => {
    expect(greeting(new Date(2026, 9, 22, 9))).toBe('Good morning')
    expect(greeting(new Date(2026, 9, 22, 14))).toBe('Good afternoon')
    expect(greeting(EVENING)).toBe('Good evening')
    renderWelcome()
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('Good evening. What are we building tonight?')
  })

  it("summarizes tonight's slate: site, lock and games with Vegas lines", () => {
    renderWelcome()
    const summary = screen.getByRole('region', { name: "Tonight's slate" })
    expect(summary).toHaveTextContent('Main 7:10 PM ET')
    expect(within(summary).getByText('DraftKings')).toBeInTheDocument()
    expect(summary).toHaveTextContent('2 games')
    const lock = new Date('2026-10-22T23:10:00Z').toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    expect(summary).toHaveTextContent(`Lock ${lock}`)

    const chips = within(within(summary).getByRole('list', { name: 'Games' })).getAllByRole('listitem')
    expect(chips).toHaveLength(2)
    // Highest total first, away @ home, favorite's line
    expect(chips[0]).toHaveTextContent('BOS @ NYK')
    expect(chips[0]).toHaveTextContent('O/U 236.5')
    expect(chips[0]).toHaveTextContent('BOS -6.5')
    // No lines: just the matchup
    expect(chips[1]).toHaveTextContent(/^LAL vs GSW$/)
  })

  it('sends a suggestion when clicked', () => {
    const onSend = renderWelcome()
    const prompts = screen.getByRole('region', { name: 'Suggested prompts' })
    expect(within(prompts).getAllByRole('button')).toHaveLength(2)
    fireEvent.click(within(prompts).getByRole('button', { name: /Payton Pritchard gain with Jaylen Brown out/ }))
    expect(onSend).toHaveBeenCalledWith('How much does Payton Pritchard gain with Jaylen Brown out tonight?')
  })

  it('shows skeletons while suggestions and slate load', () => {
    renderWelcome({ suggestionsLoading: true, slateLoading: true, games: [] })
    expect(screen.getByLabelText('Loading suggestions')).toHaveAttribute('aria-busy', 'true')
    expect(screen.queryByRole('button', { name: /Pritchard/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('list', { name: 'Games' })).not.toBeInTheDocument()
  })

  it('disables suggestions while a reply is streaming', () => {
    renderWelcome({ disabled: true })
    expect(screen.getByRole('button', { name: /BOS vs NYK game stack/ })).toBeDisabled()
  })

  it('asks for a slate when none is selected', () => {
    renderWelcome({ slate: null, games: [] })
    expect(screen.queryByRole('region', { name: "Tonight's slate" })).not.toBeInTheDocument()
    expect(screen.getByText(/No slate selected/)).toBeInTheDocument()
    expect(screen.getAllByRole('button')).toHaveLength(2)
  })
  it('flags a stale slate and turns the sync suggestion into a link instead of a prompt', () => {
    const onSend = vi.fn()
    const sync = { id: 'sync_slate', kind: 'sync_slate', label: "Sync tonight's slate", prompt: 'The latest slate is from 2026-10-21. What do I need to sync?' }
    render(
      <MemoryRouter>
        <ChatWelcome
          slate={{ ...SLATE, slate_date: '2026-10-21' }}
          games={buildGames(PLAYERS)}
          suggestions={[sync, SUGGESTIONS[1]]}
          onSend={onSend}
          now={new Date('2026-10-23T16:00:00Z')}
        />
      </MemoryRouter>,
    )
    const summary = screen.getByRole('region', { name: "Tonight's slate" })
    expect(summary).toHaveTextContent("Slate is from Wed, Oct 21 - sync tonight's slate")
    const prompts = screen.getByRole('region', { name: 'Suggested prompts' })
    const link = within(prompts).getByRole('link', { name: /Sync tonight's slate/ })
    expect(link).toHaveAttribute('href', '/')
    fireEvent.click(link)
    expect(onSend).not.toHaveBeenCalled()
  })
})
