import { useCallback, useEffect, useRef, useState } from 'react';
import { portfolioAPI } from '../../services/api';

export const POLL_MS = 800;

const errorMessage = (err) => err.response?.data?.message || err.response?.data?.error || err.message;
const IDLE = { status: 'idle' };

/**
 * Runs one portfolio build at a time: POST /api/portfolio/build, then polls the job
 * until it finishes. Starting a new build or calling reset() cancels the running one,
 * and so does unmounting.
 *
 * state.status: 'idle' | 'starting' | 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'
 */
export default function usePortfolioJob() {
  const [state, setState] = useState(IDLE);
  const active = useRef(null); // { jobId, timer, token }

  const stop = useCallback((cancelJob) => {
    const current = active.current;
    active.current = null;
    if (!current) return;
    clearTimeout(current.timer);
    if (cancelJob && current.jobId) portfolioAPI.cancel(current.jobId).catch(() => {});
  }, []);

  useEffect(() => () => stop(true), [stop]);

  const poll = useCallback((token) => {
    const current = active.current;
    if (!current || current.token !== token) return;
    portfolioAPI
      .getJob(current.jobId)
      .then((res) => {
        if (active.current?.token !== token) return;
        const job = res.data;
        if (job.finishedAt || ['completed', 'failed', 'cancelled'].includes(job.status)) {
          active.current = null;
          setState({
            status: job.status,
            jobId: job.jobId,
            request: current.request,
            startedAt: current.startedAt,
            finishedAt: Date.now(),
            result: job.result || null,
            error: job.status === 'failed' ? job.error || 'Portfolio build failed' : null,
          });
          return;
        }
        setState((s) => ({ ...s, status: job.status, stage: job.stage, progress: job.progress, message: job.message }));
        current.timer = setTimeout(() => poll(token), POLL_MS);
      })
      .catch((err) => {
        if (active.current?.token !== token) return;
        active.current = null;
        setState((s) => ({ ...s, status: 'failed', error: `Lost track of the build: ${errorMessage(err)}` }));
      });
  }, []);

  const start = useCallback(
    async (request) => {
      stop(true);
      const token = {};
      const startedAt = Date.now();
      active.current = { token, jobId: null, timer: null, request, startedAt };
      setState({ status: 'starting', stage: 'queued', progress: 0, message: 'Starting', request, startedAt });
      try {
        const res = await portfolioAPI.build(request);
        if (active.current?.token !== token) {
          // Superseded or reset while the POST was in flight
          portfolioAPI.cancel(res.data.jobId).catch(() => {});
          return;
        }
        active.current.jobId = res.data.jobId;
        setState((s) => ({ ...s, status: res.data.status || 'queued', jobId: res.data.jobId }));
        active.current.timer = setTimeout(() => poll(token), POLL_MS);
      } catch (err) {
        if (active.current?.token !== token) return;
        active.current = null;
        setState({ status: 'failed', request, startedAt, error: errorMessage(err) });
      }
    },
    [poll, stop],
  );

  const cancel = useCallback(() => {
    stop(true);
    setState((s) => ({ ...s, status: 'cancelled', finishedAt: Date.now() }));
  }, [stop]);

  const reset = useCallback(() => {
    stop(true);
    setState(IDLE);
  }, [stop]);

  const running = ['starting', 'queued', 'running'].includes(state.status);
  return { state, running, start, cancel, reset };
}
