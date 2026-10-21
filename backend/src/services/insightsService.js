/**
 * INSIGHTS SERVICE
 *
 * Analytics behind the Insights page: hot/cold streaks, consistency,
 * boom/bust, matchup advantages, recent performers, missing players and
 * usage bumps. Each card is one set-based query over historical_games
 * (no per-player loops), matched on player_key, for the requested DFS site's
 * fantasy points column.
 *
 * Shared definitions:
 * - Only games with minutes > 0 count (minutes = 0 rows are listings, not games).
 * - Date window: startDate/endDate, or lastNDays counted back from endDate.
 *   Without endDate the window ends on the latest game in the data, so a
 *   backtest database looks at its own period rather than the wall clock.
 * - season_avg (and the last-3 / floor / ceiling it is compared with) is
 *   scoped to the season containing the window's end.
 * - Streak: last-3 average at least STREAK_THRESHOLD_PCT above / below season_avg,
 *   for players whose season_avg is at least minAvg (default STREAK_MIN_AVG).
 * - consistency_score = 100 * (1 - coefficient of variation), floored at 0;
 *   sd = 0 scores 100.
 * - A player "without" a teammate: the team's games (team_game_stats) between the
 *   teammate's first and last appearance for that team this season (a box score
 *   row or a game_player_status listing) in which he has no minutes > 0 row.
 *   ESPN lists only healthy DNP-CD players, so injured players are usually
 *   absent; game_player_status (or a minutes = 0 row) only labels the absence
 *   DNP-CD, anything else is OUT.
 */

import db, { DATABASE_TYPE } from '../config/database.js';
import { isValidSite, SITE_KEYS } from '../config/sites.js';
import { fantasyPointsColumn } from './scoring.js';
import { playerKey, canonicalTeam } from '../utils/playerKey.js';
import { seasonForDate, seasonStartDate } from '../utils/season.js';

const STREAK_THRESHOLD_PCT = 15;
// Below this season average a big % swing is a few points of noise
const STREAK_MIN_AVG = 15;
const BOOM_POINTS = 50;
const BUST_POINTS = 15;

// Slate card rules (getSlateInsights)
const SLATE_MIN_GAMES = 3;
const SLATE_CARD_LIMIT = 10;
const MATCHUP_EDGE = 1.1;          // avg vs opponent > 110% of season_avg
const CONSISTENT_MAX_CV = 0.25;
const CONSISTENT_MIN_GAMES = 5;
const BOOM_MIN_SD = 12;
const RECENT_MIN_LAST3 = 30;

// Usage bumps
const BUMP_MIN_GAMES_WITHOUT = 2;
const BUMP_MIN_GAMES_WITH = 3;
const BUMP_MIN_PCT = 5;
const BUMP_LIMIT = 15;

const VARIANCE_MODES = {
  consistency: { minAvg: 20 },
  boomBust: { minAvg: 15 },
};

const SITE_ALIASES = { dk: 'draftkings', fd: 'fanduel' };
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export class InsightsError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const isAzure = () => DATABASE_TYPE === 'azuresql';
const limitSql = () => (isAzure() ? 'OFFSET 0 ROWS FETCH NEXT ? ROWS ONLY' : 'LIMIT ?');
const placeholders = (n) => Array(n).fill('?').join(', ');
// Inline table of parameter rows: (SELECT ?, ? UNION ALL SELECT ?, ? ...)
const valuesSql = (rows, width) => rows.map(() => `SELECT ${placeholders(width)}`).join(' UNION ALL ');

const round1 = (x) => (x === null || x === undefined ? null : Math.round(x * 10) / 10);
const stdDev = (variance) => Math.sqrt(Math.max(0, variance || 0));
const consistencyScore = (sd, mean) => (mean > 0 ? round1(100 * Math.max(0, 1 - sd / mean)) : 0);

// Azure returns DATE columns as Date objects
function toDateString(value) {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return value ?? null;
}

function addDays(date, n) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function localToday() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function checkDate(value, name) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !DATE_RE.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw new InsightsError(`${name} must be a YYYY-MM-DD date`);
  }
  return value;
}

/**
 * Slate payload -> [{ name, key, team, opponent, salary, ... }]. Only name and
 * team are required; projection fields are passed through when present.
 */
function normalizeSlatePlayers(players) {
  const list = (Array.isArray(players) ? players : [])
    .filter(p => p && typeof p.name === 'string' && p.name.trim() && typeof p.team === 'string' && p.team.trim())
    .map(p => ({
      name: p.name,
      key: playerKey(p.name),
      team: canonicalTeam(p.team),
      opponent: canonicalTeam(p.opponent),
      position: p.position ?? p.roster_position ?? null,
      salary: p.salary ?? null,
      projection: p.projected_points ?? p.projectedPoints ?? null,
      projectedMinutes: p.projected_minutes ?? p.projectedMinutes ?? null,
    }))
    .filter(p => p.key);
  if (list.length === 0) {
    throw new InsightsError('players must be a non-empty array of { name, team }');
  }
  return list;
}

class InsightsService {
  constructor() {
    this.STREAK_THRESHOLD_PCT = STREAK_THRESHOLD_PCT;
    this.STREAK_MIN_AVG = STREAK_MIN_AVG;
  }

  /**
   * Map 'dk' / 'fd' / 'yahoo' (or full site keys) to a site key. Empty stays
   * undefined so callers can fall back to the slate's site.
   */
  normalizeSite(site) {
    if (site === undefined || site === null || site === '') return undefined;
    const key = SITE_ALIASES[String(site).toLowerCase()] || String(site).toLowerCase();
    if (!isValidSite(key)) {
      throw new InsightsError(`Unknown site "${site}". Expected one of: dk, fd, ${SITE_KEYS.join(', ')}`);
    }
    return key;
  }

  pointsColumn(site) {
    return fantasyPointsColumn(this.normalizeSite(site));
  }

  async latestGameDate() {
    const row = await db.get('SELECT MAX(game_date) AS latest FROM historical_games');
    return toDateString(row?.latest) || null;
  }

  /**
   * Resolve { startDate, endDate, lastNDays } into a concrete window plus the
   * season its end falls in. startDate wins over lastNDays; defaultLastNDays
   * applies only when neither is given.
   */
  async resolveWindow({ startDate, endDate, lastNDays } = {}, { defaultLastNDays = null } = {}) {
    const start = checkDate(startDate, 'startDate');
    const end = checkDate(endDate, 'endDate');
    let days = null;
    if (lastNDays !== undefined && lastNDays !== null && lastNDays !== '') {
      days = Number(lastNDays);
      if (!Number.isInteger(days) || days < 1) throw new InsightsError('lastNDays must be a positive integer');
    }
    if (start && end && start > end) throw new InsightsError('startDate must be on or before endDate');

    const resolvedEnd = end || (await this.latestGameDate()) || localToday();
    const n = days ?? defaultLastNDays;
    const resolvedStart = start || (n ? addDays(resolvedEnd, -n) : null);
    const season = seasonForDate(resolvedEnd);
    return { startDate: resolvedStart, endDate: resolvedEnd, season, seasonStartDate: seasonStartDate(season) };
  }

  // Window clamped to the current season (season_avg scope)
  seasonWindow(window) {
    const start = window.startDate && window.startDate > window.seasonStartDate ? window.startDate : window.seasonStartDate;
    return { startDate: start, endDate: window.endDate };
  }

  dateFilter(column, { startDate, endDate }) {
    const sql = [];
    const params = [];
    if (startDate) { sql.push(`${column} >= ?`); params.push(startDate); }
    if (endDate) { sql.push(`${column} <= ?`); params.push(endDate); }
    return { sql: sql.map(s => ` AND ${s}`).join(''), params };
  }

  /**
   * Hot ('hot') or cold ('cold') streaks: last-3 average vs current-season
   * average, league-wide. One query.
   */
  async getStreaks(direction, { limit = 20, minGames = 5, minAvg = STREAK_MIN_AVG, site, ...windowOpts } = {}) {
    const window = await this.resolveWindow(windowOpts);
    const col = this.pointsColumn(site);
    const range = this.dateFilter('game_date', this.seasonWindow(window));
    const hot = direction === 'hot';
    const pct = '(last3_avg - season_avg) * 100.0 / NULLIF(season_avg, 0)';

    const rows = await db.all(`
      WITH g AS (
        SELECT player_key, player_name, team, game_date, ${col} AS fpts,
          ROW_NUMBER() OVER (PARTITION BY player_key ORDER BY game_date DESC) AS rn
        FROM historical_games
        WHERE minutes > 0 AND ${col} IS NOT NULL${range.sql}
      ),
      s AS (
        SELECT player_key,
          MAX(CASE WHEN rn = 1 THEN player_name END) AS player_name,
          MAX(CASE WHEN rn = 1 THEN team END) AS team,
          COUNT(*) AS total_games,
          AVG(fpts) AS season_avg,
          AVG(CASE WHEN rn <= 3 THEN fpts END) AS last3_avg,
          MAX(game_date) AS last_game
        FROM g
        GROUP BY player_key
      )
      SELECT * FROM s
      WHERE total_games >= ? AND season_avg >= ? AND season_avg > 0 AND ${pct} ${hot ? '>= ?' : '<= ?'}
      ORDER BY ${pct} ${hot ? 'DESC' : 'ASC'}, player_key
      ${limitSql()}
    `, [...range.params, minGames, minAvg, hot ? STREAK_THRESHOLD_PCT : -STREAK_THRESHOLD_PCT, limit]);

    const prefix = hot ? 'hot_streak' : 'cold_streak';
    return rows.map(r => ({
      player_key: r.player_key,
      player_name: r.player_name,
      team: r.team,
      total_games: r.total_games,
      season_avg: round1(r.season_avg),
      last_game: toDateString(r.last_game),
      last3_avg: round1(r.last3_avg),
      [`${prefix}_diff`]: round1(r.last3_avg - r.season_avg),
      [`${prefix}_pct`]: round1(((r.last3_avg - r.season_avg) / r.season_avg) * 100),
    }));
  }

  getHotStreaks(opts) {
    return this.getStreaks('hot', opts);
  }

  getColdStreaks(opts) {
    return this.getStreaks('cold', opts);
  }

  /**
   * League-wide variance cards over the window. 'consistency' ranks by lowest
   * coefficient of variation, 'boomBust' by highest standard deviation.
   */
  async getVarianceLeaders(mode, { limit = 20, minGames = 8, site, ...windowOpts } = {}) {
    const { minAvg } = VARIANCE_MODES[mode];
    const window = await this.resolveWindow(windowOpts);
    const col = this.pointsColumn(site);
    const range = this.dateFilter('game_date', window);
    const order = mode === 'consistency'
      ? 'variance / NULLIF(avg_fpts * avg_fpts, 0) ASC'
      : 'variance DESC';

    const rows = await db.all(`
      WITH g AS (
        SELECT player_key, player_name, team, game_date, ${col} AS fpts,
          ROW_NUMBER() OVER (PARTITION BY player_key ORDER BY game_date DESC) AS rn
        FROM historical_games
        WHERE minutes > 0 AND ${col} IS NOT NULL${range.sql}
      ),
      s AS (
        SELECT player_key,
          MAX(CASE WHEN rn = 1 THEN player_name END) AS player_name,
          MAX(CASE WHEN rn = 1 THEN team END) AS team,
          COUNT(*) AS games,
          AVG(fpts) AS avg_fpts,
          AVG(fpts * fpts) - AVG(fpts) * AVG(fpts) AS variance,
          MIN(fpts) AS floor,
          MAX(fpts) AS ceiling,
          MAX(game_date) AS last_game,
          SUM(CASE WHEN fpts >= ? THEN 1 ELSE 0 END) AS boom_games,
          SUM(CASE WHEN fpts < ? THEN 1 ELSE 0 END) AS bust_games
        FROM g
        GROUP BY player_key
      )
      SELECT * FROM s
      WHERE games >= ? AND avg_fpts >= ? AND avg_fpts > 0
      ORDER BY ${order}, player_key
      ${limitSql()}
    `, [...range.params, BOOM_POINTS, BUST_POINTS, minGames, minAvg, limit]);

    return rows.map(r => {
      const sd = stdDev(r.variance);
      const base = {
        player_key: r.player_key,
        player_name: r.player_name,
        team: r.team,
        games: r.games,
        avg_dk: round1(r.avg_fpts),
        floor: round1(r.floor),
        ceiling: round1(r.ceiling),
        last_game: toDateString(r.last_game),
        std_dev: round1(sd),
      };
      if (mode === 'consistency') {
        return { ...base, consistency_score: consistencyScore(sd, r.avg_fpts) };
      }
      return {
        ...base,
        boom_rate: round1((r.boom_games / r.games) * 100),
        bust_rate: round1((r.bust_games / r.games) * 100),
        upside_score: round1(r.ceiling - r.avg_fpts),
      };
    });
  }

  getConsistencyLeaders(opts) {
    return this.getVarianceLeaders('consistency', opts);
  }

  getBoomBustPlayers(opts) {
    return this.getVarianceLeaders('boomBust', opts);
  }

  /**
   * Slate cards for the given players (minAvg applies to the hot/cold cards):
   * one stats query (current season within
   * the window) and one matchup query (vs tonight's opponent, whole window).
   */
  async getSlateInsights(players, { minAvg = STREAK_MIN_AVG, site, ...windowOpts } = {}) {
    const slate = normalizeSlatePlayers(players);
    const window = await this.resolveWindow(windowOpts);
    const col = this.pointsColumn(site);
    const keys = [...new Set(slate.map(p => p.key))];
    const seasonRange = this.dateFilter('game_date', this.seasonWindow(window));

    const statsRows = await db.all(`
      WITH g AS (
        SELECT player_key, game_date, minutes, ${col} AS fpts,
          ROW_NUMBER() OVER (PARTITION BY player_key ORDER BY game_date DESC) AS rn
        FROM historical_games
        WHERE player_key IN (${placeholders(keys.length)})
          AND minutes > 0 AND ${col} IS NOT NULL${seasonRange.sql}
      )
      SELECT player_key,
        COUNT(*) AS games,
        AVG(fpts) AS season_avg,
        AVG(minutes) AS avg_min,
        MIN(fpts) AS floor,
        MAX(fpts) AS ceiling,
        MAX(game_date) AS last_game,
        AVG(fpts * fpts) - AVG(fpts) * AVG(fpts) AS variance,
        AVG(CASE WHEN rn <= 3 THEN fpts END) AS last3_avg,
        MAX(CASE WHEN rn = 1 THEN fpts END) AS score1,
        MAX(CASE WHEN rn = 2 THEN fpts END) AS score2,
        MAX(CASE WHEN rn = 3 THEN fpts END) AS score3,
        SUM(CASE WHEN fpts >= ? THEN 1 ELSE 0 END) AS boom_games
      FROM g
      GROUP BY player_key
    `, [...keys, ...seasonRange.params, BOOM_POINTS]);
    const stats = new Map(statsRows.map(r => [r.player_key, r]));

    const pairs = [...new Map(
      slate.filter(p => p.opponent).map(p => [`${p.key}|${p.opponent}`, [p.key, p.opponent]])
    ).values()];
    const matchups = new Map();
    if (pairs.length > 0) {
      const range = this.dateFilter('h.game_date', window);
      const rows = await db.all(`
        WITH pairs(player_key, opponent) AS (${valuesSql(pairs, 2)})
        SELECT h.player_key, h.opponent, COUNT(*) AS games_vs, AVG(h.${col}) AS avg_vs, MAX(h.${col}) AS best_vs
        FROM historical_games h
        JOIN pairs p ON p.player_key = h.player_key AND p.opponent = h.opponent
        WHERE h.minutes > 0 AND h.${col} IS NOT NULL${range.sql}
        GROUP BY h.player_key, h.opponent
      `, [...pairs.flat(), ...range.params]);
      for (const r of rows) matchups.set(`${r.player_key}|${r.opponent}`, r);
    }

    const insights = {
      hotStreaks: [],
      coldStreaks: [],
      matchupAdvantages: [],
      consistentPlays: [],
      boomCandidates: [],
      recentPerformers: [],
    };

    for (const player of slate) {
      const s = stats.get(player.key);
      if (!s || s.games < SLATE_MIN_GAMES || !(s.season_avg > 0)) continue;
      const m = player.opponent ? matchups.get(`${player.key}|${player.opponent}`) : null;
      const sd = stdDev(s.variance);
      const cv = sd / s.season_avg;
      const streakPct = ((s.last3_avg - s.season_avg) / s.season_avg) * 100;

      const row = {
        name: player.name,
        team: player.team,
        opponent: player.opponent,
        salary: player.salary,
        projection: player.projection,
        games: s.games,
        seasonAvg: round1(s.season_avg),
        last3Avg: round1(s.last3_avg),
        last3Scores: [s.score1, s.score2, s.score3].filter(v => v !== null && v !== undefined).join(','),
        floor: round1(s.floor),
        ceiling: round1(s.ceiling),
        stdDev: round1(sd),
        hotStreakPct: round1(streakPct),
        matchupGames: m?.games_vs || 0,
        matchupAvg: m ? round1(m.avg_vs) : null,
        matchupBest: m ? round1(m.best_vs) : null,
      };

      const streaky = s.season_avg >= minAvg;
      if (streaky && streakPct >= STREAK_THRESHOLD_PCT) {
        insights.hotStreaks.push({ ...row, reason: `+${Math.round(streakPct)}% above season avg` });
      }
      if (streaky && streakPct <= -STREAK_THRESHOLD_PCT) {
        insights.coldStreaks.push({ ...row, reason: `${Math.round(streakPct)}% below season avg` });
      }
      if (m && m.games_vs >= 1 && m.avg_vs > s.season_avg * MATCHUP_EDGE) {
        insights.matchupAdvantages.push({
          ...row,
          reason: `Avg ${round1(m.avg_vs)} vs ${player.opponent} (${m.games_vs} games)`
        });
      }
      if (cv < CONSISTENT_MAX_CV && s.games >= CONSISTENT_MIN_GAMES) {
        insights.consistentPlays.push({
          ...row,
          consistencyScore: consistencyScore(sd, s.season_avg),
          reason: `Low variance (${round1(sd)} std dev)`
        });
      }
      if (sd > BOOM_MIN_SD && s.ceiling >= BOOM_POINTS) {
        insights.boomCandidates.push({
          ...row,
          boomRate: round1((s.boom_games / s.games) * 100),
          reason: `High ceiling (${Math.round(s.ceiling)} max), ${round1(sd)} std dev`
        });
      }
      if (s.last3_avg >= RECENT_MIN_LAST3) {
        insights.recentPerformers.push({ ...row, reason: `${round1(s.last3_avg)} avg last 3 games` });
      }
    }

    insights.hotStreaks.sort((a, b) => b.hotStreakPct - a.hotStreakPct);
    insights.coldStreaks.sort((a, b) => a.hotStreakPct - b.hotStreakPct);
    insights.matchupAdvantages.sort((a, b) => (b.matchupAvg || 0) - (a.matchupAvg || 0));
    insights.consistentPlays.sort((a, b) => b.consistencyScore - a.consistencyScore);
    insights.boomCandidates.sort((a, b) => b.ceiling - a.ceiling);
    insights.recentPerformers.sort((a, b) => b.last3Avg - a.last3Avg);
    for (const card of Object.keys(insights)) {
      insights[card] = insights[card].slice(0, SLATE_CARD_LIMIT);
    }
    return insights;
  }

  /**
   * Regulars (minGames+ games, minAvg+ points in the window) of the slate's
   * teams who are not on the slate. A player counts for the team he last
   * played for in the window, so traded players are not "missing".
   */
  async findMissingRegulars(slate, window, col, minGames, minAvg) {
    const teams = [...new Set(slate.map(p => p.team))];
    const range = this.dateFilter('game_date', window);
    const rows = await db.all(`
      WITH g AS (
        SELECT player_key, player_name, team, game_date, minutes, ${col} AS fpts,
          ROW_NUMBER() OVER (PARTITION BY player_key ORDER BY game_date DESC) AS rn
        FROM historical_games
        WHERE minutes > 0 AND ${col} IS NOT NULL${range.sql}
      ),
      latest AS (SELECT player_key, team, player_name FROM g WHERE rn = 1)
      SELECT g.team, g.player_key, MAX(l.player_name) AS player_name,
        COUNT(*) AS games, AVG(g.fpts) AS avg_fpts, AVG(g.minutes) AS avg_min, MAX(g.game_date) AS last_game
      FROM g
      JOIN latest l ON l.player_key = g.player_key AND l.team = g.team
      WHERE g.team IN (${placeholders(teams.length)})
      GROUP BY g.team, g.player_key
      HAVING COUNT(*) >= ? AND AVG(g.fpts) >= ?
      ORDER BY AVG(g.fpts) DESC, g.player_key
    `, [...range.params, ...teams, minGames, minAvg]);

    const onSlate = new Set(slate.map(p => p.key));
    return rows.filter(r => !onSlate.has(r.player_key));
  }

  async getMissingPlayersReport(players, { minGames = 5, minAvgDk = 20, site, ...windowOpts } = {}) {
    const slate = normalizeSlatePlayers(players);
    const window = await this.resolveWindow(windowOpts, { defaultLastNDays: 30 });
    const missing = await this.findMissingRegulars(slate, window, this.pointsColumn(site), minGames, minAvgDk);

    const report = [];
    for (const team of new Set(slate.map(p => p.team))) {
      const teamMissing = missing.filter(m => m.team === team);
      if (teamMissing.length === 0) continue;
      report.push({
        team,
        slatePlayerCount: slate.filter(p => p.team === team).length,
        missingPlayers: teamMissing.map(p => ({
          name: p.player_name,
          avgDk: round1(p.avg_fpts),
          avgMin: round1(p.avg_min),
          games: p.games,
          lastGame: toDateString(p.last_game),
        })),
      });
    }
    const total = (t) => t.missingPlayers.reduce((sum, p) => sum + p.avgDk, 0);
    return report.sort((a, b) => total(b) - total(a));
  }

  /**
   * Usage bumps: for each missing regular, how the slate teammates scored in
   * the team's games he missed vs games he played, while he was on the team,
   * season to date (through the window's end). Two queries total.
   */
  async detectUsageBumps(players, { minGames = 8, minAvgDk = 25, site, ...windowOpts } = {}) {
    const slate = normalizeSlatePlayers(players);
    const window = await this.resolveWindow(windowOpts, { defaultLastNDays: 30 });
    const col = this.pointsColumn(site);
    const missing = await this.findMissingRegulars(slate, window, col, minGames, minAvgDk);
    if (missing.length === 0) return [];

    const season = { startDate: window.seasonStartDate, endDate: window.endDate };
    const range = this.dateFilter('game_date', season);
    const missingRows = missing.map(m => [m.player_key, m.team]);
    const slateRows = [...new Map(slate.map(p => [`${p.key}|${p.team}`, [p.key, p.team]])).values()];

    const rows = await db.all(`
      WITH missing(player_key, team) AS (${valuesSql(missingRows, 2)}),
      slate(player_key, team) AS (${valuesSql(slateRows, 2)}),
      roster AS (
        SELECT m.player_key, m.team, MIN(a.game_date) AS first_date, MAX(a.game_date) AS last_date
        FROM missing m
        JOIN (
          SELECT player_key, team, game_date FROM historical_games WHERE 1 = 1${range.sql}
          UNION ALL
          SELECT player_key, team, game_date FROM game_player_status WHERE 1 = 1${range.sql}
        ) a ON a.player_key = m.player_key AND a.team = m.team
        GROUP BY m.player_key, m.team
      ),
      team_games AS (
        SELECT r.player_key AS missing_key, r.team, t.game_id,
          CASE WHEN EXISTS (
            SELECT 1 FROM historical_games p
            WHERE p.game_id = t.game_id AND p.player_key = r.player_key AND p.minutes > 0
          ) THEN 1 ELSE 0 END AS played,
          CASE WHEN EXISTS (
            SELECT 1 FROM game_player_status s
            WHERE s.game_id = t.game_id AND s.player_key = r.player_key AND s.status = 'DNP'
          ) OR EXISTS (
            SELECT 1 FROM historical_games z
            WHERE z.game_id = t.game_id AND z.player_key = r.player_key AND COALESCE(z.minutes, 0) = 0
          ) THEN 1 ELSE 0 END AS dnp
        FROM roster r
        JOIN team_game_stats t ON t.team = r.team AND t.game_date >= r.first_date AND t.game_date <= r.last_date
      )
      SELECT l.missing_key, l.team, h.player_key,
        SUM(CASE WHEN l.played = 0 THEN 1 ELSE 0 END) AS games_without,
        SUM(CASE WHEN l.played = 0 AND l.dnp = 1 THEN 1 ELSE 0 END) AS games_without_dnp,
        SUM(l.played) AS games_with,
        AVG(CASE WHEN l.played = 0 THEN h.${col} END) AS avg_without,
        AVG(CASE WHEN l.played = 1 THEN h.${col} END) AS avg_with,
        AVG(CASE WHEN l.played = 0 THEN h.minutes END) AS min_without,
        AVG(CASE WHEN l.played = 1 THEN h.minutes END) AS min_with
      FROM team_games l
      JOIN historical_games h ON h.game_id = l.game_id AND h.team = l.team
      JOIN slate sl ON sl.player_key = h.player_key AND sl.team = h.team
      WHERE h.minutes > 0 AND h.${col} IS NOT NULL AND h.player_key <> l.missing_key
      GROUP BY l.missing_key, l.team, h.player_key
    `, [...missingRows.flat(), ...slateRows.flat(), ...range.params, ...range.params]);

    const missingByKey = new Map(missing.map(m => [`${m.player_key}|${m.team}`, m]));
    const slateByKey = new Map(slate.map(p => [`${p.key}|${p.team}`, p]));
    const best = new Map();

    for (const r of rows) {
      if (r.games_without < BUMP_MIN_GAMES_WITHOUT || r.games_with < BUMP_MIN_GAMES_WITH) continue;
      if (!(r.avg_with > 0) || r.avg_without === null) continue;
      const pctBump = ((r.avg_without - r.avg_with) / r.avg_with) * 100;
      if (pctBump < BUMP_MIN_PCT) continue;

      const player = slateByKey.get(`${r.player_key}|${r.team}`);
      const out = missingByKey.get(`${r.missing_key}|${r.team}`);
      const dkBump = r.avg_without - r.avg_with;
      const projection = player.projection || 0;
      const bumpedProjection = projection > 0
        ? round1(projection * (1 + pctBump / 100))
        : round1(r.avg_without);
      const salary = player.salary || 0;
      const sampleSize = r.games_without + r.games_with;
      const gamesWithoutDnp = r.games_without_dnp;
      const absenceReason = gamesWithoutDnp === r.games_without ? 'DNP-CD' : gamesWithoutDnp === 0 ? 'OUT' : 'MIXED';

      const bump = {
        player: player.name,
        team: r.team,
        position: player.position,
        opponent: player.opponent,
        salary,
        projection,
        projectedMinutes: player.projectedMinutes,
        bumpedProjection,
        valueScore: salary > 0 ? round1((bumpedProjection / salary) * 1000) : 0,
        missingPlayer: out.player_name,
        missingPlayerAvg: round1(out.avg_fpts),
        gamesWithout: r.games_without,
        gamesWith: r.games_with,
        gamesWithoutDnp,
        gamesWithoutOut: r.games_without - gamesWithoutDnp,
        absenceReason,
        avgWithout: round1(r.avg_without),
        avgWith: round1(r.avg_with),
        avgMinWithout: round1(r.min_without || 0),
        avgMinWith: round1(r.min_with || 0),
        dkBump: round1(dkBump),
        pctBump: round1(pctBump),
        minBump: round1((r.min_without || 0) - (r.min_with || 0)),
        confidence: sampleSize >= 20 ? 'High' : sampleSize >= 10 ? 'Medium' : 'Low',
        reason: `+${round1(dkBump)} pts (+${Math.round(pctBump)}%) when ${out.player_name} is OUT`,
      };

      // Keep the biggest bump per slate player
      const key = `${r.player_key}|${r.team}`;
      if (!best.has(key) || bump.pctBump > best.get(key).pctBump) best.set(key, bump);
    }

    // Players with projected minutes first, then value, then bump size
    return [...best.values()]
      .sort((a, b) => {
        const aMin = a.projectedMinutes || 0;
        const bMin = b.projectedMinutes || 0;
        if (aMin !== bMin && (aMin === 0 || bMin === 0)) return bMin - aMin;
        if (a.valueScore !== b.valueScore) return b.valueScore - a.valueScore;
        return b.pctBump - a.pctBump;
      })
      .slice(0, BUMP_LIMIT);
  }
}

export default new InsightsService();
