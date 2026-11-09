/**
 * Worker-thread entry: runs one portfolio build or GPP sim off the main event loop.
 * workerData: { kind: 'portfolio' | 'gpp-sim', players, options, historicalStats? }
 * Posts { type: 'progress', stage, progress, message } (throttled), then
 * { type: 'result', result } or { type: 'error', error }.
 */

import { parentPort, workerData } from 'worker_threads';
import { buildPortfolio } from './index.js';
import { runGppSim } from './gppSim.js';

const PROGRESS_INTERVAL_MS = 250;
let lastStage = null;
let lastPost = 0;

const onProgress = (p) => {
  const now = Date.now();
  if (p.stage === lastStage && now - lastPost < PROGRESS_INTERVAL_MS) return;
  lastStage = p.stage;
  lastPost = now;
  parentPort.postMessage({ type: 'progress', ...p });
};

try {
  const result = workerData.kind === 'gpp-sim'
    ? runGppSim(workerData.players, workerData.options, { onProgress })
    : buildPortfolio(workerData.players, workerData.options, { historicalStats: workerData.historicalStats, onProgress });
  parentPort.postMessage({ type: 'result', result });
} catch (err) {
  parentPort.postMessage({ type: 'error', error: err.message });
}
