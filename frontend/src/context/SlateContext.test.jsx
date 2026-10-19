import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { SlateProvider, useSlate } from './SlateContext'
import { SiteSwitcherSlot, SlateSelectorSlot } from '../components/layout/TopBarSlots'
import { SLATE_STORAGE_KEY } from './slateSelection'
import { sitesAPI, slatesAPI } from '../services/api'

vi.mock('../services/api', () => ({
  sitesAPI: { getAll: vi.fn() },
  slatesAPI: { getAll: vi.fn() },
}))

const SITES = {
  draftkings: {
    key: 'draftkings', name: 'DraftKings', salaryCap: 50000, maxPlayersPerTeam: null, minTeams: 2, minGames: 2,
    rosterSlots: ['PG', 'SG', 'SF', 'PF', 'C', 'G', 'F', 'UTIL'].map((slot) => ({ slot })),
  },
  fanduel: {
    key: 'fanduel', name: 'FanDuel', salaryCap: 60000, maxPlayersPerTeam: 4, minTeams: 3, minGames: null,
    rosterSlots: ['PG', 'PG', 'SG', 'SG', 'SF', 'SF', 'PF', 'PF', 'C'].map((slot) => ({ slot })),
  },
}

const SLATES = {
  draftkings: [{ slate_id: '10', name: 'DK Main' }, { slate_id: '11', name: 'DK Turbo' }],
  fanduel: [{ slate_id: '20', name: 'FD Main' }],
}

function SelectedSlate() {
  const { site, slateId } = useSlate()
  return <div data-testid="selection">{`${site}:${slateId}`}</div>
}

function renderTopBar() {
  return render(
    <SlateProvider>
      <SiteSwitcherSlot />
      <SlateSelectorSlot />
      <SelectedSlate />
    </SlateProvider>,
  )
}

describe('SlateContext + top bar', () => {
  beforeEach(() => {
    localStorage.clear()
    sitesAPI.getAll.mockResolvedValue({ data: SITES })
    slatesAPI.getAll.mockImplementation((site) => Promise.resolve({ data: SLATES[site] || [] }))
  })

  it('defaults to DraftKings and its newest slate, with a cap badge', async () => {
    renderTopBar()
    await waitFor(() => expect(screen.getByTestId('selection')).toHaveTextContent('draftkings:10'))
    expect(slatesAPI.getAll).toHaveBeenCalledWith('draftkings')
    expect(screen.getByText('$50K · 8 players')).toBeInTheDocument()
  })

  it('switching site reloads that site’s slates and persists the selection', async () => {
    renderTopBar()
    await waitFor(() => expect(screen.getByTestId('selection')).toHaveTextContent('draftkings:10'))

    fireEvent.change(screen.getByLabelText('DFS site'), { target: { value: 'fanduel' } })
    await waitFor(() => expect(screen.getByTestId('selection')).toHaveTextContent('fanduel:20'))
    expect(slatesAPI.getAll).toHaveBeenCalledWith('fanduel')
    expect(screen.getByText('$60K · 9 players')).toBeInTheDocument()
    expect(JSON.parse(localStorage.getItem(SLATE_STORAGE_KEY))).toEqual({ site: 'fanduel', slateId: '20' })
  })

  it('restores a persisted slate selection', async () => {
    localStorage.setItem(SLATE_STORAGE_KEY, JSON.stringify({ site: 'draftkings', slateId: '11' }))
    renderTopBar()
    await waitFor(() => expect(screen.getByTestId('selection')).toHaveTextContent('draftkings:11'))

    fireEvent.change(screen.getByLabelText('Slate'), { target: { value: '10' } })
    await waitFor(() => expect(screen.getByTestId('selection')).toHaveTextContent('draftkings:10'))
  })
})
