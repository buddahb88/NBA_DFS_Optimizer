// Client side of the optimizer's stackRules contract
// (backend/src/services/optimizer/constraints/stacking.js). The UI keeps each
// rule as a flat draft with a local `uid`; toRequestRules() turns drafts into
// the request shape and validateDraftRules() mirrors the server's validation so
// mistakes show up before Generate.

export const RULE_TYPES = {
  teamStack: {
    label: 'Team stack',
    help: 'At least Min players from one team (optionally limited to Teams).',
    fields: ['teams', 'min', 'max'],
    defaults: { min: 3 },
  },
  gameStack: {
    label: 'Game stack',
    help: 'At least Min players from one game, with Bring-back from each side.',
    fields: ['games', 'min', 'max', 'bringBack'],
    defaults: { min: 3, bringBack: 1 },
  },
  team: {
    label: 'Team limit',
    help: 'Players from each listed team must stay within Min-Max.',
    fields: ['teams', 'min', 'max'],
    defaults: { max: 3 },
  },
  maxPerTeam: {
    label: 'Max per team',
    help: 'At most Max players from any team (or each listed team).',
    fields: ['teams', 'max'],
    defaults: { max: 3 },
  },
  minGames: {
    label: 'Min games',
    help: 'Use players from at least Min different games.',
    fields: ['min'],
    defaults: { min: 3 },
  },
  avoidOpponent: {
    label: 'Avoid opponent',
    help: "If a listed player is used, at most Max players from that player's opponent.",
    fields: ['playerIds', 'max'],
    defaults: { max: 0 },
  },
};

// Server presets (GET /api/optimizer/stack-presets), duplicated so the
// builder works before that endpoint is deployed.
export const STACK_PRESETS = {
  shootout: {
    label: 'Shootout game stack',
    help: 'Stack one of the highest-total, tightest-spread games, with a bring-back.',
    fields: ['min', 'bringBack', 'topGames', 'maxSpread'],
    defaults: { min: 3, bringBack: 1, topGames: 2, maxSpread: 6 },
  },
  usageBump: {
    label: 'Usage bump stack',
    help: 'Stack teammates of a star who is OUT.',
    fields: ['teams', 'min'],
    defaults: { min: 2 },
  },
};

export const FIELD_LABELS = {
  teams: 'Teams',
  games: 'Games',
  playerIds: 'Players',
  min: 'Min',
  max: 'Max',
  bringBack: 'Bring-back',
  topGames: 'Top games',
  maxSpread: 'Max spread',
};

let nextUid = 1;

/** New draft rule. `kind` is a RULE_TYPES key or 'preset:<key>'. */
export function createRule(kind, overrides = {}) {
  const preset = kind.startsWith('preset:') ? kind.slice(7) : null;
  const def = preset ? STACK_PRESETS[preset] : RULE_TYPES[kind];
  if (!def) throw new Error(`Unknown stack rule kind: ${kind}`);
  return {
    uid: `r${nextUid++}`,
    kind,
    teams: [],
    games: [],
    playerIds: [],
    percentOfLineups: 100,
    ...def.defaults,
    ...overrides,
  };
}

export function ruleDefinition(rule) {
  return rule.kind.startsWith('preset:') ? STACK_PRESETS[rule.kind.slice(7)] : RULE_TYPES[rule.kind];
}

const isCount = (v) => Number.isInteger(v) && v >= 0;
const has = (v) => v !== '' && v != null;

/** Draft -> stackRules entry (only the fields the rule type uses). */
export function toRequestRule(rule) {
  const def = ruleDefinition(rule);
  const out = rule.kind.startsWith('preset:') ? { preset: rule.kind.slice(7) } : { type: rule.kind };
  for (const field of def.fields) {
    const v = rule[field];
    if (field === 'teams' || field === 'playerIds') {
      if (v?.length) out[field] = [...v];
    } else if (field === 'games') {
      if (v?.length) out.gameIds = [...v];
    } else if (has(v)) {
      out[field] = Number(v);
    }
  }
  if (has(rule.percentOfLineups) && Number(rule.percentOfLineups) !== 100) {
    out.percentOfLineups = Number(rule.percentOfLineups);
  }
  return out;
}

export const toRequestRules = (rules) => rules.map(toRequestRule);

/** { [uid]: string[] } of problems; empty object when every rule is valid. */
export function validateDraftRules(rules) {
  const errors = {};
  for (const rule of rules) {
    const list = [];
    const num = (f) => (has(rule[f]) ? Number(rule[f]) : null);
    const min = num('min');
    const max = num('max');

    for (const f of ['min', 'max', 'bringBack', 'topGames']) {
      const v = num(f);
      if (v != null && !isCount(v)) list.push(`${FIELD_LABELS[f]} must be a whole number of 0 or more`);
    }
    if (min != null && max != null && min > max) list.push('Min cannot exceed Max');
    const pct = num('percentOfLineups');
    if (pct != null && !(pct >= 0 && pct <= 100)) list.push('% of lineups must be 0-100');

    switch (rule.kind) {
      case 'team':
        if (!rule.teams.length) list.push('Pick at least one team');
        if (min == null && max == null) list.push('Set Min or Max');
        break;
      case 'teamStack':
      case 'gameStack':
        if (min == null || min < 1) list.push('Min (stack size) must be at least 1');
        if (rule.kind === 'gameStack' && num('bringBack') != null && min != null && num('bringBack') * 2 > min) {
          list.push('Bring-back x 2 cannot exceed Min');
        }
        break;
      case 'maxPerTeam':
        if (max == null) list.push('Set Max');
        break;
      case 'minGames':
        if (min == null) list.push('Set Min');
        break;
      case 'avoidOpponent':
        if (!rule.playerIds.length) list.push('Pick at least one player');
        break;
      default:
        break;
    }
    if (list.length) errors[rule.uid] = list;
  }
  return errors;
}

/** Plain-English one-liner for a rule card header. */
export function describeRule(rule, playerName = (id) => `#${id}`) {
  const pct = Number(rule.percentOfLineups);
  const suffix = has(rule.percentOfLineups) && pct !== 100 ? ` in ${pct}% of lineups` : '';
  const teams = rule.teams.length ? rule.teams.join('/') : null;
  switch (rule.kind) {
    case 'teamStack':
      return `${rule.min || '?'}+ from one team${teams ? ` (${teams})` : ''}${has(rule.max) ? `, max ${rule.max}` : ''}${suffix}`;
    case 'gameStack':
      return `${rule.min || '?'}+ from one game${rule.games.length ? ` (${rule.games.join(', ')})` : ''}${Number(rule.bringBack) > 0 ? `, ${rule.bringBack}+ bring-back` : ''}${suffix}`;
    case 'team':
      return `${teams || 'Team'}: ${has(rule.min) ? rule.min : 0}-${has(rule.max) ? rule.max : 'any'} players${suffix}`;
    case 'maxPerTeam':
      return `Max ${rule.max ?? '?'} per ${teams ? `team (${teams})` : 'team'}${suffix}`;
    case 'minGames':
      return `Players from ${rule.min ?? '?'}+ games${suffix}`;
    case 'avoidOpponent':
      return `Avoid opponents of ${rule.playerIds.map(playerName).join(', ') || '...'}${suffix}`;
    case 'preset:shootout':
      return `Shootout: ${rule.min}+ from a top-${rule.topGames} total game${suffix}`;
    case 'preset:usageBump':
      return `Usage bump: ${rule.min}+ from a team missing a star${suffix}`;
    default:
      return rule.kind;
  }
}

/** 'BOS@NYK' style keys for every game on the slate, sorted. */
export function slateGames(players) {
  const games = new Set();
  for (const p of players) {
    if (p.team && p.opponent) games.add([p.team, p.opponent].map((t) => t.toUpperCase()).sort().join('@'));
  }
  return [...games].sort();
}

export const slateTeams = (players) =>
  [...new Set(players.map((p) => p.team && p.team.toUpperCase()).filter(Boolean))].sort();
