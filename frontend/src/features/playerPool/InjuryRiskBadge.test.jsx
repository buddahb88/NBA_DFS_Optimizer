import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import InjuryRiskBadge from './InjuryRiskBadge'
import { injuryCode, injuryRiskInfo, isInjured } from './playerPool'
import LineupCard from '../lineupStudio/LineupCard'
import { CONTEST_PRESETS, settingsFromPreset } from '../lineupStudio/presets'
import { buildOptimizerRequest, skippedNotice } from '../lineupStudio/request'

// The backend source layer's injury-tag fields for a QUES player on a RotoWire read
const QUES = {
  id: 7, name: 'Cheap Guard', team: 'BOS', salary: 4500, projected_points: 15.3, rostership: 8,
  injury_status: 'QUES', injury_tag: 'QUES', injury_risk: 'medium',
  injury_play_prob: 0.68, injury_tag_play_prob: 0.68, injury_discount: 0.68, projection_if_plays: 22.5,
}

describe('injuryRiskInfo', () => {
  it('maps RotoWire tags to short codes (PROB is not "injured")', () => {
    expect(injuryCode('QUES')).toBe('Q')
    expect(injuryCode('DOUBT')).toBe('D')
    expect(injuryCode('PROB')).toBe('P')
    expect(isInjured({ injury_status: 'PROB' })).toBe(false)
    expect(isInjured({ injury_status: 'QUES' })).toBe(true)
  })

  it('label, tone and the tooltip text explain the discount', () => {
    const info = injuryRiskInfo(QUES)
    expect(info.label).toBe('Q 68%')
    expect(info.tone).toBe('caution')
    expect(info.tip).toBe('Questionable: plays ~68% of the time; projection shown x0.68 (if he plays: 22.5)')
    expect(injuryRiskInfo({ ...QUES, injury_risk: 'high', injury_play_prob: 0.3 }).tone).toBe('negative')
    expect(injuryRiskInfo({ ...QUES, injury_status: 'PROB', injury_risk: 'low', injury_play_prob: 0.95 }).tone).toBe('info')
  })

  it('no layer fields: the plain tag; healthy: null', () => {
    expect(injuryRiskInfo({ injury_status: 'GTD' })).toMatchObject({ label: 'GTD', tip: 'Game-time decision; no play-probability discount applied' })
    expect(injuryRiskInfo({ injury_status: null })).toBeNull()
    expect(injuryRiskInfo({ injury_status: 'OUT' })).toMatchObject({ label: 'OUT', tone: 'negative' })
  })

  it('model already lower than the tag rate: says so', () => {
    const info = injuryRiskInfo({ ...QUES, injury_play_prob: 0.5, injury_discount: 1 })
    expect(info.tip).toBe('Questionable: plays ~68% of the time; our model already gives him 50%')
  })
})

describe('InjuryRiskBadge', () => {
  it('renders the code + play chance with the tooltip on hover', async () => {
    render(<InjuryRiskBadge player={QUES} />)
    const badge = screen.getByText('Q 68%')
    expect(badge).toHaveAttribute('data-risk', 'medium')
    expect(badge).toHaveAttribute('aria-label', expect.stringContaining('projection shown x0.68 (if he plays: 22.5)'))
    await act(async () => {
      fireEvent.mouseEnter(badge)
      await new Promise((r) => setTimeout(r, 200))
    })
    expect(screen.getByRole('tooltip')).toHaveTextContent('Questionable: plays ~68% of the time')
  })

  it('compact shows just the code; healthy renders nothing', () => {
    const { container, rerender } = render(<InjuryRiskBadge player={QUES} compact />)
    expect(screen.getByText('Q')).toBeInTheDocument()
    rerender(<InjuryRiskBadge player={{ name: 'Healthy', injury_status: null }} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('shows on lineup cards', () => {
    const lineup = { key: 'l1', number: 1, slots: [{ slot: 'G', player: QUES }, { slot: 'UTIL', player: { ...QUES, id: 8, name: 'Healthy Wing', injury_status: null, injury_risk: 'none' } }] }
    render(<LineupCard lineup={lineup} salaryCap={50000} />)
    const badges = screen.getAllByText('Q')
    expect(badges).toHaveLength(1)
    expect(badges[0]).toHaveAttribute('data-risk', 'medium')
  })
})

describe('skipQuestionable request + presets', () => {
  it('on for the cash preset, off for GPP presets; the request carries it', () => {
    expect(CONTEST_PRESETS.cash.skipQuestionable).toBe(true)
    for (const key of ['se', 'max20', 'max150']) expect(CONTEST_PRESETS[key].skipQuestionable).toBe(false)
    expect(buildOptimizerRequest({ slateId: 's', site: 'draftkings', settings: settingsFromPreset('cash', 50000) }).skipQuestionable).toBe(true)
    expect(buildOptimizerRequest({ slateId: 's', site: 'draftkings', settings: settingsFromPreset('max20', 50000) }).skipQuestionable).toBe(false)
    const custom = { ...settingsFromPreset('cash', 50000), skipQuestionable: false }
    expect(buildOptimizerRequest({ slateId: 's', site: 'draftkings', settings: custom }).skipQuestionable).toBe(false)
    // settings without the field: the mode default
    expect(buildOptimizerRequest({ slateId: 's', site: 'draftkings', settings: { mode: 'gpp', numLineups: 1, stackRules: [] } }).skipQuestionable).toBe(false)
  })

  it('skippedNotice lists who was skipped', () => {
    expect(skippedNotice(null)).toBeNull()
    expect(skippedNotice({ enabled: true, count: 0, players: [] })).toBeNull()
    const n = skippedNotice({ enabled: true, count: 1, players: [{ name: 'Cheap Guard', team: 'BOS', salary: 4500, injury_status: 'QUES' }] })
    expect(n.text).toMatch(/Skipped 1 questionable player \(Q \/ D \/ GTD\)/)
    expect(n.details).toEqual(['Cheap Guard (BOS, $4,500, QUES)'])
  })
})
