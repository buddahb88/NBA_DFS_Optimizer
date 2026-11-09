/**
 * PORTFOLIO JOBS
 *
 * In-memory job queue for portfolio builds and GPP sim runs (kind 'portfolio' | 'gpp-sim').
 * Each job loads its slate on the main thread (DB access) and then runs the simulation in a
 * dedicated worker thread so the API stays responsive. Jobs are kept for JOB_TTL_MS after
 * they finish. GPP sim results are cached by slate + options + a signature of every player
 * input (projection signature), so an unchanged rerun returns at once.
 */

import { Worker } from 'worker_threads';
import crypto, { randomUUID } from 'crypto';
import { EventEmitter } from 'events';
import { fetchHistoricalStats } from '../simulation/historyRepository.js';
import { loadActuals, loadSlatePlayers, lineupActualTotal, resolveSlate } from '../slateSource.js';
import { normalizeOptions } from './index.js';
import { normalizeGppSimOptions } from './gppSim.js';
import { loadGppSimInputs } from './gppSimInputs.js';

const MAX_RUNNING = Math.max(1, Number(process.env.PORTFOLIO_MAX_CONCURRENT_JOBS) || 2);
const MAX_QUEUED = 20;
const JOB_TTL_MS = 60 * 60 * 1000;
const GPP_CACHE_SIZE = 24;
const GPP_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

const gppCache = new Map(); // key -> { result, at }
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

/** GPP sim result with actual points on each lineup, the max-projection lineup and the candidates (backtest). */
export function withGppSimActuals(result, actuals) {
  const actualOf = (id) => actuals.get(id)?.actualPoints ?? null;
  const total = (ids) => lineupActualTotal(ids.map((id) => ({ actualPoints: actualOf(id) })));
  const scoreLineup = (l) => l && {
    ...l,
    players: l.players.map((s) => ({
      ...s,
      player: { ...s.player, actualPoints: actualOf(s.player.id), resultStatus: actuals.get(s.player.id)?.resultStatus ?? null }
    })),
    actualPoints: total(l.players.map((s) => s.player.id))
  };
  return {
    ...result,
    lineups: result.lineups.map(scoreLineup),
    maxProjection: scoreLineup(result.maxProjection),
    candidates: result.candidates.map((c) => ({ ...c, actualPoints: total(c.playerIds) }))
  };
}

/** Cache key: slate + normalized options + a signature of every player input the sim reads. */
export function gppCacheKey(slate, options, players) {
  const inputs = players.map((p) => [p.id, p.salary, p.position, p.team, p.opponent, p.proj, p.p10, p.p90, p.pPlay, p.own, p.minutes, p.out ? 1 : 0]);
  const opts = { ...options, excludedPlayers: [...options.excludedPlayers].sort(), ruledOut: [...options.ruledOut].sort() };
  return crypto.createHash('sha1')
    .update(JSON.stringify({ slateId: slate.slateId, slateDate: slate.slateDate, opts, inputs }))
    .digest('hex');
}

function cachedGpp(key) {
  const hit = gppCache.get(key);
  if (!hit) return null;
  gppCache.delete(key);
  if (Date.now() - hit.at > GPP_CACHE_TTL_MS) return null;
  gppCache.set(key, hit); // most recently used last
  return hit.result;
}

function storeGpp(key, result) {
  gppCache.set(key, { result, at: Date.now() });
  while (gppCache.size > GPP_CACHE_SIZE) gppCache.delete(gppCache.keys().next().value);
}

/** Drop cached GPP sim results (tests). */
export function clearGppSimCache() {
  gppCache.clear();
}

/** Run one worker to completion; onResult(result) builds the job's final result. */
function runWorker(job, workerData, onResult) {
  return new Promise((resolve) => {
    const worker = new Worker(new URL('./worker.js', import.meta.url), { workerData });
    job.worker = worker;
    worker.on('message', (msg) => {
      if (msg.type === 'progress') {
        update(job, { stage: msg.stage, progress: msg.progress, message: msg.message });
      } else if (msg.type === 'result') {
        finish(job, { status: 'completed', stage: 'done', progress: 1, message: 'Completed', result: onResult(msg.result) });
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
}

async function runGppSimJob(job) {
  const options = normalizeGppSimOptions(job.options);
  const inputs = await (job.loadInputs ?? loadGppSimInputs)(
    { slateId: job.slateId, slateDate: job.slateDate },
    { atLock: options.atLock, ruledOut: options.ruledOut }
  );
  const { source } = inputs;
  Object.assign(job, { slateId: source.slateId, slateDate: source.slateDate, isBacktest: Boolean(source.isBacktest) });
  if (job.status !== 'running') return; // cancelled while loading
  // Reproducible by default: the seed is per slate unless the request sets one
  const seed = job.options.seed ?? `gpp:${source.slateId}:${source.slateDate ?? ''}`;
  const key = gppCacheKey(source, { ...options, seed }, inputs.players);
  const decorate = (result, cached) => ({
    ...(inputs.actuals ? withGppSimActuals(result, inputs.actuals) : result),
    cached,
    notes: inputs.notes,
    ownModel: inputs.ownModel,
    warnings: [...inputs.notes.filter((n) => /could not|failed|unavailable/i.test(n)), ...result.warnings]
  });
  const hit = job.refresh ? null : cachedGpp(key);
  if (hit) {
    finish(job, { status: 'completed', stage: 'done', progress: 1, message: 'Completed (cached)', result: decorate(hit, true) });
    return;
  }
  await runWorker(job, { kind: 'gpp-sim', players: inputs.players, options: { ...job.options, seed } }, (result) => {
    storeGpp(key, result);
    return decorate(result, false);
  });
}

async function run(job) {
  update(job, { status: 'running', stage: 'loading', message: 'Loading slate', startedAt: Date.now() });
  if (job.kind === 'gpp-sim') {
    try {
      await runGppSimJob(job);
    } catch (err) {
      finish(job, { status: 'failed', message: 'Failed', error: err.message });
    }
    return;
  }
  try {
    const source = await resolveSlate({ slateId: job.slateId, slateDate: job.slateDate });
    if (source) Object.assign(job, { slateId: source.slateId, slateDate: source.slateDate, isBacktest: source.isBacktest });
    const rows = await loadSlatePlayers(source, { ranges: job.ranges });
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

    await runWorker(job, { kind: 'portfolio', players, options: job.options, historicalStats },
      (result) => (actuals ? withBacktestActuals(result, actuals) : result));
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

function checkQueue() {
  prune();
  if (queue.length >= MAX_QUEUED) {
    const err = new Error('Too many portfolio builds queued; try again shortly');
    err.status = 429;
    throw err;
  }
}

function enqueue(fields) {
  const job = {
    id: randomUUID(),
    kind: 'portfolio',
    isBacktest: false,
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
    events: new EventEmitter(),
    ...fields
  };
  jobs.set(job.id, job);
  queue.push(job);
  pump();
  return job;
}

const slateIdOf = (slateId) => (slateId === undefined || slateId === null || slateId === '' ? null : String(slateId));

/**
 * Validate options and enqueue a build. Throws (-> HTTP 400) on invalid options.
 */
export function createJob(slateId, { slateDate = null, ranges = 'model', ...options } = {}) {
  if (!['model', 'original'].includes(ranges)) throw new Error('ranges must be model or original');
  normalizeOptions(options);
  checkQueue();
  return enqueue({
    slateId: slateIdOf(slateId),
    // Past date: rebuild that night's saved slate and score the result (services/slateSource.js)
    slateDate,
    // Backtest ranges: outcome-model (default) or the slate's pre-lock ones
    ranges,
    options
  });
}

/**
 * Validate options and enqueue a GPP sim run (gppSim.js). Throws (-> HTTP 400) on invalid options.
 * slateDate: a past night's saved slate (result scored with actual points).
 * refresh: skip the result cache. loadInputs: replaces the DB loader (tests).
 */
export function createGppSimJob(slateId, { slateDate = null, refresh = false, loadInputs = null, ...options } = {}) {
  normalizeGppSimOptions(options);
  checkQueue();
  return enqueue({
    kind: 'gpp-sim',
    slateId: slateIdOf(slateId),
    slateDate: slateDate || null,
    ranges: null,
    options,
    refresh: refresh === true || refresh === 'true',
    loadInputs
  });
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
    kind: job.kind,
    slateId: job.slateId,
    slateDate: job.slateDate,
    isBacktest: job.isBacktest,
    ranges: job.ranges,
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
    view.result = { ...rest, candidates: all.slice(0, Math.max(0, candidates)), candidateCount: rest.candidateCount ?? all.length };
  }
  return view;
}
