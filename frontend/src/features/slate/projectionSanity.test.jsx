import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { sanityNote } from './projectionSanity'
import ProjectionCell from './ProjectionCell'
import ProjectionSanityToggle from './ProjectionSanityToggle'
import { projectionsAPI } from '../../services/api'

vi.mock('../../services/api', () => ({
  projectionsAPI: { getSanity: vi.fn(), setSanity: vi.fn() },
}))

const RUI = {
  name: 'Rui Hachimura',
  projected_points: 24.94,
  projection_raw: 35.44,
  projection_adjustment: -10.5,
  projection_sanity: true,
  projection_reasons: ['FPPM 1.07 vs own 0.74: -8.2', 'blowout +16.5: -1.5 min, -2.3 pts'],
}

describe('sanityNote', () => {
  it('describes an adjusted projection: RotoWire -> adjusted with the reasons', () => {
    const note = sanityNote(RUI)
    expect(note).toEqual({
      raw: 35.44,
      adjusted: 24.94,
      delta: -10.5,
      reasons: RUI.projection_reasons,
      text: 'RotoWire 35.4 -> adjusted 24.9 (-10.5): FPPM 1.07 vs own 0.74: -8.2; blowout +16.5: -1.5 min, -2.3 pts',
    })
  })

  it('null when the layer is off or left the projection alone', () => {
    expect(sanityNote({ projected_points: 30 })).toBeNull()
    expect(sanityNote({ projected_points: 30, projection_raw: 30, projection_adjustment: 0, projection_reasons: [], projection_sanity: true })).toBeNull()
  })

  it('a reason without a points change (favorite minutes trim) still explains itself', () => {
    const note = sanityNote({ projected_points: 40, projection_raw: 40, projection_adjustment: 0, projection_reasons: ['blowout -14.5: -1.3 min, points held'], projection_sanity: true })
    expect(note.text).toBe('RotoWire 40.0 (unchanged): blowout -14.5: -1.3 min, points held')
  })
})

describe('ProjectionCell', () => {
  it('plain number without an adjustment', () => {
    render(<ProjectionCell player={{ projected_points: 30.04 }} />)
    expect(screen.getByText('30.0')).toBeInTheDocument()
    expect(screen.queryByTestId('projection-adjusted')).not.toBeInTheDocument()
  })

  it('adjusted: shows the adjusted value marked, the RotoWire value and reasons in its label', () => {
    render(<ProjectionCell player={RUI} />)
    const cell = screen.getByTestId('projection-adjusted')
    expect(cell).toHaveTextContent('24.9')
    expect(cell).toHaveAttribute('aria-label', expect.stringContaining('RotoWire 35.4 -> adjusted 24.9'))
  })

  it('value prop overrides the number shown (e.g. a manual override) but keeps the note', () => {
    render(<ProjectionCell player={RUI} value={28} />)
    expect(screen.getByTestId('projection-adjusted')).toHaveTextContent('28.0')
  })
})

describe('ProjectionSanityToggle', () => {
  beforeEach(() => {
    projectionsAPI.getSanity.mockResolvedValue({ data: { enabled: true, source: 'default', default: true, components: { fppm: false, blowout: true } } })
    projectionsAPI.setSanity.mockResolvedValue({ data: { enabled: false, source: 'runtime', default: true, components: { fppm: false, blowout: true } } })
  })

  it('shows the server setting and switches it, then tells the page to reload', async () => {
    const onChange = vi.fn()
    render(<ProjectionSanityToggle onChange={onChange} />)
    const toggle = await screen.findByRole('switch', { name: /Projection sanity adjustments/ })
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'true'))
    fireEvent.click(toggle)
    await waitFor(() => expect(projectionsAPI.setSanity).toHaveBeenCalledWith({ enabled: false }))
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'false'))
    expect(onChange).toHaveBeenCalledWith(false)
  })

  it('renders nothing when the server does not answer', async () => {
    projectionsAPI.getSanity.mockRejectedValue(new Error('down'))
    const { container } = render(<ProjectionSanityToggle />)
    await waitFor(() => expect(projectionsAPI.getSanity).toHaveBeenCalled())
    expect(container).toBeEmptyDOMElement()
  })
})
