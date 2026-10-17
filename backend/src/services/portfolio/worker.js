/**
 * Worker-thread entry: runs one portfolio build off the main event loop.
 * workerData: { players, options, historicalStats }
 * Posts { type: 'progress', stage, progress, message } (throttled), then
 * { type: 'result', result } or { type: 'error', error }.
 */

import { parentPort, workerData } from 'worker_threads';
import { buildPortfolio } from './index.js';

const PROGRESS_INTERVAL_MS = 250;
let lastStage = null;
let lastPost = 0;

try {
  const result = buildPortfolio(workerData.players, workerData.options, {
    historicalStats: workerData.historicalStats,
    onProgress: (p) => {
      const now = Date.now();
      if (p.stage === lastStage && now - lastPost < PROGRESS_INTERVAL_MS) return;
      lastStage = p.stage;
      lastPost = now;
      parentPort.postMessage({ type: 'progress', ...p });
    }
  });
  parentPort.postMessage({ type: 'result', result });
} catch (err) {
  parentPort.postMessage({ type: 'error', error: err.message });
}
