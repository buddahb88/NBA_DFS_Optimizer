import { describe, it, expect, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import StaleSlateBadge from './StaleSlateBadge'
import { easternToday, formatSlateDate, slateStaleness } from './slateFreshness'

const STALE = { slate_id: '29805', name: 'All', slate_date: '2026-10-21' }
// 2026-10-23 16:00Z = noon ET
const NOON_23RD = new Date('2026-10-23T16:00:00Z')

describe('slateStaleness', () => {
  it('uses the Eastern date across midnight', () => {
    expect(easternToday(new Date('2026-10-22T03:30:00Z'))).toBe('2026-10-21') // 11:30 PM ET
    expect(easternToday(new Date('2026-10-22T04:30:00Z'))).toBe('2026-10-22') // 12:30 AM ET
    expect(slateStaleness(STALE, new Date('2026-10-22T03:30:00Z')).isStale).toBe(false)
    expect(slateStaleness(STALE, new Date('2026-10-22T04:30:00Z'))).toEqual({ slateDate: '2026-10-21', today: '2026-10-22', isStale: true, daysOld: 1 })
  })

  it('is never stale without a slate date', () => {
    expect(slateStaleness({ slate_id: '1' }, NOON_23RD).isStale).toBe(false)
    expect(slateStaleness(null, NOON_23RD).isStale).toBe(false)
  })

  it('formats the slate date for people', () => {
    expect(formatSlateDate('2026-10-21')).toBe('Wed, Oct 21')
  })
})

describe('StaleSlateBadge', () => {
  it('shows a caution with a link to sync when the slate is from an earlier night', () => {
    render(<MemoryRouter><StaleSlateBadge slate={STALE} now={NOON_23RD} /></MemoryRouter>)
    expect(screen.getByRole('status')).toHaveTextContent("Slate is from Wed, Oct 21 - sync tonight's slate")
    expect(screen.getByRole('link', { name: /sync slate/i })).toHaveAttribute('href', '/')
  })

  it('uses a sync button when given onSync', () => {
    const onSync = vi.fn()
    render(<StaleSlateBadge slate={STALE} now={NOON_23RD} onSync={onSync} />)
    fireEvent.click(screen.getByRole('button', { name: /sync slate/i }))
    expect(onSync).toHaveBeenCalled()
  })

  it("renders nothing for tonight's slate", () => {
    const { container } = render(<StaleSlateBadge slate={{ ...STALE, slate_date: '2026-10-23' }} now={NOON_23RD} />)
    expect(container).toBeEmptyDOMElement()
  })
})
