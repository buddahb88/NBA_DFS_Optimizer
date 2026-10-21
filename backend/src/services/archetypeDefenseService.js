/**
 * ARCHETYPE DEFENSE SERVICE
 *
 * How each defense performs against each player archetype (and, as an
 * in-house DvP, each G/F/C position) relative to what those players were
 * expected to score.
 *
 * Expectation for a player-game (regular season, minutes > 0):
 *   rate     = season-to-date stat per minute from games on EARLIER dates only
 *              (no lookahead), blended with the player's prior-season rate
 *              weighted as baselinePriorMinutes minutes:
 *              (Σstat + W·priorRate) / (Σmin + W)
 *   expected = rate x actual minutes
 * Without a prior season the game needs minBaselineMinutes earlier minutes,
 * otherwise it is left out. Done for each site's fantasy points and for
 * pts, reb, ast, 3PM and stl+blk.
 *
 * Aggregated per defending team x group: per player-game averages, with every
 * delta shrunk toward 0 by n / (n + priorGames), n = distinct games, as in
 * minutesModel.buildOpponentFactors.
 *
 * A player's archetype is his player_archetypes row for the game's season,
 * or the prior season's when that row is missing or unclassified (early in a
 * season nearly everyone is below the sample minimum). Positions are ESPN's
 * coarse G/F/C, so the position grouping is 3-bucket DvP, not 5-position.
 *
 * Full-season results are stored in team_archetype_defense (refreshed after
 * the nightly historical sync); date / lastNGames windows and the per-game
 * drill-down are computed on request.
 */

import db, { DATABASE_TYPE } from '../config/database.js';
import { DEFENSE_COLUMNS } from '../config/archetypeDefenseMigrations.js';
import { ALL_ARCHETYPES } from '../config/archetypes.js';
import { SITE_KEYS, isValidSite } from '../config/sites.js';
import { getCurrentSeason } from '../utils/season.js';
import { canonicalTeam, playerKey } from '../utils/playerKey.js';
import { resolveSite } from '../utils/resolveSite.js';

export const DEFAULT_DEFENSE_CONFIG = {
  baselinePriorMinutes: 100,
  minBaselineMinutes: 60,
  priorGames: 10,
};

export const GROUPINGS = ['archetype', 'position'];
const POSITION_BUCKETS = ['G', 'F', 'C'];
// Tonight view: stat -> team_archetype_defense column it ranks by
export const STAT_COLUMNS = { fp: 'fp_over_expectation', pts: 'pts_delta', reb: 'reb_delta', ast: 'ast_delta', fg3m: 'fg3m_delta' };
// Weak tier = the top third of defenses (most allowed over expectation) per group
const WEAK_TIER_FRACTION = 1 / 3;
const SITE_ALIASES = { dk: 'draftkings', fd: 'fanduel' };
const SITE_METRICS = { draftkings: 'dk', fanduel: 'fd', yahoo: 'yahoo' };
const STATS = ['pts', 'reb', 'ast', 'fg3m', 'stocks'];
const METRICS = ['dk', 'fd', 'yahoo', ...STATS];

const SEASON_RE = /^(\d{4})-(\d{2})$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export class DefenseError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const n = (v) => Number(v) || 0;
const round3 = (x) => Math.round(x * 1000) / 1000;
// Azure returns DATE columns as Date objects
const dateString = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : v);

/**
 * In-house DvP bucket: ESPN G/F/C (or PG/SG/SF/PF) and DK positions
 * ('PG/SG', 'PF/C', 'PG,G,UTIL') map to G / F / C by their first position.
 */
export function dvpPosition(position) {
  const first = String(position ?? '').split(/[/,-]/)[0].trim().toUpperCase();
  if (first === 'PG' || first === 'SG' || first === 'G') return 'G';
  if (first === 'SF' || first === 'PF' || first === 'F') return 'F';
  if (first === 'C') return 'C';
  return null;
}

/** historical_games row -> per-metric values */
function metrics(row) {
  return {
    dk: n(row.dk_fantasy_points),
    fd: n(row.fd_fantasy_points),
    yahoo: n(row.yahoo_fantasy_points),
    pts: n(row.points),
    reb: n(row.rebounds),
    ast: n(row.assists),
    fg3m: n(row.fg3_made),
    stocks: n(row.steals) + n(row.blocks),
  };
}

const emptyTotals = () => ({ minutes: 0, ...Object.fromEntries(METRICS.map(m => [m, 0])) });

/**
 * Expected stats for every player-game with a baseline. Pure.
 * @param {Array} rows - one season of historical_games rows, minutes > 0
 * @param {Object} context - { priorTotals: Map(player_key -> totals with minutes
 *   and each metric), archetypes / priorArchetypes: Map(player_key -> key) }
 * Returns [{ game_id, game_date, player_key, player_name, team, defense,
 *   position_group, archetype, minutes, actual: {...}, expected: {...} }]
 */
export function computeExpectations(rows, context = {}, config = DEFAULT_DEFENSE_CONFIG) {
  const { priorTotals = new Map(), archetypes = new Map(), priorArchetypes = new Map() } = context;
  const sorted = [...rows].sort((a, b) => (dateString(a.game_date) < dateString(b.game_date) ? -1
    : dateString(a.game_date) > dateString(b.game_date) ? 1 : n(a.id) - n(b.id)));

  const totals = new Map();
  const out = [];
  let pending = [];
  let currentDate = null;

  // Earlier dates only: a date's games join the totals once the date is done
  const flush = () => {
    for (const { key, minutes, actual } of pending) {
      if (!totals.has(key)) totals.set(key, emptyTotals());
      const t = totals.get(key);
      t.minutes += minutes;
      for (const m of METRICS) t[m] += actual[m];
    }
    pending = [];
  };

  for (const row of sorted) {
    const minutes = n(row.minutes);
    if (!(minutes > 0) || !row.player_key) continue;
    const date = dateString(row.game_date);
    if (date !== currentDate) {
      flush();
      currentDate = date;
    }

    const key = row.player_key;
    const actual = metrics(row);
    pending.push({ key, minutes, actual });

    const t = totals.get(key) || emptyTotals();
    const prior = priorTotals.get(key);
    const weight = prior && n(prior.minutes) > 0 ? config.baselinePriorMinutes : 0;
    if (weight === 0 && t.minutes < config.minBaselineMinutes) continue;

    const expected = {};
    for (const m of METRICS) {
      const priorRate = weight > 0 ? n(prior[m]) / n(prior.minutes) : 0;
      expected[m] = ((t[m] + weight * priorRate) / (t.minutes + weight)) * minutes;
    }

    const current = archetypes.get(key);
    const archetype = (!current || current === 'unclassified') ? (priorArchetypes.get(key) ?? current ?? 'unclassified') : current;

    out.push({
      game_id: row.game_id,
      game_date: date,
      player_key: key,
      player_name: row.player_name,
      team: row.team,
      defense: row.opponent,
      position_group: dvpPosition(row.position),
      archetype,
      minutes,
      actual,
      expected,
    });
  }
  return out;
}

/** Keep only each defense's last N games (by date) among `games`. */
function lastGamesPerDefense(games, lastNGames) {
  const byTeam = new Map();
  for (const g of games) {
    if (!byTeam.has(g.defense)) byTeam.set(g.defense, new Map());
    byTeam.get(g.defense).set(g.game_id, g.game_date);
  }
  const keep = new Map();
  for (const [team, ids] of byTeam) {
    const recent = [...ids].sort((a, b) => (a[1] < b[1] ? 1 : a[1] > b[1] ? -1 : 0)).slice(0, lastNGames);
    keep.set(team, new Set(recent.map(([id]) => id)));
  }
  return games.filter(g => keep.get(g.defense).has(g.game_id));
}

/** Apply the startDate / endDate / lastNGames window. */
export function filterWindow(games, { startDate, endDate, lastNGames } = {}) {
  let out = games.filter(g => (!startDate || g.game_date >= startDate) && (!endDate || g.game_date <= endDate));
  if (lastNGames) out = lastGamesPerDefense(out, lastNGames);
  return out;
}

const groupKey = (game, grouping) => (grouping === 'position' ? game.position_group : game.archetype);

/**
 * Aggregate expectation rows by defending team x group for one site. Pure.
 * Returns rows shaped like team_archetype_defense (without season).
 */
export function aggregateDefense(games, { site = 'draftkings', grouping = 'archetype', ...window } = {}, config = DEFAULT_DEFENSE_CONFIG) {
  const fp = SITE_METRICS[site];
  const groups = new Map();
  for (const g of filterWindow(games, window)) {
    const key = groupKey(g, grouping);
    if (!key) continue;
    const id = `${g.defense}|${key}`;
    if (!groups.has(id)) {
      groups.set(id, { team: g.defense, group_key: key, gameIds: new Set(), count: 0, minutes: 0, fp: 0, expected: 0,
        deltas: Object.fromEntries(STATS.map(s => [s, 0])) });
    }
    const a = groups.get(id);
    a.gameIds.add(g.game_id);
    a.count += 1;
    a.minutes += g.minutes;
    a.fp += g.actual[fp];
    a.expected += g.expected[fp];
    for (const s of STATS) a.deltas[s] += g.actual[s] - g.expected[s];
  }

  const rows = [];
  for (const a of groups.values()) {
    const games = a.gameIds.size;
    const shrink = games / (games + config.priorGames);
    const raw = (a.fp - a.expected) / a.count;
    rows.push({
      site,
      group_by: grouping,
      team: a.team,
      group_key: a.group_key,
      games,
      player_games: a.count,
      avg_minutes: round3(a.minutes / a.count),
      avg_fp: round3(a.fp / a.count),
      avg_expected_fp: round3(a.expected / a.count),
      fp_over_expectation_raw: round3(raw),
      shrink: round3(shrink),
      fp_over_expectation: round3(raw * shrink),
      ...Object.fromEntries(STATS.map(s => [`${s}_delta`, round3((a.deltas[s] / a.count) * shrink)])),
    });
  }
  return rows.sort((x, y) => y.fp_over_expectation - x.fp_over_expectation || (x.team < y.team ? -1 : 1));
}

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

const GAMES_SQL = `
  SELECT id, game_id, game_date, player_key, player_name, team, opponent, position, minutes,
         points, rebounds, assists, fg3_made, steals, blocks,
         dk_fantasy_points, fd_fantasy_points, yahoo_fantasy_points
  FROM historical_games
  WHERE season = ? AND COALESCE(season_type, 'regular') = 'regular'
    AND minutes > 0 AND player_key IS NOT NULL
  ORDER BY game_date, id
`;

const PRIOR_TOTALS_SQL = `
  SELECT player_key, SUM(minutes) AS minutes,
         SUM(dk_fantasy_points) AS dk, SUM(fd_fantasy_points) AS fd, SUM(yahoo_fantasy_points) AS yahoo,
         SUM(points) AS pts, SUM(rebounds) AS reb, SUM(assists) AS ast, SUM(fg3_made) AS fg3m,
         SUM(COALESCE(steals, 0) + COALESCE(blocks, 0)) AS stocks
  FROM historical_games
  WHERE season = ? AND COALESCE(season_type, 'regular') = 'regular'
    AND minutes > 0 AND player_key IS NOT NULL
  GROUP BY player_key
`;

const ARCHETYPES_SQL = 'SELECT player_key, archetype FROM player_archetypes WHERE season = ?';

export function previousSeason(season) {
  const year = Number(SEASON_RE.exec(season)[1]) - 1;
  return `${year}-${String((year + 1) % 100).padStart(2, '0')}`;
}

/** Load and compute one season's expectation rows. */
export async function loadSeasonExpectations(season, config = DEFAULT_DEFENSE_CONFIG) {
  const prior = previousSeason(season);
  const [rows, priorRows, current, previous] = await Promise.all([
    db.all(GAMES_SQL, season),
    db.all(PRIOR_TOTALS_SQL, prior),
    db.all(ARCHETYPES_SQL, season),
    db.all(ARCHETYPES_SQL, prior),
  ]);
  return computeExpectations(rows, {
    priorTotals: new Map(priorRows.map(r => [r.player_key, r])),
    archetypes: new Map(current.map(r => [r.player_key, r.archetype])),
    priorArchetypes: new Map(previous.map(r => [r.player_key, r.archetype])),
  }, config);
}

const INSERT_SQL = `INSERT INTO team_archetype_defense (${DEFENSE_COLUMNS.join(', ')})
  VALUES (${DEFENSE_COLUMNS.map(c => `@${c}`).join(', ')})`;
const DELETE_SQL = 'DELETE FROM team_archetype_defense WHERE season = @season';

/**
 * Recompute and replace one season's team_archetype_defense rows for every
 * site and grouping. Returns { season, playerGames, rows }.
 */
export async function refreshSeasonDefense(season) {
  const games = await loadSeasonExpectations(season);
  const rows = [];
  for (const site of SITE_KEYS) {
    for (const grouping of GROUPINGS) {
      for (const row of aggregateDefense(games, { site, grouping })) rows.push({ season, ...row });
    }
  }

  if (DATABASE_TYPE === 'azuresql') {
    await db.run(DELETE_SQL, { season });
    for (const row of rows) await db.run(INSERT_SQL, row);
  } else {
    const sqlite = db.sqliteDb;
    const insert = sqlite.prepare(INSERT_SQL);
    db.transaction(() => {
      sqlite.prepare(DELETE_SQL).run({ season });
      for (const row of rows) insert.run(row);
    })();
  }

  return { season, playerGames: games.length, rows: rows.length };
}

/** Refresh several seasons in order. */
export async function refreshDefense(seasons) {
  const results = [];
  for (const season of seasons) results.push(await refreshSeasonDefense(season));
  return results;
}

// ---------------------------------------------------------------------------
// Reads (routes/archetypes.js)
// ---------------------------------------------------------------------------

function checkDate(value, name) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !DATE_RE.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw new DefenseError(`${name} must be a YYYY-MM-DD date`);
  }
  return value;
}

/** Validate and default request filters. */
export function normalizeFilters(query = {}) {
  const season = query.season || getCurrentSeason();
  if (!SEASON_RE.test(season)) throw new DefenseError('season must look like 2025-26');

  const rawSite = String(query.site || 'draftkings').toLowerCase();
  const site = SITE_ALIASES[rawSite] || rawSite;
  if (!isValidSite(site)) throw new DefenseError(`Unknown site "${query.site}". Expected one of: dk, fd, ${SITE_KEYS.join(', ')}`);

  const grouping = query.grouping || 'archetype';
  if (!GROUPINGS.includes(grouping)) throw new DefenseError(`grouping must be one of: ${GROUPINGS.join(', ')}`);

  let lastNGames = null;
  if (query.lastNGames !== undefined && query.lastNGames !== null && query.lastNGames !== '') {
    lastNGames = Number(query.lastNGames);
    if (!Number.isInteger(lastNGames) || lastNGames < 1) throw new DefenseError('lastNGames must be a positive integer');
  }
  const startDate = checkDate(query.startDate, 'startDate');
  const endDate = checkDate(query.endDate, 'endDate');
  if (startDate && endDate && startDate > endDate) throw new DefenseError('startDate must be on or before endDate');

  return {
    season, site, grouping, lastNGames, startDate, endDate,
    team: query.team ? String(query.team).toUpperCase() : null,
    group: query.group || null,
  };
}

const LABELS = Object.fromEntries(ALL_ARCHETYPES.map(a => [a.key, a.label]));
export const POSITION_LABELS = { G: 'Guards', F: 'Forwards', C: 'Centers' };
const labelFor = (grouping, key) => (grouping === 'position' ? POSITION_LABELS[key] : LABELS[key]) ?? key;
const withLabel = (grouping) => (row) => ({ ...row, label: labelFor(grouping, row.group_key) });

const STORED_SQL = `SELECT ${DEFENSE_COLUMNS.join(', ')}, updated_at FROM team_archetype_defense
  WHERE season = ? AND site = ? AND group_by = ?
  ORDER BY fp_over_expectation DESC, team, group_key`;

/**
 * Defense vs archetype (or G/F/C) rows. Full season comes from
 * team_archetype_defense; a window, or a season not built yet, is computed live.
 */
export async function getDefense(query = {}) {
  const f = normalizeFilters(query);
  const windowed = Boolean(f.lastNGames || f.startDate || f.endDate);

  let rows = [];
  let source = 'precomputed';
  if (!windowed) rows = await db.all(STORED_SQL, f.season, f.site, f.grouping);
  if (rows.length === 0) {
    source = 'live';
    const games = await loadSeasonExpectations(f.season);
    rows = aggregateDefense(games, f).map(r => ({ season: f.season, ...r }));
  }

  rows = rows
    .filter(r => (!f.team || r.team === f.team) && (!f.group || r.group_key === f.group))
    .map(withLabel(f.grouping));

  const { team, group, ...filters } = f;
  return { ...filters, source, config: DEFAULT_DEFENSE_CONFIG, rows };
}

/**
 * The player-games behind one team x group cell, newest first, with the
 * site's actual / expected FP and raw (unshrunk) per-stat deltas, plus the
 * cell's aggregate as `summary`. A G/F/C group implies grouping 'position'.
 */
export async function getDefenseGames(team, group, query = {}) {
  const grouping = query.grouping || (POSITION_BUCKETS.includes(group) ? 'position' : 'archetype');
  const f = normalizeFilters({ ...query, grouping, team });
  const fp = SITE_METRICS[f.site];

  const all = filterWindow(await loadSeasonExpectations(f.season), f);
  const cell = all.filter(g => g.defense === f.team && groupKey(g, f.grouping) === group);
  const [summary = null] = aggregateDefense(cell, { site: f.site, grouping: f.grouping });

  const games = cell
    .sort((a, b) => (a.game_date < b.game_date ? 1 : a.game_date > b.game_date ? -1 : 0))
    .map(g => ({
      game_id: g.game_id,
      game_date: g.game_date,
      player_key: g.player_key,
      player_name: g.player_name,
      team: g.team,
      position_group: g.position_group,
      archetype: g.archetype,
      minutes: g.minutes,
      fp: round3(g.actual[fp]),
      expected_fp: round3(g.expected[fp]),
      fp_over_expectation: round3(g.actual[fp] - g.expected[fp]),
      ...Object.fromEntries(STATS.flatMap(s => [[s, g.actual[s]], [`${s}_delta`, round3(g.actual[s] - g.expected[s])]])),
    }));

  return {
    season: f.season, site: f.site, grouping: f.grouping, team: f.team, group, label: labelFor(f.grouping, group),
    lastNGames: f.lastNGames, startDate: f.startDate, endDate: f.endDate,
    summary: summary && withLabel(f.grouping)(summary),
    games,
  };
}

// ---------------------------------------------------------------------------
// Tonight: slate players vs weak-tier defenses
// ---------------------------------------------------------------------------

/**
 * Weak tier per group: defenses ranked by the stat's delta (most allowed
 * first), the top third (rounded up) that also allow MORE than expected. Pure.
 * Returns Map(group_key -> Map(team -> { rank, teams, row })), best first.
 */
export function weakTiers(rows, stat = 'fp') {
  const column = STAT_COLUMNS[stat];
  const byGroup = new Map();
  for (const r of rows) {
    if (!byGroup.has(r.group_key)) byGroup.set(r.group_key, []);
    byGroup.get(r.group_key).push(r);
  }
  const tiers = new Map();
  for (const [group, list] of byGroup) {
    const ranked = [...list].sort((a, b) => n(b[column]) - n(a[column]) || (a.team < b.team ? -1 : 1));
    const size = Math.ceil(ranked.length * WEAK_TIER_FRACTION);
    const tier = new Map();
    ranked.slice(0, size).forEach((row, i) => {
      if (n(row[column]) > 0) tier.set(row.team, { rank: i + 1, teams: ranked.length, row });
    });
    tiers.set(group, tier);
  }
  return tiers;
}

const SLATE_SQL = 'SELECT slate_id FROM slates WHERE slate_id = ?';
const SLATE_PLAYERS_SQL = `SELECT player_id, name, team, opponent, position, salary, projected_points, injury_status
  FROM players WHERE slate_id = ?`;

/**
 * Slate players whose opponent is in the weak tier vs their archetype (or
 * G/F/C), with salary, projection and the matchup delta for `stat`, best
 * matchup first. Archetype falls back to the prior season like the defense
 * aggregation. Site defaults to the slate's.
 */
export async function getTonight(query = {}) {
  if (!query.slateId) throw new DefenseError('slateId is required');
  const stat = query.stat || 'fp';
  if (!STAT_COLUMNS[stat]) throw new DefenseError(`stat must be one of: ${Object.keys(STAT_COLUMNS).join(', ')}`);
  if (!(await db.get(SLATE_SQL, query.slateId))) throw new DefenseError(`Slate ${query.slateId} not found`, 404);

  const { site, error } = await resolveSite(query.site ? (SITE_ALIASES[String(query.site).toLowerCase()] || query.site) : null, query.slateId);
  if (error) throw new DefenseError(error);
  const defense = await getDefense({ ...query, site, team: null, group: null });
  const { season, grouping } = defense;

  const [players, current, previous] = await Promise.all([
    db.all(SLATE_PLAYERS_SQL, query.slateId),
    db.all(ARCHETYPES_SQL, season),
    db.all(ARCHETYPES_SQL, previousSeason(season)),
  ]);
  const archetypes = new Map(current.map(r => [r.player_key, r.archetype]));
  const priorArchetypes = new Map(previous.map(r => [r.player_key, r.archetype]));
  const archetypeOf = (key) => {
    const a = archetypes.get(key);
    return (!a || a === 'unclassified') ? (priorArchetypes.get(key) ?? a ?? null) : a;
  };

  const tiers = weakTiers(defense.rows, stat);
  const column = STAT_COLUMNS[stat];
  let matchedPlayers = 0;
  const out = [];
  for (const p of players) {
    const archetype = archetypeOf(playerKey(p.name));
    const group = grouping === 'position' ? dvpPosition(p.position) : archetype;
    if (!group || group === 'unclassified') continue;
    matchedPlayers += 1;
    const opponent = canonicalTeam(p.opponent);
    const hit = tiers.get(group)?.get(opponent);
    if (!hit) continue;
    out.push({
      player_id: p.player_id,
      name: p.name,
      team: canonicalTeam(p.team),
      opponent,
      position: p.position,
      salary: p.salary,
      projected_points: p.projected_points,
      injury_status: p.injury_status,
      archetype,
      group_key: group,
      label: labelFor(grouping, group),
      matchup_delta: hit.row[column],
      fp_over_expectation: hit.row.fp_over_expectation,
      rank: hit.rank,
      teams: hit.teams,
      games: hit.row.games,
    });
  }
  out.sort((a, b) => b.matchup_delta - a.matchup_delta || n(b.projected_points) - n(a.projected_points));

  return {
    slateId: query.slateId, season, site, grouping, stat,
    lastNGames: defense.lastNGames, source: defense.source,
    slatePlayers: players.length, matchedPlayers, defenseRows: defense.rows.length,
    players: out,
  };
}
