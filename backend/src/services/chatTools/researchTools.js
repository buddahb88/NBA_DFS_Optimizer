/**
 * CHAT RESEARCH TOOLS
 *
 * Matchup, role, insights and results tools shared by ResearchAgent,
 * AnalystAgent and aiChatService. Each is a thin wrapper over an existing
 * service, same shape as historyTools: { name, description, parameters,
 * execute(args) -> object }.
 *
 * - get_archetype_matchups    archetypeDefenseService.getTonight (G1 adjusted edge)
 * - get_player_profile        playerProfileService reads
 * - get_team_defense_profile  archetypeDefenseService.getDefense (+ thin-season fallback)
 * - get_usage_bumps / get_missing_players / get_streaks_and_consistency  insightsService
 * - score_lineup              resultsService.getPlayerResultsOnDate
 * - get_projection_results    resultsService.getResults / getPlayerResults
 *
 * Slate tools default to the latest slate. Rates are fractions (0.31 = 31%).
 * Successful results carry ui blocks (uiBlocks.js) under a symbol key the
 * LLM never sees.
 */

import slateModel from '../../models/slateModel.js';
import playerModel from '../../models/playerModel.js';
import insightsService from '../insightsService.js';
import { getTonight, getDefense, rankDefenses } from '../archetypeDefenseService.js';
import { getPlayerProfiles, getSeasonToDate } from '../playerProfileService.js';
import { getResults, getPlayerResults, getPlayerResultsOnDate } from '../resultsService.js';
import { resolvePlayer } from './historyTools.js';
import { canonicalTeam } from '../../utils/playerKey.js';
import { getCurrentSeason } from '../../utils/season.js';
import { resolveSite } from '../../utils/resolveSite.js';
import { withUiBlocks } from './uiBlockBuilders.js';

export const RESEARCH_TOOL_NAMES = Object.freeze([
  'get_archetype_matchups',
  'get_player_profile',
  'get_team_defense_profile',
  'get_usage_bumps',
  'get_missing_players',
  'get_streaks_and_consistency',
  'score_lineup',
  'get_projection_results',
]);

const SITES = ['draftkings', 'fanduel', 'yahoo'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const LOW_SAMPLE_GAMES = 10;

const round1 = (x) => (x === null || x === undefined ? null : Math.round(x * 10) / 10);
const round2 = (x) => (x === null || x === undefined ? null : Math.round(x * 100) / 100);
const round3 = (x) => (x === null || x === undefined ? null : Math.round(x * 1000) / 1000);
const toDateString = (value) => (value instanceof Date ? value.toISOString().slice(0, 10) : value ?? null);
const clampLimit = (value, fallback, max = 50) => Math.max(1, Math.min(Number(value) || fallback, max));

const SITE_PROP = { type: 'string', enum: SITES, description: 'DFS site (default: the slate\'s site, else draftkings)' };
const SLATE_PROP = { type: 'string', description: 'Slate ID (default: the latest slate)' };
const WINDOW_PROPS = {
  startDate: { type: 'string', description: 'Window start YYYY-MM-DD' },
  endDate: { type: 'string', description: 'Window end YYYY-MM-DD (default: latest game in the data)' },
};

async function currentSlateId(slateId) {
  if (slateId) return String(slateId);
  const [latest] = await slateModel.getAll();
  return latest?.slate_id ?? null;
}

async function siteFor(site, slateId) {
  const { site: resolved, error } = await resolveSite(insightsService.normalizeSite(site), slateId);
  if (error) throw new Error(error);
  return resolved;
}

const fallbackNote = (fallback, season) => (fallback
  ? `${fallback.from} has only ${fallback.qualifiedDefenses} defenses with ${fallback.minGames}+ games, so defense numbers are from ${season}.`
  : undefined);

// ── Handlers ─────────────────────────────────────────────────────────

async function getArchetypeMatchups({ slateId, site, minEdge, limit = 15 }) {
  const id = await currentSlateId(slateId);
  if (!id) return { success: false, message: 'No slates found. Import a slate first.' };
  const tonight = await getTonight({ slateId: id, site: site || undefined });
  const min = minEdge === undefined || minEdge === null ? null : Number(minEdge);
  const matches = tonight.players.filter(p => min === null || (p.adjusted_edge ?? -Infinity) >= min);
  return {
    success: true,
    slateId: id,
    season: tonight.season,
    site: tonight.site,
    fallback: tonight.fallback,
    note: fallbackNote(tonight.fallback, tonight.season),
    slatePlayers: tonight.slatePlayers,
    totalMatches: matches.length,
    players: matches.slice(0, clampLimit(limit, 15)).map(p => ({
      name: p.name,
      team: p.team,
      opponent: p.opponent,
      position: p.position,
      salary: p.salary,
      projectedPoints: p.projected_points,
      injuryStatus: p.injury_status,
      archetype: p.archetype,
      archetypeLabel: p.label,
      matchupEdge: p.matchup_delta,
      rank: p.rank,
      teams: p.teams,
      games: p.games,
      adjustedEdge: p.adjusted_edge,
      minutes: p.minutes,
      role: p.role,
      newTeam: p.new_team,
      crowding: p.crowding,
      flags: p.flags,
      components: p.components,
    })),
    howToRead: 'matchupEdge = FP per player-game the opponent allows to this archetype above expectation (rank 1 = allows the most). adjustedEdge = matchupEdge x minutes confidence x crowding; flags explain the discounts.',
  };
}

const profileRow = (p) => ({
  season: p.season,
  team: p.team,
  teams: p.teams,
  position: p.position,
  archetype: p.archetype ?? null,
  secondaryArchetype: p.secondary_archetype ?? null,
  games: p.games,
  starts: p.starts,
  minutesPg: round1(p.minutes_pg),
  usgPct: round3(p.usg_pct),
  astPct: round3(p.ast_pct),
  rebPct: round3(p.reb_pct),
  stlPct: round3(p.stl_pct),
  blkPct: round3(p.blk_pct),
  threePaRate: round3(p.three_pa_rate),
  tsPct: round3(p.ts_pct),
  ptsPer36: round1(p.pts_per36),
  rebPer36: round1(p.reb_per36),
  astPer36: round1(p.ast_per36),
  fg3mPer36: round1(p.fg3m_per36),
  dkFppm: round3(p.dk_fppm),
  fdFppm: round3(p.fd_fppm),
});

async function getPlayerProfile({ name, seasons }) {
  const player = await resolvePlayer(name);
  if (!player.found) {
    const names = player.suggestions.map(s => s.name);
    return {
      success: false,
      message: `Player "${name}" not found.${names.length ? ` Closest matches: ${names.join(', ')}.` : ''}`,
      closestMatches: names,
    };
  }
  const season = getCurrentSeason();
  const [profiles, toDate] = await Promise.all([
    getPlayerProfiles(player.key, { seasons }),
    getSeasonToDate(player.key, season),
  ]);
  const currentProfile = profiles.find(p => p.season === season);
  return {
    success: true,
    player: { name: player.name, key: player.key, team: player.team },
    profiles: profiles.map(profileRow),
    currentSeason: {
      season,
      games: toDate?.games || 0,
      starts: toDate?.starts || 0,
      minutesPg: round1(toDate?.minutes_pg),
      dkAvg: round1(toDate?.dk_avg),
      fdAvg: round1(toDate?.fd_avg),
      lastGame: toDateString(toDate?.last_game),
      profile: currentProfile ? profileRow(currentProfile) : null,
    },
    note: profiles.length === 0 ? 'No season profiles stored for this player.' : 'Rates are fractions (0.28 = 28%); per-36 and fppm are per minute played.',
  };
}

function defenseView(allRows, team) {
  const ranks = rankDefenses(allRows);
  const rows = allRows
    .filter(r => r.team === team)
    .map(r => {
      const hit = ranks.get(r.group_key)?.get(team);
      return {
        group: r.group_key,
        label: r.label,
        fpOverExpectation: round2(r.fp_over_expectation),
        ptsDelta: round2(r.pts_delta),
        rebDelta: round2(r.reb_delta),
        astDelta: round2(r.ast_delta),
        fg3mDelta: round2(r.fg3m_delta),
        stocksDelta: round2(r.stocks_delta),
        rank: hit?.rank ?? null,
        teams: hit?.teams ?? null,
        games: r.games,
        playerGames: r.player_games,
        lowSample: (Number(r.games) || 0) < LOW_SAMPLE_GAMES,
      };
    })
    .sort((a, b) => b.fpOverExpectation - a.fpOverExpectation);
  return {
    rows,
    weakestVs: rows.filter(r => r.fpOverExpectation > 0).slice(0, 3),
    strongestVs: [...rows].reverse().slice(0, 3),
  };
}

async function getTeamDefenseProfile({ team, season, site, groupBy = 'both' }) {
  const code = canonicalTeam(team);
  if (!code) return { success: false, message: 'team is required (abbreviation, e.g. "BOS")' };
  if (!['archetype', 'position', 'both'].includes(groupBy)) return { success: false, message: 'groupBy must be archetype, position or both' };
  const siteKey = insightsService.normalizeSite(site) || 'draftkings';

  const groupings = groupBy === 'both' ? ['archetype', 'position'] : [groupBy];
  const first = await getDefense({ season, site: siteKey, grouping: groupings[0], seasonFallback: true });
  const out = {
    success: true,
    team: code,
    season: first.season,
    site: siteKey,
    fallback: first.fallback,
    note: fallbackNote(first.fallback, first.season),
    [groupings[0]]: defenseView(first.rows, code),
  };
  if (groupings[1]) {
    // Same season as the first grouping, no separate fallback
    out[groupings[1]] = defenseView((await getDefense({ season: first.season, site: siteKey, grouping: groupings[1] })).rows, code);
  }
  if (groupings.every(g => out[g].rows.length === 0)) {
    return { success: false, message: `No defense rows for ${code} in ${first.season} (${siteKey}).` };
  }
  out.howToRead = 'fpOverExpectation = fantasy points per player-game this defense allows above (+) / below (-) what those players normally score; rank 1 = allows the most of 30. Under 10 games values are mostly shrunk to 0.';
  return out;
}

// Early in a season nobody has enough games in the default window
const EMPTY_WINDOW_NOTE = 'Nothing qualified in this window (regulars need 5-8+ games). Early in a season pass startDate/endDate covering last season.';

async function slatePlayersFor({ slateId, team }) {
  const id = await currentSlateId(slateId);
  if (!id) return { error: 'No slates found. Import a slate first.' };
  let players = await playerModel.getBySlateId(id);
  if (players.length === 0) return { error: `No players on slate ${id}.` };
  const code = canonicalTeam(team);
  if (code) players = players.filter(p => canonicalTeam(p.team) === code);
  return { id, players, team: code };
}

async function getUsageBumps({ team, slateId, startDate, endDate, site }) {
  const slate = await slatePlayersFor({ slateId, team });
  if (slate.error) return { success: false, message: slate.error };
  if (slate.players.length === 0) return { success: true, slateId: slate.id, team: slate.team, count: 0, usageBumps: [], message: `No ${slate.team} players on slate ${slate.id}.` };
  const siteKey = await siteFor(site, slate.id);
  const usageBumps = await insightsService.detectUsageBumps(slate.players, { site: siteKey, startDate, endDate, minGames: 8, minAvgDk: 25 });
  return {
    success: true,
    slateId: slate.id,
    team: slate.team,
    site: siteKey,
    count: usageBumps.length,
    usageBumps,
    note: usageBumps.length === 0 ? EMPTY_WINDOW_NOTE : undefined,
    howToRead: 'For each regular missing from the slate (8+ games, 25+ avg in the window, default last 30 days), slate teammates\' average in games he missed vs played this season. absenceReason OUT = not in the box score, DNP-CD = healthy scratch.',
  };
}

async function getMissingPlayers({ team, slateId, startDate, endDate, site }) {
  const slate = await slatePlayersFor({ slateId, team });
  if (slate.error) return { success: false, message: slate.error };
  if (slate.players.length === 0) return { success: true, slateId: slate.id, team: slate.team, teamsWithMissing: 0, report: [] };
  const siteKey = await siteFor(site, slate.id);
  const report = await insightsService.getMissingPlayersReport(slate.players, { site: siteKey, startDate, endDate, minGames: 5, minAvgDk: 20 });
  return {
    success: true, slateId: slate.id, team: slate.team, site: siteKey, teamsWithMissing: report.length, report,
    note: report.length === 0 ? EMPTY_WINDOW_NOTE : undefined,
  };
}

const STREAK_TYPES = {
  hot: 'getHotStreaks',
  cold: 'getColdStreaks',
  consistency: 'getConsistencyLeaders',
  boom_bust: 'getBoomBustPlayers',
};

async function getStreaksAndConsistency({ type, limit = 15, minGames, lastNDays, startDate, endDate, site }) {
  const method = STREAK_TYPES[type];
  if (!method) return { success: false, message: `type must be one of: ${Object.keys(STREAK_TYPES).join(', ')}` };
  const siteKey = insightsService.normalizeSite(site) || 'draftkings';
  const defaults = type === 'hot' || type === 'cold' ? 5 : 8;
  const players = await insightsService[method]({
    limit: clampLimit(limit, 15), minGames: Number(minGames) || defaults, lastNDays, startDate, endDate, site: siteKey,
  });
  return { success: true, type, site: siteKey, count: players.length, players };
}

async function scoreLineup({ players = [], date, site }) {
  if (!date || !DATE_RE.test(date)) return { success: false, message: 'date must be YYYY-MM-DD' };
  if (!Array.isArray(players) || players.length === 0) return { success: false, message: 'players must list at least one name' };
  const siteKey = insightsService.normalizeSite(site) || 'draftkings';

  const resolved = [];
  const notFound = [];
  for (const name of players) {
    const p = await resolvePlayer(name);
    if (p.found) resolved.push(p);
    else notFound.push({ query: name, closestMatches: p.suggestions.map(s => s.name) });
  }
  const results = await getPlayerResultsOnDate({ playerKeys: resolved.map(p => p.key), date, site: siteKey });
  const byKey = new Map(results.map(r => [r.playerKey, r]));

  const rows = resolved.map(p => {
    const r = byKey.get(p.key);
    const played = r.status === 'PLAYED';
    const points = played ? r.actual ?? 0 : 0;
    return {
      name: p.name,
      key: p.key,
      team: r.team,
      opponent: r.opponent,
      status: r.status,
      statusReason: r.statusReason,
      minutes: played ? r.actualMinutes : 0,
      points,
      salary: r.salary ?? null,
      projected: r.projectedPoints ?? null,
      vsProjection: r.projectedPoints !== null && r.projectedPoints !== undefined && played ? round2(points - r.projectedPoints) : null,
      valuePer1k: r.salary > 0 ? round2(points / (r.salary / 1000)) : null,
      onSnapshot: r.onSnapshot,
    };
  });
  const withSnapshot = rows.filter(r => r.onSnapshot);
  const sum = (list, field) => round2(list.reduce((s, r) => s + (Number(r[field]) || 0), 0));
  const totalSalary = withSnapshot.length ? sum(withSnapshot, 'salary') : null;
  const totalPoints = sum(rows, 'points');

  return {
    success: true,
    date,
    site: siteKey,
    totalPoints,
    totalSalary,
    totalProjected: withSnapshot.length ? sum(withSnapshot, 'projected') : null,
    valuePer1k: totalSalary > 0 ? round2(totalPoints / (totalSalary / 1000)) : null,
    playersWithSnapshot: withSnapshot.length,
    players: rows,
    notPlayed: rows.filter(r => r.status !== 'PLAYED').map(r => r.name),
    notFound: notFound.length ? notFound : undefined,
    incomplete: notFound.length > 0 || undefined,
    message: notFound.length
      ? `Total excludes ${notFound.map(n => `"${n.query}"${n.closestMatches.length ? ` (did you mean ${n.closestMatches.slice(0, 3).join(' / ')}?)` : ''}`).join(', ')}; retry with the full name.`
      : undefined,
    note: withSnapshot.length < rows.length
      ? 'Salary/projection come from saved slate snapshots; players without one show null (totals cover snapshot players only).'
      : undefined,
  };
}

const missRow = (r) => ({
  name: r.name, team: r.team, date: r.date, salary: r.salary, projected: r.projectedPoints, actual: r.actual,
  error: r.projectionError, minutes: r.actualMinutes, projectedMinutes: r.projectedMinutes,
});

async function getProjectionResults({ date, startDate, endDate, site, slateId }) {
  for (const [name, v] of [['date', date], ['startDate', startDate], ['endDate', endDate]]) {
    if (v && !DATE_RE.test(v)) return { success: false, message: `${name} must be YYYY-MM-DD` };
  }
  const from = date || startDate || null;
  const to = date || endDate || null;
  const siteKey = insightsService.normalizeSite(site) || 'draftkings';
  const results = await getResults({ from, to, site: siteKey, slateId });
  if (results.overall.players === 0) {
    return { success: false, message: `No saved slate snapshots for ${siteKey}${from ? ` from ${from}` : ''}${to ? ` to ${to}` : ''}.` };
  }
  const played = (await getPlayerResults({ from, to, site: siteKey, slateId })).filter(r => r.projectionError !== null);
  const byError = [...played].sort((a, b) => b.projectionError - a.projectionError);
  return {
    success: true,
    site: siteKey,
    from,
    to,
    overall: results.overall,
    bySalaryTier: results.bySalaryTier,
    byPosition: results.byPosition,
    byDate: results.byDate.slice(-15),
    biggestMisses: {
      over: byError.filter(r => r.projectionError > 0).slice(0, 5).map(missRow),
      under: byError.filter(r => r.projectionError < 0).reverse().slice(0, 5).map(missRow),
    },
    howToRead: 'projection error = projected - actual (bias > 0 = projections too high); hitRates are % of players who played reaching 3x/5x/6x salary/1000; DNP/INACTIVE counted separately.',
  };
}

// ── Definitions ──────────────────────────────────────────────────────

const DEFINITIONS = [
  {
    name: 'get_archetype_matchups',
    description: 'FIRST CHOICE for "best matchups tonight": slate players whose opponent is in the weak tier vs their archetype, ranked by adjusted edge (matchup edge x minutes confidence x crowding). Returns archetype, opponent, matchup edge (FP per game above expectation), defense rank and games, minutes context, role/new-team flags and crowding. Early in a season defense uses last season (says so).',
    parameters: {
      type: 'object',
      properties: {
        slateId: SLATE_PROP,
        site: SITE_PROP,
        minEdge: { type: 'number', description: 'Minimum adjusted edge in fantasy points (e.g. 1.5)' },
        limit: { type: 'number', description: 'Max players (default 15, max 50)' },
      },
    },
    handler: getArchetypeMatchups,
  },
  {
    name: 'get_player_profile',
    description: "A player's role by season: archetype and secondary archetype, minutes, usage, assist/rebound/steal/block rates, 3PA rate, TS% (all rates are FRACTIONS: 0.28 = 28%), per-36 stats and fantasy points per minute, plus current-season games so far. Use for role changes and what kind of player someone is.",
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Player name (accents, Jr./III handled)' },
        seasons: { type: 'array', items: { type: 'string' }, description: 'Seasons like ["2025-26"] (default: all)' },
      },
      required: ['name'],
    },
    handler: getPlayerProfile,
  },
  {
    name: 'get_team_defense_profile',
    description: "One defense vs every archetype and G/F/C: fantasy points allowed above/below expectation per player-game, per-stat deltas (pts/reb/ast/3PM/stocks), league rank (1 = allows the most) and games sample. weakestVs = groups to attack. Without season, a thin current season falls back to last season (says so).",
    parameters: {
      type: 'object',
      properties: {
        team: { type: 'string', description: 'Defending team abbreviation (e.g. "BOS")' },
        season: { type: 'string', description: 'Season like "2025-26" (default: current, with fallback)' },
        site: SITE_PROP,
        groupBy: { type: 'string', enum: ['archetype', 'position', 'both'], description: 'Grouping (default both)' },
      },
      required: ['team'],
    },
    handler: getTeamDefenseProfile,
  },
  {
    name: 'get_usage_bumps',
    description: 'Slate players who score more when a regular teammate is missing from the slate (injured/out): averages with vs without him this season, minutes change, bumped projection and value. Use for "who benefits from X being out" on tonight\'s slate.',
    parameters: {
      type: 'object',
      properties: { team: { type: 'string', description: 'Only this team (abbreviation)' }, slateId: SLATE_PROP, ...WINDOW_PROPS, site: SITE_PROP },
    },
    handler: getUsageBumps,
  },
  {
    name: 'get_missing_players',
    description: 'Regulars (5+ games, 20+ fantasy avg in the window, default last 30 days) of each slate team who are NOT on the slate - likely out tonight.',
    parameters: {
      type: 'object',
      properties: { team: { type: 'string', description: 'Only this team (abbreviation)' }, slateId: SLATE_PROP, ...WINDOW_PROPS, site: SITE_PROP },
    },
    handler: getMissingPlayers,
  },
  {
    name: 'get_streaks_and_consistency',
    description: 'League-wide form cards. hot/cold: last-3 average 15%+ above/below season average. consistency: lowest variance (score 0-100). boom_bust: highest standard deviation with boom (50+) / bust (<15) rates.',
    parameters: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: Object.keys(STREAK_TYPES), description: 'Which card' },
        limit: { type: 'number', description: 'Max players (default 15)' },
        minGames: { type: 'number', description: 'Minimum games (default 5 for hot/cold, 8 otherwise)' },
        lastNDays: { type: 'number', description: 'Window length in days (consistency/boom_bust)' },
        ...WINDOW_PROPS,
        site: SITE_PROP,
      },
      required: ['type'],
    },
    handler: getStreaksAndConsistency,
  },
  {
    name: 'score_lineup',
    description: 'Score a lineup (or any players) on a PAST date: actual fantasy points per player and the total, DNP/INACTIVE flagged (scored 0), and when the date has a saved slate, salary, projection, actual minus projection and points per $1K. Use for "how did this lineup do".',
    parameters: {
      type: 'object',
      properties: {
        players: { type: 'array', items: { type: 'string' }, description: 'Player names' },
        date: { type: 'string', description: 'Game date YYYY-MM-DD' },
        site: SITE_PROP,
      },
      required: ['players', 'date'],
    },
    handler: scoreLineup,
  },
  {
    name: 'get_projection_results',
    description: 'How our projections did on past slates: MAE/RMSE/bias of projected vs actual points and minutes, value hit rates (3x/5x/6x), splits by salary tier, position and date, and the biggest misses. Pass date for one night or startDate/endDate.',
    parameters: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'One date YYYY-MM-DD' },
        ...WINDOW_PROPS,
        slateId: { type: 'string', description: 'Only this slate' },
        site: SITE_PROP,
      },
    },
    handler: getProjectionResults,
  },
];

/** Fresh tool objects: { name, description, parameters, execute } */
export function createResearchTools() {
  return DEFINITIONS.map(({ handler, ...def }) => ({
    ...def,
    execute: async (args = {}) => {
      console.log(`\n🔎 [research] ${def.name}`, JSON.stringify(args));
      try {
        return await withUiBlocks(def.name, await handler(args), args);
      } catch (error) {
        console.error(`❌ ${def.name} error:`, error);
        return { success: false, message: error.message };
      }
    },
  }));
}
