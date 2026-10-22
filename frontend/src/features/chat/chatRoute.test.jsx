import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import App from '../../App'
import { chatAPI, sitesAPI, slatesAPI } from '../../services/api'

vi.mock('../../services/api', () => ({
  chatAPI: { getSessions: vi.fn(), getSessionHistory: vi.fn(), deleteSession: vi.fn(), renameSession: vi.fn(), getSuggestions: vi.fn() },
  playersAPI: { getBySlateId: vi.fn() },
  sitesAPI: { getAll: vi.fn() },
  slatesAPI: { getAll: vi.fn() },
}))
// Only the chat route matters here; keep the other pages out of the render
vi.mock('../../pages/HomePage', () => ({ default: () => null }))
vi.mock('../../pages/PlayerPoolPage', () => ({ default: () => null }))
vi.mock('../../pages/LineupsPage', () => ({ default: () => null }))
vi.mock('../../pages/LineupStudioPage', () => ({ default: () => null }))
vi.mock('../../pages/InsightsPage', () => ({ default: () => null }))
vi.mock('../../pages/ArchetypesPage', () => ({ default: () => null }))
vi.mock('../../pages/DataStatusPage', () => ({ default: () => null }))

beforeEach(() => {
  chatAPI.getSessions.mockResolvedValue({ data: { success: true, sessions: [] } })
  chatAPI.getSuggestions.mockResolvedValue({ data: { success: true, suggestions: [] } })
  sitesAPI.getAll.mockResolvedValue({ data: { draftkings: { key: 'draftkings', name: 'DraftKings', rosterSlots: [], salaryCap: 50000 } } })
  slatesAPI.getAll.mockResolvedValue({ data: [] })
  window.history.pushState({}, '', '/chat')
})

describe('/chat route', () => {
  it('renders the chat page on the app theme, not inside a LegacyPage', async () => {
    render(<App />)
    const chat = await screen.findByRole('region', { name: 'Chat' })
    expect(chat.closest('.theme-light')).toBeNull()
    expect(document.querySelector('.theme-light')).toBeNull()
    expect(screen.getByRole('heading', { name: /what are we building tonight/i })).toBeInTheDocument()
  })
})
