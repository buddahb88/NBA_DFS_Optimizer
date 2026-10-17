import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import usePortfolioJob, { POLL_MS } from './usePortfolioJob'
import { portfolioAPI } from '../../services/api'

vi.mock('../../services/api', () => ({
  portfolioAPI: { build: vi.fn(), getJob: vi.fn(), cancel: vi.fn() },
}))

const tick = async (ms = POLL_MS) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  portfolioAPI.build.mockResolvedValue({ data: { jobId: 'j1', status: 'queued' } })
  portfolioAPI.cancel.mockResolvedValue({ data: {} })
})
afterEach(() => vi.useRealTimers())

describe('usePortfolioJob', () => {
  it('polls progress until the job completes', async () => {
    portfolioAPI.getJob
      .mockResolvedValueOnce({ data: { jobId: 'j1', status: 'running', stage: 'contest', progress: 0.5, message: 'Simulating contest' } })
      .mockResolvedValueOnce({ data: { jobId: 'j1', status: 'completed', finishedAt: 'now', result: { ok: 1 } } })
    const { result } = renderHook(() => usePortfolioJob())

    await act(() => result.current.start({ slateId: '1' }))
    expect(portfolioAPI.build).toHaveBeenCalledWith({ slateId: '1' })
    expect(result.current.running).toBe(true)

    await tick()
    expect(result.current.state).toMatchObject({ status: 'running', stage: 'contest', progress: 0.5 })
    await tick()
    expect(result.current.running).toBe(false)
    expect(result.current.state).toMatchObject({ status: 'completed', result: { ok: 1 }, request: { slateId: '1' } })
    expect(portfolioAPI.getJob).toHaveBeenCalledWith('j1')
  })

  it('reports failed jobs and build errors', async () => {
    portfolioAPI.getJob.mockResolvedValueOnce({ data: { jobId: 'j1', status: 'failed', finishedAt: 'now', error: 'Not enough eligible players (3)' } })
    const { result } = renderHook(() => usePortfolioJob())
    await act(() => result.current.start({ slateId: '1' }))
    await tick()
    expect(result.current.state).toMatchObject({ status: 'failed', error: 'Not enough eligible players (3)' })

    portfolioAPI.build.mockRejectedValueOnce({ response: { data: { error: 'Invalid portfolio request', message: 'poolSize must be >= numLineups' } } })
    await act(() => result.current.start({ slateId: '1' }))
    expect(result.current.state).toMatchObject({ status: 'failed', error: 'poolSize must be >= numLineups' })
  })

  it('cancels the server job on cancel and on unmount, and stops polling', async () => {
    portfolioAPI.getJob.mockResolvedValue({ data: { jobId: 'j1', status: 'running', progress: 0.1 } })
    const { result, unmount } = renderHook(() => usePortfolioJob())
    await act(() => result.current.start({ slateId: '1' }))
    act(() => result.current.cancel())
    expect(portfolioAPI.cancel).toHaveBeenCalledWith('j1')
    expect(result.current.state.status).toBe('cancelled')
    await tick(POLL_MS * 3)
    expect(portfolioAPI.getJob).not.toHaveBeenCalled()

    await act(() => result.current.start({ slateId: '1' }))
    unmount()
    expect(portfolioAPI.cancel).toHaveBeenCalledTimes(2)
  })
})
