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
import { buildSlateContext } from './slateContext.js';

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
/**
 * The card's "Minutes upside" block from the own-model row (else the slate
 * row's source-layer fields): { score, reasons, ours, ours_raw, p10, p90,
 * rotowire, gap, correction } or null when neither carries a score.
 */
export function minutesUpsideBlock(own, p = {}) {
  const score = num(own?.minutes_upside) ?? num(p.minutes_upside);
  if (score === null) return null;
  return {
    score,
    reasons: own?.minutes_upside_reasons ?? p.minutes_upside_reasons ?? [],
    ours: num(own?.ours_minutes) ?? num(p.ours_minutes),
    ours_raw: num(own?.ours_minutes_raw),
    p10: num(own?.minutes_p10) ?? num(p.ours_minutes_p10),
    p90: num(own?.minutes_p90) ?? num(p.ours_minutes_p90),
    rotowire: num(own?.rotowire_minutes_posted) ?? num(p.projected_minutes),
    gap: num(own?.rw_minutes_gap) ?? num(p.rw_minutes_gap),
    correction: own?.minutes_correction ?? p.minutes_correction ?? null,
  };
}

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

const HISTORY_CHUNK = 400;

/**
 * Game logs (current + last season) and salary snapshots before asOf for
 * many players in one pass: { fpColumn, games: Map(key -> rows newest first),
 * snapshots: Map(key -> rows) }. The card reads one key, the slate verdicts all.
 */
export async function loadHistory(keys, { asOf, season, site }) {
  const fpColumn = fantasyPointsColumn(site);
  const unique = [...new Set(keys.filter(Boolean))];
  const games = new Map(unique.map(k => [k, []]));
  const snapshots = new Map(unique.map(k => [k, []]));
  for (let i = 0; i < unique.length; i += HISTORY_CHUNK) {
    const chunk = unique.slice(i, i + HISTORY_CHUNK);
    const marks = chunk.map(() => '?').join(', ');
    const [gameRows, snapRows] = await Promise.all([
      db.all(`
        SELECT player_key, game_date, season, season_type, team, opponent, minutes, points, rebounds, assists, steals, blocks,
               turnovers, fg3_made, ${fpColumn}, is_starter, is_back_to_back, is_home
        FROM historical_games
        WHERE player_key IN (${marks}) AND game_date < ? AND season IN (?, ?)
        ORDER BY game_date DESC`, ...chunk, asOf, season, previousSeason(season)),
      db.all(`
        SELECT player_key, game_date, slate_id, salary, projected_points, captured_at
        FROM slate_player_snapshots
        WHERE player_key IN (${marks}) AND site = ? AND game_date < ?`, ...chunk, site, asOf),
    ]);
    for (const r of gameRows) games.get(r.player_key)?.push(r);
    for (const r of snapRows) snapshots.get(r.player_key)?.push(r);
  }
  return { fpColumn, games, snapshots };
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

const byId = (rows) => new Map((rows ?? []).map(r => [String(r.id), r]));

/**
 * Everything slate-wide the card and the slate verdicts share, loaded once:
 * { source, chosen, asOf, season, lastSeason, players, ctx, own: Map(id -> own
 * model row), radar: Map(id -> radar row), slate (slateContext.js: game
 * count, size bucket, ownership distribution), warnings }. own / radar are empty
 * maps when their service fails (named in warnings).
 */
export async function prepareSlate({ slateId, slateDate = null, projectionSource = null, now = new Date() } = {}) {
  const source = await resolveSlate({ slateId, slateDate: slateDate || null, now });
  if (!source) throw new SlateSourceError('No slate synced', 404);
  return prepareSource(source, { projectionSource, now });
}

/** prepareSlate for an already resolved source. */
export async function prepareSource(source, { projectionSource = null, now = new Date() } = {}) {
  const chosen = parseSource(projectionSource) ?? activeProjectionSource();
  const warnings = [];
  const asOf = source.slateDate ?? easternDate(now);
  const players = await loadSlatePlayers(source, { includeZero: true, projectionSource: chosen, now });
  const [ctx, own, radar] = await Promise.all([
    slateContext(source, asOf, warnings),
    soft(warnings, 'own model', async () => byId((await projectSlateOwnModel(source.slateId, { source, now })).players), new Map()),
    soft(warnings, 'opportunity radar', async () => byId((await getOpportunityRadar({
      slateId: source.slateId, slateDate: source.isBacktest ? source.slateDate : null, site: source.site, now,
    })).players), new Map()),
  ]);
  // Slate size / ownership distribution for the verdicts, once per slate
  const slate = buildSlateContext(players);
  return { source, chosen, asOf, season: ctx.season, lastSeason: previousSeason(ctx.season), players, ctx, own, radar, slate, warnings };
}

export const findSlatePlayer = (players, id) => findPlayer(players, id);

/** History key of a slate row (live rows carry no player_key: derive it from the name). */
export const slatePlayerKey = (p) => p.player_key ?? playerKey(p.name);

/**
 * The verdict-bearing pieces of one player's card, pure given the prepared
 * slate and his history (loadHistory): { key, team, opponent, info, own,
 * radar, entries, form, track, projection, matchup (no per-stat deltas),
 * environment, split, radarSummary, starterChange, verdict, ... }. The card
 * and the slate verdicts both call this, so they cannot disagree.
 */
export function assemblePlayer(p, prep, history) {
  const { ctx, season, lastSeason, chosen } = prep;
  const key = slatePlayerKey(p);
  const own = prep.own.get(String(p.id)) ?? null;
  const radar = prep.radar.get(String(p.id)) ?? null;
  const team = canonicalTeam(p.team);
  const opponent = canonicalTeam(p.opponent);
  const fpColumn = history?.fpColumn ?? fantasyPointsColumn(prep.source.site);

  // --- Form -------------------------------------------------------------------------
  const byDate = snapshotsByDate(history?.snapshots?.get(key) ?? []);
  const entries = (history?.games?.get(key) ?? []).map(g => ({
    ...gameEntry(g, { fpColumn, salary: byDate.get(String(g.game_date).slice(0, 10))?.salary ?? null }),
    seasonKey: g.season,
  }));
  const form = summarizeForm(entries, { season, lastSeason });
  const gamesByDate = new Map(entries.map(e => [e.date, e]));
  const track = trackRecord([...byDate.values()], gamesByDate);

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
    // minutes_v2's p_play before the injury tag (the verdict's p_play rule; the tag has its own rule)
    p_play_model: num(own?.p_play_model) ?? num(p.p_play_model) ?? num(own?.p_play) ?? num(p.p_play),
    minutes_upside: minutesUpsideBlock(own, p),
    fade,
    ours_diff: num(own?.disagreement?.points_diff),
    floor: num(p.floor),
    ceiling: num(p.ceiling),
    boom_probability: num(p.boom_probability),
    rostership: num(p.rostership),
    leverage: num(p.leverage_score),
    value: active !== null && salaryK ? r2(active / salaryK) : null,
    projection_reasons: p.projection_reasons ?? null,
    injury_tag: p.injury_tag ?? null,
    injury_risk: p.injury_risk ?? null,
    injury_play_prob: num(p.injury_play_prob),
    injury_tag_play_prob: num(p.injury_tag_play_prob),
    injury_discount: num(p.injury_discount),
    projection_if_plays: num(p.projection_if_plays),
  };

  // --- Matchup ------------------------------------------------------------------------
  const info = ctx.matchups.get(String(p.player_id)) ?? {};
  let matchup = null;
  if (info.matchup) {
    const m = info.matchup;
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
      stats: null,
    };
  }
  const spread = num(p.vegas_spread);
  const environment = {
    implied_total: num(p.vegas_implied_total),
    opp_implied_total: num(p.vegas_over_under) !== null && num(p.vegas_implied_total) !== null
      ? r1(num(p.vegas_over_under) - num(p.vegas_implied_total)) : null,
    spread,
    over_under: num(p.vegas_over_under),
    blowout: spread === null ? null : Math.abs(spread) >= 10,
    blowout_risk: num(p.blowout_risk),
    team: ctx.ratings?.get(team) ?? null,
    opponent: ctx.ratings?.get(opponent) ?? null,
  };

  // --- Context ------------------------------------------------------------------------
  const split = radar && (radar.teammate_out_names?.length || radar.teammate_min_delta !== null) ? {
    out_names: radar.teammate_out_names ?? [],
    sample: radar.teammate_sample ?? null,
    games_without: radar.teammate_games_without ?? null,
    min_delta: num(radar.teammate_min_delta),
    usg_delta: num(radar.teammate_usg_delta),
    absorbed_pct: num(radar.teammate_absorbed_pct),
  } : null;
  const radarSummary = radar ? {
    cash_score: radar.cash_score ?? null,
    gpp_score: radar.gpp_score ?? null,
    reason: radar.reason ?? null,
    rate_projection: num(radar.rate_projection),
    salary_lag: radar.salary_lag ?? null,
    back_to_back: radar.back_to_back ?? null,
    rest_days: radar.rest_days ?? null,
  } : null;
  const change = starterChange(radar?.starter_change);

  // --- Verdict --------------------------------------------------------------------------------
  const minutesBase = form.trend.baseline === 'season' ? form.season : form.lastSeason;
  const signals = {
    id: p.id,
    name: p.name,
    salary,
    injuryStatus: p.injury_status,
    injuryTag: projection.injury_tag,
    injuryPlayProb: projection.injury_play_prob,
    injuryDiscount: projection.injury_discount,
    projectionIfPlays: projection.projection_if_plays,
    pPlay: projection.p_play_model ?? projection.p_play,
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
    starterChange: change,
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
    radarCash: radarSummary?.cash_score ?? null,
    radarGpp: radarSummary?.gpp_score ?? null,
    trackBias: track.bias,
    trackN: track.n,
  };
  // prep.slate: slate size + ownership distribution (null = the slate-agnostic legacy rules)
  const verdict = buildVerdict(signals, prep.slate ?? null);

  return {
    key, team, opponent, info, own, radar, entries, form, track, projection, matchup, environment,
    split, radarSummary, starterChange: change, salary, salaryK, active, rotowire, signals, verdict,
  };
}

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

  const prep = await prepareSource(source, { projectionSource: chosen, now });
  const { players, ctx, season, lastSeason, asOf } = prep;
  const warnings = [...prep.warnings];
  const found = findPlayer(players, playerId);
  if (!found) throw new SlateSourceError(`Player ${playerId} is not on slate ${source.slateId}`, 404);
  let p = found;
  if (source.isBacktest) [p] = await withActuals(source, [found]);

  const key = slatePlayerKey(p);
  const [history, current, previousRows, archetypeRow] = await Promise.all([
    soft(warnings, 'game log', () => loadHistory([key], { asOf, season, site: source.site }), null),
    soft(warnings, 'season profile', () => seasonToDateProfile(key, { season, asOf })),
    soft(warnings, 'last season profile', () => getPlayerProfiles(key, { seasons: [lastSeason] }), []),
    // A backtest reads last season's (complete) row so the night's season can't leak in
    soft(warnings, 'archetype', () => secondaryArchetype(key, source.isBacktest ? lastSeason : season)),
  ]);
  const a = assemblePlayer(p, prep, history);
  const { team, opponent, info, form, track, projection, environment, split, radarSummary, salaryK, active, rotowire, verdict } = a;

  // --- Identity ---------------------------------------------------------------------
  const archetype = info.archetype ?? p.archetype ?? (archetypeRow?.archetype !== 'unclassified' ? archetypeRow?.archetype : null) ?? null;
  const secondary = archetypeRow?.secondary_archetype && archetypeRow.secondary_archetype !== archetype ? archetypeRow.secondary_archetype : null;
  const isHome = isHomeFlag(p);

  // --- Matchup: per-stat deltas from the defense grid (card only) ----------------------------
  let matchup = a.matchup;
  if (info.matchup) {
    const m = info.matchup;
    const row = await soft(warnings, 'defense grid', async () => (await defenseRows(ctx, source, m))
      .find(r => r.team === m.opponent && r.group_key === m.group_key) ?? null);
    matchup = {
      ...matchup,
      stats: row ? {
        pts: r2(num(row.pts_delta)), reb: r2(num(row.reb_delta)), ast: r2(num(row.ast_delta)),
        fg3m: r2(num(row.fg3m_delta)), stocks: r2(num(row.stocks_delta)),
      } : null,
    };
  }

  // --- Context ------------------------------------------------------------------------
  const teammatesOut = players
    .filter(o => o !== found && canonicalTeam(o.team) === team && isOutStatus(o.injury_status))
    .map(o => ({ name: o.name, status: o.injury_status, salary: num(o.salary) }))
    .sort((x, y) => (y.salary ?? 0) - (x.salary ?? 0));
  const context = { teammates_out: teammatesOut, split, radar: radarSummary };

  // --- Role -----------------------------------------------------------------------------
  const prev = previousRows?.[0] ?? null;
  const role = {
    season,
    lastSeason,
    current,
    previous: prev ? { season: lastSeason, games: prev.games, starts: prev.starts, ...roleRow(prev) } : null,
    archetype_average: archetype ? ctx.archetypeAvg?.get(archetype) ?? null : null,
    started_last_game: a.radar?.started_last_game ?? form.log.at(-1)?.is_starter ?? null,
    starts_l5: a.radar?.starts_l5 ?? null,
    starter_change: a.starterChange,
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
      salary: a.salary,
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

export default { getPlayerCard, clearPlayerCardCache, prepareSlate, prepareSource, loadHistory, assemblePlayer };
