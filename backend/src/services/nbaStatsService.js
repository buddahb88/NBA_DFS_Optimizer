/**
 * NBA STATS SERVICE
 *
 * Fetches historical game data from NBA.com stats API
 * Uses concurrent requests with rate limiting to avoid throttling
 * Calculates DraftKings fantasy points from box scores
 */

import axios from 'axios';
import pLimit from 'p-limit';
import db from '../config/database.js';
import { computeFantasyPoints } from './scoring.js';
import { getCurrentSeason, seasonForDate } from '../utils/season.js';
import { playerKey, canonicalTeam } from '../utils/playerKey.js';

const DATABASE_TYPE = process.env.DATABASE_TYPE || 'sqlite';

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

/**
 * Turn a stats.nba.com resultSet ({ headers, rowSet }) into row objects
 */
function resultSetRows(resultSet) {
  if (!resultSet?.headers || !resultSet?.rowSet) return [];
  return resultSet.rowSet.map(row => {
    const obj = {};
    resultSet.headers.forEach((header, i) => {
      obj[header] = row[i];
    });
    return obj;
  });
}

class NBAStatsService {
  constructor() {
    // NBA.com stats API endpoints
    this.baseUrl = 'https://stats.nba.com/stats';

    // Headers required by NBA.com API
    this.headers = {
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
      'Host': 'stats.nba.com',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Referer': 'https://www.nba.com/',
      'Origin': 'https://www.nba.com',
      'Connection': 'keep-alive',
      'x-nba-stats-origin': 'stats',
      'x-nba-stats-token': 'true'
    };

    // Rate limiting: 1 concurrent request, 1.5s delay between requests (NBA.com is strict)
    this.concurrencyLimit = pLimit(1);
    this.requestDelay = 1500;

    // Team abbreviation mappings
    this.teamAbbreviations = {
      'Atlanta Hawks': 'ATL', 'Boston Celtics': 'BOS', 'Brooklyn Nets': 'BKN',
      'Charlotte Hornets': 'CHA', 'Chicago Bulls': 'CHI', 'Cleveland Cavaliers': 'CLE',
      'Dallas Mavericks': 'DAL', 'Denver Nuggets': 'DEN', 'Detroit Pistons': 'DET',
      'Golden State Warriors': 'GSW', 'Houston Rockets': 'HOU', 'Indiana Pacers': 'IND',
      'LA Clippers': 'LAC', 'Los Angeles Clippers': 'LAC', 'Los Angeles Lakers': 'LAL',
      'LA Lakers': 'LAL', 'Memphis Grizzlies': 'MEM', 'Miami Heat': 'MIA',
      'Milwaukee Bucks': 'MIL', 'Minnesota Timberwolves': 'MIN', 'New Orleans Pelicans': 'NOP',
      'New York Knicks': 'NYK', 'Oklahoma City Thunder': 'OKC', 'Orlando Magic': 'ORL',
      'Philadelphia 76ers': 'PHI', 'Phoenix Suns': 'PHX', 'Portland Trail Blazers': 'POR',
      'Sacramento Kings': 'SAC', 'San Antonio Spurs': 'SAS', 'Toronto Raptors': 'TOR',
      'Utah Jazz': 'UTA', 'Washington Wizards': 'WAS'
    };
  }

  /**
   * Normalize a name to its player_key (see utils/playerKey.js)
   * e.g., "Luka Dončić" → "luka doncic", "Jaren Jackson Jr." → "jaren jackson"
   */
  normalizeName(name) {
    return playerKey(name);
  }

  /**
   * Calculate DraftKings fantasy points from box score stats
   */
  calculateDKFantasyPoints(stats) {
    const points = (stats.points || 0) * 1;
    const fg3m = (stats.fg3_made || 0) * 0.5;
    const rebounds = (stats.rebounds || 0) * 1.25;
    const assists = (stats.assists || 0) * 1.5;
    const steals = (stats.steals || 0) * 2;
    const blocks = (stats.blocks || 0) * 2;
    const turnovers = (stats.turnovers || 0) * -0.5;

    // Double-double and triple-double bonuses
    const categories = [
      stats.points || 0,
      stats.rebounds || 0,
      stats.assists || 0,
      stats.steals || 0,
      stats.blocks || 0
    ];
    const doubleDigits = categories.filter(c => c >= 10).length;

    const ddBonus = doubleDigits >= 2 ? 1.5 : 0;
    const tdBonus = doubleDigits >= 3 ? 3 : 0;

    return Math.round((points + fg3m + rebounds + assists + steals + blocks + turnovers + ddBonus + tdBonus) * 10) / 10;
  }

  /**
   * Parse minutes string "MM:SS" to decimal minutes
   */
  parseMinutes(minStr) {
    if (!minStr) return 0;
    if (typeof minStr === 'number') return minStr;

    const parts = minStr.toString().split(':');
    if (parts.length === 2) {
      return parseInt(parts[0]) + parseInt(parts[1]) / 60;
    }
    return parseFloat(minStr) || 0;
  }

  /**
   * Parse game date from "Apr 11, 2025" (or "APR 11, 2025") to "2025-04-11"
   * without going through UTC, which shifts the day outside US timezones
   */
  parseGameDate(dateStr) {
    if (!dateStr) return null;
    const match = /^([A-Za-z]{3})[A-Za-z]*\.? (\d{1,2}), (\d{4})$/.exec(String(dateStr).trim());
    const month = match && MONTHS[match[1].toLowerCase()];
    if (month) {
      return `${match[3]}-${String(month).padStart(2, '0')}-${match[2].padStart(2, '0')}`;
    }
    try {
      const date = new Date(dateStr);
      if (isNaN(date.getTime())) return dateStr; // Return original if parsing fails
      return date.toISOString().split('T')[0]; // YYYY-MM-DD format
    } catch (e) {
      return dateStr;
    }
  }

  /**
   * Extract opponent from matchup string
   */
  parseMatchup(matchup, teamAbbr) {
    if (!matchup) return { opponent: 'UNK', isHome: false };

    // Format: "PHX @ MEM" or "MEM vs. PHX"
    const isHome = matchup.includes('vs.');
    const parts = matchup.split(isHome ? 'vs.' : '@').map(s => s.trim());

    const opponent = parts.find(p => p !== teamAbbr) || 'UNK';
    return { opponent, isHome };
  }

  /**
   * Fetch every player who appeared in `season`, one league-wide call per
   * season: leaguedashplayerstats gives who played (and games played, used for
   * resume), playerindex adds positions. The team is the player's last team
   * that season; each game's team comes from its own MATCHUP.
   */
  async fetchAllPlayers(season = getCurrentSeason()) {
    console.log(`📋 Fetching NBA player list for ${season}...`);

    try {
      const response = await axios.get(`${this.baseUrl}/leaguedashplayerstats`, {
        headers: this.headers,
        params: {
          LeagueID: '00',
          Season: season,
          SeasonType: 'Regular Season',
          PerMode: 'Totals',
          MeasureType: 'Base',
          LastNGames: 0,
          Month: 0,
          OpponentTeamID: 0,
          PaceAdjust: 'N',
          Period: 0,
          PlusMinus: 'N',
          Rank: 'N'
        },
        timeout: 30000
      });

      const positions = await this.fetchPlayerPositions(season);

      const players = resultSetRows(response.data.resultSets?.[0]).map(p => ({
        id: p.PLAYER_ID,
        name: p.PLAYER_NAME,
        team: canonicalTeam(p.TEAM_ABBREVIATION),
        position: positions.get(p.PLAYER_ID) || null,
        gamesPlayed: p.GP || 0
      })).filter(p => p.gamesPlayed > 0);

      console.log(`✅ Found ${players.length} players with games in ${season}`);
      return players;
    } catch (error) {
      console.error('❌ Error fetching players:', error.message);
      throw error;
    }
  }

  /**
   * Map of PERSON_ID -> position ("G", "F-C", ...) for a season. Positions are
   * nice-to-have, so a failed call returns an empty map instead of throwing.
   */
  async fetchPlayerPositions(season) {
    try {
      const response = await axios.get(`${this.baseUrl}/playerindex`, {
        headers: this.headers,
        params: { LeagueID: '00', Season: season, Historical: 1 },
        timeout: 30000
      });
      const positions = new Map();
      for (const p of resultSetRows(response.data.resultSets?.[0])) {
        if (p.POSITION) positions.set(p.PERSON_ID, p.POSITION);
      }
      return positions;
    } catch (error) {
      console.warn(`⚠️ Could not fetch player positions for ${season}: ${error.message}`);
      return new Map();
    }
  }

  /**
   * Fetch game log for a single player
   */
  async fetchPlayerGameLog(playerId, playerName, season = getCurrentSeason(), retryCount = 0) {
    try {
      const response = await axios.get(`${this.baseUrl}/playergamelog`, {
        headers: this.headers,
        params: {
          PlayerID: playerId,
          Season: season,
          SeasonType: 'Regular Season'
        },
        timeout: 30000 // Increased timeout to 30 seconds
      });

      const data = response.data;
      if (!data.resultSets || !data.resultSets[0]) {
        return [];
      }

      return resultSetRows(data.resultSets[0]).map(game => {
        // Parse matchup to get team and opponent (format: "LAL vs. HOU" or "LAL @ HOU")
        const matchup = game.MATCHUP || '';
        const isHome = matchup.includes('vs.');
        const matchupParts = matchup.split(isHome ? ' vs. ' : ' @ ');
        const team = matchupParts[0] || 'UNK';
        const opponent = matchupParts[1] || 'UNK';

        // Convert date format from "Apr 11, 2025" to "2025-04-11"
        const gameDate = game.GAME_DATE ? this.parseGameDate(game.GAME_DATE) : null;

        const stats = {
          player_id: String(playerId),
          player_name: playerName,
          team: team,
          opponent: opponent,
          game_id: game.Game_ID || game.GAME_ID, // API returns Game_ID (mixed case)
          game_date: gameDate,
          season: season,
          is_home: isHome ? 1 : 0,
          minutes: this.parseMinutes(game.MIN),
          points: game.PTS || 0,
          rebounds: game.REB || 0,
          assists: game.AST || 0,
          steals: game.STL || 0,
          blocks: game.BLK || 0,
          turnovers: game.TOV || 0,
          fouls: game.PF || 0,
          fg_made: game.FGM || 0,
          fg_attempted: game.FGA || 0,
          fg_pct: game.FG_PCT ?? null,
          fg3_made: game.FG3M || 0,
          fg3_attempted: game.FG3A || 0,
          fg3_pct: game.FG3_PCT ?? null,
          ft_made: game.FTM || 0,
          ft_attempted: game.FTA || 0,
          ft_pct: game.FT_PCT ?? null,
          oreb: game.OREB || 0,
          dreb: game.DREB || 0,
          plus_minus: game.PLUS_MINUS || 0
        };

        stats.dk_fantasy_points = this.calculateDKFantasyPoints(stats);
        stats.fd_fantasy_points = computeFantasyPoints(stats, 'fanduel');
        stats.yahoo_fantasy_points = computeFantasyPoints(stats, 'yahoo');

        return stats;
      });
    } catch (error) {
      // Retry on rate limit or timeout (up to 3 retries)
      if (retryCount < 3 && (error.response?.status === 429 || error.code === 'ECONNABORTED' || error.message.includes('timeout'))) {
        const delay = (retryCount + 1) * 2000; // Exponential backoff: 2s, 4s, 6s
        console.warn(`⚠️ Retry ${retryCount + 1}/3 for ${playerName} in ${delay/1000}s...`);
        await this.sleep(delay);
        return this.fetchPlayerGameLog(playerId, playerName, season, retryCount + 1);
      }
      console.error(`❌ Error fetching game log for ${playerName}:`, error.message);
      return [];
    }
  }

  /**
   * Sleep utility for rate limiting
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Named parameters for one historical_games row (shared by both backends)
   */
  toInsertParams(game) {
    return {
      player_id: game.player_id,
      player_name: game.player_name,
      player_key: playerKey(game.player_name),
      team: canonicalTeam(game.team),
      opponent: canonicalTeam(game.opponent),
      position: game.position || null,
      game_id: game.game_id,
      game_date: game.game_date,
      season: game.season,
      is_home: game.is_home,
      minutes: game.minutes,
      points: game.points,
      rebounds: game.rebounds,
      assists: game.assists,
      steals: game.steals,
      blocks: game.blocks,
      turnovers: game.turnovers,
      fouls: game.fouls ?? null,
      fg_made: game.fg_made,
      fg_attempted: game.fg_attempted,
      fg_pct: game.fg_pct ?? null,
      fg3_made: game.fg3_made,
      fg3_attempted: game.fg3_attempted,
      fg3_pct: game.fg3_pct ?? null,
      ft_made: game.ft_made,
      ft_attempted: game.ft_attempted,
      ft_pct: game.ft_pct ?? null,
      oreb: game.oreb,
      dreb: game.dreb,
      plus_minus: game.plus_minus,
      dk_fantasy_points: game.dk_fantasy_points,
      fd_fantasy_points: game.fd_fantasy_points ?? computeFantasyPoints(game, 'fanduel'),
      yahoo_fantasy_points: game.yahoo_fantasy_points ?? computeFantasyPoints(game, 'yahoo'),
      // ?? not ||: 0 rest days (back-to-back) is a real value
      rest_days: game.rest_days ?? null,
      is_back_to_back: game.is_back_to_back || 0
    };
  }

  /**
   * Bulk insert games into database
   */
  async bulkInsertGames(games) {
    if (games.length === 0) return 0;

    let inserted = 0;

    if (DATABASE_TYPE === 'azuresql') {
      // Azure SQL: Use individual MERGE statements (no transactions needed for simple inserts)
      for (const game of games) {
        try {
          await db.run(`
            MERGE INTO historical_games AS target
            USING (SELECT @player_id AS player_id, @game_id AS game_id) AS source
            ON target.player_id = source.player_id AND target.game_id = source.game_id
            WHEN MATCHED THEN
              UPDATE SET
                player_name = @player_name, player_key = @player_key, team = @team, opponent = @opponent, position = @position,
                game_date = @game_date, season = @season, is_home = @is_home,
                minutes = @minutes, points = @points, rebounds = @rebounds, assists = @assists,
                steals = @steals, blocks = @blocks, turnovers = @turnovers, fouls = @fouls,
                fg_made = @fg_made, fg_attempted = @fg_attempted, fg_pct = @fg_pct, fg3_made = @fg3_made,
                fg3_attempted = @fg3_attempted, fg3_pct = @fg3_pct, ft_made = @ft_made, ft_attempted = @ft_attempted, ft_pct = @ft_pct,
                oreb = @oreb, dreb = @dreb, plus_minus = @plus_minus,
                dk_fantasy_points = @dk_fantasy_points, fd_fantasy_points = @fd_fantasy_points,
                yahoo_fantasy_points = @yahoo_fantasy_points, rest_days = @rest_days, is_back_to_back = @is_back_to_back
            WHEN NOT MATCHED THEN
              INSERT (player_id, player_name, player_key, team, opponent, position, game_id, game_date, season, is_home,
                      minutes, points, rebounds, assists, steals, blocks, turnovers, fouls,
                      fg_made, fg_attempted, fg_pct, fg3_made, fg3_attempted, fg3_pct, ft_made, ft_attempted, ft_pct,
                      oreb, dreb, plus_minus, dk_fantasy_points, fd_fantasy_points, yahoo_fantasy_points, rest_days, is_back_to_back)
              VALUES (@player_id, @player_name, @player_key, @team, @opponent, @position, @game_id, @game_date, @season, @is_home,
                      @minutes, @points, @rebounds, @assists, @steals, @blocks, @turnovers, @fouls,
                      @fg_made, @fg_attempted, @fg_pct, @fg3_made, @fg3_attempted, @fg3_pct, @ft_made, @ft_attempted, @ft_pct,
                      @oreb, @dreb, @plus_minus, @dk_fantasy_points, @fd_fantasy_points, @yahoo_fantasy_points, @rest_days, @is_back_to_back);
          `, this.toInsertParams(game));
          inserted++;
        } catch (e) {
          if (inserted === 0) {
            console.error(`❌ Insert error for ${game.player_name}:`, e.message);
          }
        }
      }
    } else {
      // SQLite: Use transaction with prepared statement
      const stmt = db.prepare(`
        INSERT OR REPLACE INTO historical_games (
          player_id, player_name, player_key, team, opponent, position, game_id, game_date, season, is_home,
          minutes, points, rebounds, assists, steals, blocks, turnovers, fouls,
          fg_made, fg_attempted, fg_pct, fg3_made, fg3_attempted, fg3_pct, ft_made, ft_attempted, ft_pct,
          oreb, dreb, plus_minus, dk_fantasy_points, fd_fantasy_points, yahoo_fantasy_points, rest_days, is_back_to_back
        ) VALUES (
          @player_id, @player_name, @player_key, @team, @opponent, @position, @game_id, @game_date, @season, @is_home,
          @minutes, @points, @rebounds, @assists, @steals, @blocks, @turnovers, @fouls,
          @fg_made, @fg_attempted, @fg_pct, @fg3_made, @fg3_attempted, @fg3_pct, @ft_made, @ft_attempted, @ft_pct,
          @oreb, @dreb, @plus_minus, @dk_fantasy_points, @fd_fantasy_points, @yahoo_fantasy_points, @rest_days, @is_back_to_back
        )
      `);

      const insertMany = db.transaction((gameList) => {
        let count = 0;
        for (const game of gameList) {
          try {
            stmt.run(this.toInsertParams(game));
            count++;
          } catch (e) {
            if (count === 0) {
              console.error(`❌ Insert error for ${game.player_name}:`, e.message);
              console.error('Game data:', JSON.stringify(game, null, 2));
            }
          }
        }
        return count;
      });

      inserted = insertMany(games);
    }

    return inserted;
  }

  /**
   * Date of the player's latest stored game before `beforeDate`, matched by
   * player_key so rows from any source (blob, NBA API) count. Null if none.
   */
  async getPreviousGameDate(playerName, beforeDate) {
    const key = playerKey(playerName);
    const row = DATABASE_TYPE === 'azuresql'
      ? await db.get(
          `SELECT CONVERT(VARCHAR(10), MAX(game_date), 23) AS prev FROM historical_games WHERE player_key = @key AND game_date < @beforeDate`,
          { key, beforeDate })
      : await db.get(
          `SELECT MAX(game_date) AS prev FROM historical_games WHERE player_key = ? AND game_date < ?`,
          key, beforeDate);
    return row?.prev || null;
  }

  /**
   * Number of NBA API rows stored for a player's season (resume check)
   */
  async countStoredGames(playerId, season) {
    const row = DATABASE_TYPE === 'azuresql'
      ? await db.get(
          `SELECT COUNT(*) AS n FROM historical_games WHERE player_id = @playerId AND season = @season`,
          { playerId: String(playerId), season })
      : await db.get(
          `SELECT COUNT(*) AS n FROM historical_games WHERE player_id = ? AND season = ?`,
          String(playerId), season);
    return row?.n || 0;
  }

  /**
   * Compute rest days against the previous stored game, then insert.
   * Returns the number of rows written.
   */
  async insertPlayerGames(games, position) {
    if (games.length === 0) return 0;
    const firstDate = games.reduce((min, g) => (g.game_date < min ? g.game_date : min), games[0].game_date);
    const previousGameDate = await this.getPreviousGameDate(games[0].player_name, firstDate);
    const withRest = this.calculateRestDays(games, previousGameDate)
      .map(g => ({ ...g, position: g.position || position || null }));
    return this.bulkInsertGames(withRest);
  }

  /**
   * Calculate rest days for each game. `previousGameDate` is the player's last
   * game already stored before this batch, so the first fetched game is
   * measured against it instead of guessed.
   */
  calculateRestDays(games, previousGameDate = null) {
    // Sort by date ascending
    const sorted = [...games].sort((a, b) =>
      new Date(a.game_date) - new Date(b.game_date)
    );

    for (let i = 0; i < sorted.length; i++) {
      const prev = i === 0 ? previousGameDate : sorted[i - 1].game_date;
      if (!prev) {
        sorted[i].rest_days = 3; // Assume 3 days rest when no previous game is known
        sorted[i].is_back_to_back = 0;
      } else {
        const prevDate = new Date(prev);
        const currDate = new Date(sorted[i].game_date);
        const diffDays = Math.floor((currDate - prevDate) / (1000 * 60 * 60 * 24)) - 1;
        sorted[i].rest_days = Math.max(0, diffDays);
        sorted[i].is_back_to_back = diffDays === 0 ? 1 : 0;
      }
    }

    return sorted;
  }

  /**
   * Fetch all game logs for a season, one player at a time.
   * options.skipComplete: skip players whose stored game count for the season
   * already matches games played (resume after an interrupted backfill).
   * Returns { players, games, skipped, elapsed }.
   */
  async fetchSeasonGameLogs(season = getCurrentSeason(), progressCallback = null, { skipComplete = false } = {}) {
    console.log(`\n🏀 ═══════════════════════════════════════════════════`);
    console.log(`   FETCHING ${season} SEASON GAME LOGS`);
    console.log(`═══════════════════════════════════════════════════════\n`);

    const startTime = Date.now();

    // Everyone who played this season
    const players = await this.fetchAllPlayers(season);

    let totalGames = 0;
    let processedPlayers = 0;
    let skipped = 0;

    // Process players one at a time with delay (NBA.com is strict about rate limiting)
    for (const player of players) {
      let fetched = false;
      try {
        if (skipComplete && await this.countStoredGames(player.id, season) >= player.gamesPlayed) {
          skipped++;
        } else {
          fetched = true;
          const games = await this.fetchPlayerGameLog(player.id, player.name, season);
          const inserted = await this.insertPlayerGames(games, player.position);
          totalGames += inserted;
          if (games.length > 0) {
            console.log(`✅ ${player.name}: ${games.length} fetched, ${inserted} inserted`);
          }
        }
      } catch (error) {
        console.error(`❌ Failed for ${player.name}:`, error.message);
      }

      processedPlayers++;

      // Progress callback
      if (progressCallback) {
        progressCallback({
          processed: processedPlayers,
          total: players.length,
          games: totalGames,
          skipped
        });
      }

      // Delay between each player request (skipped players made no request)
      if (fetched && processedPlayers < players.length) {
        await this.sleep(this.requestDelay);
      }
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    console.log(`\n═══════════════════════════════════════════════════════`);
    console.log(`✅ Complete! Processed ${processedPlayers} players (${skipped} already complete)`);
    console.log(`📊 Total games inserted: ${totalGames}`);
    console.log(`⏱️  Elapsed time: ${elapsed}s`);
    console.log(`═══════════════════════════════════════════════════════\n`);

    return { players: processedPlayers, games: totalGames, skipped, elapsed };
  }

  /**
   * Get historical stats summary for AI context
   * @param {string} startDate - Optional start date filter (YYYY-MM-DD)
   * @param {string} endDate - Optional end date filter (YYYY-MM-DD)
   */
  async getHistoricalSummary(startDate = null, endDate = null) {
    let whereClause = '';
    const params = [];

    if (startDate || endDate) {
      const conditions = [];
      if (startDate) {
        conditions.push(DATABASE_TYPE === 'azuresql' ? 'game_date >= @startDate' : 'game_date >= ?');
        params.push(startDate);
      }
      if (endDate) {
        conditions.push(DATABASE_TYPE === 'azuresql' ? 'game_date <= @endDate' : 'game_date <= ?');
        params.push(endDate);
      }
      whereClause = 'WHERE ' + conditions.join(' AND ');
    }

    const query = `
      SELECT
        COUNT(*) as total_games,
        COUNT(DISTINCT player_name) as unique_players,
        COUNT(DISTINCT game_date) as unique_dates,
        MIN(game_date) as earliest_game,
        MAX(game_date) as latest_game,
        AVG(dk_fantasy_points) as avg_dk_points,
        AVG(minutes) as avg_minutes
      FROM historical_games
      ${whereClause}
    `;

    if (DATABASE_TYPE === 'azuresql') {
      const namedParams = {};
      if (startDate) namedParams.startDate = startDate;
      if (endDate) namedParams.endDate = endDate;
      return await db.get(query, namedParams);
    } else {
      return await db.get(query, ...params);
    }
  }

  /**
   * Get player historical performance for AI analysis
   */
  async getPlayerHistory(playerName, limit = 20) {
    const query = `
      SELECT
        game_date, opponent, is_home, minutes, points, rebounds, assists,
        steals, blocks, turnovers, dk_fantasy_points, rest_days, is_back_to_back
      FROM historical_games
      WHERE player_name LIKE ${DATABASE_TYPE === 'azuresql' ? '@playerName' : '?'}
      ORDER BY game_date DESC
      ${DATABASE_TYPE === 'azuresql' ? 'OFFSET 0 ROWS FETCH NEXT @limit ROWS ONLY' : 'LIMIT ?'}
    `;

    if (DATABASE_TYPE === 'azuresql') {
      return await db.all(query, { playerName: `%${playerName}%`, limit });
    } else {
      return await db.all(query, `%${playerName}%`, limit);
    }
  }

  /**
   * Get matchup history (player vs specific team)
   */
  async getMatchupHistory(playerName, opponent) {
    const query = `
      SELECT
        game_date, is_home, minutes, points, rebounds, assists,
        steals, blocks, turnovers, dk_fantasy_points
      FROM historical_games
      WHERE player_name LIKE ${DATABASE_TYPE === 'azuresql' ? '@playerName' : '?'}
        AND opponent = ${DATABASE_TYPE === 'azuresql' ? '@opponent' : '?'}
      ORDER BY game_date DESC
    `;

    if (DATABASE_TYPE === 'azuresql') {
      return await db.all(query, { playerName: `%${playerName}%`, opponent });
    } else {
      return await db.all(query, `%${playerName}%`, opponent);
    }
  }

  /**
   * Get performance trends (for ML features)
   */
  async getPerformanceTrends(playerName) {
    const query = `
      SELECT
        AVG(dk_fantasy_points) as avg_dk_pts,
        AVG(CASE WHEN is_back_to_back = 1 THEN dk_fantasy_points END) as avg_b2b_pts,
        AVG(CASE WHEN is_back_to_back = 0 THEN dk_fantasy_points END) as avg_rested_pts,
        AVG(CASE WHEN is_home = 1 THEN dk_fantasy_points END) as avg_home_pts,
        AVG(CASE WHEN is_home = 0 THEN dk_fantasy_points END) as avg_away_pts,
        AVG(minutes) as avg_minutes,
        COUNT(*) as games_played,
        MAX(dk_fantasy_points) as ceiling,
        MIN(dk_fantasy_points) as floor
      FROM historical_games
      WHERE player_name LIKE ${DATABASE_TYPE === 'azuresql' ? '@playerName' : '?'}
    `;

    if (DATABASE_TYPE === 'azuresql') {
      return await db.get(query, { playerName: `%${playerName}%` });
    } else {
      return await db.get(query, `%${playerName}%`);
    }
  }

  /**
   * Get top performers by DK fantasy points
   * @param {number} limit - Max results to return
   * @param {number} minGames - Minimum games required
   * @param {string} startDate - Optional start date filter (YYYY-MM-DD)
   * @param {string} endDate - Optional end date filter (YYYY-MM-DD)
   */
  async getTopPerformers(limit = 20, minGames = 10, startDate = null, endDate = null) {
    let whereClause = '';
    const conditions = [];

    if (startDate) {
      conditions.push(DATABASE_TYPE === 'azuresql' ? 'game_date >= @startDate' : 'game_date >= ?');
    }
    if (endDate) {
      conditions.push(DATABASE_TYPE === 'azuresql' ? 'game_date <= @endDate' : 'game_date <= ?');
    }
    if (conditions.length > 0) {
      whereClause = 'WHERE ' + conditions.join(' AND ');
    }

    const query = `
      SELECT
        player_name,
        team,
        COUNT(*) as games,
        ROUND(AVG(dk_fantasy_points), 1) as avg_dk_pts,
        ROUND(AVG(minutes), 1) as avg_minutes,
        MAX(dk_fantasy_points) as best_game,
        MIN(dk_fantasy_points) as worst_game
      FROM historical_games
      ${whereClause}
      GROUP BY player_name, team
      HAVING COUNT(*) >= ${DATABASE_TYPE === 'azuresql' ? '@minGames' : '?'}
      ORDER BY avg_dk_pts DESC
      ${DATABASE_TYPE === 'azuresql' ? 'OFFSET 0 ROWS FETCH NEXT @limit ROWS ONLY' : 'LIMIT ?'}
    `;

    if (DATABASE_TYPE === 'azuresql') {
      const params = { minGames, limit };
      if (startDate) params.startDate = startDate;
      if (endDate) params.endDate = endDate;
      return await db.all(query, params);
    } else {
      const params = [];
      if (startDate) params.push(startDate);
      if (endDate) params.push(endDate);
      params.push(minGames, limit);
      return await db.all(query, ...params);
    }
  }

  /**
   * Analyze back-to-back impact across all players
   */
  async analyzeB2BImpact() {
    const query = `
      SELECT
        CASE WHEN is_back_to_back = 1 THEN 'B2B' ELSE 'Rested' END as rest_status,
        COUNT(*) as games,
        ROUND(AVG(dk_fantasy_points), 2) as avg_dk_pts,
        ROUND(AVG(minutes), 2) as avg_minutes,
        ROUND(AVG(points), 2) as avg_points
      FROM historical_games
      GROUP BY is_back_to_back
    `;

    return await db.all(query);
  }

  /**
   * Get player's performance when a specific teammate is OUT
   * Compares their stats in games where teammate played vs didn't play
   */
  async getUsageWithoutTeammate(playerName, teammateName, team = null) {
    const teamCondition = team
      ? (DATABASE_TYPE === 'azuresql' ? 'AND team = @team' : 'AND team = ?')
      : '';

    const query = `
      WITH player_games AS (
        SELECT
          game_id,
          game_date,
          player_name,
          team,
          minutes,
          dk_fantasy_points,
          points,
          rebounds,
          assists
        FROM historical_games
        WHERE player_name LIKE ${DATABASE_TYPE === 'azuresql' ? '@playerName' : '?'}
        ${teamCondition}
      ),
      teammate_games AS (
        SELECT
          game_id,
          minutes as teammate_minutes
        FROM historical_games
        WHERE player_name LIKE ${DATABASE_TYPE === 'azuresql' ? '@teammateName' : '?'}
        ${teamCondition}
      )
      SELECT
        pg.game_id,
        pg.game_date,
        pg.player_name,
        pg.team,
        pg.minutes,
        pg.dk_fantasy_points,
        pg.points,
        pg.rebounds,
        pg.assists,
        COALESCE(tg.teammate_minutes, 0) as teammate_minutes,
        CASE WHEN COALESCE(tg.teammate_minutes, 0) > 0 THEN 'WITH' ELSE 'WITHOUT' END as teammate_status
      FROM player_games pg
      LEFT JOIN teammate_games tg ON pg.game_id = tg.game_id
      ORDER BY pg.game_date DESC
    `;

    let games;
    if (DATABASE_TYPE === 'azuresql') {
      const params = { playerName: `%${playerName}%`, teammateName: `%${teammateName}%` };
      if (team) params.team = team;
      games = await db.all(query, params);
    } else {
      const params = team
        ? [`%${playerName}%`, team, `%${teammateName}%`, team]
        : [`%${playerName}%`, `%${teammateName}%`];
      games = await db.all(query, ...params);
    }

    if (games.length === 0) {
      return { success: false, message: 'No games found for this player/teammate combination' };
    }

    // Calculate averages with and without teammate
    const withTeammate = games.filter(g => g.teammate_status === 'WITH');
    const withoutTeammate = games.filter(g => g.teammate_status === 'WITHOUT');

    const calcAverages = (gameList) => {
      if (gameList.length === 0) return null;
      return {
        games: gameList.length,
        avgDkPoints: Math.round(gameList.reduce((sum, g) => sum + g.dk_fantasy_points, 0) / gameList.length * 10) / 10,
        avgMinutes: Math.round(gameList.reduce((sum, g) => sum + g.minutes, 0) / gameList.length * 10) / 10,
        avgPoints: Math.round(gameList.reduce((sum, g) => sum + g.points, 0) / gameList.length * 10) / 10,
        avgRebounds: Math.round(gameList.reduce((sum, g) => sum + g.rebounds, 0) / gameList.length * 10) / 10,
        avgAssists: Math.round(gameList.reduce((sum, g) => sum + g.assists, 0) / gameList.length * 10) / 10,
      };
    };

    const withStats = calcAverages(withTeammate);
    const withoutStats = calcAverages(withoutTeammate);

    // Calculate the boost/difference
    let usageBump = null;
    if (withStats && withoutStats) {
      usageBump = {
        dkPointsDiff: Math.round((withoutStats.avgDkPoints - withStats.avgDkPoints) * 10) / 10,
        minutesDiff: Math.round((withoutStats.avgMinutes - withStats.avgMinutes) * 10) / 10,
        pointsDiff: Math.round((withoutStats.avgPoints - withStats.avgPoints) * 10) / 10,
        percentBoost: Math.round(((withoutStats.avgDkPoints - withStats.avgDkPoints) / withStats.avgDkPoints) * 1000) / 10
      };
    }

    return {
      success: true,
      player: games[0]?.player_name,
      teammate: teammateName,
      team: games[0]?.team,
      withTeammate: withStats,
      withoutTeammate: withoutStats,
      usageBump,
      recentGamesWithout: withoutTeammate.slice(0, 5).map(g => ({
        date: g.game_date,
        dkPoints: g.dk_fantasy_points,
        minutes: g.minutes,
        points: g.points,
        rebounds: g.rebounds,
        assists: g.assists
      }))
    };
  }

  /**
   * Analyze roster context - find historical games with similar active roster
   * Given a list of active players for tonight, find games where similar combinations played
   */
  async analyzeRosterContext(team, activePlayers, absentPlayers = []) {
    // Get all games for this team
    const teamGames = await db.all(`
      SELECT DISTINCT game_id, game_date
      FROM historical_games
      WHERE team = ${DATABASE_TYPE === 'azuresql' ? '@team' : '?'}
      ORDER BY game_date DESC
    `, DATABASE_TYPE === 'azuresql' ? { team } : team);

    if (teamGames.length === 0) {
      return { success: false, message: `No historical games found for ${team}` };
    }

    // For each game, determine which players played
    const gameRosters = [];
    for (const game of teamGames) {
      const players = await db.all(`
        SELECT player_name, minutes, dk_fantasy_points
        FROM historical_games
        WHERE team = ${DATABASE_TYPE === 'azuresql' ? '@team' : '?'}
          AND game_id = ${DATABASE_TYPE === 'azuresql' ? '@gameId' : '?'}
          AND minutes > 0
      `, DATABASE_TYPE === 'azuresql' ? { team, gameId: game.game_id } : team, game.game_id);

      gameRosters.push({
        game_id: game.game_id,
        game_date: game.game_date,
        activePlayers: players.map(p => p.player_name),
        playerStats: players
      });
    }

    // Find games where absent players didn't play (or played 0 minutes)
    // This simulates "tonight's scenario"
    const matchingGames = gameRosters.filter(game => {
      // Check that absent players didn't play in this game
      const absentMatched = absentPlayers.every(absent =>
        !game.activePlayers.some(p => p.toLowerCase().includes(absent.toLowerCase()))
      );

      // Check that at least some of tonight's active players played
      const activeMatched = activePlayers.some(active =>
        game.activePlayers.some(p => p.toLowerCase().includes(active.toLowerCase()))
      );

      return absentMatched && activeMatched;
    });

    if (matchingGames.length === 0) {
      return {
        success: true,
        message: 'No historical games found with this exact roster configuration',
        team,
        activePlayers,
        absentPlayers,
        matchingGames: []
      };
    }

    // Aggregate stats for players in matching games
    const playerBoosts = {};

    matchingGames.forEach(game => {
      game.playerStats.forEach(player => {
        if (!playerBoosts[player.player_name]) {
          playerBoosts[player.player_name] = {
            name: player.player_name,
            gamesInContext: 0,
            totalDkPoints: 0,
            totalMinutes: 0
          };
        }
        playerBoosts[player.player_name].gamesInContext++;
        playerBoosts[player.player_name].totalDkPoints += player.dk_fantasy_points;
        playerBoosts[player.player_name].totalMinutes += player.minutes;
      });
    });

    // Get overall averages for comparison
    const playerOverallStats = {};
    for (const playerName of Object.keys(playerBoosts)) {
      const overall = await db.get(`
        SELECT
          AVG(dk_fantasy_points) as avg_dk,
          AVG(minutes) as avg_min,
          COUNT(*) as total_games
        FROM historical_games
        WHERE player_name = ${DATABASE_TYPE === 'azuresql' ? '@playerName' : '?'}
          AND team = ${DATABASE_TYPE === 'azuresql' ? '@team' : '?'}
      `, DATABASE_TYPE === 'azuresql' ? { playerName, team } : playerName, team);

      playerOverallStats[playerName] = overall;
    }

    // Calculate usage bumps
    const usageBumps = Object.entries(playerBoosts)
      .map(([name, stats]) => {
        const contextAvg = stats.totalDkPoints / stats.gamesInContext;
        const contextMinAvg = stats.totalMinutes / stats.gamesInContext;
        const overall = playerOverallStats[name];

        return {
          player: name,
          gamesInContext: stats.gamesInContext,
          contextAvgDk: Math.round(contextAvg * 10) / 10,
          contextAvgMin: Math.round(contextMinAvg * 10) / 10,
          overallAvgDk: Math.round((overall?.avg_dk || 0) * 10) / 10,
          overallAvgMin: Math.round((overall?.avg_min || 0) * 10) / 10,
          dkPointsBump: Math.round((contextAvg - (overall?.avg_dk || 0)) * 10) / 10,
          minutesBump: Math.round((contextMinAvg - (overall?.avg_min || 0)) * 10) / 10,
          percentBoost: overall?.avg_dk > 0
            ? Math.round(((contextAvg - overall.avg_dk) / overall.avg_dk) * 1000) / 10
            : 0
        };
      })
      .filter(p => p.gamesInContext >= 2) // At least 2 games for relevance
      .sort((a, b) => b.percentBoost - a.percentBoost);

    return {
      success: true,
      team,
      activePlayers,
      absentPlayers,
      matchingGamesCount: matchingGames.length,
      matchingGameDates: matchingGames.slice(0, 5).map(g => g.game_date),
      usageBumps: usageBumps.slice(0, 10), // Top 10 players with biggest bumps
      topBeneficiaries: usageBumps.filter(p => p.percentBoost > 5).slice(0, 5) // Players with 5%+ boost
    };
  }

  /**
   * Find all teammates for a player based on historical games
   */
  async getTeammates(playerName) {
    const query = `
      SELECT DISTINCT h2.player_name, h2.team, COUNT(*) as games_together
      FROM historical_games h1
      JOIN historical_games h2 ON h1.game_id = h2.game_id AND h1.team = h2.team
      WHERE h1.player_name LIKE ${DATABASE_TYPE === 'azuresql' ? '@playerName' : '?'}
        AND h2.player_name NOT LIKE ${DATABASE_TYPE === 'azuresql' ? '@playerName' : '?'}
        AND h1.minutes > 0
        AND h2.minutes > 0
      GROUP BY h2.player_name, h2.team
      ORDER BY games_together DESC
    `;

    if (DATABASE_TYPE === 'azuresql') {
      return await db.all(query, { playerName: `%${playerName}%` });
    } else {
      return await db.all(query, `%${playerName}%`, `%${playerName}%`);
    }
  }

  /**
   * Insert a single game from box score JSON (from Azure Blob)
   * Used when syncing from blob storage
   * @param {Object} game - Box score game object from blob storage
   * @returns {boolean} - Whether the game was inserted (false if already exists)
   */
  async insertGameFromBoxScore(game) {
    // Map blob storage fields to database fields
    const gameData = {
      player_id: null, // Not available from Basketball Reference
      player_name: game.player_name,
      player_key: playerKey(game.player_name),
      team: canonicalTeam(this.teamAbbreviations[game.team] || game.team), // Convert full name to abbrev if needed
      opponent: canonicalTeam(this.teamAbbreviations[game.opponent] || game.opponent),
      position: null,
      game_id: `${game.game_date}_${game.team}_${game.opponent}`, // Generate unique ID
      game_date: game.game_date,
      season: seasonForDate(game.game_date),
      is_home: game.is_home,
      minutes: game.minutes || 0,
      points: game.points || 0,
      rebounds: game.rebounds || 0,
      assists: game.assists || 0,
      steals: game.steals || 0,
      blocks: game.blocks || 0,
      turnovers: game.turnovers || 0,
      fg_made: game.fg_made || 0,
      fg_attempted: game.fg_attempted || 0,
      fg3_made: game.fg3_made || 0,
      fg3_attempted: game.fg3_attempted || 0,
      ft_made: game.ft_made || 0,
      ft_attempted: game.ft_attempted || 0,
      oreb: game.oreb || 0,
      dreb: game.dreb || 0,
      plus_minus: game.plus_minus || 0,
      dk_fantasy_points: game.dk_fantasy_points || this.calculateDKFantasyPoints({
        points: game.points,
        fg3_made: game.fg3_made,
        rebounds: game.rebounds,
        assists: game.assists,
        steals: game.steals,
        blocks: game.blocks,
        turnovers: game.turnovers
      }),
      fd_fantasy_points: game.fd_fantasy_points ?? computeFantasyPoints(game, 'fanduel'),
      yahoo_fantasy_points: game.yahoo_fantasy_points ?? computeFantasyPoints(game, 'yahoo'),
      rest_days: null,
      is_back_to_back: 0
    };

    try {
      if (DATABASE_TYPE === 'azuresql') {
        // Use MERGE for Azure SQL - insert only if not exists
        const result = await db.run(`
          MERGE INTO historical_games AS target
          USING (SELECT @game_id AS game_id, @player_name AS player_name) AS source
          ON target.game_id = source.game_id AND target.player_name = source.player_name
          WHEN NOT MATCHED THEN
            INSERT (player_id, player_name, player_key, team, opponent, position, game_id, game_date, season, is_home,
                    minutes, points, rebounds, assists, steals, blocks, turnovers,
                    fg_made, fg_attempted, fg3_made, fg3_attempted, ft_made, ft_attempted,
                    oreb, dreb, plus_minus, dk_fantasy_points, fd_fantasy_points, yahoo_fantasy_points, rest_days, is_back_to_back)
            VALUES (@player_id, @player_name, @player_key, @team, @opponent, @position, @game_id, @game_date, @season, @is_home,
                    @minutes, @points, @rebounds, @assists, @steals, @blocks, @turnovers,
                    @fg_made, @fg_attempted, @fg3_made, @fg3_attempted, @ft_made, @ft_attempted,
                    @oreb, @dreb, @plus_minus, @dk_fantasy_points, @fd_fantasy_points, @yahoo_fantasy_points, @rest_days, @is_back_to_back);
        `, gameData);
        return result && result.rowsAffected > 0;
      } else {
        const result = await db.run(`
          INSERT OR IGNORE INTO historical_games (
            player_id, player_name, player_key, team, opponent, position, game_id, game_date, season, is_home,
            minutes, points, rebounds, assists, steals, blocks, turnovers,
            fg_made, fg_attempted, fg3_made, fg3_attempted, ft_made, ft_attempted,
            oreb, dreb, plus_minus, dk_fantasy_points, fd_fantasy_points, yahoo_fantasy_points, rest_days, is_back_to_back
          ) VALUES (
            @player_id, @player_name, @player_key, @team, @opponent, @position, @game_id, @game_date, @season, @is_home,
            @minutes, @points, @rebounds, @assists, @steals, @blocks, @turnovers,
            @fg_made, @fg_attempted, @fg3_made, @fg3_attempted, @ft_made, @ft_attempted,
            @oreb, @dreb, @plus_minus, @dk_fantasy_points, @fd_fantasy_points, @yahoo_fantasy_points, @rest_days, @is_back_to_back
          )
        `, gameData);
        return result.changes > 0;
      }
    } catch (error) {
      // If it's a duplicate key error, return false (game already exists)
      if (error.message.includes('UNIQUE constraint failed') || error.message.includes('duplicate')) {
        return false;
      }
      throw error;
    }
  }

  /**
   * Check if historical data exists and return status
   */
  async getDataStatus() {
    try {
      const result = await db.get(`
        SELECT
          COUNT(*) as totalGames,
          COUNT(DISTINCT player_name) as uniquePlayers,
          MIN(game_date) as earliestGame,
          MAX(game_date) as latestGame
        FROM historical_games
      `);

      return {
        hasData: result.totalGames > 0,
        totalGames: result.totalGames,
        uniquePlayers: result.uniquePlayers,
        earliestGame: result.earliestGame,
        latestGame: result.latestGame,
        needsFullSync: result.totalGames === 0,
        needsUpdate: result.latestGame ? this.daysSinceDate(result.latestGame) > 1 : true
      };
    } catch (error) {
      // Table might not exist
      return {
        hasData: false,
        totalGames: 0,
        needsFullSync: true,
        needsUpdate: true,
        error: error.message
      };
    }
  }

  /**
   * Calculate days since a date
   */
  daysSinceDate(dateStr) {
    const date = new Date(dateStr);
    const today = new Date();
    const diffTime = Math.abs(today - date);
    return Math.ceil(diffTime / (1000 * 60 * 60 * 24));
  }

  /**
   * Fetch game logs incrementally (only games after lastDate)
   */
  async fetchIncrementalGameLogs(season = getCurrentSeason(), lastDate = null, progressCallback = null) {
    console.log(`\n🏀 ═══════════════════════════════════════════════════`);
    console.log(`   INCREMENTAL UPDATE: Games after ${lastDate || 'beginning'}`);
    console.log(`═══════════════════════════════════════════════════════\n`);

    const startTime = Date.now();

    // Everyone who played this season
    const players = await this.fetchAllPlayers(season);

    let totalGames = 0;
    let processedPlayers = 0;
    let newGamesFound = 0;

    // Process players one at a time with delay
    for (const player of players) {
      try {
        const games = await this.fetchPlayerGameLog(player.id, player.name, season);

        if (games.length > 0) {
          // Filter to only games after lastDate
          const newGames = lastDate
            ? games.filter(g => g.game_date > lastDate)
            : games;

          if (newGames.length > 0) {
            // Rest days for the first new game come from the last stored game
            const inserted = await this.insertPlayerGames(newGames, player.position);
            totalGames += inserted;
            newGamesFound += newGames.length;
            console.log(`✅ ${player.name}: ${newGames.length} new games inserted`);
          }
        }
      } catch (error) {
        console.error(`❌ Failed for ${player.name}:`, error.message);
      }

      processedPlayers++;

      if (progressCallback) {
        progressCallback({
          processed: processedPlayers,
          total: players.length,
          games: totalGames,
          newGames: newGamesFound
        });
      }

      // Delay between each player request
      if (processedPlayers < players.length) {
        await this.sleep(this.requestDelay);
      }
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    console.log(`\n═══════════════════════════════════════════════════════`);
    console.log(`✅ Complete! Processed ${processedPlayers} players`);
    console.log(`📊 New games inserted: ${totalGames}`);
    console.log(`⏱️  Elapsed time: ${elapsed}s`);
    console.log(`═══════════════════════════════════════════════════════\n`);

    return { players: processedPlayers, games: totalGames, newGames: newGamesFound, elapsed };
  }

  /**
   * Get players on a specific team from historical data
   */
  async getTeamRoster(team) {
    const query = `
      SELECT
        player_name,
        COUNT(*) as games,
        MAX(game_date) as last_game,
        ROUND(AVG(dk_fantasy_points), 1) as avg_dk,
        ROUND(AVG(minutes), 1) as avg_min
      FROM historical_games
      WHERE team = ${DATABASE_TYPE === 'azuresql' ? '@team' : '?'}
      GROUP BY player_name
      HAVING COUNT(*) >= 3
      ORDER BY avg_dk DESC
    `;

    if (DATABASE_TYPE === 'azuresql') {
      return await db.all(query, { team });
    } else {
      return await db.all(query, team);
    }
  }

  /**
   * Get players on hot streaks - recent performance above season average
   * @param {number} limit - Max results to return
   * @param {number} minGames - Minimum games required
   * @param {string} startDate - Optional start date filter (YYYY-MM-DD)
   * @param {string} endDate - Optional end date filter (YYYY-MM-DD)
   */
  async getHotStreaks(limit = 20, minGames = 5, startDate = null, endDate = null) {
    let whereClause = '';
    const conditions = [];

    if (startDate) {
      conditions.push(DATABASE_TYPE === 'azuresql' ? 'game_date >= @startDate' : 'game_date >= ?');
    }
    if (endDate) {
      conditions.push(DATABASE_TYPE === 'azuresql' ? 'game_date <= @endDate' : 'game_date <= ?');
    }
    if (conditions.length > 0) {
      whereClause = 'WHERE ' + conditions.join(' AND ');
    }

    // Get all players with enough games in date range
    const playersQuery = `
      SELECT
        player_name,
        team,
        COUNT(*) as total_games,
        ROUND(AVG(dk_fantasy_points), 1) as season_avg,
        MAX(game_date) as last_game
      FROM historical_games
      ${whereClause}
      GROUP BY player_name, team
      HAVING COUNT(*) >= ${DATABASE_TYPE === 'azuresql' ? '@minGames' : '?'}
    `;

    let players;
    if (DATABASE_TYPE === 'azuresql') {
      const params = { minGames };
      if (startDate) params.startDate = startDate;
      if (endDate) params.endDate = endDate;
      players = await db.all(playersQuery, params);
    } else {
      const params = [];
      if (startDate) params.push(startDate);
      if (endDate) params.push(endDate);
      params.push(minGames);
      players = await db.all(playersQuery, ...params);
    }

    // Calculate last 3 average for each (within date range)
    const hotStreaks = [];
    for (const p of players) {
      let last3Query, last3Params;

      if (DATABASE_TYPE === 'azuresql') {
        let dateFilter = '';
        if (startDate) dateFilter += ' AND game_date >= @startDate';
        if (endDate) dateFilter += ' AND game_date <= @endDate';

        last3Query = `
          SELECT AVG(dk_fantasy_points) as avg
          FROM (
            SELECT TOP 3 dk_fantasy_points FROM historical_games
            WHERE player_name = @playerName ${dateFilter}
            ORDER BY game_date DESC
          ) sub
        `;
        last3Params = { playerName: p.player_name };
        if (startDate) last3Params.startDate = startDate;
        if (endDate) last3Params.endDate = endDate;
      } else {
        let dateFilter = '';
        const paramsList = [p.player_name];
        if (startDate) { dateFilter += ' AND game_date >= ?'; paramsList.push(startDate); }
        if (endDate) { dateFilter += ' AND game_date <= ?'; paramsList.push(endDate); }

        last3Query = `
          SELECT AVG(dk_fantasy_points) as avg
          FROM (
            SELECT dk_fantasy_points FROM historical_games
            WHERE player_name = ? ${dateFilter}
            ORDER BY game_date DESC LIMIT 3
          )
        `;
        last3Params = paramsList;
      }

      const last3 = DATABASE_TYPE === 'azuresql'
        ? await db.get(last3Query, last3Params)
        : await db.get(last3Query, ...last3Params);

      const last3Avg = last3?.avg || p.season_avg;
      const hotStreakPct = ((last3Avg - p.season_avg) / p.season_avg) * 100;

      if (hotStreakPct >= 10) { // At least 10% above average
        hotStreaks.push({
          ...p,
          last3_avg: Math.round(last3Avg * 10) / 10,
          hot_streak_diff: Math.round((last3Avg - p.season_avg) * 10) / 10,
          hot_streak_pct: Math.round(hotStreakPct * 10) / 10
        });
      }
    }

    return hotStreaks
      .sort((a, b) => b.hot_streak_pct - a.hot_streak_pct)
      .slice(0, limit);
  }

  /**
   * Get players on cold streaks - recent performance below season average
   * @param {number} limit - Max results to return
   * @param {number} minGames - Minimum games required
   * @param {string} startDate - Optional start date filter (YYYY-MM-DD)
   * @param {string} endDate - Optional end date filter (YYYY-MM-DD)
   */
  async getColdStreaks(limit = 20, minGames = 5, startDate = null, endDate = null) {
    let whereClause = '';
    const conditions = [];

    if (startDate) {
      conditions.push(DATABASE_TYPE === 'azuresql' ? 'game_date >= @startDate' : 'game_date >= ?');
    }
    if (endDate) {
      conditions.push(DATABASE_TYPE === 'azuresql' ? 'game_date <= @endDate' : 'game_date <= ?');
    }
    if (conditions.length > 0) {
      whereClause = 'WHERE ' + conditions.join(' AND ');
    }

    // Get all players with enough games in date range
    const playersQuery = `
      SELECT
        player_name,
        team,
        COUNT(*) as total_games,
        ROUND(AVG(dk_fantasy_points), 1) as season_avg,
        MAX(game_date) as last_game
      FROM historical_games
      ${whereClause}
      GROUP BY player_name, team
      HAVING COUNT(*) >= ${DATABASE_TYPE === 'azuresql' ? '@minGames' : '?'}
    `;

    let players;
    if (DATABASE_TYPE === 'azuresql') {
      const params = { minGames };
      if (startDate) params.startDate = startDate;
      if (endDate) params.endDate = endDate;
      players = await db.all(playersQuery, params);
    } else {
      const params = [];
      if (startDate) params.push(startDate);
      if (endDate) params.push(endDate);
      params.push(minGames);
      players = await db.all(playersQuery, ...params);
    }

    // Calculate last 3 average for each (within date range)
    const coldStreaks = [];
    for (const p of players) {
      let last3Query, last3Params;

      if (DATABASE_TYPE === 'azuresql') {
        let dateFilter = '';
        if (startDate) dateFilter += ' AND game_date >= @startDate';
        if (endDate) dateFilter += ' AND game_date <= @endDate';

        last3Query = `
          SELECT AVG(dk_fantasy_points) as avg
          FROM (
            SELECT TOP 3 dk_fantasy_points FROM historical_games
            WHERE player_name = @playerName ${dateFilter}
            ORDER BY game_date DESC
          ) sub
        `;
        last3Params = { playerName: p.player_name };
        if (startDate) last3Params.startDate = startDate;
        if (endDate) last3Params.endDate = endDate;
      } else {
        let dateFilter = '';
        const paramsList = [p.player_name];
        if (startDate) { dateFilter += ' AND game_date >= ?'; paramsList.push(startDate); }
        if (endDate) { dateFilter += ' AND game_date <= ?'; paramsList.push(endDate); }

        last3Query = `
          SELECT AVG(dk_fantasy_points) as avg
          FROM (
            SELECT dk_fantasy_points FROM historical_games
            WHERE player_name = ? ${dateFilter}
            ORDER BY game_date DESC LIMIT 3
          )
        `;
        last3Params = paramsList;
      }

      const last3 = DATABASE_TYPE === 'azuresql'
        ? await db.get(last3Query, last3Params)
        : await db.get(last3Query, ...last3Params);

      const last3Avg = last3?.avg || p.season_avg;
      const coldStreakPct = ((last3Avg - p.season_avg) / p.season_avg) * 100;

      if (coldStreakPct <= -15) { // At least 15% below average
        coldStreaks.push({
          ...p,
          last3_avg: Math.round(last3Avg * 10) / 10,
          cold_streak_diff: Math.round((last3Avg - p.season_avg) * 10) / 10,
          cold_streak_pct: Math.round(coldStreakPct * 10) / 10
        });
      }
    }

    return coldStreaks
      .sort((a, b) => a.cold_streak_pct - b.cold_streak_pct)
      .slice(0, limit);
  }

  /**
   * Get most consistent performers (low variance)
   * @param {number} limit - Max results to return
   * @param {number} minGames - Minimum games required
   * @param {string} startDate - Optional start date filter (YYYY-MM-DD)
   * @param {string} endDate - Optional end date filter (YYYY-MM-DD)
   */
  async getConsistencyLeaders(limit = 20, minGames = 8, startDate = null, endDate = null) {
    let whereClause = '';
    const conditions = [];

    if (startDate) {
      conditions.push(DATABASE_TYPE === 'azuresql' ? 'game_date >= @startDate' : 'game_date >= ?');
    }
    if (endDate) {
      conditions.push(DATABASE_TYPE === 'azuresql' ? 'game_date <= @endDate' : 'game_date <= ?');
    }
    if (conditions.length > 0) {
      whereClause = 'WHERE ' + conditions.join(' AND ');
    }

    // SQLite doesn't have STDDEV, so we calculate it manually
    const playersQuery = `
      SELECT
        player_name,
        team,
        COUNT(*) as games,
        ROUND(AVG(dk_fantasy_points), 1) as avg_dk,
        ROUND(MIN(dk_fantasy_points), 1) as floor,
        ROUND(MAX(dk_fantasy_points), 1) as ceiling,
        MAX(game_date) as last_game
      FROM historical_games
      ${whereClause}
      GROUP BY player_name, team
      HAVING COUNT(*) >= ${DATABASE_TYPE === 'azuresql' ? '@minGames' : '?'} AND AVG(dk_fantasy_points) >= 20
      ORDER BY (MAX(dk_fantasy_points) - MIN(dk_fantasy_points)) / AVG(dk_fantasy_points) ASC
      ${DATABASE_TYPE === 'azuresql' ? 'OFFSET 0 ROWS FETCH NEXT @limit ROWS ONLY' : 'LIMIT ?'}
    `;

    let players;
    if (DATABASE_TYPE === 'azuresql') {
      const params = { minGames, limit };
      if (startDate) params.startDate = startDate;
      if (endDate) params.endDate = endDate;
      players = await db.all(playersQuery, params);
    } else {
      const params = [];
      if (startDate) params.push(startDate);
      if (endDate) params.push(endDate);
      params.push(minGames, limit);
      players = await db.all(playersQuery, ...params);
    }

    // Calculate actual standard deviation for each (within date range)
    const result = [];
    for (const p of players) {
      let gamesQuery, gamesParams;

      if (DATABASE_TYPE === 'azuresql') {
        let dateFilter = '';
        if (startDate) dateFilter += ' AND game_date >= @startDate';
        if (endDate) dateFilter += ' AND game_date <= @endDate';
        gamesQuery = `SELECT dk_fantasy_points FROM historical_games WHERE player_name = @playerName ${dateFilter}`;
        gamesParams = { playerName: p.player_name };
        if (startDate) gamesParams.startDate = startDate;
        if (endDate) gamesParams.endDate = endDate;
      } else {
        let dateFilter = '';
        gamesParams = [p.player_name];
        if (startDate) { dateFilter += ' AND game_date >= ?'; gamesParams.push(startDate); }
        if (endDate) { dateFilter += ' AND game_date <= ?'; gamesParams.push(endDate); }
        gamesQuery = `SELECT dk_fantasy_points FROM historical_games WHERE player_name = ? ${dateFilter}`;
      }

      const games = DATABASE_TYPE === 'azuresql'
        ? await db.all(gamesQuery, gamesParams)
        : await db.all(gamesQuery, ...gamesParams);

      const mean = games.reduce((sum, g) => sum + g.dk_fantasy_points, 0) / games.length;
      const variance = games.reduce((sum, g) => sum + Math.pow(g.dk_fantasy_points - mean, 2), 0) / games.length;
      const stdDev = Math.sqrt(variance);

      result.push({
        ...p,
        std_dev: Math.round(stdDev * 10) / 10,
        consistency_score: Math.round((1 / (stdDev / mean)) * 100) / 10 // Higher = more consistent
      });
    }

    return result.sort((a, b) => b.consistency_score - a.consistency_score);
  }

  /**
   * Get high-variance boom/bust players (good for GPPs)
   * @param {number} limit - Max results to return
   * @param {number} minGames - Minimum games required
   * @param {string} startDate - Optional start date filter (YYYY-MM-DD)
   * @param {string} endDate - Optional end date filter (YYYY-MM-DD)
   */
  async getBoomBustPlayers(limit = 20, minGames = 8, startDate = null, endDate = null) {
    let whereClause = '';
    const conditions = [];

    if (startDate) {
      conditions.push(DATABASE_TYPE === 'azuresql' ? 'game_date >= @startDate' : 'game_date >= ?');
    }
    if (endDate) {
      conditions.push(DATABASE_TYPE === 'azuresql' ? 'game_date <= @endDate' : 'game_date <= ?');
    }
    if (conditions.length > 0) {
      whereClause = 'WHERE ' + conditions.join(' AND ');
    }

    const playersQuery = `
      SELECT
        player_name,
        team,
        COUNT(*) as games,
        ROUND(AVG(dk_fantasy_points), 1) as avg_dk,
        ROUND(MIN(dk_fantasy_points), 1) as floor,
        ROUND(MAX(dk_fantasy_points), 1) as ceiling,
        MAX(game_date) as last_game
      FROM historical_games
      ${whereClause}
      GROUP BY player_name, team
      HAVING COUNT(*) >= ${DATABASE_TYPE === 'azuresql' ? '@minGames' : '?'} AND AVG(dk_fantasy_points) >= 15
      ORDER BY (MAX(dk_fantasy_points) - MIN(dk_fantasy_points)) DESC
      ${DATABASE_TYPE === 'azuresql' ? 'OFFSET 0 ROWS FETCH NEXT @limit ROWS ONLY' : 'LIMIT ?'}
    `;

    let players;
    if (DATABASE_TYPE === 'azuresql') {
      const params = { minGames, limit: limit * 2 };
      if (startDate) params.startDate = startDate;
      if (endDate) params.endDate = endDate;
      players = await db.all(playersQuery, params);
    } else {
      const params = [];
      if (startDate) params.push(startDate);
      if (endDate) params.push(endDate);
      params.push(minGames, limit * 2);
      players = await db.all(playersQuery, ...params);
    }

    const result = [];
    for (const p of players) {
      let gamesQuery, gamesParams;

      if (DATABASE_TYPE === 'azuresql') {
        let dateFilter = '';
        if (startDate) dateFilter += ' AND game_date >= @startDate';
        if (endDate) dateFilter += ' AND game_date <= @endDate';
        gamesQuery = `SELECT dk_fantasy_points FROM historical_games WHERE player_name = @playerName ${dateFilter}`;
        gamesParams = { playerName: p.player_name };
        if (startDate) gamesParams.startDate = startDate;
        if (endDate) gamesParams.endDate = endDate;
      } else {
        let dateFilter = '';
        gamesParams = [p.player_name];
        if (startDate) { dateFilter += ' AND game_date >= ?'; gamesParams.push(startDate); }
        if (endDate) { dateFilter += ' AND game_date <= ?'; gamesParams.push(endDate); }
        gamesQuery = `SELECT dk_fantasy_points FROM historical_games WHERE player_name = ? ${dateFilter}`;
      }

      const games = DATABASE_TYPE === 'azuresql'
        ? await db.all(gamesQuery, gamesParams)
        : await db.all(gamesQuery, ...gamesParams);

      const mean = games.reduce((sum, g) => sum + g.dk_fantasy_points, 0) / games.length;
      const variance = games.reduce((sum, g) => sum + Math.pow(g.dk_fantasy_points - mean, 2), 0) / games.length;
      const stdDev = Math.sqrt(variance);

      // Count boom games (50+ DK pts) and bust games (< 15 DK pts)
      const boomGames = games.filter(g => g.dk_fantasy_points >= 50).length;
      const bustGames = games.filter(g => g.dk_fantasy_points < 15).length;

      result.push({
        ...p,
        std_dev: Math.round(stdDev * 10) / 10,
        boom_rate: Math.round((boomGames / games.length) * 1000) / 10,
        bust_rate: Math.round((bustGames / games.length) * 1000) / 10,
        upside_score: Math.round((p.ceiling - p.avg_dk) * 10) / 10
      });
    }

    return result.sort((a, b) => b.std_dev - a.std_dev).slice(0, limit);
  }

  /**
   * Get comprehensive slate insights for all players in current slate
   * @param {Array} slatePlayers - Array of player objects from current slate
   * @param {string} startDate - Optional start date filter (YYYY-MM-DD)
   * @param {string} endDate - Optional end date filter (YYYY-MM-DD)
   */
  async getSlateInsights(slatePlayers, startDate = null, endDate = null) {
    // Build date filter conditions
    let dateCondition = '';
    const dateParams = {};
    if (startDate) {
      dateCondition += DATABASE_TYPE === 'azuresql' ? ' AND game_date >= @startDate' : ' AND game_date >= ?';
      dateParams.startDate = startDate;
    }
    if (endDate) {
      dateCondition += DATABASE_TYPE === 'azuresql' ? ' AND game_date <= @endDate' : ' AND game_date <= ?';
      dateParams.endDate = endDate;
    }

    const insights = {
      hotStreaks: [],
      coldStreaks: [],
      matchupAdvantages: [],
      b2bPlayers: [],
      restedPlayers: [],
      consistentPlays: [],
      boomCandidates: [],
      recentPerformers: []
    };

    for (const player of slatePlayers) {
      const playerName = player.name;
      const opponent = player.opponent;
      const team = player.team;

      // Get historical stats for this player (with date filter)
      let stats;
      if (DATABASE_TYPE === 'azuresql') {
        const statsQuery = `
          SELECT
            COUNT(*) as games,
            AVG(dk_fantasy_points) as season_avg,
            AVG(minutes) as avg_min,
            MIN(dk_fantasy_points) as floor,
            MAX(dk_fantasy_points) as ceiling,
            MAX(game_date) as last_game
          FROM historical_games
          WHERE player_name LIKE @playerName${dateCondition}
        `;
        stats = await db.get(statsQuery, { playerName: `%${playerName}%`, ...dateParams });
      } else {
        const statsQuery = `
          SELECT
            COUNT(*) as games,
            AVG(dk_fantasy_points) as season_avg,
            AVG(minutes) as avg_min,
            MIN(dk_fantasy_points) as floor,
            MAX(dk_fantasy_points) as ceiling,
            MAX(game_date) as last_game
          FROM historical_games
          WHERE player_name LIKE ?${dateCondition.replace(/@\w+/g, '?')}
        `;
        const paramsList = [`%${playerName}%`];
        if (startDate) paramsList.push(startDate);
        if (endDate) paramsList.push(endDate);
        stats = await db.get(statsQuery, ...paramsList);
      }

      if (!stats || stats.games < 3) continue;

      // Get last 3 games average (within date range)
      let last3;
      if (DATABASE_TYPE === 'azuresql') {
        const last3Query = `
          SELECT AVG(dk_fantasy_points) as avg, STRING_AGG(CAST(dk_fantasy_points AS VARCHAR), ',') as scores
          FROM (
            SELECT TOP 3 dk_fantasy_points FROM historical_games
            WHERE player_name LIKE @playerName${dateCondition}
            ORDER BY game_date DESC
          ) sub
        `;
        last3 = await db.get(last3Query, { playerName: `%${playerName}%`, ...dateParams });
      } else {
        const last3Query = `
          SELECT AVG(dk_fantasy_points) as avg, GROUP_CONCAT(dk_fantasy_points) as scores
          FROM (
            SELECT dk_fantasy_points FROM historical_games
            WHERE player_name LIKE ?${dateCondition.replace(/@\w+/g, '?')}
            ORDER BY game_date DESC LIMIT 3
          )
        `;
        const paramsList = [`%${playerName}%`];
        if (startDate) paramsList.push(startDate);
        if (endDate) paramsList.push(endDate);
        last3 = await db.get(last3Query, ...paramsList);
      }

      // Get matchup history vs opponent (with date filter)
      let matchupHistory;
      if (DATABASE_TYPE === 'azuresql') {
        const matchupQuery = `
          SELECT
            COUNT(*) as games_vs,
            AVG(dk_fantasy_points) as avg_vs,
            MAX(dk_fantasy_points) as best_vs
          FROM historical_games
          WHERE player_name LIKE @playerName AND opponent = @opponent${dateCondition}
        `;
        matchupHistory = await db.get(matchupQuery, { playerName: `%${playerName}%`, opponent, ...dateParams });
      } else {
        const matchupQuery = `
          SELECT
            COUNT(*) as games_vs,
            AVG(dk_fantasy_points) as avg_vs,
            MAX(dk_fantasy_points) as best_vs
          FROM historical_games
          WHERE player_name LIKE ? AND opponent = ?${dateCondition.replace(/@\w+/g, '?')}
        `;
        const paramsList = [`%${playerName}%`, opponent];
        if (startDate) paramsList.push(startDate);
        if (endDate) paramsList.push(endDate);
        matchupHistory = await db.get(matchupQuery, ...paramsList);
      }

      const last3Avg = last3?.avg || stats.season_avg;
      const seasonAvg = stats.season_avg;
      const hotStreakPct = ((last3Avg - seasonAvg) / seasonAvg) * 100;

      // Calculate std dev for this player (within date range)
      let allGames;
      if (DATABASE_TYPE === 'azuresql') {
        const allGamesQuery = `SELECT dk_fantasy_points FROM historical_games WHERE player_name LIKE @playerName${dateCondition}`;
        allGames = await db.all(allGamesQuery, { playerName: `%${playerName}%`, ...dateParams });
      } else {
        const allGamesQuery = `SELECT dk_fantasy_points FROM historical_games WHERE player_name LIKE ?${dateCondition.replace(/@\w+/g, '?')}`;
        const paramsList = [`%${playerName}%`];
        if (startDate) paramsList.push(startDate);
        if (endDate) paramsList.push(endDate);
        allGames = await db.all(allGamesQuery, ...paramsList);
      }

      let stdDev = 0;
      if (allGames.length > 1) {
        const mean = allGames.reduce((s, g) => s + g.dk_fantasy_points, 0) / allGames.length;
        const variance = allGames.reduce((s, g) => s + Math.pow(g.dk_fantasy_points - mean, 2), 0) / allGames.length;
        stdDev = Math.sqrt(variance);
      }

      const playerInsight = {
        name: playerName,
        team,
        opponent,
        salary: player.salary,
        projection: player.projected_points,
        games: stats.games,
        seasonAvg: Math.round(seasonAvg * 10) / 10,
        last3Avg: Math.round(last3Avg * 10) / 10,
        last3Scores: last3?.scores,
        floor: Math.round(stats.floor * 10) / 10,
        ceiling: Math.round(stats.ceiling * 10) / 10,
        stdDev: Math.round(stdDev * 10) / 10,
        hotStreakPct: Math.round(hotStreakPct * 10) / 10,
        matchupGames: matchupHistory?.games_vs || 0,
        matchupAvg: matchupHistory?.avg_vs ? Math.round(matchupHistory.avg_vs * 10) / 10 : null,
        matchupBest: matchupHistory?.best_vs ? Math.round(matchupHistory.best_vs * 10) / 10 : null
      };

      // Categorize the player
      if (hotStreakPct >= 15) {
        insights.hotStreaks.push({ ...playerInsight, reason: `+${Math.round(hotStreakPct)}% above season avg` });
      }
      if (hotStreakPct <= -15) {
        insights.coldStreaks.push({ ...playerInsight, reason: `${Math.round(hotStreakPct)}% below season avg` });
      }
      if (matchupHistory?.games_vs >= 1 && matchupHistory.avg_vs > seasonAvg * 1.1) {
        insights.matchupAdvantages.push({
          ...playerInsight,
          reason: `Avg ${Math.round(matchupHistory.avg_vs * 10) / 10} vs ${opponent} (${matchupHistory.games_vs} games)`
        });
      }
      if (stdDev / seasonAvg < 0.25 && stats.games >= 5) {
        insights.consistentPlays.push({
          ...playerInsight,
          consistencyScore: Math.round((1 / (stdDev / seasonAvg)) * 10) / 10,
          reason: `Low variance (${Math.round(stdDev * 10) / 10} std dev)`
        });
      }
      if (stdDev > 12 && stats.ceiling >= 50) {
        insights.boomCandidates.push({
          ...playerInsight,
          boomRate: Math.round((allGames.filter(g => g.dk_fantasy_points >= 50).length / allGames.length) * 1000) / 10,
          reason: `High ceiling (${Math.round(stats.ceiling)} max), ${Math.round(stdDev * 10) / 10} std dev`
        });
      }

      // Add to recent performers if they've been solid
      if (last3Avg >= 30) {
        insights.recentPerformers.push({
          ...playerInsight,
          reason: `${Math.round(last3Avg * 10) / 10} avg last 3 games`
        });
      }
    }

    // Sort each category
    insights.hotStreaks.sort((a, b) => b.hotStreakPct - a.hotStreakPct);
    insights.coldStreaks.sort((a, b) => a.hotStreakPct - b.hotStreakPct);
    insights.matchupAdvantages.sort((a, b) => (b.matchupAvg || 0) - (a.matchupAvg || 0));
    insights.consistentPlays.sort((a, b) => b.consistencyScore - a.consistencyScore);
    insights.boomCandidates.sort((a, b) => b.ceiling - a.ceiling);
    insights.recentPerformers.sort((a, b) => b.last3Avg - a.last3Avg);

    // Limit results
    insights.hotStreaks = insights.hotStreaks.slice(0, 10);
    insights.coldStreaks = insights.coldStreaks.slice(0, 10);
    insights.matchupAdvantages = insights.matchupAdvantages.slice(0, 10);
    insights.consistentPlays = insights.consistentPlays.slice(0, 10);
    insights.boomCandidates = insights.boomCandidates.slice(0, 10);
    insights.recentPerformers = insights.recentPerformers.slice(0, 10);

    return insights;
  }

  /**
   * Detect usage bump opportunities for tonight's slate
   * Compares slate roster against historical roster to find missing high-usage players
   * Then calculates which remaining players benefit most when those players are out
   *
   * @param {Array} slatePlayers - Players on tonight's slate
   * @param {number} minGames - Minimum games for a player to be considered "regular"
   * @param {number} minAvgDk - Minimum avg DK points to be considered "high-usage"
   */
  async detectUsageBumps(slatePlayers, minGames = 8, minAvgDk = 25) {
    // Group slate players by team
    const slateByTeam = {};
    for (const player of slatePlayers) {
      if (!slateByTeam[player.team]) {
        slateByTeam[player.team] = [];
      }
      slateByTeam[player.team].push(player.name);
    }

    const usageBumps = [];

    // For each team on the slate, check for missing high-usage players
    for (const [team, slateRoster] of Object.entries(slateByTeam)) {
      // Get historical regular players for this team (played recently and significant minutes)
      let historicalRoster;
      if (DATABASE_TYPE === 'azuresql') {
        historicalRoster = await db.all(`
          SELECT
            player_name,
            COUNT(*) as games,
            ROUND(AVG(dk_fantasy_points), 1) as avg_dk,
            ROUND(AVG(minutes), 1) as avg_min,
            MAX(game_date) as last_game
          FROM historical_games
          WHERE team = @team
            AND game_date >= DATEADD(day, -30, GETDATE())
          GROUP BY player_name
          HAVING COUNT(*) >= @minGames AND ROUND(AVG(dk_fantasy_points), 1) >= @minAvgDk
          ORDER BY avg_dk DESC
        `, { team, minGames: Math.min(minGames, 5), minAvgDk });
      } else {
        historicalRoster = await db.all(`
          SELECT
            player_name,
            COUNT(*) as games,
            ROUND(AVG(dk_fantasy_points), 1) as avg_dk,
            ROUND(AVG(minutes), 1) as avg_min,
            MAX(game_date) as last_game
          FROM historical_games
          WHERE team = ?
            AND game_date >= date('now', '-30 days')
          GROUP BY player_name
          HAVING games >= ? AND avg_dk >= ?
          ORDER BY avg_dk DESC
        `, team, Math.min(minGames, 5), minAvgDk);
      }

      // Find missing high-usage players (in historical but not on slate)
      const missingPlayers = historicalRoster.filter(histPlayer => {
        // Check if this player is NOT on tonight's slate (normalized name match)
        const histNameNorm = this.normalizeName(histPlayer.player_name);
        const histLastName = histNameNorm.split(' ').pop();

        const isOnSlate = slateRoster.some(slateName => {
          const slateNameNorm = this.normalizeName(slateName);
          const slateLastName = slateNameNorm.split(' ').pop();
          // Match full name or last name
          return histNameNorm === slateNameNorm ||
                 histLastName === slateLastName ||
                 histNameNorm.includes(slateLastName) ||
                 slateNameNorm.includes(histLastName);
        });
        return !isOnSlate;
      });

      // For each missing player, find who benefits when they're out
      for (const missingPlayer of missingPlayers) {
        // Get game dates where this player didn't play (0 minutes or not in game)
        let gamesWithout;
        if (DATABASE_TYPE === 'azuresql') {
          gamesWithout = await db.all(`
            SELECT DISTINCT TOP 20 game_date
            FROM historical_games
            WHERE team = @team
              AND game_date NOT IN (
                SELECT game_date FROM historical_games
                WHERE player_name = @playerName AND team = @team AND minutes > 5
              )
            ORDER BY game_date DESC
          `, { team, playerName: missingPlayer.player_name });
        } else {
          gamesWithout = await db.all(`
            SELECT DISTINCT game_date
            FROM historical_games
            WHERE team = ?
              AND game_date NOT IN (
                SELECT game_date FROM historical_games
                WHERE player_name = ? AND team = ? AND minutes > 5
              )
            ORDER BY game_date DESC
            LIMIT 20
          `, team, missingPlayer.player_name, team);
        }

        if (gamesWithout.length < 2) continue;

        const gameDatesWithout = gamesWithout.map(g => g.game_date);

        // For each player on tonight's slate from this team, calculate their stats WITH vs WITHOUT
        for (const slateName of slateRoster) {
          // Normalize the slate player name for matching
          const slateNameNorm = this.normalizeName(slateName);
          const slateLastName = slateNameNorm.split(' ').pop();

          // Get all potential matches from historical data
          let potentialMatches;
          if (DATABASE_TYPE === 'azuresql') {
            potentialMatches = await db.all(`
              SELECT DISTINCT player_name FROM historical_games WHERE team = @team
            `, { team });
          } else {
            potentialMatches = await db.all(`
              SELECT DISTINCT player_name FROM historical_games WHERE team = ?
            `, team);
          }

          // Find the best match using normalized names
          const matchedPlayer = potentialMatches.find(p => {
            const histNameNorm = this.normalizeName(p.player_name);
            const histLastName = histNameNorm.split(' ').pop();
            return histNameNorm === slateNameNorm ||
                   histLastName === slateLastName ||
                   histNameNorm.includes(slateLastName) ||
                   slateNameNorm.includes(histLastName);
          });

          if (!matchedPlayer) continue;

          const playerName = matchedPlayer.player_name;

          // Stats when missing player is OUT
          let statsWithout, statsWith;
          if (DATABASE_TYPE === 'azuresql') {
            const placeholders = gameDatesWithout.map((_, i) => `@date${i}`).join(',');
            const dateParams = {};
            gameDatesWithout.forEach((d, i) => dateParams[`date${i}`] = d);

            statsWithout = await db.get(`
              SELECT
                COUNT(*) as games,
                AVG(dk_fantasy_points) as avg_dk,
                AVG(minutes) as avg_min
              FROM historical_games
              WHERE player_name = @playerName AND team = @team AND game_date IN (${placeholders})
            `, { playerName, team, ...dateParams });

            statsWith = await db.get(`
              SELECT
                COUNT(*) as games,
                AVG(dk_fantasy_points) as avg_dk,
                AVG(minutes) as avg_min
              FROM historical_games
              WHERE player_name = @playerName AND team = @team AND game_date NOT IN (${placeholders})
            `, { playerName, team, ...dateParams });
          } else {
            const placeholders = gameDatesWithout.map(() => '?').join(',');

            statsWithout = await db.get(`
              SELECT
                COUNT(*) as games,
                AVG(dk_fantasy_points) as avg_dk,
                AVG(minutes) as avg_min
              FROM historical_games
              WHERE player_name = ? AND team = ? AND game_date IN (${placeholders})
            `, playerName, team, ...gameDatesWithout);

            statsWith = await db.get(`
              SELECT
                COUNT(*) as games,
                AVG(dk_fantasy_points) as avg_dk,
                AVG(minutes) as avg_min
              FROM historical_games
              WHERE player_name = ? AND team = ? AND game_date NOT IN (${placeholders})
            `, playerName, team, ...gameDatesWithout);
          }

          // Calculate the bump
          if (statsWithout?.games >= 2 && statsWith?.games >= 3 && statsWithout.avg_dk && statsWith.avg_dk) {
            const dkBump = statsWithout.avg_dk - statsWith.avg_dk;
            const pctBump = ((statsWithout.avg_dk - statsWith.avg_dk) / statsWith.avg_dk) * 100;
            const minBump = (statsWithout.avg_min || 0) - (statsWith.avg_min || 0);

            // Only include if there's a meaningful positive bump (at least 5% increase)
            if (pctBump >= 5) {
              // Find the slate player object to get salary/projection (using normalized names)
              const slatePlayer = slatePlayers.find(p => {
                const pNameNorm = this.normalizeName(p.name);
                const pLastName = pNameNorm.split(' ').pop();
                return pNameNorm === slateNameNorm ||
                       pLastName === slateLastName ||
                       pNameNorm.includes(slateLastName) ||
                       slateNameNorm.includes(pLastName);
              });

              // Get additional slate player data
              const projectedMinutes = slatePlayer?.projected_minutes || null;
              const position = slatePlayer?.position || slatePlayer?.roster_position || null;
              const opponentTeam = slatePlayer?.opponent || null;

              // Calculate expected DK with bump applied to projection
              const projectedDk = slatePlayer?.projected_points || 0;
              const bumpedProjection = projectedDk > 0
                ? Math.round((projectedDk * (1 + pctBump / 100)) * 10) / 10
                : Math.round(statsWithout.avg_dk * 10) / 10;

              // Calculate value score (projected DK / salary * 1000)
              const salary = slatePlayer?.salary || 0;
              const valueScore = salary > 0
                ? Math.round((bumpedProjection / salary) * 10000) / 10
                : 0;

              // Calculate "confidence" based on sample size
              const sampleSize = statsWithout.games + statsWith.games;
              const confidence = sampleSize >= 20 ? 'High' : sampleSize >= 10 ? 'Medium' : 'Low';

              usageBumps.push({
                player: slateName,
                team,
                position,
                opponent: opponentTeam,
                salary,
                projection: projectedDk,
                projectedMinutes,
                bumpedProjection,
                valueScore,
                missingPlayer: missingPlayer.player_name,
                missingPlayerAvg: missingPlayer.avg_dk,
                gamesWithout: statsWithout.games,
                gamesWith: statsWith.games,
                avgWithout: Math.round(statsWithout.avg_dk * 10) / 10,
                avgWith: Math.round(statsWith.avg_dk * 10) / 10,
                avgMinWithout: Math.round((statsWithout.avg_min || 0) * 10) / 10,
                avgMinWith: Math.round((statsWith.avg_min || 0) * 10) / 10,
                dkBump: Math.round(dkBump * 10) / 10,
                pctBump: Math.round(pctBump * 10) / 10,
                minBump: Math.round(minBump * 10) / 10,
                confidence,
                reason: `+${Math.round(dkBump * 10) / 10} DK pts (+${Math.round(pctBump)}%) when ${missingPlayer.player_name} is OUT`
              });
            }
          }
        }
      }
    }

    // Sort by percentage bump and remove duplicates (keep highest bump per player)
    const uniqueBumps = {};
    for (const bump of usageBumps) {
      const key = bump.player;
      if (!uniqueBumps[key] || bump.pctBump > uniqueBumps[key].pctBump) {
        uniqueBumps[key] = bump;
      }
    }

    // Sort by a composite score that prioritizes:
    // 1. Players with projected minutes (they're likely to play)
    // 2. Higher value scores (better bang for buck)
    // 3. Higher percentage bumps
    // 4. Sample size confidence
    return Object.values(uniqueBumps)
      .sort((a, b) => {
        // Primary: Sort by projected minutes (descending, null last)
        const aMin = a.projectedMinutes || 0;
        const bMin = b.projectedMinutes || 0;
        if (aMin !== bMin && (aMin === 0 || bMin === 0)) {
          return bMin - aMin; // Non-zero minutes first
        }

        // Secondary: Sort by value score (descending)
        if (a.valueScore !== b.valueScore) {
          return b.valueScore - a.valueScore;
        }

        // Tertiary: Sort by percentage bump
        return b.pctBump - a.pctBump;
      })
      .slice(0, 15);
  }

  /**
   * Get a summary of missing players for each team on the slate
   */
  async getMissingPlayersReport(slatePlayers, minGames = 5, minAvgDk = 20) {
    // Group slate players by team
    const slateByTeam = {};
    for (const player of slatePlayers) {
      if (!slateByTeam[player.team]) {
        slateByTeam[player.team] = [];
      }
      slateByTeam[player.team].push(player.name);
    }

    const report = [];

    for (const [team, slateRoster] of Object.entries(slateByTeam)) {
      // Get historical regular players for this team
      let historicalRoster;
      if (DATABASE_TYPE === 'azuresql') {
        historicalRoster = await db.all(`
          SELECT
            player_name,
            COUNT(*) as games,
            ROUND(AVG(dk_fantasy_points), 1) as avg_dk,
            ROUND(AVG(minutes), 1) as avg_min,
            MAX(game_date) as last_game
          FROM historical_games
          WHERE team = @team
            AND game_date >= DATEADD(day, -30, GETDATE())
          GROUP BY player_name
          HAVING COUNT(*) >= @minGames AND ROUND(AVG(dk_fantasy_points), 1) >= @minAvgDk
          ORDER BY avg_dk DESC
        `, { team, minGames, minAvgDk });
      } else {
        historicalRoster = await db.all(`
          SELECT
            player_name,
            COUNT(*) as games,
            ROUND(AVG(dk_fantasy_points), 1) as avg_dk,
            ROUND(AVG(minutes), 1) as avg_min,
            MAX(game_date) as last_game
          FROM historical_games
          WHERE team = ?
            AND game_date >= date('now', '-30 days')
          GROUP BY player_name
          HAVING games >= ? AND avg_dk >= ?
          ORDER BY avg_dk DESC
        `, team, minGames, minAvgDk);
      }

      // Find missing players (using normalized names to handle diacritics like Dončić vs Doncic)
      const missingPlayers = historicalRoster.filter(histPlayer => {
        const histNameNorm = this.normalizeName(histPlayer.player_name);
        const histLastName = histNameNorm.split(' ').pop();

        const isOnSlate = slateRoster.some(slateName => {
          const slateNameNorm = this.normalizeName(slateName);
          const slateLastName = slateNameNorm.split(' ').pop();
          // Match full name or last name
          return histNameNorm === slateNameNorm ||
                 histLastName === slateLastName ||
                 histNameNorm.includes(slateLastName) ||
                 slateNameNorm.includes(histLastName);
        });
        return !isOnSlate;
      });

      if (missingPlayers.length > 0) {
        report.push({
          team,
          slatePlayerCount: slateRoster.length,
          missingPlayers: missingPlayers.map(p => ({
            name: p.player_name,
            avgDk: p.avg_dk,
            avgMin: p.avg_min,
            games: p.games,
            lastGame: p.last_game
          }))
        });
      }
    }

    return report.sort((a, b) => {
      // Sort by total missing DK production
      const aTotalDk = a.missingPlayers.reduce((sum, p) => sum + p.avgDk, 0);
      const bTotalDk = b.missingPlayers.reduce((sum, p) => sum + p.avgDk, 0);
      return bTotalDk - aTotalDk;
    });
  }
}

export default new NBAStatsService();
