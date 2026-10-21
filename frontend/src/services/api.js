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
  getActiveSlate: () => api.get('/slates/active'), // Get the current active slate
  getById: (slateId) => api.get(`/slates/${slateId}`),
  create: (data) => api.post('/slates', data),
  delete: (slateId) => api.delete(`/slates/${slateId}`),
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
  getProjectionBreakdown: (slateId, playerId) => api.get(`/players/${slateId}/projection/${playerId}`),
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
  update: (lineupId, data) => api.put(`/lineups/${lineupId}`, data),
  delete: (lineupId) => api.delete(`/lineups/${lineupId}`),
  validate: (players) => api.post('/lineups/validate', { players }),
  // { site, mode: 'new'|'entries', lineupIds | lineups, entriesTemplate? } -> { csv, rowCount, warnings }
  exportCsv: (data) => api.post('/lineups/export', data),
};

// Optimizer API
export const optimizerAPI = {
  generate: (settings) => api.post('/optimizer/generate', settings),
  validate: (players, minSalary) => api.post('/optimizer/validate', { players, minSalary }),
  autoTune: (slateId, mode) => api.post('/optimizer/auto-tune', { slateId, mode }),
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
  sendMessage: (message, sessionId = null, slateId = null) =>
    api.post('/chat', { message, sessionId, slateId }),
  getSessions: (limit = 20) =>
    api.get('/chat/sessions', { params: { limit } }),
  getSessionHistory: (sessionId, limit = 50) =>
    api.get(`/chat/sessions/${sessionId}`, { params: { limit } }),
  createSession: (slateId = null, title = null) =>
    api.post('/chat/sessions', { slateId, title }),
  deleteSession: (sessionId) =>
    api.delete(`/chat/sessions/${sessionId}`),
};

// Historical Insights API
export const historicalAPI = {
  // Data status and sync
  getStatus: () => api.get('/historical/status'),
  // Season list + current season; omitted season args default server-side
  getSeasons: () => api.get('/historical/seasons'),
  startSync: (forceFullSync = false, seasons) =>
    api.post('/historical/sync', { forceFullSync, seasons }, { timeout: 60000 }),
  startNbaApiSync: (season, fromDate = null) =>
    api.post('/historical/sync/nba-api', { season, fromDate }, { timeout: 60000 }),
  getSyncStatus: () => api.get('/historical/sync/status'),

  // Existing endpoints
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
  getTopPerformers: (limit = 20, minGames = 10, dateParams = {}) =>
    api.get('/historical/top-performers', { params: { limit, minGames, ...dateParams } }),
  getPlayerHistory: (name, limit = 20) =>
    api.get(`/historical/player/${encodeURIComponent(name)}`, { params: { limit } }),
  getMatchupHistory: (player, opponent) =>
    api.get(`/historical/matchup/${encodeURIComponent(player)}/${opponent}`),
  getTeammateImpact: (player, teammate, team = null) =>
    api.get(`/historical/teammate-impact/${encodeURIComponent(player)}/${encodeURIComponent(teammate)}`, { params: { team } }),
  getUsageBumps: (players, minGames = 8, minAvgDk = 25) =>
    api.post('/historical/usage-bumps', { players, minGames, minAvgDk }),
  getMissingPlayers: (players, minGames = 5, minAvgDk = 20) =>
    api.post('/historical/missing-players', { players, minGames, minAvgDk }),
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
