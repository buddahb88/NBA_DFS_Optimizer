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

export default api;
