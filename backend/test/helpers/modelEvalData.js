/**
 * Seeded feature-store data for the model evaluation tests: two seasons of a
 * small league (4 teams, 5 players each) with deterministic box scores, team
 * totals, and inactive / DNP listings. Shapes match loadFeatureData().
 */

import { playerKey } from '../../src/utils/playerKey.js';

export const TEAMS = ['AAA', 'BBB', 'CCC', 'DDD'];
// [name suffix, minutes, points scale, starter]
const ROLES = [
  ['Star', 36, 1.6, 1], ['Wing', 32, 1.1, 1], ['Big', 30, 1.0, 1], ['Sixth', 22, 0.8, 0], ['Deep', 10, 0.5, 0]
];

export const nameOf = (team, role) => `${team} ${role}`;

const addDays = (date, n) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/** Every other day from `start`, `count` dates; AAA-BBB and CCC-DDD play each date (home alternates). */
export function scheduleDates(start, count, step = 2) {
  return Array.from({ length: count }, (_, i) => addDays(start, i * step));
}

/**
 * @param {Object} [options]
 * @param {Object<string,string[]>} [options.seasons] - season -> dates
 * @param {Function} [options.skip] - (name, date) => 'inactive' | 'dnp' | 'missing' | null
 */
export function buildData({ seasons = {
  '2024-25': scheduleDates('2024-11-01', 20),
  '2025-26': scheduleDates('2025-11-01', 20)
}, skip = () => null } = {}) {
  const games = [];
  const teamGames = [];
  const statuses = [];
  let id = 0;
  for (const [season, dates] of Object.entries(seasons)) {
    dates.forEach((date, d) => {
      for (const [home, away] of [['AAA', 'BBB'], ['CCC', 'DDD']]) {
        const gameId = `${season}-${d}-${home}`;
        const homeIsFirst = d % 2 === 0;
        for (const [team, opponent] of [[home, away], [away, home]]) {
          const isHome = (team === home) === homeIsFirst ? 1 : 0;
          const totals = { pts: 0, fga: 0, fgm: 0, fta: 0, tov: 0, oreb: 0, dreb: 0, fg3a: 0 };
          ROLES.forEach(([role, minutes, scale, starter], r) => {
            const name = nameOf(team, role);
            const s = skip(name, date);
            if (s === 'inactive' || s === 'dnp') {
              statuses.push({ game_id: gameId, game_date: date, team, player_key: playerKey(name), player_name: name,
                status: s === 'inactive' ? 'INACTIVE' : 'DNP', reason: s === 'inactive' ? 'ANKLE' : "COACH'S DECISION" });
              return;
            }
            if (s === 'missing') return;
            const wobble = ((d * 7 + r * 3 + team.charCodeAt(0)) % 9) - 4;
            const pts = Math.max(0, Math.round(scale * (14 + wobble)));
            const reb = 2 + ((d + r) % 6);
            const ast = 1 + ((d * 3 + r) % 5);
            const stl = (d + r) % 2;
            const blk = (d + 2 * r) % 2;
            const tov = 1 + ((d + r) % 3);
            const fg3 = (d + r) % 4;
            const dk = pts + 0.5 * fg3 + 1.25 * reb + 1.5 * ast + 2 * stl + 2 * blk - 0.5 * tov;
            const fga = Math.round(pts / 1.1) + 1;
            totals.pts += pts; totals.fga += fga; totals.fgm += Math.round(pts / 2.3); totals.fta += 2;
            totals.tov += tov; totals.oreb += 1; totals.dreb += reb - 1; totals.fg3a += fg3 * 2 + 1;
            games.push({
              id: ++id, player_name: name, player_key: playerKey(name), team, opponent, position: r === 2 ? 'C' : r === 0 ? 'G' : 'F',
              game_id: gameId, game_date: date, season, season_type: 'regular', is_home: isHome, is_starter: starter,
              minutes: minutes + (wobble % 3), points: pts, rebounds: reb, assists: ast, steals: stl, blocks: blk, turnovers: tov,
              fouls: 2, fg_made: Math.round(pts / 2.3), fg_attempted: fga, fg3_made: fg3, fg3_attempted: fg3 * 2 + 1,
              ft_made: 1, ft_attempted: 2, oreb: 1, dreb: reb - 1,
              dk_fantasy_points: dk, fd_fantasy_points: dk, yahoo_fantasy_points: dk, is_back_to_back: 0
            });
          });
          teamGames.push({
            game_id: gameId, game_date: date, season, season_type: 'regular', team, opponent, is_home: isHome,
            minutes: 240, pts: totals.pts, fgm: totals.fgm, fga: totals.fga, fg3m: 8, fg3a: totals.fg3a, ftm: 10,
            fta: totals.fta, oreb: totals.oreb, dreb: totals.dreb, ast: 20, tov: totals.tov, stl: 6, blk: 4, pf: 18,
            possessions: 95 + (d % 5) + (team === 'AAA' ? 6 : 0)
          });
        }
      }
    });
  }
  return { site: 'draftkings', games, teamGames, statuses };
}

/** Copy of `data` with every row on/after `date` replaced by wild values, plus extra games after it. */
export function poisonFrom(data, date) {
  const wild = (r) => (r.game_date >= date
    ? { ...r, minutes: 48, points: 90, rebounds: 30, assists: 25, dk_fantasy_points: 200, fd_fantasy_points: 200,
      yahoo_fantasy_points: 200, is_starter: 1 - (r.is_starter ?? 0) }
    : r);
  const wildTeam = (r) => (r.game_date >= date ? { ...r, pts: 199, possessions: 140 } : r);
  const extra = data.games.filter(r => r.game_date >= date).map((r, i) => ({
    ...wild(r), id: 100000 + i, game_date: addDays(r.game_date, 1), game_id: `${r.game_id}-x`, opponent: r.team === 'AAA' ? 'CCC' : r.opponent
  }));
  return {
    ...data,
    games: [...data.games.map(wild), ...extra],
    teamGames: data.teamGames.map(wildTeam),
    statuses: [...data.statuses, ...data.games.filter(r => r.game_date >= date).slice(0, 5).map(r => ({
      game_id: r.game_id, game_date: r.game_date, team: r.team, player_key: r.player_key, player_name: r.player_name, status: 'INACTIVE', reason: 'X'
    }))]
  };
}
