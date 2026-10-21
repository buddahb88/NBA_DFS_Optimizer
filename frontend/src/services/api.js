import axios from 'axios';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001/api';

const api = axios.create({
  baseURL: API_URL,
  headers: {
    'Content-Type': 'application/json',
  },
});

// DFS sites API (contest rules: salary cap, roster slots, scoring)
export const sitesAPI = {
  getAll: () => api.get('/sites'),
  getByKey: (site) => api.get(`/sites/${site}`),
};

// Slates API
export const slatesAPI = {
  getAll: (site = null) => api.get('/slates', { params: site ? { site } : {} }),
  getAvailableSlates: () => api.get('/slates/list'), // Get available slates from RotoWire
  getById: (slateId) => api.get(`/slates/${slateId}`),
  // Upload a site's official salary CSV; site/slateId are optional (site is auto-detected)
  importSalaries: (file, { site, slateId } = {}) => {
    const form = new FormData();
    form.append('file', file);
    if (site) form.append('site', site);
    if (slateId) form.append('slateId', slateId);
    // Overrides the instance's JSON content type; the browser adds the boundary
    return api.post('/slates/import-salaries', form, { headers: { 'Content-Type': 'multipart/form-data' } });
  },
};

// Players API
export const playersAPI = {
  getBySlateId: (slateId, filters = {}) => api.get(`/players/${slateId}`, { params: filters }),
  syncFromRotoWire: (slateId, data = {}) => api.post(`/players/${slateId}/sync`, data),
  getById: (playerId) => api.get(`/players/player/${playerId}`),
  recalculateProjections: (slateId) => api.post(`/players/${slateId}/recalculate-projections`),
  resetProjections: (slateId) => api.post(`/players/${slateId}/reset-projections`),
};

// Per-slate player controls (lock/exclude/exposure/projection override), keyed by players.player_id
export const playerSettingsAPI = {
  getBySlateId: (slateId) => api.get(`/player-settings/${slateId}`),
  save: (slateId, playerId, settings) => api.put(`/player-settings/${slateId}/${encodeURIComponent(playerId)}`, settings),
  clear: (slateId) => api.delete(`/player-settings/${slateId}`),
};

// Lineups API
export const lineupsAPI = {
  getAll: (slateId = null) => api.get('/lineups', { params: slateId ? { slateId } : {} }),
  getById: (lineupId) => api.get(`/lineups/${lineupId}`),
  create: (data) => api.post('/lineups', data),
  delete: (lineupId) => api.delete(`/lineups/${lineupId}`),
  // { site, mode: 'new'|'entries', lineupIds | lineups, entriesTemplate? } -> { csv, rowCount, warnings }
  exportCsv: (data) => api.post('/lineups/export', data),
};

// Optimizer API
export const optimizerAPI = {
  generate: (settings) => api.post('/optimizer/generate', settings),
  slateBreakdown: (slateId, mode) => api.post('/optimizer/slate-breakdown', { slateId, mode }),
  reviewLineup: (slateId, lineup, mode) => api.post('/optimizer/review-lineup', { slateId, lineup, mode }),
};

// Export API (site upload CSVs)
export const exportAPI = {
  // { site, slateId, lineups: [{ players: [{ slot, playerId }] }] } -> { csv, filename, count, warnings }
  lineups: (data) => api.post('/export/lineups', data),
};

// GPP portfolio builder (background contest-sim jobs)
export const portfolioAPI = {
  getPresets: () => api.get('/portfolio/presets'),
  // { slateId, contest, numLineups, poolSize, iterations, ... } -> 202 { jobId, status }
  build: (data) => api.post('/portfolio/build', data),
  // Job status; `result` once completed. candidates: how many ranked candidates to include
  getJob: (jobId, candidates = 0) => api.get(`/portfolio/${jobId}`, { params: { candidates } }),
  cancel: (jobId) => api.delete(`/portfolio/${jobId}`),
};

// Chat API
export const chatAPI = {
  getSessions: (limit = 20) =>
    api.get('/chat/sessions', { params: { limit } }),
  getSessionHistory: (sessionId, limit = 50) =>
    api.get(`/chat/sessions/${sessionId}`, { params: { limit } }),
  deleteSession: (sessionId) =>
    api.delete(`/chat/sessions/${sessionId}`),
};

// Historical Insights API
export const historicalAPI = {
  // Data status and sync
  getStatus: () => api.get('/historical/status'),
  // Data Status panel: game log coverage by season, sync runs, snapshot coverage
  getDataStatus: () => api.get('/historical/data-status'),
  // ESPN catch-up from the latest stored game -> { runId } or { upToDate: true }
  startIncrementalSync: () => api.post('/historical/sync/incremental', {}, { timeout: 60000 }),
  // Walk a whole season from ESPN, filling missing games
  backfillSeason: (season) =>
    api.post('/historical/sync', { seasons: [season], backfill: true }, { timeout: 60000 }),
  getSyncStatus: () => api.get('/historical/sync/status'),

  getSummary: (dateParams = {}) =>
    api.get('/historical/summary', { params: dateParams }),
  getSlateInsights: (players, dateParams = {}) =>
    api.post('/historical/slate-insights', { players, ...dateParams }),
  getHotStreaks: (limit = 20, minGames = 5, dateParams = {}) =>
    api.get('/historical/hot-streaks', { params: { limit, minGames, ...dateParams } }),
  getColdStreaks: (limit = 20, minGames = 5, dateParams = {}) =>
    api.get('/historical/cold-streaks', { params: { limit, minGames, ...dateParams } }),
  getConsistencyLeaders: (limit = 20, minGames = 8, dateParams = {}) =>
    api.get('/historical/consistency-leaders', { params: { limit, minGames, ...dateParams } }),
  getBoomBustPlayers: (limit = 20, minGames = 8, dateParams = {}) =>
    api.get('/historical/boom-bust-players', { params: { limit, minGames, ...dateParams } }),
  // params: { startDate, endDate } or { lastNDays }, site, slateId
  getUsageBumps: (players, minGames = 8, minAvgDk = 25, params = {}) =>
    api.post('/historical/usage-bumps', { players, minGames, minAvgDk, ...params }),
  getMissingPlayers: (players, minGames = 5, minAvgDk = 20, params = {}) =>
    api.post('/historical/missing-players', { players, minGames, minAvgDk, ...params }),
};

// Minutes x FPPM projections and manual overrides
export const projectionsAPI = {
  // options: { site, slateDate, minutesWeight, updateDb }
  getMinutesProjections: (slateId, options = {}) =>
    api.post(`/projections/${slateId}/minutes`, options, { timeout: 120000 }),
  getOverrides: (slateId) => api.get(`/projections/${slateId}/overrides`),
  // override: { minutes, points, note, apply } - minutes 0 marks the player OUT
  setOverride: (slateId, playerId, override) =>
    api.put(`/projections/${slateId}/overrides/${playerId}`, override, { timeout: 120000 }),
  clearOverride: (slateId, playerId) =>
    api.delete(`/projections/${slateId}/overrides/${playerId}`),
};

// Late Swap API
export const lateSwapAPI = {
  // body: { slateId, csv, site?, now?, mode?, maxExposure?, playerExposure?, outPlayers?, lockedTeams?, gameTimes?, swapQuestionable?, unique? }
  run: (body) => api.post('/lateswap', body, { timeout: 120000 }),
};

export default api;
