/**
 * AGENT VALUE-PICK BACKTEST
 *
 * For every past date with slate_player_snapshots, the chat agent's top 5
 * value plays at salary <= $6,500 are scored against historical_games and
 * compared on the same date with two baselines:
 *
 *   agent           the chat tool layer's picks (agentPicker; by default
 *                   the slate pool ranked by projection per $1K with the
 *                   get_archetype_matchups edge as an adjustment, see
 *                   agentValuePicks)
 *   baseline_value  top 5 by projected points per $1K, $3,500-6,500, not OUT
 *   band_average    the average player in the $4,500-6,500 band who played
 *   opportunity_top top 5 by Opportunity Radar score (cash by default, or
 *                   gpp) at $3,500-6,500, not OUT (opportunityPicker; the
 *                   radar for that night only reads games before it)
 *
 * Per method: total DK, points per $1K, 5x hit rate (DK >= 5 x salary/1000)
 * and projected vs actual minutes per player. Pick methods use total DK /
 * total salary; band_average is the mean of per-player values, and its total
 * DK is a 5-player set at the band's average. A pick who did not play scores
 * 0 and misses 5x. Pool rows are resultsService.getPlayerResults rows.
 *
 * A method with fewer than PICKS picks (or a band with no played players) is
 * marked incomplete; summarize leaves those dates out of the cumulative
 * comparison, and avgDk (DK per player) compares methods on equal footing.
 *
 * Results persist to agent_value_backtests (one row per run, date, method).
 */

import db from '../config/database.js';
import { getPlayerResults } from './resultsService.js';
import { createResearchTools } from './chatTools/researchTools.js';
import { STAT_COLUMNS, buildTonight, getDefense, loadArchetypeLookup, previousSeason, weakTiers } from './archetypeDefenseService.js';
import { loadEdgeContext } from './archetypeMatchupService.js';
import { playerKey } from '../utils/playerKey.js';
import { getOpportunityRadar } from './opportunity/radarService.js';

export const PICKS = 5;
export const AGENT_MAX_SALARY = 6500;
export const BASELINE_BAND = { min: 3500, max: 6500 };
export const AVERAGE_BAND = { min: 4500, max: 6500 };
export const METHODS = ['agent', 'baseline_value', 'band_average', 'opportunity_top'];
// Methods with picks (band_average is a band, not picks)
const PICK_METHODS = ['agent', 'baseline_value', 'opportunity_top'];
const HIT_MULTIPLE = 5;

const n = (v) => Number(v) || 0;
const round2 = (x) => Math.round(x * 100) / 100;
const dateString = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : v);
const isOut = (p) => String(p.injuryStatus ?? '').toUpperCase() === 'OUT';
const played = (p) => p.status === 'PLAYED';
const dk = (p) => (played(p) ? n(p.actual) : 0);
const hits5x = (p) => played(p) && n(p.actual) >= HIT_MULTIPLE * (n(p.salary) / 1000);
const per1k = (points, salary) => (salary > 0 ? points / (salary / 1000) : 0);
const pickRow = (p) => ({ name: p.name, salary: p.salary, projected: p.projectedPoints, dk: dk(p), minutes: n(p.actualMinutes) });

/** Score a list of picks (pool rows). */
export function scorePicks(picks) {
  const totalDk = picks.reduce((s, p) => s + dk(p), 0);
  const totalSalary = picks.reduce((s, p) => s + n(p.salary), 0);
  const hits = picks.filter(hits5x).length;
  const count = picks.length || 1;
  return {
    names: picks.map(p => p.name),
    players: picks.map(pickRow),
    picks: picks.length,
    avgDk: round2(totalDk / count),
    totalDk: round2(totalDk),
    totalSalary,
    valuePer1k: round2(per1k(totalDk, totalSalary)),
    hits5x: hits,
    hit5x: round2(hits / count),
    projectedMinutes: round2(picks.reduce((s, p) => s + n(p.projectedMinutes), 0) / count),
    actualMinutes: round2(picks.reduce((s, p) => s + n(p.actualMinutes), 0) / count),
  };
}

/** Baseline (a): top `count` by projected points per $1K in BASELINE_BAND, not OUT. */
export function topProjectedValue(pool, count = PICKS) {
  return pool
    .filter(p => n(p.salary) >= BASELINE_BAND.min && n(p.salary) <= BASELINE_BAND.max && !isOut(p))
    .sort((a, b) => per1k(n(b.projectedPoints), b.salary) - per1k(n(a.projectedPoints), a.salary)
      || n(b.projectedPoints) - n(a.projectedPoints) || String(a.name).localeCompare(String(b.name)))
    .slice(0, count);
}

/** Baseline (b): the average player in AVERAGE_BAND who played. */
export function bandAverage(pool) {
  const band = pool.filter(p => n(p.salary) >= AVERAGE_BAND.min && n(p.salary) <= AVERAGE_BAND.max && played(p));
  const count = band.length || 1;
  const valueSum = band.reduce((s, p) => s + per1k(n(p.actual), n(p.salary)), 0);
  const hits = band.filter(hits5x).length;
  const avgDk = band.reduce((s, p) => s + n(p.actual), 0) / count;
  return {
    names: [],
    players: band.length,
    avgDk: round2(avgDk),
    totalDk: round2(avgDk * PICKS),
    valuePer1k: round2(valueSum / count),
    valueSum,
    hits5x: hits,
    hit5x: round2(hits / count),
    projectedMinutes: round2(band.reduce((s, p) => s + n(p.projectedMinutes), 0) / count),
    actualMinutes: round2(band.reduce((s, p) => s + n(p.actualMinutes), 0) / count),
  };
}

/**
 * opportunity_top: top `count` pool players by Opportunity Radar score for
 * `mode` (cash_score / gpp_score; radar rows matched by player key) in
 * BASELINE_BAND, not OUT. Players without a score are left out.
 */
export function opportunityTopPicks(pool, radarRows, { mode = 'cash', count = PICKS } = {}) {
  const field = mode === 'gpp' ? 'gpp_score' : 'cash_score';
  const scoreOf = new Map(radarRows
    .filter(r => r[field] !== null && r[field] !== undefined)
    .map(r => [r.player_key ?? playerKey(r.name), Number(r[field])]));
  const key = (p) => p.playerKey ?? playerKey(p.name);
  return pool
    .filter(p => n(p.salary) >= BASELINE_BAND.min && n(p.salary) <= BASELINE_BAND.max && !isOut(p) && scoreOf.has(key(p)))
    .sort((a, b) => scoreOf.get(key(b)) - scoreOf.get(key(a))
      || n(b.projectedPoints) - n(a.projectedPoints) || String(a.name).localeCompare(String(b.name)))
    .slice(0, count);
}

/** Default opportunityPicker: the radar for that night's saved slate (no lookahead). */
export async function deterministicOpportunityPicker({ date, slateId, site, pool, mode = 'cash' }) {
  const radar = await getOpportunityRadar({ slateId: String(slateId), slateDate: date, site, mode });
  return { source: `opportunity_radar:${mode}`, names: opportunityTopPicks(pool, radar.players, { mode }).map(p => p.name) };
}

/** Pool players the agent may pick: salary <= AGENT_MAX_SALARY, not OUT, with a projection. */
export function agentEligible(pool) {
  return pool.filter(p => n(p.salary) > 0 && n(p.salary) <= AGENT_MAX_SALARY && !isOut(p) && n(p.projectedPoints) > 0);
}

/**
 * The agent's value ranking: every eligible pool player by (projection +
 * matchup adjusted edge) per $1K. get_archetype_matchups only lists players
 * facing a weak-defense tier, so its rows (matched by player key) adjust the
 * score and a player without one counts an edge of 0.
 */
export function agentValuePicks(pool, matchupRows = [], count = PICKS) {
  const edgeOf = new Map(matchupRows.map(r => [playerKey(r.name), n(r.adjustedEdge)]));
  const score = (p) => per1k(n(p.projectedPoints) + (edgeOf.get(p.playerKey ?? playerKey(p.name)) ?? 0), n(p.salary));
  return agentEligible(pool)
    .sort((a, b) => score(b) - score(a) || n(b.projectedPoints) - n(a.projectedPoints) || String(a.name).localeCompare(String(b.name)))
    .slice(0, count);
}

const SNAPSHOT_SQL = `SELECT player_key, player_name, team, opponent, position, salary, projected_points,
  projected_minutes, injury_status FROM slate_player_snapshots WHERE game_date = ? AND site = ? AND slate_id = ?`;

/**
 * get_archetype_matchups rows for a past slate. While the slate is still
 * loaded this is the chat tool itself; otherwise the same ranking
 * (buildTonight) is replayed on the saved snapshot, with minutes so far
 * counted before the slate date (as scripts/tonightEdgeBacktest.js does).
 */
export async function matchupRowsFor({ date, slateId, site }) {
  const loaded = await db.get('SELECT COUNT(*) AS n FROM players WHERE slate_id = ?', String(slateId));
  if (n(loaded?.n) > 0) {
    const tool = createResearchTools().find(t => t.name === 'get_archetype_matchups');
    const out = await tool.execute({ slateId: String(slateId), site, limit: 50 });
    if (out.success) return { source: 'get_archetype_matchups', rows: out.players };
  }
  const defense = await getDefense({ site, seasonFallback: true });
  const archetypeSeason = defense.fallback?.from ?? defense.season;
  const [snapshot, archetypeOf, edgeContext] = await Promise.all([
    db.all(SNAPSHOT_SQL, date, site, String(slateId)),
    loadArchetypeLookup(archetypeSeason),
    loadEdgeContext({ season: archetypeSeason, lastSeason: previousSeason(archetypeSeason), asOfDate: date }),
  ]);
  const players = snapshot.map(s => ({ ...s, player_id: s.player_key, name: s.player_name }));
  const { players: tonight } = buildTonight(players, {
    tiers: weakTiers(defense.rows, 'fp'), column: STAT_COLUMNS.fp, grouping: 'archetype', archetypeOf, edgeContext,
  });
  return {
    source: 'snapshot_replay',
    rows: tonight.map(p => ({
      name: p.name, salary: p.salary, projectedPoints: p.projected_points, injuryStatus: p.injury_status, adjustedEdge: p.adjusted_edge,
    })),
  };
}

/** Default agentPicker: the deterministic tool output (no LLM). `eligible` is the candidate count. */
export async function deterministicAgentPicker({ date, slateId, site, pool }) {
  const { source, rows } = await matchupRowsFor({ date, slateId, site });
  return { source, names: agentValuePicks(pool, rows).map(r => r.name), eligible: agentEligible(pool).length };
}

/** The question the live agent gets for one date. */
export const valueQuestion = ({ date, slateId, site }) => `List your top ${PICKS} value plays at salary <= $${AGENT_MAX_SALARY} `
  + `for the ${date} ${site} slate (slate ${slateId}). Use the archetype matchup tool. Give one player per line with the full name.`;

/**
 * Pool players named in `text`, in order of first mention (full name or
 * player key), at most PICKS.
 */
export function namesFromAnswer(text, pool) {
  const lower = String(text ?? '').toLowerCase();
  const hits = [];
  for (const p of pool) {
    const idx = [String(p.name).toLowerCase(), p.playerKey].map(s => lower.indexOf(s)).filter(i => i >= 0);
    if (idx.length) hits.push({ name: p.name, at: Math.min(...idx) });
  }
  return hits.sort((a, b) => a.at - b.at).slice(0, PICKS).map(h => h.name);
}

/** Live agentPicker: asks the configured LLM through the chat orchestrator. */
export async function liveAgentPicker({ date, slateId, site, pool }) {
  const { default: agenticChatService } = await import('./agenticChatService.js');
  const response = await agenticChatService.chat(valueQuestion({ date, slateId, site }), `value-backtest-${date}`, { slateId });
  return { source: 'live_llm', names: namesFromAnswer(response.message, pool), eligible: agentEligible(pool).length, answer: response.message };
}

const DATES_SQL = `SELECT s.game_date, s.slate_id, COUNT(*) AS players
  FROM slate_player_snapshots s LEFT JOIN slate_catalog c ON c.site = s.site AND c.slate_id = s.slate_id
  WHERE s.site = ? GROUP BY s.game_date, s.slate_id
  ORDER BY s.game_date, MAX(CAST(COALESCE(c.is_main, 0) AS INT)) DESC, COUNT(*) DESC`;

/** Past dates with snapshots and their main slate (slate_catalog), else their largest. */
export async function backtestDates(site, { from, to } = {}) {
  const byDate = new Map();
  for (const r of await db.all(DATES_SQL, site)) {
    const date = dateString(r.game_date);
    if ((from && date < from) || (to && date > to) || byDate.has(date)) continue;
    byDate.set(date, String(r.slate_id));
  }
  return [...byDate].map(([date, slateId]) => ({ date, slateId }));
}

const incompleteDate = (d) => METHODS.some(method => d.methods[method]?.incomplete);

/**
 * Cumulative totals per method across `dates` (runValueBacktest rows). Dates
 * where any method is incomplete are left out and listed in `excluded`.
 */
export function summarize(allDates) {
  const dates = allDates.filter(d => !incompleteDate(d));
  const out = { excluded: allDates.filter(incompleteDate).map(d => d.date) };
  for (const method of PICK_METHODS) {
    const list = dates.map(d => d.methods[method]).filter(Boolean);
    const totalDk = list.reduce((s, m) => s + m.totalDk, 0);
    const totalSalary = list.reduce((s, m) => s + m.totalSalary, 0);
    const picks = list.reduce((s, m) => s + m.picks, 0) || 1;
    out[method] = {
      dates: list.length,
      totalDk: round2(totalDk),
      avgDk: round2(totalDk / picks),
      totalSalary,
      valuePer1k: round2(per1k(totalDk, totalSalary)),
      hit5x: round2(list.reduce((s, m) => s + m.hits5x, 0) / picks),
      projectedMinutes: round2(list.reduce((s, m) => s + m.projectedMinutes * m.picks, 0) / picks),
      actualMinutes: round2(list.reduce((s, m) => s + m.actualMinutes * m.picks, 0) / picks),
    };
  }
  const bands = dates.map(d => d.methods.band_average).filter(Boolean);
  const players = bands.reduce((s, b) => s + b.players, 0) || 1;
  out.band_average = {
    dates: bands.length,
    totalDk: round2(bands.reduce((s, b) => s + b.totalDk, 0)),
    avgDk: round2(bands.reduce((s, b) => s + b.avgDk * b.players, 0) / players),
    valuePer1k: round2(bands.reduce((s, b) => s + b.valueSum, 0) / players),
    hit5x: round2(bands.reduce((s, b) => s + b.hits5x, 0) / players),
    projectedMinutes: round2(bands.reduce((s, b) => s + b.projectedMinutes * b.players, 0) / players),
    actualMinutes: round2(bands.reduce((s, b) => s + b.actualMinutes * b.players, 0) / players),
  };
  out.agentBeatsBaseline = out.agent.valuePer1k > out.baseline_value.valuePer1k;
  out.opportunityBeatsBaseline = out.opportunity_top.dates > 0 && out.opportunity_top.valuePer1k > out.baseline_value.valuePer1k;
  return out;
}

async function persist(runAt, site, d) {
  for (const method of METHODS) {
    const m = d.methods[method];
    if (!m) continue;
    const source = method === 'agent' ? d.source : method === 'opportunity_top' ? d.opportunitySource : method;
    await db.run(`
      INSERT INTO agent_value_backtests (run_at, game_date, site, slate_id, method, source, players, n_players,
        pick_count, incomplete, total_salary, total_dk, value_per_1k, hit_5x, projected_minutes, actual_minutes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, runAt, d.date, site, d.slateId, method, source,
    JSON.stringify(method === 'band_average' ? [] : m.players), method === 'band_average' ? m.players : m.picks,
    method === 'band_average' ? null : m.picks, m.incomplete ? 1 : 0, m.totalSalary ?? null, m.totalDk, m.valuePer1k, m.hit5x, m.projectedMinutes, m.actualMinutes);
  }
}

/**
 * Run the backtest over every snapshot date (or from/to).
 * @param {Object} options - { site, from, to, agentPicker, opportunityPicker,
 *   opportunityMode ('cash' | 'gpp', default cash), persist, runAt }
 * @returns {{ runAt, site, dates: Array, summary }}
 */
export async function runValueBacktest(options = {}) {
  const {
    site = 'draftkings', from, to, agentPicker = deterministicAgentPicker, opportunityPicker = deterministicOpportunityPicker,
    opportunityMode = 'cash', runAt = new Date().toISOString(),
  } = options;
  const dates = [];
  for (const { date, slateId } of await backtestDates(site, { from, to })) {
    const pool = await getPlayerResults({ from: date, to: date, site, slateId });
    const picked = await agentPicker({ date, slateId, site, pool });
    // A night the radar cannot score (e.g. no metrics) leaves the method incomplete
    const opportunity = await opportunityPicker({ date, slateId, site, pool, mode: opportunityMode })
      .catch(error => ({ source: `error: ${error.message}`, names: [] }));
    const byKey = new Map(pool.map(p => [p.playerKey, p]));
    const picksOf = (names) => names.map(name => byKey.get(playerKey(name))).filter(Boolean);
    const agent = scorePicks(picksOf(picked.names));
    const opportunityTop = scorePicks(picksOf(opportunity.names));
    const baseline = scorePicks(topProjectedValue(pool));
    const band = bandAverage(pool);
    const row = {
      date,
      slateId,
      source: picked.source,
      opportunitySource: opportunity.source,
      methods: {
        agent: { ...agent, eligible: picked.eligible ?? null, incomplete: agent.picks < PICKS },
        baseline_value: { ...baseline, incomplete: baseline.picks < PICKS },
        band_average: { ...band, incomplete: band.players === 0 },
        opportunity_top: { ...opportunityTop, mode: opportunityMode, incomplete: opportunityTop.picks < PICKS },
      },
    };
    if (options.persist !== false) await persist(runAt, site, row);
    dates.push(row);
  }
  return { runAt, site, dates, summary: summarize(dates) };
}

export default {
  runValueBacktest, summarize, scorePicks, topProjectedValue, bandAverage, agentValuePicks, agentEligible, opportunityTopPicks,
};
