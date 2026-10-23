/**
 * PORTFOLIO JOBS
 *
 * In-memory job queue for portfolio builds. Each job loads its slate on the main thread
 * (DB access) and then runs the simulation in a dedicated worker thread so the API stays
 * responsive. Jobs are kept for JOB_TTL_MS after they finish.
 */

import { Worker } from 'worker_threads';
import { randomUUID } from 'crypto';
import { EventEmitter } from 'events';
import { fetchHistoricalStats } from '../simulation/historyRepository.js';
import { loadActuals, loadSlatePlayers, lineupActualTotal, resolveSlate } from '../slateSource.js';
import { normalizeOptions } from './index.js';

const MAX_RUNNING = Math.max(1, Number(process.env.PORTFOLIO_MAX_CONCURRENT_JOBS) || 2);
const MAX_QUEUED = 20;
const JOB_TTL_MS = 60 * 60 * 1000;

const jobs = new Map();
const queue = [];
let running = 0;

// Only the fields the engine reads - keeps the structured clone into the worker small
const PLAYER_FIELDS = [
  'id', 'player_id', 'name', 'team', 'opponent', 'position', 'salary', 'projected_points',
  'projected_minutes', 'usage', 'rostership', 'floor', 'ceiling', 'volatility', 'std_dev', 'injury_status',
  'vegas_implied_total', 'vegas_spread', 'vegas_over_under'
];

const pick = (row) => Object.fromEntries(PLAYER_FIELDS.filter((k) => row[k] !== undefined).map((k) => [k, row[k]]));

function prune() {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (job.finishedAt && now - job.finishedAt > JOB_TTL_MS) jobs.delete(id);
  }
}

function update(job, patch) {
  Object.assign(job, patch);
  job.events.emit('update', job);
}

function finish(job, patch) {
  if (job.finishedAt) return;
  update(job, { ...patch, finishedAt: Date.now(), worker: null });
  job.events.emit('done', job);
  job.events.removeAllListeners('update');
}

/**
 * Backtest result with actual points: on each portfolio lineup (per player and
 * actualPoints total), each candidate (actualPoints) and each player row.
 */
export function withBacktestActuals(result, actuals) {
  const actualOf = (id) => actuals.get(id)?.actualPoints ?? null;
  const total = (ids) => lineupActualTotal(ids.map((id) => ({ actualPoints: actualOf(id) })));
  const lineups = result.portfolio.lineups.map((l) => {
    const players = l.players.map((s) => ({
      ...s,
      player: { ...s.player, actualPoints: actualOf(s.player.id), resultStatus: actuals.get(s.player.id)?.resultStatus ?? null }
    }));
    return { ...l, players, actualPoints: total(l.players.map((s) => s.player.id)) };
  });
  const scored = lineups.map((l) => l.actualPoints).filter((x) => x !== null);
  return {
    ...result,
    portfolio: {
      ...result.portfolio,
      lineups,
      actual: {
        best: scored.length ? Math.max(...scored) : null,
        mean: scored.length ? Math.round((scored.reduce((s, x) => s + x, 0) / scored.length) * 10) / 10 : null
      }
    },
    candidates: result.candidates.map((c) => ({ ...c, actualPoints: total(c.playerIds) })),
    players: result.players.map((p) => ({ ...p, actualPoints: actualOf(p.id) }))
  };
}

async function run(job) {
  update(job, { status: 'running', stage: 'loading', message: 'Loading slate', startedAt: Date.now() });
  try {
    const source = await resolveSlate({ slateId: job.slateId, slateDate: job.slateDate });
    if (source) Object.assign(job, { slateId: source.slateId, slateDate: source.slateDate, isBacktest: source.isBacktest });
    const rows = await loadSlatePlayers(source);
    if (!rows || rows.length === 0) throw new Error('No players found for this slate');
    const players = rows.map(pick);
    // Pending results stay null until the box scores land
    const actuals = source.isBacktest ? await loadActuals(source, rows) : null;

    let historicalStats = new Map();
    try {
      historicalStats = await fetchHistoricalStats(players.map((p) => p.name),
        source.isBacktest ? { beforeDate: source.slateDate } : {});
    } catch (err) {
      console.warn('⚠️  Portfolio: historical variance unavailable, using fallbacks:', err.message);
    }
    if (job.status !== 'running') return; // cancelled while loading

    await new Promise((resolve) => {
      const worker = new Worker(new URL('./worker.js', import.meta.url), {
        workerData: { players, options: job.options, historicalStats }
      });
      job.worker = worker;
      worker.on('message', (msg) => {
        if (msg.type === 'progress') {
          update(job, { stage: msg.stage, progress: msg.progress, message: msg.message });
        } else if (msg.type === 'result') {
          const result = actuals ? withBacktestActuals(msg.result, actuals) : msg.result;
          finish(job, { status: 'completed', stage: 'done', progress: 1, message: 'Completed', result });
        } else if (msg.type === 'error') {
          finish(job, { status: 'failed', message: 'Failed', error: msg.error });
        }
      });
      worker.on('error', (err) => finish(job, { status: 'failed', message: 'Failed', error: err.message }));
      worker.on('exit', (code) => {
        finish(job, { status: 'failed', message: 'Failed', error: `Worker exited unexpectedly (code ${code})` });
        resolve();
      });
    });
  } catch (err) {
    finish(job, { status: 'failed', message: 'Failed', error: err.message });
  }
}

function pump() {
  while (running < MAX_RUNNING && queue.length > 0) {
    const job = queue.shift();
    running++;
    run(job).finally(() => {
      running--;
      pump();
    });
  }
}

/**
 * Validate options and enqueue a build. Throws (-> HTTP 400) on invalid options.
 */
export function createJob(slateId, { slateDate = null, ...options } = {}) {
  normalizeOptions(options);
  prune();
  if (queue.length >= MAX_QUEUED) {
    const err = new Error('Too many portfolio builds queued; try again shortly');
    err.status = 429;
    throw err;
  }
  const job = {
    id: randomUUID(),
    slateId: slateId === undefined || slateId === null || slateId === '' ? null : String(slateId),
    // Past date: rebuild that night's saved slate and score the result (services/slateSource.js)
    slateDate,
    isBacktest: false,
    options,
    status: 'queued',
    stage: 'queued',
    progress: 0,
    message: 'Queued',
    createdAt: Date.now(),
    startedAt: null,
    finishedAt: null,
    result: null,
    error: null,
    worker: null,
    events: new EventEmitter()
  };
  jobs.set(job.id, job);
  queue.push(job);
  pump();
  return job;
}

export function getJob(id) {
  prune();
  return jobs.get(id) || null;
}

export function cancelJob(id) {
  const job = jobs.get(id);
  if (!job || job.finishedAt) return job || null;
  const qi = queue.indexOf(job);
  if (qi >= 0) queue.splice(qi, 1);
  const worker = job.worker;
  finish(job, { status: 'cancelled', message: 'Cancelled' });
  if (worker) worker.terminate();
  return job;
}

/**
 * JSON-safe view of a job.
 * @param opts - { includeResult = true, candidates = 100 } (candidates: how many ranked candidates to include)
 */
export function jobView(job, { includeResult = true, candidates = 100 } = {}) {
  const view = {
    jobId: job.id,
    slateId: job.slateId,
    slateDate: job.slateDate,
    isBacktest: job.isBacktest,
    status: job.status,
    stage: job.stage,
    progress: Math.round(job.progress * 1000) / 1000,
    message: job.message,
    createdAt: new Date(job.createdAt).toISOString(),
    startedAt: job.startedAt ? new Date(job.startedAt).toISOString() : null,
    finishedAt: job.finishedAt ? new Date(job.finishedAt).toISOString() : null,
    error: job.error
  };
  if (includeResult && job.result) {
    const { candidates: all, ...rest } = job.result;
    view.result = { ...rest, candidates: all.slice(0, Math.max(0, candidates)), candidateCount: all.length };
  }
  return view;
}
