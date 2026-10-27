/**
 * UI BLOCK BUILDERS
 *
 * tool name -> async (result, args) => block | block[] | null, mapping a
 * successful chat tool result (researchTools, OptimizerAgent build_lineup) to
 * uiBlocks.js blocks. Failed or empty results get no block; the markdown
 * answer covers them.
 */

import db from '../../config/database.js';
import { uiBlock, attachUiBlocks } from './uiBlocks.js';
import { playerKey } from '../../utils/playerKey.js';

const val = (x) => (x === undefined || x === null || Number.isNaN(Number(x)) ? null : Number(x));
const keyOf = (name) => (name ? playerKey(name) || null : null);

/** Slate rows by players.id and by player_key: headshot and projected ownership */
async function slateExtras(slateId) {
  const byId = new Map();
  const byKey = new Map();
  if (!slateId) return { byId, byKey };
  const rows = await db.all('SELECT id, name, headshot, rostership FROM players WHERE slate_id = ?', slateId);
  for (const r of rows) {
    const extra = { headshot: r.headshot || null, ownership: val(r.rostership) };
    byId.set(String(r.id), extra);
    byKey.set(keyOf(r.name), extra);
  }
  return { byId, byKey };
}

async function archetypeMatchups(r) {
  const { byKey } = await slateExtras(r.slateId);
  return uiBlock('player_list', {
    title: 'Best archetype matchups',
    note: r.note,
    context: { slate_id: r.slateId, site: r.site, season: r.season },
    players: r.players.map((p) => {
      const key = keyOf(p.name);
      const extra = byKey.get(key) || {};
      return {
        name: p.name,
        player_key: key,
        team: p.team,
        opponent: p.opponent,
        position: p.position,
        headshot: extra.headshot ?? null,
        salary: val(p.salary),
        projection: val(p.projectedPoints),
        projected_minutes: val(p.minutes?.projected),
        last_season_minutes: val(p.minutes?.last_season),
        archetype: p.archetype,
        archetype_label: p.archetypeLabel,
        matchup_edge: val(p.matchupEdge),
        adjusted_edge: val(p.adjustedEdge),
        defense_rank: val(p.rank),
        defense_teams: val(p.teams),
        ownership: extra.ownership ?? null,
        injury_status: p.injuryStatus ?? null,
        flags: p.flags || [],
      };
    }),
  });
}

function playerProfile(r) {
  const [latest] = r.profiles;
  const current = r.currentSeason?.profile;
  const role = current || latest;
  // Last completed season = newest profile that is not the current season
  const lastSeason = r.profiles.find(p => p.season !== r.currentSeason?.season);
  return uiBlock('player_list', {
    title: `${r.player.name} role profile`,
    context: { season: role?.season ?? r.currentSeason?.season },
    players: [{
      name: r.player.name,
      player_key: r.player.key,
      team: r.player.team ?? role?.team ?? null,
      position: role?.position ?? null,
      archetype: role?.archetype ?? null,
      last_season_minutes: val(lastSeason?.minutesPg),
      flags: [],
      stats: {
        games: val(r.currentSeason?.games),
        minutes_pg: val(r.currentSeason?.minutesPg),
        dk_avg: val(r.currentSeason?.dkAvg),
        usg_pct: val(role?.usgPct),
        ts_pct: val(role?.tsPct),
        pts_per36: val(role?.ptsPer36),
        reb_per36: val(role?.rebPer36),
        ast_per36: val(role?.astPer36),
        dk_fppm: val(role?.dkFppm),
      },
    }],
  });
}

const groupRow = (team) => (g) => ({
  team,
  group_key: g.group,
  label: g.label ?? null,
  fp_over_expectation: val(g.fpOverExpectation),
  pts_delta: val(g.ptsDelta),
  reb_delta: val(g.rebDelta),
  ast_delta: val(g.astDelta),
  fg3m_delta: val(g.fg3mDelta),
  stocks_delta: val(g.stocksDelta),
  rank: val(g.rank),
  teams: val(g.teams),
  games: val(g.games),
  player_games: val(g.playerGames),
  low_sample: Boolean(g.lowSample),
});

function teamDefense(r) {
  const context = { season: r.season, site: r.site, team: r.team };
  const groupings = ['archetype', 'position'].filter(g => r[g]?.rows?.length);
  const toRow = groupRow(r.team);
  return [
    uiBlock('team_defense', {
      title: `${r.team} defense`,
      note: r.note,
      context,
      team: r.team,
      groups: groupings.map(g => ({
        group_by: g,
        weakest: r[g].weakestVs.map(toRow),
        strongest: r[g].strongestVs.map(toRow),
      })),
    }),
    ...groupings.map(g => uiBlock('matchup_table', {
      title: `${r.team} vs every ${g}`,
      context,
      group_by: g,
      rows: r[g].rows.map(toRow),
    })),
  ];
}

async function usageBumps(r) {
  if (!r.usageBumps.length) return null;
  const { byKey } = await slateExtras(r.slateId);
  return uiBlock('usage_bumps', {
    title: 'Usage bumps',
    context: { slate_id: r.slateId, site: r.site, team: r.team },
    bumps: r.usageBumps.map((b) => {
      const key = keyOf(b.player);
      const extra = byKey.get(key) || {};
      return {
        player: {
          name: b.player,
          player_key: key,
          team: b.team,
          opponent: b.opponent ?? null,
          position: b.position ?? null,
          headshot: extra.headshot ?? null,
          salary: val(b.salary),
          projection: val(b.projection),
          projected_minutes: val(b.projectedMinutes),
          ownership: extra.ownership ?? null,
        },
        missing_player: b.missingPlayer,
        absence_reason: b.absenceReason ?? null,
        games_with: val(b.gamesWith),
        games_without: val(b.gamesWithout),
        avg_with: val(b.avgWith),
        avg_without: val(b.avgWithout),
        minutes_with: val(b.avgMinWith),
        minutes_without: val(b.avgMinWithout),
        pct_bump: val(b.pctBump),
        bumped_projection: val(b.bumpedProjection),
        value: val(b.valueScore),
        confidence: b.confidence ?? null,
      };
    }),
  });
}

function missingPlayers(r) {
  const players = r.report.flatMap(t => t.missingPlayers.map(p => ({
    name: p.name,
    player_key: keyOf(p.name),
    team: t.team,
    flags: ['missing'],
    stats: { avg_dk: val(p.avgDk), avg_minutes: val(p.avgMin), games: val(p.games) },
  })));
  if (!players.length) return null;
  return uiBlock('player_list', {
    title: 'Regulars missing from the slate',
    context: { slate_id: r.slateId, site: r.site, team: r.team },
    players,
  });
}

function streaks(r) {
  if (!r.players.length) return null;
  const prefix = r.type === 'hot' ? 'hot_streak' : 'cold_streak';
  return uiBlock('streaks', {
    title: { hot: 'Hot streaks', cold: 'Cold streaks', consistency: 'Most consistent', boom_bust: 'Boom / bust' }[r.type],
    context: { site: r.site },
    kind: r.type,
    players: r.players.map(p => ({
      name: p.player_name,
      player_key: p.player_key ?? keyOf(p.player_name),
      team: p.team ?? null,
      games: val(p.total_games ?? p.games),
      season_avg: val(p.season_avg ?? p.avg_dk),
      last3_avg: val(p.last3_avg),
      diff: val(p[`${prefix}_diff`]),
      pct: val(p[`${prefix}_pct`]),
      floor: val(p.floor),
      ceiling: val(p.ceiling),
      std_dev: val(p.std_dev),
      consistency_score: val(p.consistency_score),
      boom_rate: val(p.boom_rate),
      bust_rate: val(p.bust_rate),
      last_game: p.last_game ?? null,
    })),
  });
}

function lineupScore(r) {
  return uiBlock('lineup_score', {
    title: `Lineup results ${r.date}`,
    note: r.note,
    context: { date: r.date, site: r.site },
    players: r.players.map(p => ({
      name: p.name,
      player_key: p.key,
      team: p.team ?? null,
      opponent: p.opponent ?? null,
      status: p.status,
      status_reason: p.statusReason ?? null,
      minutes: val(p.minutes),
      salary: val(p.salary),
      projected: val(p.projected),
      actual: val(p.points),
      vs_projection: val(p.vsProjection),
      value_per_1k: val(p.valuePer1k),
    })),
    totals: {
      actual: val(r.totalPoints),
      projected: val(r.totalProjected),
      salary: val(r.totalSalary),
      value_per_1k: val(r.valuePer1k),
    },
    incomplete: Boolean(r.incomplete),
    not_found: (r.notFound || []).map(n => n.query),
  });
}

const missRow = (m) => ({
  name: m.name,
  player_key: keyOf(m.name),
  team: m.team ?? null,
  date: m.date ?? null,
  salary: val(m.salary),
  projected: val(m.projected),
  actual: val(m.actual),
  error: val(m.error),
  minutes: val(m.minutes),
  projected_minutes: val(m.projectedMinutes),
});

function projectionResults(r) {
  const o = r.overall;
  return uiBlock('projection_results', {
    title: 'Projection results',
    context: { site: r.site, from: r.from, to: r.to },
    overall: {
      players: val(o.players),
      played: val(o.played),
      mae: val(o.projection?.mae),
      rmse: val(o.projection?.rmse),
      bias: val(o.projection?.bias),
      minutes_mae: val(o.minutes?.mae),
      hit_rates: Object.fromEntries(Object.entries(o.hitRates || {}).map(([k, v]) => [k, val(v)])),
    },
    misses: [...r.biggestMisses.over, ...r.biggestMisses.under].map(missRow),
  });
}

async function buildLineup(r) {
  const { byId } = await slateExtras(r.slateId);
  return r.lineups.map((lineup, i) => {
    const filled = lineup.players.map(s => s.player).filter(Boolean);
    const owned = filled.map(p => val(p.ownership)).filter(x => x !== null);
    return uiBlock('lineup', {
      title: r.lineups.length > 1 ? `Lineup ${i + 1}` : 'Optimal lineup',
      context: { slate_id: r.slateId },
      mode: r.mode,
      slots: lineup.players.map(s => ({
        slot: s.position,
        player: s.player ? {
          name: s.player.name,
          player_key: keyOf(s.player.name),
          team: s.player.team ?? null,
          headshot: byId.get(String(s.player.id))?.headshot ?? null,
          salary: val(s.player.salary),
          projection: val(s.player.projectedPoints),
          ownership: val(s.player.ownership),
          floor: val(s.player.floor),
          ceiling: val(s.player.ceiling),
        } : null,
      })),
      totals: {
        salary: val(lineup.totalSalary),
        projection: val(lineup.projectedPoints),
        remaining_salary: val(lineup.remainingSalary),
        ownership: owned.length ? Math.round(owned.reduce((a, b) => a + b, 0) * 10) / 10 : null,
      },
    });
  });
}

/** player_list row for an opportunity player: score for the mode, reason, key metrics as stats. */
function opportunityCard(p, { score, reason, metrics, actualPoints }, extra = {}) {
  return {
    name: p.name,
    player_key: keyOf(p.name),
    team: p.team ?? null,
    opponent: p.opponent ?? null,
    position: p.position ?? null,
    headshot: extra.headshot ?? null,
    salary: val(p.salary),
    projection: val(p.projectedPoints),
    projected_minutes: val(metrics.minutes?.projected),
    ownership: val(p.ownership),
    injury_status: p.injuryStatus ?? null,
    flags: [],
    opportunity_score: val(score),
    reason: reason || null,
    stats: {
      min_delta_l3: val(metrics.minutes?.deltaL3),
      usg_delta: val(metrics.usage?.delta),
      rate_projection: val(metrics.rateProjection?.projection),
      rate_gap: val(metrics.rateProjection?.gap),
      hit5x_l10: val(metrics.hit5xL10 ?? metrics.valueHitRates?.hit5x),
      absorbed_pct: val(metrics.teammateOut?.absorbedPct),
      implied_total: val(metrics.impliedTotal ?? metrics.environment?.impliedTotal),
      ...(actualPoints === undefined ? {} : { actual_points: val(actualPoints) }),
    },
  };
}

const modeLabel = (mode) => (mode === 'gpp' ? 'GPP' : 'Cash');

async function opportunityRadar(r) {
  const { byKey } = await slateExtras(r.slateId);
  return uiBlock('player_list', {
    title: `Opportunity Radar (${modeLabel(r.mode)})`,
    note: r.backtest ? r.label : undefined,
    context: { slate_id: r.slateId, site: r.site, season: r.season, date: r.slateDate ?? null },
    players: r.players.map(p => opportunityCard(p, p, byKey.get(keyOf(p.name)))),
  });
}

async function playerOpportunity(r) {
  const { byKey } = await slateExtras(r.slateId);
  const p = r.player;
  return uiBlock('player_list', {
    title: `${p.name} opportunity`,
    note: r.backtest ? r.label : undefined,
    context: { slate_id: r.slateId, site: r.site, season: r.season, date: r.slateDate ?? null },
    players: [opportunityCard(p, {
      score: r.scores.cash.score, reason: r.reason, metrics: r.metrics, actualPoints: r.actual?.points,
    }, byKey.get(keyOf(p.name)))].map(card => ({
      ...card,
      stats: { ...card.stats, cash_score: val(r.scores.cash.score), gpp_score: val(r.scores.gpp.score) },
    })),
  });
}

export const UI_BLOCK_BUILDERS = {
  get_opportunity_radar: opportunityRadar,
  get_player_opportunity: playerOpportunity,
  get_archetype_matchups: archetypeMatchups,
  get_player_profile: playerProfile,
  get_team_defense_profile: teamDefense,
  get_usage_bumps: usageBumps,
  get_missing_players: missingPlayers,
  get_streaks_and_consistency: streaks,
  score_lineup: lineupScore,
  get_projection_results: projectionResults,
  build_lineup: buildLineup,
};

/** Blocks for a tool result ([] when the tool failed or has no builder) */
export async function buildUiBlocks(toolName, result, args = {}) {
  const builder = UI_BLOCK_BUILDERS[toolName];
  if (!builder || !result?.success) return [];
  const blocks = await builder(result, args);
  return [blocks].flat().filter(Boolean);
}

/**
 * Attach the tool's blocks to `result` and return it. A builder error only
 * costs the cards, never the tool result.
 */
export async function withUiBlocks(toolName, result, args = {}) {
  try {
    return attachUiBlocks(result, await buildUiBlocks(toolName, result, args));
  } catch (error) {
    console.warn(`⚠️ ${toolName} ui block failed:`, error.message);
    return result;
  }
}
