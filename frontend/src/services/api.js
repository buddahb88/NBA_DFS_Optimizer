import axios from 'axios';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001/api';

const api = axios.create({
  baseURL: API_URL,
  headers: {
    'Content-Type': 'application/json',
  },
});

// Slates API
export const slatesAPI = {
  getAll: () => api.get('/slates'),
  getAvailableSlates: () => api.get('/slates/list'), // Get available slates from RotoWire
  getActiveSlate: () => api.get('/slates/active'), // Get the current active slate
  getById: (slateId) => api.get(`/slates/${slateId}`),
  create: (data) => api.post('/slates', data),
  delete: (slateId) => api.delete(`/slates/${slateId}`),
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

// Lineups API
export const lineupsAPI = {
  getAll: (slateId = null) => api.get('/lineups', { params: slateId ? { slateId } : {} }),
  getById: (lineupId) => api.get(`/lineups/${lineupId}`),
  create: (data) => api.post('/lineups', data),
  update: (lineupId, data) => api.put(`/lineups/${lineupId}`, data),
  delete: (lineupId) => api.delete(`/lineups/${lineupId}`),
  validate: (players) => api.post('/lineups/validate', { players }),
};

// Optimizer API
export const optimizerAPI = {
  generate: (settings) => api.post('/optimizer/generate', settings),
  validate: (players, minSalary) => api.post('/optimizer/validate', { players, minSalary }),
  autoTune: (slateId, mode) => api.post('/optimizer/auto-tune', { slateId, mode }),
  slateBreakdown: (slateId, mode) => api.post('/optimizer/slate-breakdown', { slateId, mode }),
  reviewLineup: (slateId, lineup, mode) => api.post('/optimizer/review-lineup', { slateId, lineup, mode }),
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

export default api;
