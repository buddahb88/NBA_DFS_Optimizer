/**
 * PLAYER CARD SERVICE
 *
 * GET /api/players/:slateId/card/:playerId[?slateDate=&projectionSource=]:
 * everything the player card shows, assembled from the existing services in
 * one request:
 *   identity     slate row (+ archetype from getSlateMatchups, secondary
 *                from player_archetypes), game time, home / away
 *   projection   the active source's numbers (slateSource), RotoWire / ours /
 *                blend and the own model's distribution (projectSlateOwnModel),
 *                the fade call (sourceLayer.fadeCall)
 *   form         last games from historical_games with that night's salary
 *                (slate_player_snapshots), L5 / L10 / season averages,
 *                consistency (std dev, 5x hit rate), minutes / FPPM trend
 *   role         season-to-date profile (computeProfiles on games before the
 *                slate date) vs last season's stored profile vs the archetype
 *   matchup      opponent defense vs his archetype (getSlateMatchups + per-stat
 *                deltas from getDefense), team ratings as of the date
 *                (computeTeamRatings), Vegas
 *   context      teammates out and his with / without split, Opportunity
 *                Radar cash / GPP score (getOpportunityRadar)
 *   trackRecord  his past projections vs actual
 *   verdict      verdict.buildVerdict (deterministic rules)
 *   actual       backtest only: what happened
 *
 * No leakage: every history read is strictly before the slate date (today for
 * a live slate); a backtest reads the saved slate and the as-of services.
 * Each section fails soft: a missing piece is null and named in meta.warnings.
 * Slate-wide context (matchups, defense grid, team ratings, archetype
 * averages) is cached per slate; finished cards briefly per player.
 */

import db from '../../config/database.js';
import { ALL_ARCHETYPES } from '../../config/archetypes.js';
import { parseSource, projectionSource as activeProjectionSource } from '../../config/projectionSource.js';
import { fantasyPointsColumn } from '../scoring.js';
import { resolveSlate, loadSlatePlayers, withActuals, SlateSourceError } from '../slateSource.js';
import { easternDate, isHomeFlag, playerGameStart } from '../slateSnapshotService.js';
import { fadeCall } from '../projections/sourceLayer.js';
import { projectSlateOwnModel } from '../modelEval/ownModelService.js';
import { getOpportunityRadar } from '../opportunity/radarService.js';
import { getSlateMatchups, getDefense } from '../archetypeDefenseService.js';
import { computeTeamRatings, loadTeamGames as loadRatingGames } from '../teamRatingsService.js';
import { computeProfiles, getPlayerProfiles, GAME_ROWS_SELECT } from '../playerProfileService.js';
import { isOutStatus } from '../minutesModel.js';
import { canonicalTeam, playerKey } from '../../utils/playerKey.js';
import { seasonForDate, previousSeason } from '../../utils/season.js';
import { gameEntry, summarizeForm, trackRecord, snapshotsByDate, rankTeams } from './cardMath.js';
import { buildVerdict } from './verdict.js';

const CONTEXT_TTL_MS = 10 * 60 * 1000;
const CARD_TTL_MS = 60 * 1000;
const CACHE_LIMIT = 300;
const ROLE_FIELDS = ['usg_pct', 'ast_pct', 'reb_pct', 'three_pa_rate', 'ts_pct', 'stl_pct', 'blk_pct', 'dk_fppm', 'minutes_pg', 'pts_per36', 'reb_per36', 'ast_per36'];
const ARCHETYPE_MIN_MINUTES = 15;

const LABELS = Object.fromEntries(ALL_ARCHETYPES.map(a => [a.key, a.label]));
const SOURCE_LABELS = { rotowire: 'RotoWire', ours: 'Ours', blend: 'Blend' };

const contexts = new Map();
const cards = new Map();

const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const r1 = (x) => (x === null || !Number.isFinite(x) ? null : Math.round(x * 10) / 10 + 0);
const r2 = (x) => (x === null || !Number.isFinite(x) ? null : Math.round(x * 100) / 100 + 0);
const r3 = (x) => (x === null || !Number.isFinite(x) ? null : Math.round(x * 1000) / 1000 + 0);
const dayBefore = (date) => new Date(Date.parse(`${date}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);

function remember(map, key, value) {
  map.delete(key);
  map.set(key, { at: Date.now(), value });
  while (map.size > CACHE_LIMIT) map.delete(map.keys().next().value);
  return value;
}
function recall(map, key, ttl) {
  const hit = map.get(key);
  return hit && Date.now() - hit.at < ttl ? hit.value : null;
}

/** Drop cached slate contexts and cards (tests, new data). */
export function clearPlayerCardCache() {
  contexts.clear();
  cards.clear();
}

/** Run a section; a failure becomes a warning and `fallback`. */
async function soft(warnings, name, fn, fallback = null) {
  try {
    return await fn();
  } catch (error) {
    warnings.push(`${name}: ${error.message}`);
    return fallback;
  }
}

/** Slate-wide pieces shared by every card on the slate (cached). */
async function slateContext(source, asOf, warnings) {
  const key = `${source.slateId}|${source.slateDate ?? ''}|${source.site}|${asOf}`;
  const cached = recall(contexts, key, CONTEXT_TTL_MS);
  if (cached) return cached;

  const season = seasonForDate(asOf);
  const local = [];
  const [matchups, ratings, archetypeAvg] = await Promise.all([
    soft(local, 'matchups', () => getSlateMatchups(source.slateId, {
      slateDate: source.isBacktest ? source.slateDate : undefined, site: source.site,
    }), new Map()),
    soft(local, 'team ratings', async () => rankTeams(
      computeTeamRatings(await loadRatingGames(season), { season, asOf }).teams, canonicalTeam)),
    // Last season is complete before any date of this one: as-of safe
    soft(local, 'archetype averages', () => loadArchetypeAverages(previousSeason(season)), new Map()),
  ]);
  warnings.push(...local);
  const ctx = { season, matchups, ratings, archetypeAvg, defense: new Map() };
  // Only cache a context whose pieces all loaded
  return local.length ? ctx : remember(contexts, key, ctx);
}

async function loadArchetypeAverages(season) {
  const rows = await db.all(`
    SELECT a.archetype, COUNT(*) AS players, ${ROLE_FIELDS.map(f => `AVG(sp.${f}) AS ${f}`).join(', ')}
    FROM player_season_profiles sp
    JOIN player_archetypes a ON a.season = sp.season AND a.player_key = sp.player_key
    WHERE sp.season = ? AND sp.minutes_pg >= ?
    GROUP BY a.archetype`, season, ARCHETYPE_MIN_MINUTES);
  return new Map(rows.map(r => [r.archetype, { season, ...roleRow(r), players: Number(r.players) }]));
}

const roleRow = (r) => (r ? Object.fromEntries(ROLE_FIELDS.map(f => [f, r3(num(r[f]))])) : null);

/** The defense grid rows (all teams x groups) for a matchup's season / grouping, cached on the context. */
async function defenseRows(ctx, source, matchup) {
  const key = `${matchup.season}|${matchup.grouping}`;
  if (!ctx.defense.has(key)) {
    ctx.defense.set(key, getDefense({
      season: matchup.season, site: matchup.site ?? source.site, grouping: matchup.grouping,
      ...(source.isBacktest ? { endDate: dayBefore(source.slateDate) } : {}),
    }).then(r => r.rows));
  }
  return ctx.defense.get(key);
}

const findPlayer = (players, id) => {
  const s = String(id);
  return players.find(p => String(p.id) === s) ?? players.find(p => String(p.player_id) === s)
    ?? players.find(p => (p.player_key ?? playerKey(p.name)) === s) ?? null;
};

/** Played and unplayed games of the current + last season before asOf, newest first. */
async function loadGames(key, { asOf, season, site }) {
  const fpColumn = fantasyPointsColumn(site);
  const rows = await db.all(`
    SELECT game_date, season, season_type, team, opponent, minutes, points, rebounds, assists, steals, blocks,
           turnovers, fg3_made, ${fpColumn}, is_starter, is_back_to_back, is_home
    FROM historical_games
    WHERE player_key = ? AND game_date < ? AND season IN (?, ?)
    ORDER BY game_date DESC`, key, asOf, season, previousSeason(season));
  return { rows, fpColumn };
}

async function loadSnapshots(key, { asOf, site }) {
  return db.all(`
    SELECT game_date, slate_id, salary, projected_points, captured_at
    FROM slate_player_snapshots
    WHERE player_key = ? AND site = ? AND game_date < ?`, key, site, asOf);
}

/** Season-to-date role profile from games before asOf (computeProfiles), or null. */
async function seasonToDateProfile(key, { season, asOf }) {
  const rows = await db.all(`${GAME_ROWS_SELECT}
    WHERE h.player_key = ? AND h.season = ? AND h.game_date < ?
      AND COALESCE(h.season_type, 'regular') = 'regular' AND h.minutes > 0
    ORDER BY h.game_date, h.id`, key, season, asOf);
  if (!rows.length) return null;
  const [profile] = computeProfiles(season, rows);
  return profile ? { season, games: profile.games, starts: profile.starts, ...roleRow(profile) } : null;
}

async function secondaryArchetype(key, season) {
  const row = await db.get('SELECT archetype, secondary_archetype FROM player_archetypes WHERE season = ? AND player_key = ?', season, key);
  return row ?? null;
}

const starterChange = (c) => (c === 'into' ? 'to_starter' : c === 'out' ? 'to_bench' : null);

/**
 * The card for one slate player. playerId matches the slate row id, the
 * site's player_id or the player_key. Throws SlateSourceError (404 when the
 * slate or player is not found).
 */
export async function getPlayerCard({ slateId, playerId, slateDate = null, projectionSource = null, now = new Date() } = {}) {
  const source = await resolveSlate({ slateId, slateDate: slateDate || null, now });
  if (!source) throw new SlateSourceError('No slate synced', 404);
  const chosen = parseSource(projectionSource) ?? activeProjectionSource();
  const cardKey = `${source.slateId}|${source.slateDate ?? ''}|${source.site}|${playerId}|${chosen}`;
  const cachedCard = recall(cards, cardKey, CARD_TTL_MS);
  if (cachedCard) return { ...cachedCard, meta: { ...cachedCard.meta, cached: true } };

  const warnings = [];
  let players = await loadSlatePlayers(source, { includeZero: true, projectionSource: chosen, now });
  const found = findPlayer(players, playerId);
  if (!found) throw new SlateSourceError(`Player ${playerId} is not on slate ${source.slateId}`, 404);
  let p = found;
  if (source.isBacktest) [p] = await withActuals(source, [found]);

  const key = p.player_key ?? playerKey(p.name);
  const asOf = source.slateDate ?? easternDate(now);
  const ctx = await slateContext(source, asOf, warnings);
  const { season } = ctx;
  const lastSeason = previousSeason(season);
  const team = canonicalTeam(p.team);
  const opponent = canonicalTeam(p.opponent);

  const [own, radar, games, snapshots, current, previousRows, archetypeRow] = await Promise.all([
    soft(warnings, 'own model', async () => {
      const result = await projectSlateOwnModel(source.slateId, { source, now });
      return result.players.find(o => String(o.id) === String(p.id)) ?? null;
    }),
    soft(warnings, 'opportunity radar', async () => {
      const r = await getOpportunityRadar({ slateId: source.slateId, slateDate: source.isBacktest ? source.slateDate : null, site: source.site, now });
      return r.players.find(row => String(row.id) === String(p.id)) ?? null;
    }),
    soft(warnings, 'game log', () => loadGames(key, { asOf, season, site: source.site }), { rows: [], fpColumn: fantasyPointsColumn(source.site) }),
    soft(warnings, 'salary history', () => loadSnapshots(key, { asOf, site: source.site }), []),
    soft(warnings, 'season profile', () => seasonToDateProfile(key, { season, asOf })),
    soft(warnings, 'last season profile', () => getPlayerProfiles(key, { seasons: [lastSeason] }), []),
    // A backtest reads last season's (complete) row so the night's season can't leak in
    soft(warnings, 'archetype', () => secondaryArchetype(key, source.isBacktest ? lastSeason : season)),
  ]);

  // --- Form -------------------------------------------------------------------------
  const byDate = snapshotsByDate(snapshots);
  const entries = games.rows.map(g => ({
    ...gameEntry(g, { fpColumn: games.fpColumn, salary: byDate.get(String(g.game_date).slice(0, 10))?.salary ?? null }),
    seasonKey: g.season,
  }));
  const form = summarizeForm(entries, { season, lastSeason });
  const gamesByDate = new Map(entries.map(e => [e.date, e]));
  const track = trackRecord([...byDate.values()], gamesByDate);

  // --- Identity ---------------------------------------------------------------------
  const info = ctx.matchups.get(String(p.player_id)) ?? {};
  const archetype = info.archetype ?? p.archetype ?? (archetypeRow?.archetype !== 'unclassified' ? archetypeRow?.archetype : null) ?? null;
  const secondary = archetypeRow?.secondary_archetype && archetypeRow.secondary_archetype !== archetype ? archetypeRow.secondary_archetype : null;
  const isHome = isHomeFlag(p);

  // --- Projection ---------------------------------------------------------------------
  const salary = num(p.salary);
  const salaryK = salary > 0 ? salary / 1000 : null;
  const activeSource = p.projection_source ?? (chosen === 'rotowire' ? 'rotowire' : chosen);
  const rotowire = num(p.projection_rotowire) ?? (activeSource === 'rotowire' ? num(p.projected_points) : num(own?.rotowire_points));
  const active = num(p.projected_points);
  const fade = p.projection_fade ?? (own ? fadeCall(own) : null);
  const projection = {
    source: activeSource,
    requested: chosen,
    fallback: Boolean(p.projection_fallback),
    active,
    rotowire,
    ours: num(own?.ours_mean) ?? num(p.projection_ours),
    blend: num(own?.blend_point) ?? num(p.projection_blend),
    ours_median: num(own?.ours_median),
    p10: num(own?.p10),
    p90: num(own?.p90),
    blend_p10: num(own?.blend_p10),
    blend_p90: num(own?.blend_p90),
    p_boom: num(own?.p_boom),
    blend_p_boom: num(own?.blend_p_boom),
    boom_at: num(own?.boom_at) ?? (salaryK ? r1(salaryK * 6) : null),
    p_dd: num(own?.p_dd),
    ours_minutes: num(own?.ours_minutes) ?? num(p.ours_minutes),
    rotowire_minutes: num(p.projected_minutes),
    p_play: num(own?.p_play) ?? num(p.p_play),
    fade,
    ours_diff: num(own?.disagreement?.points_diff),
    floor: num(p.floor),
    ceiling: num(p.ceiling),
    boom_probability: num(p.boom_probability),
    rostership: num(p.rostership),
    leverage: num(p.leverage_score),
    value: active !== null && salaryK ? r2(active / salaryK) : null,
    projection_reasons: p.projection_reasons ?? null,
  };

  // --- Matchup ------------------------------------------------------------------------
  let matchup = null;
  if (info.matchup) {
    const m = info.matchup;
    const row = await soft(warnings, 'defense grid', async () => (await defenseRows(ctx, source, m))
      .find(r => r.team === m.opponent && r.group_key === m.group_key) ?? null);
    matchup = {
      opponent: m.opponent,
      grouping: m.grouping,
      group_key: m.group_key,
      label: m.label,
      season: m.season,
      fp_delta: r2(num(m.delta)),
      rank: m.rank,
      teams: m.teams,
      grade: m.grade,
      games: m.games,
      adjusted_edge: r2(num(m.adjusted_edge)),
      edge_flags: m.edge_flags ?? [],
      stats: row ? {
        pts: r2(num(row.pts_delta)), reb: r2(num(row.reb_delta)), ast: r2(num(row.ast_delta)),
        fg3m: r2(num(row.fg3m_delta)), stocks: r2(num(row.stocks_delta)),
      } : null,
    };
  }
  const teamRating = ctx.ratings?.get(team) ?? null;
  const oppRating = ctx.ratings?.get(opponent) ?? null;
  const spread = num(p.vegas_spread);
  const environment = {
    implied_total: num(p.vegas_implied_total),
    opp_implied_total: num(p.vegas_over_under) !== null && num(p.vegas_implied_total) !== null
      ? r1(num(p.vegas_over_under) - num(p.vegas_implied_total)) : null,
    spread,
    over_under: num(p.vegas_over_under),
    blowout: spread === null ? null : Math.abs(spread) >= 10,
    blowout_risk: num(p.blowout_risk),
    team: teamRating,
    opponent: oppRating,
  };

  // --- Context ------------------------------------------------------------------------
  const teammatesOut = players
    .filter(o => o !== found && canonicalTeam(o.team) === team && isOutStatus(o.injury_status))
    .map(o => ({ name: o.name, status: o.injury_status, salary: num(o.salary) }))
    .sort((a, b) => (b.salary ?? 0) - (a.salary ?? 0));
  const split = radar && (radar.teammate_out_names?.length || radar.teammate_min_delta !== null) ? {
    out_names: radar.teammate_out_names ?? [],
    sample: radar.teammate_sample ?? null,
    games_without: radar.teammate_games_without ?? null,
    min_delta: num(radar.teammate_min_delta),
    usg_delta: num(radar.teammate_usg_delta),
    absorbed_pct: num(radar.teammate_absorbed_pct),
  } : null;
  const context = {
    teammates_out: teammatesOut,
    split,
    radar: radar ? {
      cash_score: radar.cash_score ?? null,
      gpp_score: radar.gpp_score ?? null,
      reason: radar.reason ?? null,
      rate_projection: num(radar.rate_projection),
      salary_lag: radar.salary_lag ?? null,
      back_to_back: radar.back_to_back ?? null,
      rest_days: radar.rest_days ?? null,
    } : null,
  };

  // --- Role -----------------------------------------------------------------------------
  const prev = previousRows?.[0] ?? null;
  const role = {
    season,
    lastSeason,
    current,
    previous: prev ? { season: lastSeason, games: prev.games, starts: prev.starts, ...roleRow(prev) } : null,
    archetype_average: archetype ? ctx.archetypeAvg?.get(archetype) ?? null : null,
    started_last_game: radar?.started_last_game ?? form.log.at(-1)?.is_starter ?? null,
    starts_l5: radar?.starts_l5 ?? null,
    starter_change: starterChange(radar?.starter_change),
  };

  // --- Actual (backtest) ------------------------------------------------------------------
  const actual = source.isBacktest ? {
    points: num(p.actualPoints),
    minutes: num(p.actualMinutes),
    status: p.resultStatus ?? null,
    value: num(p.actualPoints) !== null && salaryK ? r2(num(p.actualPoints) / salaryK) : null,
    vs_projection: num(p.actualPoints) !== null && active !== null ? r1(num(p.actualPoints) - active) : null,
    vs_rotowire: num(p.actualPoints) !== null && rotowire !== null ? r1(num(p.actualPoints) - rotowire) : null,
    vs_ours: num(p.actualPoints) !== null && projection.ours !== null ? r1(num(p.actualPoints) - projection.ours) : null,
    hit5x: num(p.actualPoints) !== null && salaryK ? num(p.actualPoints) >= salaryK * 5 : null,
  } : null;

  // --- Verdict --------------------------------------------------------------------------------
  const minutesBase = form.trend.baseline === 'season' ? form.season : form.lastSeason;
  const verdict = buildVerdict({
    name: p.name,
    salary,
    injuryStatus: p.injury_status,
    pPlay: projection.p_play,
    projection: active,
    sourceLabel: SOURCE_LABELS[activeSource] ?? 'Projection',
    rotowire,
    ours: projection.ours,
    oursDiff: projection.ours_diff,
    p90: activeSource === 'blend' ? projection.blend_p90 ?? projection.p90 : projection.p90 ?? projection.ceiling,
    rostership: projection.rostership,
    fade,
    minutesL5: form.l5?.minutes ?? null,
    minutesSeason: minutesBase?.minutes ?? null,
    minutesDelta: form.trend.minutes_delta_l5,
    starterChange: role.starter_change,
    teammatesOut: split?.out_names ?? [],
    teammateMinDelta: split?.min_delta ?? null,
    teammateGames: split?.games_without ?? null,
    hit5xRate: form.consistency.hit_rate,
    hit5xGames: form.consistency.priced_games,
    games: entries.filter(e => e.minutes > 0).length,
    matchupDelta: matchup?.fp_delta ?? null,
    matchupRank: matchup?.rank ?? null,
    matchupTeams: matchup?.teams ?? null,
    matchupLabel: matchup?.label ?? null,
    opponent,
    impliedTotal: environment.implied_total,
    spread,
    radarCash: context.radar?.cash_score ?? null,
    radarGpp: context.radar?.gpp_score ?? null,
    trackBias: track.bias,
    trackN: track.n,
  });

  const card = {
    slate: {
      slateId: source.slateId, slateDate: source.slateDate, site: source.site,
      isBacktest: Boolean(source.isBacktest), label: source.label, asOf, settingsKey: source.settingsKey,
    },
    player: {
      id: p.id,
      player_id: p.player_id,
      player_key: key,
      name: p.name,
      team,
      opponent,
      position: p.position,
      roster_positions: p.roster_positions ?? null,
      salary,
      headshot: p.headshot ?? null,
      injury_status: p.injury_status ?? null,
      archetype,
      archetype_label: archetype ? LABELS[archetype] ?? archetype : null,
      secondary_archetype: secondary,
      secondary_label: secondary ? LABELS[secondary] ?? secondary : null,
      game_time: p.game_start_time ?? playerGameStart(p),
      is_home: isHome === null ? null : isHome === 1,
    },
    projection,
    form,
    role,
    matchup,
    environment,
    context,
    trackRecord: track,
    actual,
    verdict: { ...verdict, rules: verdict.rules.map(({ blurb, ...r }) => r) },
    meta: { generatedAt: new Date().toISOString(), cached: false, warnings },
  };
  return warnings.length ? card : remember(cards, cardKey, card);
}

export default { getPlayerCard, clearPlayerCardCache };
