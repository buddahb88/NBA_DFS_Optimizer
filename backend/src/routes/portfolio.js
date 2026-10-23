import express from 'express';
import { createJob, getJob, cancelJob, jobView } from '../services/portfolio/jobs.js';
import { CONTEST_PRESETS, LIMITS } from '../services/portfolio/index.js';

const router = express.Router();

const HEARTBEAT_MS = 15000;

const candidateLimit = (q) => {
  if (q === undefined) return 100;
  if (q === 'all') return Infinity;
  const n = Math.floor(Number(q));
  return Number.isFinite(n) && n >= 0 ? n : 100;
};

/**
 * GET /api/portfolio/presets
 * Contest presets and option limits for building a request.
 */
router.get('/presets', (req, res) => {
  res.json({ success: true, presets: CONTEST_PRESETS, limits: LIMITS });
});

/**
 * POST /api/portfolio/build
 * Body: { slateId, contest='20-max' | {preset?, contestSize, entryFee, maxEntries, payouts?, ...},
 *         numLineups, poolSize=1000, fieldSize=5000, iterations=2000, optimalIterations=1000, seed,
 *         randomness=0.6, minSalary=49000, lockedPlayers, excludedPlayers, ownership: {id: pct},
 *         maxExposure, playerExposure: {id: maxPct}, minUnique, poolMaxExposure,
 *         field: {optimizedShare, optimizerNoise, meanLeftover, maxLeftover, calibrationRounds}, simConfig }
 * Starts a background build; poll GET /api/portfolio/:jobId or stream GET /api/portfolio/:jobId/events.
 * slateDate (YYYY-MM-DD, before today) rebuilds that night's saved slate; the result then carries
 * actualPoints per lineup, candidate and player.
 */
router.post('/build', (req, res) => {
  const { slateId, ...options } = req.body || {};
  if ((slateId === undefined || slateId === null || slateId === '') && !options.slateDate) {
    return res.status(400).json({ error: 'slateId is required' });
  }
  try {
    const job = createJob(slateId, options);
    res.status(202).json({
      success: true,
      jobId: job.id,
      status: job.status,
      statusUrl: `/api/portfolio/${job.id}`,
      eventsUrl: `/api/portfolio/${job.id}/events`
    });
  } catch (error) {
    res.status(error.status || 400).json({ error: 'Invalid portfolio request', message: error.message });
  }
});

/**
 * GET /api/portfolio/:jobId?candidates=100|all
 * Job status; includes `result` once completed (candidates ranked by standalone ROI).
 */
router.get('/:jobId', (req, res) => {
  const job = getJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json({ success: true, ...jobView(job, { candidates: candidateLimit(req.query.candidates) }) });
});

/**
 * GET /api/portfolio/:jobId/events?candidates=100|all
 * Server-sent events: `progress` while running, then a final `done` carrying the full job view.
 */
router.get('/:jobId/events', (req, res) => {
  const job = getJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  const candidates = candidateLimit(req.query.candidates);

  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.flushHeaders();

  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const onUpdate = (j) => send('progress', jobView(j, { includeResult: false }));
  const onDone = (j) => {
    send('done', jobView(j, { candidates }));
    cleanup();
    res.end();
  };
  const heartbeat = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS);
  const cleanup = () => {
    clearInterval(heartbeat);
    job.events.off('update', onUpdate);
    job.events.off('done', onDone);
  };
  req.on('close', cleanup);

  if (job.finishedAt) return onDone(job);
  send('progress', jobView(job, { includeResult: false }));
  job.events.on('update', onUpdate);
  job.events.on('done', onDone);
});

/**
 * DELETE /api/portfolio/:jobId
 * Cancel a queued or running build.
 */
router.delete('/:jobId', (req, res) => {
  const job = cancelJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json({ success: true, ...jobView(job, { includeResult: false }) });
});

export default router;
