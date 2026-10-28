import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { fadeNote, sourceNote } from './projectionSource'
import { sanityNote } from './projectionSanity'
import ProjectionCell from './ProjectionCell'
import ProjectionSourceSelect from './ProjectionSourceSelect'
import SourceComparison from './SourceComparison'
import { optimizerAPI, projectionsAPI } from '../../services/api'

vi.mock('../../services/api', () => ({
  projectionsAPI: { getSource: vi.fn(), setSource: vi.fn() },
  optimizerAPI: { compareSources: vi.fn() },
}))

const FADE = {
  points_diff: -5.2, ours: 20.1, rotowire: 25.3, bucket: 'lower 4-6', hit_rate: 0.709, n: 79,
  text: 'Fade: ours 20.1 vs RotoWire 25.3 (-5.2). Ours lower 4-6: actual below RotoWire 71% of 79 saved-slate calls.',
}
const BLENDED = {
  name: 'Value Wing',
  projected_points: 22.7,
  projection_source: 'blend',
  projection_requested: 'blend',
  projection_fallback: false,
  projection_rotowire: 25.3,
  projection_ours: 20.1,
  projection_blend: 22.7,
  ours_minutes: 24.5,
  p_play: 0.93,
  projection_fade: FADE,
}

describe('sourceNote / fadeNote', () => {
  it('names the source, the three projections and our minutes', () => {
    expect(sourceNote(BLENDED)).toEqual({
      source: 'blend', requested: 'blend', fallback: false,
      text: 'Blend projection. RotoWire 25.3 · Ours 20.1 · Blend 22.7. Our minutes 24.5 · plays 93%',
    })
  })

  it('null on a RotoWire read; a fallback says RotoWire was kept and why', () => {
    expect(sourceNote({ projected_points: 30 })).toBeNull()
    const note = sourceNote({ ...BLENDED, projection_source: 'rotowire', projection_fallback: true, projection_fallback_reason: 'not in the own model', projection_ours: null, projection_blend: null })
    expect(note.fallback).toBe(true)
    expect(note.text).toContain('Blend unavailable, RotoWire kept: not in the own model')
    expect(note.text).toContain('Ours —')
  })

  it('fade: label with the hit rate, the server text', () => {
    expect(fadeNote(BLENDED)).toEqual({ label: 'Fade 71%', text: FADE.text, hitRate: 0.709, pointsDiff: -5.2 })
    expect(fadeNote({ projected_points: 3 })).toBeNull()
    expect(fadeNote({ projection_fade: { ...FADE, hit_rate: null } }).label).toBe('Fade')
  })

  it('sanityNote compares RotoWire with the adjusted RotoWire, not the blend shown', () => {
    const note = sanityNote({ ...BLENDED, projection_sanity: true, projection_raw: 27, projection_adjustment: -1.7, projection_reasons: ['blowout +12.0: -1.0 min, -1.7 pts'] })
    expect(note.text).toMatch(/^RotoWire 27.0 -> adjusted 25.3 \(-1.7\)/)
  })
})

describe('ProjectionCell with a source', () => {
  it('shows the active value marked with the source, the tooltip label and the fade badge', () => {
    render(<ProjectionCell player={BLENDED} />)
    const cell = screen.getByTestId('projection-source')
    expect(cell).toHaveTextContent('22.7')
    expect(cell).toHaveAttribute('data-source', 'blend')
    expect(cell).toHaveAttribute('aria-label', expect.stringContaining('RotoWire 25.3 · Ours 20.1 · Blend 22.7'))
    expect(screen.getByTestId('fade-badge')).toHaveTextContent('Fade 71%')
    expect(screen.getByTestId('fade-badge')).toHaveAttribute('aria-label', FADE.text)
  })

  it('no fade badge without a call, or with showFade off', () => {
    const { rerender } = render(<ProjectionCell player={{ ...BLENDED, projection_fade: null }} />)
    expect(screen.queryByTestId('fade-badge')).not.toBeInTheDocument()
    rerender(<ProjectionCell player={BLENDED} showFade={false} />)
    expect(screen.queryByTestId('fade-badge')).not.toBeInTheDocument()
  })

  it('sanity and source together: one tooltip with both', () => {
    render(<ProjectionCell player={{ ...BLENDED, projection_sanity: true, projection_raw: 27, projection_adjustment: -1.7, projection_reasons: ['blowout'] }} />)
    const cell = screen.getByTestId('projection-adjusted')
    expect(cell.getAttribute('aria-label')).toMatch(/Blend projection.*RotoWire 27.0 -> adjusted 25.3/)
  })
})

describe('ProjectionSourceSelect', () => {
  beforeEach(() => {
    projectionsAPI.getSource.mockReset()
    projectionsAPI.setSource.mockReset()
    projectionsAPI.getSource.mockResolvedValue({ data: { source: 'blend', origin: 'default', default: 'blend', options: ['rotowire', 'ours', 'blend'] } })
    projectionsAPI.setSource.mockResolvedValue({ data: { source: 'rotowire', origin: 'runtime', default: 'blend', options: ['rotowire', 'ours', 'blend'] } })
  })

  it('shows the server source and switches it, then tells the page to reload', async () => {
    const onChange = vi.fn()
    render(<ProjectionSourceSelect onChange={onChange} />)
    const group = await screen.findByRole('radiogroup', { name: 'Projections' })
    expect(within(group).getByRole('radio', { name: 'Blend' })).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(within(group).getByRole('radio', { name: 'RotoWire' }))
    await waitFor(() => expect(projectionsAPI.setSource).toHaveBeenCalledWith({ source: 'rotowire' }))
    await waitFor(() => expect(within(group).getByRole('radio', { name: 'RotoWire' })).toHaveAttribute('aria-checked', 'true'))
    expect(onChange).toHaveBeenCalledWith('rotowire')
  })

  it('asks for the slate counts and flags players that kept RotoWire', async () => {
    projectionsAPI.getSource.mockResolvedValue({
      data: { source: 'ours', origin: 'runtime', default: 'blend', options: ['rotowire', 'ours', 'blend'], slate: { source: 'ours', players: 120, applied: 117, fallback: 3, fades: 9, error: null } },
    })
    render(<ProjectionSourceSelect slateParams={{ slateId: '29931' }} />)
    expect(await screen.findByTestId('source-fallback')).toHaveTextContent('3 on RotoWire')
    expect(projectionsAPI.getSource).toHaveBeenCalledWith({ slateId: '29931' })
  })

  it('renders nothing when the server does not answer', async () => {
    projectionsAPI.getSource.mockRejectedValue(new Error('down'))
    const { container } = render(<ProjectionSourceSelect />)
    await waitFor(() => expect(projectionsAPI.getSource).toHaveBeenCalled())
    expect(container).toBeEmptyDOMElement()
  })
})

describe('SourceComparison', () => {
  const row = (source, bestActual, mae, fallback = 0) => ({
    source, summary: { source, applied: 100 - fallback, fallback, error: null }, lineups: 1, topProjected: 290 + bestActual / 100,
    bestActual, avgActual: bestActual, accuracy: { n: 101, mae, bias: -0.4, playedN: 90, playedMae: mae - 0.5 },
    topLineup: { projected: 290, actual: bestActual, players: [{ position: 'PG', name: 'A Guard', projected: 45, actual: 51 }] },
  })

  it('runs the request once per source and marks the best actual and the lowest MAE', async () => {
    optimizerAPI.compareSources.mockResolvedValue({ data: { sources: [row('rotowire', 270.5, 7.9), row('ours', 281.25, 8.1, 2), row('blend', 276, 7.6)] } })
    const request = { slateId: '29868', slateDate: '2026-10-24', mode: 'cash', numLineups: 1 }
    render(<SourceComparison request={request} />)
    fireEvent.click(screen.getByRole('button', { name: 'Compare sources' }))
    await waitFor(() => expect(optimizerAPI.compareSources).toHaveBeenCalledWith(request))
    const ours = await screen.findByTestId('source-row-ours')
    expect(ours).toHaveTextContent('Ours')
    expect(ours).toHaveTextContent('2 RW')
    for (const el of within(ours).getAllByText('281.3')) expect(el.closest('td')).toHaveClass('text-positive')
    const blend = screen.getByTestId('source-row-blend')
    expect(within(blend).getByText('7.60')).toHaveClass('text-positive')
    expect(within(screen.getByTestId('source-row-rotowire')).getByText('7.90')).not.toHaveClass('text-positive')
  })

  it('shows the error and is disabled without a request', async () => {
    optimizerAPI.compareSources.mockRejectedValue({ response: { data: { error: 'No players found for this slate' } } })
    const { rerender } = render(<SourceComparison request={null} />)
    expect(screen.getByRole('button', { name: 'Compare sources' })).toBeDisabled()
    rerender(<SourceComparison request={{ slateId: 'x' }} />)
    fireEvent.click(screen.getByRole('button', { name: 'Compare sources' }))
    expect(await screen.findByText('No players found for this slate')).toBeInTheDocument()
  })
})
