// Agent activity timeline: folds the chat SSE events into an ordered list of steps.
//
// Step shapes (all have id, kind, status, startedAt, endedAt):
//   { kind: 'thought', text }
//   { kind: 'agent', agent, task, stepLimitHit, error }
//   { kind: 'tool', tool, agent, args, preview, error }   agent = 'orchestrator' or the sub-agent running it
// status: 'running' | 'success' | 'error' | 'interrupted'

export const ORCHESTRATOR = 'orchestrator';
const DELEGATE_TOOL = 'delegate_to_agent';

const TOOL_LABELS = {
  get_current_slate: 'Loading the current slate',
  get_slate_summary: 'Summarizing the slate',
  get_player_pool: 'Scanning the player pool',
  search_players: 'Searching players',
  get_player_history: 'Pulling game logs',
  get_player_profile: 'Reading player profiles',
  compare_players: 'Comparing players',
  get_archetype_matchups: 'Checking archetype matchups',
  get_team_defense_profile: 'Reviewing team defense',
  get_matchup_history: 'Checking matchup history',
  get_game_environment: 'Checking game environments',
  get_team_roster: 'Loading team rosters',
  get_missing_players: 'Checking injuries and absences',
  get_usage_bumps: 'Checking usage bumps',
  get_usage_without_teammate: 'Checking usage without a teammate',
  analyze_roster_context: 'Analyzing roster context',
  get_historical_summary: 'Summarizing history',
  get_streaks_and_consistency: 'Checking streaks and consistency',
  get_projection_results: 'Reviewing past projection results',
  query_historical_data: 'Querying historical data',
  sql_query: 'Running a database query',
  build_lineup: 'Building a lineup',
  score_lineup: 'Scoring the lineup',
  validate_lineup: 'Validating the lineup',
};

export function toolLabel(name = '') {
  if (TOOL_LABELS[name]) return TOOL_LABELS[name];
  const words = name.replace(/^get_/, '').replace(/_/g, ' ').trim();
  return words ? words[0].toUpperCase() + words.slice(1) : 'Running a tool';
}

export function agentLabel(agent = '') {
  if (agent === ORCHESTRATOR) return 'Assistant';
  return `${agent[0]?.toUpperCase() ?? ''}${agent.slice(1)} agent`;
}

export function formatDuration(ms) {
  if (ms == null || Number.isNaN(ms)) return '';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const secs = Math.round(ms / 1000);
  return `${Math.floor(secs / 60)}m ${String(secs % 60).padStart(2, '0')}s`;
}

export function stepDuration(step) {
  return step.startedAt != null && step.endedAt != null ? step.endedAt - step.startedAt : null;
}

const PREVIEW_CHARS = 280;
const ROW_KEYS = ['players', 'rows', 'results', 'data', 'lineups', 'games', 'matchups'];

// Short, display-only view of a tool result: a row count when it's tabular, else truncated JSON
export function previewResult(result) {
  if (result == null) return '';
  if (Array.isArray(result)) return `${result.length} row${result.length === 1 ? '' : 's'}`;
  if (typeof result === 'object') {
    const key = ROW_KEYS.find((k) => Array.isArray(result[k]));
    if (key) return previewResult(result[key]);
  }
  const text = typeof result === 'string' ? result : JSON.stringify(result);
  return text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS)}…` : text;
}

function resultError(data) {
  const r = data.result;
  if (r && typeof r === 'object' && !Array.isArray(r) && (r.success === false || (r.error && typeof r.error === 'string'))) {
    return r.error || 'Tool returned an error';
  }
  return data.success === false ? 'Tool returned an error' : null;
}

// "Using x tool..." / "Delegating to..." just narrate steps the timeline already shows
const NOISE = /^(\[\w+\] )?(Using \S+( tool)?\.\.\.|Delegating to )/;

export function createTimeline() {
  return { steps: [], startedAt: null, endedAt: null, iteration: null, maxIterationsReached: false, pendingDelegate: null, nextId: 1 };
}

const eventTime = (data, now) => {
  const t = data?.timestamp ? Date.parse(data.timestamp) : NaN;
  return Number.isNaN(t) ? now : t;
};

function currentAgent(steps) {
  for (let i = steps.length - 1; i >= 0; i--) {
    if (steps[i].kind === 'agent' && steps[i].status === 'running') return steps[i].agent;
  }
  return ORCHESTRATOR;
}

function updateLast(steps, match, patch) {
  for (let i = steps.length - 1; i >= 0; i--) {
    if (match(steps[i])) {
      const next = steps.slice();
      next[i] = { ...steps[i], ...patch };
      return next;
    }
  }
  return steps;
}

function addStep(state, step) {
  return { ...state, steps: [...state.steps, { id: state.nextId, ...step }], nextId: state.nextId + 1 };
}

function applyEvent(state, type, data, now) {
  const at = eventTime(data, now);
  switch (type) {
    case 'thinking':
      if (!data.text || NOISE.test(data.text)) return state;
      return addStep(state, { kind: 'thought', text: data.text, status: 'success', startedAt: at, endedAt: at });

    case 'iteration':
      return { ...state, iteration: { current: data.current, max: data.max } };

    case 'tool_call':
      if (data.tool === DELEGATE_TOOL) return { ...state, pendingDelegate: { args: data.args || {}, startedAt: at, spawned: false } };
      return addStep(state, {
        kind: 'tool',
        tool: data.tool,
        agent: currentAgent(state.steps),
        args: data.args || {},
        status: 'running',
        startedAt: at,
        endedAt: null,
      });

    case 'tool_result': {
      if (data.tool === DELEGATE_TOOL) {
        const pending = state.pendingDelegate;
        const next = { ...state, pendingDelegate: null };
        const error = resultError(data);
        if (pending && !pending.spawned && error) {
          return addStep(next, {
            kind: 'agent',
            agent: pending.args.agent || 'unknown',
            task: pending.args.task || '',
            status: 'error',
            error,
            stepLimitHit: false,
            startedAt: pending.startedAt,
            endedAt: at,
          });
        }
        return next;
      }
      const error = resultError(data);
      return {
        ...state,
        steps: updateLast(state.steps, (s) => s.kind === 'tool' && s.tool === data.tool && s.status === 'running', {
          status: error ? 'error' : 'success',
          error,
          preview: previewResult(data.result),
          endedAt: at,
        }),
      };
    }

    case 'agent_spawn': {
      const pendingDelegate = state.pendingDelegate && { ...state.pendingDelegate, spawned: true };
      return addStep(
        { ...state, pendingDelegate },
        { kind: 'agent', agent: data.agent, task: data.task || '', status: 'running', stepLimitHit: false, startedAt: at, endedAt: null },
      );
    }

    case 'agent_complete': {
      const r = data.result || {};
      const failed = r.success === false;
      return {
        ...state,
        steps: updateLast(state.steps, (s) => s.kind === 'agent' && s.agent === data.agent && s.status === 'running', {
          status: failed ? 'error' : 'success',
          error: failed ? r.error || 'Agent failed' : null,
          stepLimitHit: Boolean(r.maxIterationsReached),
          endedAt: at,
        }),
      };
    }

    case 'done':
      return { ...state, maxIterationsReached: Boolean(data.maxIterationsReached) };

    default:
      return state;
  }
}

/**
 * Actions: { type: 'start', now } | { type: 'event', event, data, now } | { type: 'end', now } | { type: 'reset' }
 * `now` is the client clock, used only when an event has no server timestamp.
 */
export function timelineReducer(state, action) {
  switch (action.type) {
    case 'start':
      return { ...createTimeline(), startedAt: action.now };
    case 'event':
      return applyEvent(state, action.event, action.data || {}, action.now);
    case 'end':
      return {
        ...state,
        pendingDelegate: null,
        endedAt: action.now,
        steps: state.steps.map((s) => (s.status === 'running' ? { ...s, status: 'interrupted', endedAt: action.now } : s)),
      };
    case 'reset':
      return createTimeline();
    default:
      return state;
  }
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function timelineCounts(timeline) {
  const steps = timeline?.steps || [];
  const tools = steps.filter((s) => s.kind === 'tool').length;
  const agents = new Set(steps.filter((s) => s.kind === 'agent').map((s) => s.agent)).size;
  return { tools, agents };
}

export function summarizeTimeline(timeline) {
  const { tools, agents } = timelineCounts(timeline);
  const parts = [];
  if (tools) parts.push(plural(tools, 'tool'));
  let text = parts.length ? `Used ${parts[0]}` : '';
  if (agents) text = text ? `${text} across ${plural(agents, 'agent')}` : `Used ${plural(agents, 'agent')}`;
  if (!text) text = 'Answered directly';
  const duration = timeline?.startedAt != null && timeline?.endedAt != null ? formatDuration(timeline.endedAt - timeline.startedAt) : '';
  return duration ? `${text} · ${duration}` : text;
}

export function timelineWarnings(timeline) {
  const warnings = [];
  for (const s of timeline?.steps || []) {
    if (s.kind === 'tool' && s.status === 'error') warnings.push(`${toolLabel(s.tool)} failed: ${s.error}`);
    if (s.kind === 'agent' && s.status === 'error') warnings.push(`${agentLabel(s.agent)} failed: ${s.error}`);
    if (s.kind === 'agent' && s.stepLimitHit) warnings.push(`${agentLabel(s.agent)} hit its step limit before finishing - results may be partial`);
    if (s.status === 'interrupted') {
      warnings.push(`${s.kind === 'tool' ? toolLabel(s.tool) : agentLabel(s.agent || ORCHESTRATOR)} was interrupted - results may be partial`);
    }
  }
  if (timeline?.maxIterationsReached) warnings.push('The assistant hit its step limit before finishing - results may be partial');
  return warnings;
}

/**
 * Saved messages only keep { toolsUsed, agentsUsed, maxIterationsReached? } (orchestrator-level
 * tools, no timings), so history shows the steps without durations.
 */
export function timelineFromMetadata(meta) {
  if (!meta) return null;
  const tools = meta.toolsUsed || [];
  const agentsUsed = meta.agentsUsed || [];
  let state = createTimeline();
  const seenAgents = new Set();
  for (const entry of tools) {
    const name = typeof entry === 'object' ? entry?.name : entry;
    const args = (typeof entry === 'object' && entry?.args) || {};
    if (!name) continue;
    if (name === DELEGATE_TOOL) {
      if (!args.agent) continue;
      seenAgents.add(args.agent);
      state = addStep(state, { kind: 'agent', agent: args.agent, task: args.task || '', status: 'success', stepLimitHit: false, startedAt: null, endedAt: null });
    } else {
      state = addStep(state, { kind: 'tool', tool: name, agent: ORCHESTRATOR, args, status: 'success', startedAt: null, endedAt: null });
    }
  }
  for (const agent of agentsUsed) {
    if (!seenAgents.has(agent)) {
      state = addStep(state, { kind: 'agent', agent, task: '', status: 'success', stepLimitHit: false, startedAt: null, endedAt: null });
    }
  }
  state = { ...state, maxIterationsReached: Boolean(meta.maxIterationsReached) };
  return state.steps.length || state.maxIterationsReached ? state : null;
}
