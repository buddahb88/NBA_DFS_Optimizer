import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import SlateContextBar from './SlateContextBar'

const renderBar = (slate) =>
  render(
    <MemoryRouter>
      <SlateContextBar slate={slate} siteName="DraftKings" gameCount={7} loading={false} mode="cash" onModeChange={vi.fn()} now={new Date('2026-10-23T16:00:00Z')} />
    </MemoryRouter>,
  )

describe('SlateContextBar', () => {
  it('warns that a stale slate is not tonight and links to sync', () => {
    renderBar({ slate_id: '29805', name: 'All', slate_date: '2026-10-21' })
    const bar = screen.getByRole('region', { name: 'Slate context' })
    expect(bar).toHaveTextContent("Slate is from Wed, Oct 21 - sync tonight's slate")
    expect(screen.getByRole('link', { name: /sync slate/i })).toHaveAttribute('href', '/')
  })

  it("shows no caution for tonight's slate", () => {
    renderBar({ slate_id: '29900', name: 'All', slate_date: '2026-10-23' })
    expect(screen.queryByText(/slate is from/i)).toBeNull()
  })

  it('backtest: shows the selector, a note and no stale caution', () => {
    render(
      <MemoryRouter>
        <SlateContextBar
          slate={{ slate_id: '29805', name: 'All', slate_date: '2026-10-21' }}
          siteName="DraftKings" gameCount={7} loading={false} mode="cash" onModeChange={vi.fn()}
          now={new Date('2026-10-23T16:00:00Z')}
          backtest={{ slateDate: '2026-10-21', slateId: '29805' }}
          slateSelector={<span data-testid="selector">Backtest 2026-10-21</span>}
        />
      </MemoryRouter>,
    )
    expect(screen.getByTestId('selector')).toBeInTheDocument()
    expect(screen.getByText(/Questions use the saved 2026-10-21 slate/)).toBeInTheDocument()
    expect(screen.queryByText(/sync tonight/i)).toBeNull()
  })
})

