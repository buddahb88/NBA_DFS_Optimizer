import { addToPlayerVars, requireDistinctGroups } from './helpers.js';
import { salaryScale } from '../scoring.js';

/**
 * STACKING
 *
 * Team/game correlation rules, sent as settings.stackRules (settings.teamStacks
 * is accepted as an alias and appended):
 *
 *   stackRules: [{ type, teams | gameId, min, max, bringBack, percentOfLineups, ... }]
 *
 * Rule types (team abbreviations are case-insensitive):
 *   team           Players from each listed team must be within [min, max].
 *                  { type: 'team', teams: ['BOS'], min: 2, max: 4 }
 *   teamStack      At least `min` players from ONE team. `teams` limits which
 *                  teams may be the stack (default: any). `max` caps every
 *                  candidate team.
 *                  { type: 'teamStack', min: 3 }
 *   gameStack      At least `min` players from ONE game, with at least
 *                  `bringBack` from each side of that game. `gameId` (or
 *                  `gameIds`, or `teams` = games those teams play in) limits the
 *                  candidate games (default: any). `max` caps every candidate game.
 *                  gameId is the two teams in either order: 'BOS@NYK', 'NYK vs BOS'.
 *                  { type: 'gameStack', gameId: 'BOS@NYK', min: 3, bringBack: 1 }
 *   maxPerTeam     At most `max` players from any team (or from each listed team).
 *                  { type: 'maxPerTeam', max: 3 }
 *   minGames       Lineup uses players from at least `min` distinct games.
 *                  { type: 'minGames', min: 3 }
 *   avoidOpponent  If a listed player is in the lineup, at most `max` (default 0)
 *                  players from that player's opponent. Players are optimizer
 *                  pool IDs, the same IDs as lockedPlayers.
 *                  { type: 'avoidOpponent', playerIds: [123] }
 *
 * Every rule takes percentOfLineups (default 100): the rule is enforced until at
 * least ceil(percent * numLineups / 100) lineups of the request satisfy it; the
 * remaining lineups are free (they may still satisfy it on their own). E.g.
 * 25% of lineups use a 3-man stack from one game, the rest unconstrained:
 *   { type: 'gameStack', gameId: 'BOS@NYK', min: 3, percentOfLineups: 25 }
 *
 * NBA presets, expanded into the rules above against the slate's player pool:
 *   { preset: 'shootout', min = 3, bringBack = 1, topGames = 2, maxSpread = 6, minTotal }
 *       gameStack from one of the `topGames` highest Vegas totals among games
 *       whose spread is within maxSpread (and total >= minTotal, if given).
 *   { preset: 'usageBump', min = 2, outPlayers, teams }
 *       teamStack from teams missing a star: `teams` as given, plus the teams
 *       of `outPlayers` (names or pool IDs), plus pool players marked OUT with a
 *       DK-equivalent salary >= $7,000. OUT players are usually dropped from the
 *       pool on import, so pass outPlayers or teams when in doubt.
 *   { preset: 'cash' }
 *       No stacking rules (expands to nothing).
 * Presets also take percentOfLineups.
 *
 * Constraints use the per-player LP variables from roster.js (ctx.varsByPlayer);
 * stack choices add binary helper variables prefixed `stk<ruleIndex>`.
 */
export const name = 'stacking';

export const RULE_TYPES = ['team', 'teamStack', 'gameStack', 'maxPerTeam', 'minGames', 'avoidOpponent'];

export const STACK_PRESETS = {
  shootout: {
    label: 'Shootout game stack',
    description: 'Stack one of the highest-total, tightest-spread games, with a bring-back',
    defaults: { min: 3, bringBack: 1, topGames: 2, maxSpread: 6 }
  },
  usageBump: {
    label: 'Usage bump stack',
    description: 'Stack teammates of a star who is OUT',
    defaults: { min: 2 }
  },
  cash: {
    label: 'Cash',
    description: 'No stacking rules',
    defaults: {}
  }
};

// DK-equivalent salary that makes an OUT player a "star" for usageBump
const STAR_SALARY = 7000;

const upper = (s) => String(s).trim().toUpperCase();

export const gameOf = (p) => (p.team && p.opponent ? gameKey(p.team, p.opponent) : null);

function gameKey(a, b) {
  return [upper(a), upper(b)].sort().join('@');
}

/**
 * 'BOS@NYK', 'nyk vs bos', 'BOS-NYK' -> 'BOS@NYK'; null if not two teams
 */
export function parseGameId(gameId) {
  const teams = String(gameId ?? '')
    .split(/[^A-Za-z0-9]+/)
    .filter(t => t && !/^(vs|at|v)$/i.test(t));
  return teams.length === 2 ? gameKey(teams[0], teams[1]) : null;
}

export function isOut(player) {
  const status = player.injury_status;
  if (!status) return false;
  return /^o$/i.test(String(status).trim()) || /\bout\b/i.test(String(status));
}

const asList = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
const isCount = (v) => Number.isInteger(v) && v >= 0;

/**
 * Validate the raw request rules (no player pool needed).
 * @returns {string[]} error messages, empty if valid
 */
export function validateStackRules(rules) {
  if (rules == null) return [];
  if (!Array.isArray(rules)) return ['stackRules must be an array'];

  const errors = [];
  rules.forEach((rule, i) => {
    const at = `stackRules[${i}]`;
    if (!rule || typeof rule !== 'object') {
      errors.push(`${at} must be an object`);
      return;
    }

    const { percentOfLineups } = rule;
    if (percentOfLineups != null && !(typeof percentOfLineups === 'number' && percentOfLineups >= 0 && percentOfLineups <= 100)) {
      errors.push(`${at}.percentOfLineups must be a number from 0 to 100`);
    }
    for (const key of ['min', 'max', 'bringBack', 'topGames']) {
      if (rule[key] != null && !isCount(rule[key])) errors.push(`${at}.${key} must be a non-negative integer`);
    }
    if (rule.min != null && rule.max != null && rule.min > rule.max) {
      errors.push(`${at}.min cannot exceed max`);
    }

    if (rule.preset != null) {
      if (!STACK_PRESETS[rule.preset]) {
        errors.push(`${at}.preset must be one of ${Object.keys(STACK_PRESETS).join(', ')}`);
      }
      return;
    }

    if (!RULE_TYPES.includes(rule.type)) {
      errors.push(`${at}.type must be one of ${RULE_TYPES.join(', ')} (or set preset)`);
      return;
    }

    const teams = asList(rule.teams);
    const gameIds = [...asList(rule.gameId), ...asList(rule.gameIds)];
    switch (rule.type) {
      case 'team':
        if (teams.length === 0) errors.push(`${at}.teams is required for type team`);
        if (rule.min == null && rule.max == null) errors.push(`${at} needs min or max`);
        break;
      case 'teamStack':
        if (rule.min == null || rule.min < 1) errors.push(`${at}.min (stack size, >= 1) is required for type teamStack`);
        break;
      case 'gameStack':
        if (rule.min == null || rule.min < 1) errors.push(`${at}.min (stack size, >= 1) is required for type gameStack`);
        gameIds.forEach(g => {
          if (!parseGameId(g)) errors.push(`${at}.gameId "${g}" must name two teams, e.g. "BOS@NYK"`);
        });
        if (rule.bringBack != null && rule.min != null && rule.bringBack * 2 > rule.min) {
          errors.push(`${at}.bringBack x 2 cannot exceed min (each side needs bringBack players)`);
        }
        break;
      case 'maxPerTeam':
        if (rule.max == null) errors.push(`${at}.max is required for type maxPerTeam`);
        break;
      case 'minGames':
        if (rule.min == null) errors.push(`${at}.min is required for type minGames`);
        break;
      case 'avoidOpponent':
        if ([...asList(rule.playerId), ...asList(rule.playerIds)].length === 0) {
          errors.push(`${at}.playerIds is required for type avoidOpponent`);
        }
        break;
    }
  });
  return errors;
}

/**
 * Expand presets and normalize rules against the player pool.
 * Throws if the rules are invalid (routes validate first and return 400).
 * @returns {Array} concrete rules: { type, percentOfLineups, teams?, games?, min?, max?, bringBack?, playerIds? }
 */
export function resolveStackRules(rawRules, players, site) {
  const errors = validateStackRules(rawRules);
  if (errors.length) throw new Error(`Invalid stack rules: ${errors.join('; ')}`);

  const rules = [];
  for (const raw of rawRules || []) {
    const percentOfLineups = raw.percentOfLineups ?? 100;
    if (raw.preset) {
      rules.push(...expandPreset(raw, players, site).map(r => ({ ...r, percentOfLineups, preset: raw.preset })));
      continue;
    }

    const rule = { type: raw.type, percentOfLineups };
    if (raw.min != null) rule.min = raw.min;
    if (raw.max != null) rule.max = raw.max;
    if (raw.teams != null) rule.teams = asList(raw.teams).map(upper);

    if (raw.type === 'gameStack') {
      // gameId(s) and/or teams -> candidate games (null = any game)
      let games = [...asList(raw.gameId), ...asList(raw.gameIds)].map(parseGameId);
      if (rule.teams) {
        const slateGames = games.length ? games : [...new Set(players.map(gameOf).filter(Boolean))];
        games = slateGames.filter(g => g.split('@').some(t => rule.teams.includes(t)));
        delete rule.teams;
        if (games.length === 0) games = ['NONE@NONE']; // no game for those teams -> infeasible
      }
      if (games.length) rule.games = games;
      rule.bringBack = raw.bringBack ?? 0;
    }
    if (raw.type === 'avoidOpponent') {
      rule.playerIds = [...asList(raw.playerId), ...asList(raw.playerIds)];
      rule.max = raw.max ?? 0;
    }
    rules.push(rule);
  }
  return rules;
}

function expandPreset(raw, players, site) {
  const opts = { ...STACK_PRESETS[raw.preset].defaults, ...raw };

  if (raw.preset === 'shootout') {
    const games = rankShootoutGames(players, opts).slice(0, opts.topGames);
    if (games.length === 0) {
      console.warn('⚠️  shootout preset: no game matches the Vegas total/spread limits; preset skipped');
      return [];
    }
    return [{ type: 'gameStack', games: games.map(g => g.game), min: opts.min, bringBack: opts.bringBack }];
  }

  if (raw.preset === 'usageBump') {
    const teams = usageBumpTeams(players, site, opts);
    if (teams.length === 0) {
      console.warn('⚠️  usageBump preset: no OUT star found (pass outPlayers or teams); preset skipped');
      return [];
    }
    return [{ type: 'teamStack', teams, min: opts.min }];
  }

  return []; // cash
}

/**
 * Games on the slate by Vegas total (high first), keeping those within
 * maxSpread and at or above minTotal. Uses each game's largest listed total
 * and smallest absolute spread across its players.
 */
export function rankShootoutGames(players, { maxSpread = 6, minTotal } = {}) {
  const games = new Map();
  for (const p of players) {
    const game = gameOf(p);
    if (!game) continue;
    const g = games.get(game) || { game, total: null, spread: null };
    const total = Number(p.vegas_over_under);
    const spread = Math.abs(Number(p.vegas_spread));
    if (total > 0 && (g.total == null || total > g.total)) g.total = total;
    if (p.vegas_spread != null && Number.isFinite(spread) && (g.spread == null || spread < g.spread)) g.spread = spread;
    games.set(game, g);
  }

  return [...games.values()]
    .filter(g => g.total != null)
    .filter(g => g.spread == null || g.spread <= maxSpread)
    .filter(g => minTotal == null || g.total >= minTotal)
    .sort((a, b) => b.total - a.total || (a.spread ?? 0) - (b.spread ?? 0));
}

export function usageBumpTeams(players, site, { teams, outPlayers } = {}) {
  const result = new Set(asList(teams).map(upper));

  const wanted = asList(outPlayers);
  const wantedIds = new Set(wanted.filter(v => typeof v === 'number'));
  const wantedNames = new Set(wanted.filter(v => typeof v === 'string').map(n => n.trim().toLowerCase()));
  const scale = site ? salaryScale(site) : 1;

  for (const p of players) {
    if (!p.team) continue;
    const named = wantedIds.has(p.id) || wantedNames.has(String(p.name || '').trim().toLowerCase());
    const outStar = isOut(p) && (p.salary || 0) * scale >= STAR_SALARY;
    if (named || outStar) result.add(upper(p.team));
  }
  return [...result];
}

/**
 * Does a lineup (array of player objects) satisfy a resolved rule?
 * Used for percentOfLineups bookkeeping and handy for tests.
 */
export function lineupSatisfies(rule, lineupPlayers, rosterSize = lineupPlayers.length) {
  const teamCount = new Map();
  const gameCount = new Map();
  for (const p of lineupPlayers) {
    if (p.team) teamCount.set(upper(p.team), (teamCount.get(upper(p.team)) || 0) + 1);
    const g = gameOf(p);
    if (g) gameCount.set(g, (gameCount.get(g) || 0) + 1);
  }
  const countTeam = (t) => teamCount.get(t) || 0;
  const inRange = (n) => (rule.min == null || n >= rule.min) && (rule.max == null || n <= rule.max);

  switch (rule.type) {
    case 'team':
      return rule.teams.every(t => inRange(countTeam(t)));
    case 'teamStack': {
      const candidates = rule.teams || [...teamCount.keys()];
      if (rule.max != null && candidates.some(t => countTeam(t) > rule.max)) return false;
      return candidates.some(t => countTeam(t) >= rule.min);
    }
    case 'gameStack': {
      const candidates = rule.games || [...gameCount.keys()];
      if (rule.max != null && candidates.some(g => (gameCount.get(g) || 0) > rule.max)) return false;
      return candidates.some(g => {
        const [a, b] = g.split('@');
        return countTeam(a) + countTeam(b) >= rule.min &&
          countTeam(a) >= rule.bringBack && countTeam(b) >= rule.bringBack;
      });
    }
    case 'maxPerTeam':
      return (rule.teams || [...teamCount.keys()]).every(t => countTeam(t) <= rule.max);
    case 'minGames':
      return gameCount.size >= rule.min;
    case 'avoidOpponent':
      return rule.playerIds.every(id => {
        const anchor = lineupPlayers.find(p => p.id === id);
        return !anchor || countTeam(upper(anchor.opponent)) <= rule.max;
      });
    default:
      return true;
  }
}

function rulesFor(ctx) {
  const raw = [...asList(ctx.settings.stackRules), ...asList(ctx.settings.teamStacks)];
  return raw.length ? resolveStackRules(raw, ctx.players, ctx.site) : [];
}

/**
 * Is the rule enforced on this solve? percentOfLineups < 100 rules switch off
 * once enough earlier lineups in the request satisfy them.
 */
function isActive(rule, ctx) {
  if (rule.percentOfLineups >= 100) return true;
  if (rule.percentOfLineups <= 0) return false;
  const target = Math.ceil((rule.percentOfLineups / 100) * (ctx.numLineups || 1));
  const satisfied = (ctx.priorLineups || []).filter(ids => lineupSatisfies(
    rule,
    ids.map(id => ctx.playersById.get(id)).filter(Boolean),
    ctx.rosterSize
  )).length;
  return satisfied < target;
}

export function apply(model, ctx) {
  const rules = rulesFor(ctx);
  if (rules.length === 0) return;

  // Pool players with LP variables, grouped by team and game
  const byTeam = new Map();
  const byGame = new Map();
  for (const p of ctx.players) {
    if (!p.team || !(ctx.varsByPlayer.get(p.id) || []).length) continue;
    const team = upper(p.team);
    if (!byTeam.has(team)) byTeam.set(team, []);
    byTeam.get(team).push(p.id);
    const game = gameOf(p);
    if (game) {
      if (!byGame.has(game)) byGame.set(game, []);
      byGame.get(game).push(p.id);
    }
  }
  const teamsOfGame = (game) => game.split('@');

  // constraint key -> sum(players of these teams) with the given bounds
  const countConstraint = (key, teams, bounds) => {
    model.constraints[key] = bounds;
    teams.forEach(t => (byTeam.get(t) || []).forEach(id => addToPlayerVars(model, ctx, id, key)));
  };

  // Binary helper variable, optionally with coefficients on constraints
  const binary = (varName, coefs) => {
    model.variables[varName] = { ...coefs, [`${varName}_bin`]: 1 };
    model.constraints[`${varName}_bin`] = { max: 1 };
    model.ints[varName] = 1;
  };

  rules.forEach((rule, r) => {
    if (!isActive(rule, ctx)) return;
    const k = `stk${r}`;

    switch (rule.type) {
      case 'team':
        rule.teams.forEach(t => {
          const bounds = {};
          if (rule.min != null) bounds.min = rule.min;
          if (rule.max != null) bounds.max = rule.max;
          countConstraint(`${k}_team_${t}`, [t], bounds);
        });
        break;

      case 'teamStack': {
        // one binary per candidate team: count_t - min * y_t >= 0, sum(y) >= 1
        const candidates = rule.teams || [...byTeam.keys()];
        model.constraints[`${k}_any`] = { min: 1 };
        candidates.forEach(t => {
          const key = `${k}_t_${t}`;
          countConstraint(key, [t], { min: 0 });
          binary(`${k}_y_${t}`, { [key]: -rule.min, [`${k}_any`]: 1 });
          if (rule.max != null) countConstraint(`${k}_tmax_${t}`, [t], { max: rule.max });
        });
        break;
      }

      case 'gameStack': {
        // one binary per candidate game: game count >= min * y, each side >= bringBack * y
        const games = rule.games || [...byGame.keys()];
        model.constraints[`${k}_any`] = { min: 1 };
        games.forEach(g => {
          const [a, b] = teamsOfGame(g);
          const gid = `${a}_${b}`;
          const coefs = { [`${k}_any`]: 1 };

          countConstraint(`${k}_g_${gid}`, [a, b], { min: 0 });
          coefs[`${k}_g_${gid}`] = -rule.min;
          if (rule.bringBack > 0) {
            countConstraint(`${k}_side_${gid}_${a}`, [a], { min: 0 });
            countConstraint(`${k}_side_${gid}_${b}`, [b], { min: 0 });
            coefs[`${k}_side_${gid}_${a}`] = -rule.bringBack;
            coefs[`${k}_side_${gid}_${b}`] = -rule.bringBack;
          }
          binary(`${k}_y_${gid}`, coefs);
          if (rule.max != null) countConstraint(`${k}_gmax_${gid}`, [a, b], { max: rule.max });
        });
        break;
      }

      case 'maxPerTeam':
        (rule.teams || [...byTeam.keys()]).forEach(t => countConstraint(`${k}_team_${t}`, [t], { max: rule.max }));
        break;

      case 'minGames':
        requireDistinctGroups(model, ctx, { prefix: `${k}Games`, minGroups: rule.min, groupOf: gameOf });
        break;

      case 'avoidOpponent':
        // opp count + (rosterSize - max) * x_anchor <= rosterSize
        rule.playerIds.forEach(id => {
          const anchor = ctx.playersById.get(id);
          if (!anchor?.opponent || !(ctx.varsByPlayer.get(id) || []).length) return;
          const key = `${k}_avoid_${id}`;
          countConstraint(key, [upper(anchor.opponent)], { max: ctx.rosterSize });
          addToPlayerVars(model, ctx, id, key, ctx.rosterSize - rule.max);
        });
        break;
    }
  });
}
