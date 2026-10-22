/**
 * CHAT SUGGESTIONS
 *
 * Starter prompts for an empty chat, built from tonight's slate:
 *   usage_bump      biggest teammate bump with a regular out (get_usage_bumps)
 *   archetype_edge  top adjusted archetype edge (get_archetype_matchups)
 *   game_stack      highest Vegas total game on the slate
 *   hot_streak      hottest slate player over the last 3 games (get_streaks_and_consistency)
 *   value_play      best projected points per $1K at $6,000 or less
 *   score_lineup    score a lineup from the latest night with results
 *
 * Each source is optional: a source that throws or finds nothing is skipped,
 * so the list holds only what tonight's data supports (possibly nothing).
 */

import slateModel from '../models/slateModel.js';
import playerModel from '../models/playerModel.js';
import db from '../config/database.js';
import { createResearchTools } from './chatTools/researchTools.js';
import { playerKey } from '../utils/playerKey.js';

const VALUE_MAX_SALARY = 6000;
const VALUE_MIN_SALARY = 3500;
const OUT_STATUSES = /^(out|o|ofs|inj|doubtful|d)$/i;

const round1 = (x) => Math.round(x * 10) / 10;
const num = (v) => (v === null || v === undefined || v === '' || Number.isNaN(Number(v)) ? null : Number(v));
const money = (salary) => `$${Number(salary).toLocaleString('en-US')}`;
const isOut = (p) => OUT_STATUSES.test(String(p.injury_status || '').trim());

/** Games on the slate with a Vegas total (game O/U, else the sum of implied totals), highest first. */
export function slateGames(players) {
  const games = new Map();
  for (const p of players) {
    if (!p.team || !p.opponent) continue;
    const key = [p.team, p.opponent].sort().join('-');
    if (!games.has(key)) games.set(key, { key, teams: {}, overUnder: null });
    const g = games.get(key);
    g.overUnder ??= num(p.vegas_over_under);
    const t = (g.teams[p.team] ??= { team: p.team, implied: null, spread: null });
    t.implied ??= num(p.vegas_implied_total);
    t.spread ??= num(p.vegas_spread);
  }
  return [...games.values()]
    .map((g) => {
      const teams = Object.values(g.teams);
      const implied = teams.map((t) => t.implied);
      const total = g.overUnder ?? (teams.length === 2 && implied.every((x) => x !== null) ? implied[0] + implied[1] : null);
      const spread = teams.map((t) => t.spread).find((s) => s !== null) ?? null;
      return { key: g.key, teams: g.key.split('-'), total, spread: spread === null ? null : Math.abs(spread) };
    })
    .filter((g) => g.total !== null)
    .sort((a, b) => b.total - a.total || a.key.localeCompare(b.key));
}

export function bestValuePlay(players) {
  return players
    .filter((p) => !isOut(p) && num(p.salary) >= VALUE_MIN_SALARY && num(p.salary) <= VALUE_MAX_SALARY && num(p.projected_points) > 0)
    .map((p) => ({ ...p, value: (num(p.projected_points) / num(p.salary)) * 1000 }))
    .sort((a, b) => b.value - a.value || num(b.projected_points) - num(a.projected_points))[0] ?? null;
}

// ── Default data sources (each wraps a chat tool or a single query) ──

function defaultSources() {
  const tools = Object.fromEntries(createResearchTools().map((t) => [t.name, t]));
  return {
    async latestSlateId() {
      const [latest] = await slateModel.getAll();
      return latest?.slate_id ?? null;
    },
    slatePlayers: (slateId) => playerModel.getBySlateId(slateId),
    async usageBumps(slateId) {
      const res = await tools.get_usage_bumps.execute({ slateId });
      return res.success ? res.usageBumps : [];
    },
    async archetypeEdges(slateId) {
      const res = await tools.get_archetype_matchups.execute({ slateId, limit: 5 });
      return res.success ? res.players : [];
    },
    async hotStreaks() {
      const res = await tools.get_streaks_and_consistency.execute({ type: 'hot', limit: 50 });
      return res.success ? res.players : [];
    },
    async latestResultsDate() {
      const row = await db.get('SELECT MAX(game_date) AS game_date FROM historical_games WHERE minutes > 0');
      return row?.game_date ?? null;
    },
  };
}

// ── Builders: data -> { id, kind, label, prompt, detail } or null ──

const BUILDERS = [
  async function usageBump({ src, slateId }) {
    const [bump] = await src.usageBumps(slateId);
    if (!bump) return null;
    return {
      kind: 'usage_bump',
      label: 'Usage bump',
      prompt: `How much does ${bump.player} gain with ${bump.missingPlayer} out tonight?`,
      detail: `${bump.player} with ${bump.missingPlayer} out: +${bump.dkBump} FP (+${Math.round(bump.pctBump)}%)`,
    };
  },
  async function archetypeEdge({ src, slateId }) {
    const top = (await src.archetypeEdges(slateId)).find((p) => num(p.adjustedEdge) !== null && p.adjustedEdge > 0);
    if (!top) return null;
    return {
      kind: 'archetype_edge',
      label: 'Matchup edge',
      prompt: `Break down ${top.name}'s matchup vs ${top.opponent} tonight. Is the ${top.archetypeLabel || 'archetype'} edge real?`,
      detail: `${top.name} (${top.archetypeLabel || top.archetype}) vs ${top.opponent}: +${round1(top.adjustedEdge)} FP adjusted edge`,
    };
  },
  async function gameStack({ players }) {
    const [game] = slateGames(players);
    if (!game) return null;
    const matchup = game.teams.join(' vs ');
    return {
      kind: 'game_stack',
      label: 'Game stack',
      prompt: `Build me a ${matchup} game stack. It has the highest total on the slate (${game.total}).`,
      detail: `${matchup}: total ${game.total}${game.spread !== null ? `, spread ${game.spread}` : ''}`,
    };
  },
  async function hotStreak({ src, players }) {
    const onSlate = new Set(players.map((p) => playerKey(p.name)));
    const hot = (await src.hotStreaks()).find((p) => onSlate.has(p.player_key));
    if (!hot) return null;
    return {
      kind: 'hot_streak',
      label: 'Hot streak',
      prompt: `${hot.player_name} is averaging ${hot.last3_avg} FP over the last 3 games. Can it continue tonight?`,
      detail: `${hot.player_name}: ${hot.last3_avg} FP last 3 vs ${hot.season_avg} season`,
    };
  },
  async function valuePlay({ players }) {
    const p = bestValuePlay(players);
    if (!p) return null;
    return {
      kind: 'value_play',
      label: 'Value play',
      prompt: `Is ${p.name} (${money(p.salary)}, ${round1(p.value)}x) a safe value play tonight?`,
      detail: `${p.name}: ${round1(num(p.projected_points))} proj at ${money(p.salary)} (${round1(p.value)}x)`,
    };
  },
  async function scoreLineup({ src }) {
    const date = await src.latestResultsDate();
    if (!date) return null;
    const day = String(date).slice(0, 10);
    return {
      kind: 'score_lineup',
      label: 'Score a lineup',
      prompt: `Score my lineup from last night (${day}).`,
      detail: `Results are in through ${day}`,
    };
  },
];

/**
 * Suggestions for the slate (default: latest). Never throws for a missing
 * source; returns { slateId, suggestions } with suggestions possibly empty.
 */
export async function buildChatSuggestions({ slateId } = {}, sources = defaultSources()) {
  const id = slateId ? String(slateId) : await sources.latestSlateId().catch(() => null);
  const players = id ? await sources.slatePlayers(id).catch(() => []) : [];
  const ctx = { src: sources, slateId: id, players };
  const slateBuilders = new Set(['usageBump', 'archetypeEdge', 'gameStack', 'hotStreak', 'valuePlay']);

  const results = await Promise.all(BUILDERS.map(async (build) => {
    if (slateBuilders.has(build.name) && players.length === 0) return null;
    try {
      return await build(ctx);
    } catch (error) {
      console.warn(`⚠️ chat suggestion ${build.name} skipped:`, error.message);
      return null;
    }
  }));

  return {
    slateId: id,
    suggestions: results.filter(Boolean).map((s) => ({ id: s.kind, ...s })),
  };
}
