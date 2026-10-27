/**
 * ESPN BOX SCORE SERVICE
 *
 * Canonical source for historical_games (stats.nba.com is unreachable from
 * our network). Per date, the scoreboard lists games; each completed game's
 * summary has the full box score:
 *
 *   scoreboard: site.api.espn.com/.../scoreboard?dates=YYYYMMDD
 *     events[].season.type: 1 preseason, 2 regular, 3 playoffs, 5 play-in
 *     events[].competitions[0].type.abbreviation 'ALLSTAR' for All-Star games
 *     event dates are UTC, so game_date is the queried (US) date
 *   summary: site.web.api.espn.com/.../summary?event=<id>
 *     boxscore.players[].statistics[0]: keys[] + athletes[] (stats[] aligned
 *       to keys, "m-a" shooting, integer minutes) + totals[]
 *     boxscore.teams[].statistics: totalTurnovers includes team turnovers
 *     header.competitions[0].competitors[].linescores: one per period
 *
 * Each game writes historical_games (one row per player who played, upserted
 * on (player_key, game_date)), game_player_status (DNP / inactive players)
 * and team_game_stats. team_game_stats is written last, so a game with both
 * team rows is fully loaded and is skipped on resume.
 */

import axios from 'axios';
import db, { DATABASE_TYPE } from '../config/database.js';
import nbaStatsService from './nbaStatsService.js';
import { computeFantasyPoints } from './scoring.js';
import { seasonForDate, seasonStartDate, seasonEndYear } from '../utils/season.js';
import { playerKey, canonicalTeam } from '../utils/playerKey.js';

const SCOREBOARD_URL = 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard';
const SUMMARY_URL = 'https://site.web.api.espn.com/apis/site/v2/sports/basketball/nba/summary';

const SEASON_TYPES = { 2: 'regular', 3: 'playoffs', 5: 'play-in' };
const NBA_TEAMS = new Set(Object.values(nbaStatsService.teamAbbreviations));

// Last date walked for a season (the Finals end in mid June)
const SEASON_LAST_DAY = '06-30';

const round = (n, places) => Math.round(n * 10 ** places) / 10 ** places;
const pct = (made, attempted) => (attempted > 0 ? round(made / attempted, 3) : null);

function toInt(value) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : 0;
}

function madeAttempted(value) {
  const [made, attempted] = String(value ?? '').split('-');
  return [toInt(made), toInt(attempted)];
}

/** Box score columns by ESPN key, from one stats array aligned to `keys` */
function statLine(keys, values) {
  const get = key => values[keys.indexOf(key)];
  const [fgm, fga] = madeAttempted(get('fieldGoalsMade-fieldGoalsAttempted'));
  const [fg3m, fg3a] = madeAttempted(get('threePointFieldGoalsMade-threePointFieldGoalsAttempted'));
  const [ftm, fta] = madeAttempted(get('freeThrowsMade-freeThrowsAttempted'));
  return {
    minutes: nbaStatsService.parseMinutes(get('minutes')),
    points: toInt(get('points')),
    fgm, fga, fg3m, fg3a, ftm, fta,
    rebounds: toInt(get('rebounds')),
    assists: toInt(get('assists')),
    turnovers: toInt(get('turnovers')),
    steals: toInt(get('steals')),
    blocks: toInt(get('blocks')),
    oreb: toInt(get('offensiveRebounds')),
    dreb: toInt(get('defensiveRebounds')),
    fouls: toInt(get('fouls')),
    plus_minus: toInt(get('plusMinus')),
  };
}

function sumLines(lines) {
  const sum = {};
  for (const line of lines) {
    for (const [key, value] of Object.entries(line)) sum[key] = (sum[key] || 0) + value;
  }
  return sum;
}

const toDateParam = date => date.replace(/-/g, '');

function addDays(date, days) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

function localDate(date) {
  const pad = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Azure SQL returns DATE columns as Date objects */
const dateString = value => (value instanceof Date ? value.toISOString().slice(0, 10) : value ?? null);

/**
 * Completed regular-season, play-in and playoff games between two NBA teams
 * from a scoreboard response. `date` (YYYY-MM-DD) is the date queried.
 */
export function parseScoreboard(scoreboard, date) {
  const games = [];
  for (const event of scoreboard?.events || []) {
    const competition = event.competitions?.[0];
    const seasonType = SEASON_TYPES[event.season?.type];
    const completed = event.status?.type?.completed ?? competition?.status?.type?.completed;
    if (!competition || !seasonType || !completed) continue;
    if (competition.type?.abbreviation === 'ALLSTAR') continue;

    const team = side => canonicalTeam(competition.competitors?.find(c => c.homeAway === side)?.team?.abbreviation);
    const home = team('home');
    const away = team('away');
    if (!NBA_TEAMS.has(home) || !NBA_TEAMS.has(away)) continue;

    games.push({
      game_id: String(event.id),
      game_date: date,
      season: seasonForDate(date),
      season_type: seasonType,
      home_team: home,
      away_team: away,
    });
  }
  return games;
}

/**
 * Vegas lines per team from a summary's pickcenter (the sportsbook's line as
 * of tip-off): Map(team -> { vegas_implied_total, vegas_spread, over_under }).
 * pickcenter spread is the home team's; each team gets its own (favorite
 * negative). Empty when the game has no line.
 */
export function parseGameOdds(summary, game) {
  const odds = new Map();
  const line = (summary?.pickcenter || []).find(p => p?.spread != null && p?.overUnder != null
    && Number.isFinite(Number(p.spread)) && Number.isFinite(Number(p.overUnder)));
  if (!line) return odds;
  const spread = Number(line.spread);
  const total = Number(line.overUnder);
  odds.set(game.home_team, { vegas_implied_total: (total - spread) / 2, vegas_spread: spread, over_under: total });
  odds.set(game.away_team, { vegas_implied_total: (total + spread) / 2, vegas_spread: spread === 0 ? 0 : -spread, over_under: total });
  return odds;
}

/**
 * historical_games rows, game_player_status rows and team_game_stats rows
 * from a summary response. `game` is the scoreboard entry for the event.
 */
export function parseSummary(summary, game) {
  const box = summary?.boxscore;
  if (!box?.players?.length) throw new Error(`No box score for game ${game.game_id}`);

  const competitors = summary.header?.competitions?.[0]?.competitors || [];
  const periods = Math.max(4, ...competitors.map(c => c.linescores?.length || 0));
  const teamMinutes = 240 + 25 * (periods - 4);

  const season = seasonForDate(game.game_date);
  const base = { game_id: game.game_id, game_date: game.game_date };
  const teamCodes = box.players.map(t => canonicalTeam(t.team?.abbreviation));
  const homeAway = Object.fromEntries((box.teams || []).map(t => [canonicalTeam(t.team?.abbreviation), t.homeAway]));
  const isHome = team => (homeAway[team] ? homeAway[team] === 'home' : team === game.home_team) ? 1 : 0;
  const finalScore = Object.fromEntries(competitors.map(c => [canonicalTeam(c.team?.abbreviation), toInt(c.score)]));

  const players = [];
  const statuses = [];
  const teams = [];

  box.players.forEach((teamBox, i) => {
    const team = teamCodes[i];
    const opponent = teamCodes[1 - i];
    const { keys = [], athletes = [], totals = [] } = teamBox.statistics?.[0] || {};

    const lines = [];
    for (const entry of athletes) {
      const name = entry.athlete?.displayName;
      if (!name) continue;
      const espnPlayerId = entry.athlete.id != null ? String(entry.athlete.id) : null;

      if (entry.didNotPlay || !entry.stats?.length) {
        const reason = entry.reason || null;
        statuses.push({
          ...base, team, player_key: playerKey(name), player_name: name, espn_player_id: espnPlayerId,
          status: !reason || /coach/i.test(reason) ? 'DNP' : 'INACTIVE',
          reason,
        });
        continue;
      }

      const s = statLine(keys, entry.stats);
      lines.push(s);
      const row = {
        ...base, season, season_type: game.season_type,
        player_id: null,
        espn_player_id: espnPlayerId,
        player_name: name,
        player_key: playerKey(name),
        position: entry.athlete.position?.abbreviation || null,
        is_starter: entry.starter ? 1 : 0,
        team, opponent, is_home: isHome(team),
        minutes: s.minutes,
        points: s.points, rebounds: s.rebounds, assists: s.assists,
        steals: s.steals, blocks: s.blocks, turnovers: s.turnovers, fouls: s.fouls,
        fg_made: s.fgm, fg_attempted: s.fga, fg_pct: pct(s.fgm, s.fga),
        fg3_made: s.fg3m, fg3_attempted: s.fg3a, fg3_pct: pct(s.fg3m, s.fg3a),
        ft_made: s.ftm, ft_attempted: s.fta, ft_pct: pct(s.ftm, s.fta),
        oreb: s.oreb, dreb: s.dreb, plus_minus: s.plus_minus,
        ts_pct: pct(s.points, 2 * (s.fga + 0.44 * s.fta)),
        efg_pct: pct(s.fgm + 0.5 * s.fg3m, s.fga),
      };
      row.dk_fantasy_points = computeFantasyPoints(row, 'draftkings');
      row.fd_fantasy_points = computeFantasyPoints(row, 'fanduel');
      row.yahoo_fantasy_points = computeFantasyPoints(row, 'yahoo');
      players.push(row);
    }

    // ESPN's totals are occasionally wrong (and occasionally a player line is
    // missing); trust whichever matches the final score, preferring totals
    let t = statLine(keys, totals);
    const summed = sumLines(lines);
    if (t.points !== finalScore[team] && summed.points === finalScore[team]) t = summed;
    const teamStats = (box.teams || []).find(bt => canonicalTeam(bt.team?.abbreviation) === team)?.statistics || [];
    const totalTurnovers = teamStats.find(st => st.name === 'totalTurnovers')?.displayValue;
    const tov = totalTurnovers != null ? toInt(totalTurnovers) : t.turnovers;
    teams.push({
      ...base, season, season_type: game.season_type,
      team, opponent, is_home: isHome(team),
      minutes: teamMinutes,
      pts: t.points, fgm: t.fgm, fga: t.fga, fg3m: t.fg3m, fg3a: t.fg3a, ftm: t.ftm, fta: t.fta,
      oreb: t.oreb, dreb: t.dreb, ast: t.assists, tov, stl: t.steals, blk: t.blocks, pf: t.fouls,
      possessions: round(t.fga - t.oreb + tov + 0.44 * t.fta, 1),
    });
  });

  return { players, statuses, teams };
}

const PLAYER_EXTRA_COLUMNS = ['espn_player_id', 'is_starter', 'ts_pct', 'efg_pct', 'season_type'];
const TEAM_COLUMNS = ['game_id', 'game_date', 'season', 'season_type', 'team', 'opponent', 'is_home', 'minutes',
  'pts', 'fgm', 'fga', 'fg3m', 'fg3a', 'ftm', 'fta', 'oreb', 'dreb', 'ast', 'tov', 'stl', 'blk', 'pf', 'possessions'];
const STATUS_COLUMNS = ['game_id', 'game_date', 'team', 'player_key', 'player_name', 'espn_player_id', 'status', 'reason'];

const insertSql = (table, columns) =>
  `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(c => `@${c}`).join(', ')})`;

const pick = (row, columns) => Object.fromEntries(columns.map(c => [c, row[c] ?? null]));

class EspnBoxScoreService {
  constructor() {
    // Polite rate limiting: minimum ms between any two ESPN requests
    this.requestDelay = Number(process.env.ESPN_REQUEST_DELAY_MS) || 400;
    this.maxRetries = 3;
    this.retryBaseDelay = 1000;
    this.timeout = 20000;
    this.lastRequestAt = 0;
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * GET with rate limiting and exponential backoff on network errors, 429
   * and 5xx. Other HTTP errors (404, ...) fail immediately.
   */
  async request(url, params) {
    for (let attempt = 0; ; attempt++) {
      const wait = this.lastRequestAt + this.requestDelay - Date.now();
      if (wait > 0) await this.sleep(wait);
      this.lastRequestAt = Date.now();
      try {
        const response = await axios.get(url, {
          params,
          timeout: this.timeout,
          headers: { 'User-Agent': 'Mozilla/5.0 (NBA DFS Optimizer)', Accept: 'application/json' },
        });
        return response.data;
      } catch (error) {
        const status = error.response?.status;
        const retryable = !status || status === 429 || status >= 500;
        if (!retryable || attempt >= this.maxRetries) {
          throw new Error(`ESPN ${status ? `HTTP ${status}` : error.message} for ${url} ${JSON.stringify(params)}`);
        }
        const backoff = this.retryBaseDelay * 2 ** attempt;
        console.warn(`⚠️ ESPN ${status || error.message}, retry ${attempt + 1}/${this.maxRetries} in ${backoff}ms`);
        await this.sleep(backoff);
      }
    }
  }

  async fetchScoreboard(date) {
    return parseScoreboard(await this.request(SCOREBOARD_URL, { dates: toDateParam(date) }), date);
  }

  async fetchGame(game) {
    return parseSummary(await this.request(SUMMARY_URL, { event: game.game_id }), game);
  }

  /** Vegas lines for every completed game on a date: Map(team -> parseGameOdds values). */
  async fetchOdds(date) {
    const odds = new Map();
    for (const game of await this.fetchScoreboard(date)) {
      const summary = await this.request(SUMMARY_URL, { event: game.game_id });
      for (const [team, line] of parseGameOdds(summary, game)) odds.set(team, line);
    }
    return odds;
  }

  /** game_ids among `gameIds` with both team_game_stats rows stored */
  async loadedGameIds(gameIds) {
    if (gameIds.length === 0) return new Set();
    const rows = await db.all(
      `SELECT game_id FROM team_game_stats WHERE game_id IN (${gameIds.map(() => '?').join(', ')})
       GROUP BY game_id HAVING COUNT(*) >= 2`,
      gameIds);
    return new Set(rows.map(r => String(r.game_id)));
  }

  /**
   * Write one parsed game. Rest days are measured against each player's
   * previous stored game (any source), so walk dates oldest first.
   * Returns the number of historical_games rows written.
   */
  async saveGame({ players, statuses, teams }) {
    const playerParams = [];
    for (const row of players) {
      const previous = await nbaStatsService.getPreviousGameDate(row.player_name, row.game_date);
      const [withRest] = nbaStatsService.calculateRestDays([{ ...row }], previous);
      playerParams.push({ ...nbaStatsService.toInsertParams(withRest), ...pick(row, PLAYER_EXTRA_COLUMNS) });
    }

    const columns = Object.keys(playerParams[0] || {});
    const updateSql = `UPDATE historical_games SET ${columns.filter(c => c !== 'player_key' && c !== 'game_date').map(c => `${c} = @${c}`).join(', ')}
      WHERE player_key = @player_key AND game_date = @game_date`;
    // Another source may have stored the same player-game twice under different spellings
    const dedupeSql = `DELETE FROM historical_games WHERE player_key = @player_key AND game_date = @game_date
      AND id <> (SELECT MIN(id) FROM historical_games WHERE player_key = @player_key AND game_date = @game_date)`;
    const playerInsertSql = insertSql('historical_games', columns);
    const gameId = { game_id: teams[0]?.game_id ?? players[0]?.game_id };

    const steps = [
      ...playerParams.map(params => ({ upsert: true, params })),
      { sql: 'DELETE FROM game_player_status WHERE game_id = @game_id', params: gameId },
      ...statuses.map(s => ({ sql: insertSql('game_player_status', STATUS_COLUMNS), params: pick(s, STATUS_COLUMNS) })),
      // Last: both team rows present marks the game fully loaded
      { sql: 'DELETE FROM team_game_stats WHERE game_id = @game_id', params: gameId },
      ...teams.map(t => ({ sql: insertSql('team_game_stats', TEAM_COLUMNS), params: pick(t, TEAM_COLUMNS) })),
    ];

    if (DATABASE_TYPE === 'azuresql') {
      for (const step of steps) {
        if (!step.upsert) {
          await db.run(step.sql, step.params);
          continue;
        }
        const keyParams = { player_key: step.params.player_key, game_date: step.params.game_date };
        await db.run(dedupeSql, keyParams);
        const { changes } = await db.run(updateSql, step.params);
        if (!changes) await db.run(playerInsertSql, step.params);
      }
    } else {
      const sqlite = db.sqliteDb;
      const write = db.transaction(() => {
        for (const step of steps) {
          if (!step.upsert) {
            sqlite.prepare(step.sql).run(step.params);
            continue;
          }
          const keyParams = { player_key: step.params.player_key, game_date: step.params.game_date };
          sqlite.prepare(dedupeSql).run(keyParams);
          if (!sqlite.prepare(updateSql).run(step.params).changes) {
            sqlite.prepare(playerInsertSql).run(step.params);
          }
        }
      });
      write();
    }

    return playerParams.length;
  }

  /**
   * Load every game from `start` through `end` (YYYY-MM-DD, inclusive).
   * options.skipLoaded (default true): skip games already fully loaded.
   * Failed dates/games are collected in `failed` and the walk continues.
   */
  async syncDates(start, end, { skipLoaded = true, onProgress = null } = {}) {
    const startTime = Date.now();
    const dates = [];
    for (let d = start; d <= end; d = addDays(d, 1)) dates.push(d);

    const result = { dates: dates.length, games: 0, rows: 0, skipped: 0, failed: [] };
    console.log(`\n🏀 ESPN box scores ${start} → ${end} (${dates.length} dates, ${this.requestDelay}ms between requests)`);

    for (const [i, date] of dates.entries()) {
      let games = [];
      try {
        games = await this.fetchScoreboard(date);
      } catch (error) {
        console.error(`❌ ${date} scoreboard: ${error.message}`);
        result.failed.push({ game_date: date, game_id: null, error: error.message });
      }

      const loaded = skipLoaded ? await this.loadedGameIds(games.map(g => g.game_id)) : new Set();
      let dateRows = 0;
      for (const game of games) {
        if (loaded.has(game.game_id)) {
          result.skipped++;
          continue;
        }
        try {
          const rows = await this.saveGame(await this.fetchGame(game));
          result.games++;
          result.rows += rows;
          dateRows += rows;
        } catch (error) {
          console.error(`❌ ${date} game ${game.game_id} (${game.away_team} @ ${game.home_team}): ${error.message}`);
          result.failed.push({ game_date: date, game_id: game.game_id, error: error.message });
        }
      }
      if (games.length > 0) {
        console.log(`📅 ${date}: ${games.length} games, ${games.length - loaded.size} fetched, ${dateRows} player rows`);
      }

      onProgress?.({
        date,
        datesProcessed: i + 1,
        totalDates: dates.length,
        games: result.games,
        rows: result.rows,
        skipped: result.skipped,
        failed: result.failed.length,
      });
    }

    result.elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`✅ ESPN ${start} → ${end}: ${result.games} games, ${result.rows} rows, ${result.skipped} skipped, ${result.failed.length} failed in ${result.elapsed}s`);
    return result;
  }

  /**
   * [first, last] dates to walk for a season: opening night through June 30,
   * capped at yesterday. Null if the season has no completed dates yet.
   */
  seasonDateRange(season, now = new Date()) {
    const start = seasonStartDate(season);
    const seasonEnd = `${seasonEndYear(season)}-${SEASON_LAST_DAY}`;
    const yesterday = addDays(localDate(now), -1);
    const end = seasonEnd < yesterday ? seasonEnd : yesterday;
    return start <= end ? [start, end] : null;
  }

  /**
   * Load a season. options.resumeFromLatest starts at the latest loaded
   * date in the season instead of opening night (quick incremental sync).
   */
  async syncSeason(season, { resumeFromLatest = false, now = new Date(), ...options } = {}) {
    const range = this.seasonDateRange(season, now);
    if (!range) return { dates: 0, games: 0, rows: 0, skipped: 0, failed: [], elapsed: '0.0' };
    let [start, end] = range;
    if (resumeFromLatest && options.skipLoaded !== false) {
      const latest = await this.latestLoadedDate(season);
      if (latest && latest > start) start = latest < end ? latest : end;
    }
    return this.syncDates(start, end, options);
  }

  async latestLoadedDate(season) {
    const row = await db.get(`SELECT MAX(game_date) AS latest FROM team_game_stats WHERE season = ?`, season);
    return dateString(row?.latest);
  }

  /** ESPN load status for GET /api/historical/status */
  async getStatus() {
    const row = await db.get(`
      SELECT COUNT(DISTINCT game_id) AS loadedGames, MIN(game_date) AS earliestGameDate, MAX(game_date) AS latestGameDate
      FROM team_game_stats
    `);
    return {
      source: 'espn',
      loadedGames: row?.loadedGames || 0,
      earliestGameDate: dateString(row?.earliestGameDate),
      latestGameDate: dateString(row?.latestGameDate),
    };
  }
}

export default new EspnBoxScoreService();
