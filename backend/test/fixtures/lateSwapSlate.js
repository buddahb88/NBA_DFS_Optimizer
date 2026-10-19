// Fake 4-game slate for late swap tests, plus writers for DK / FD entries files
// laid out like the real downloads (entries on the left, player list on the right).
import { toCsv } from '../../src/services/lateSwap/entriesCsv.js';

export const GAMES = [
  { away: 'LAL', home: 'BOS', time: '10/17/2026 07:00PM ET' },
  { away: 'DAL', home: 'SAS', time: '10/17/2026 07:30PM ET' },
  { away: 'GSW', home: 'PHX', time: '10/17/2026 10:00PM ET' },
  { away: 'NYK', home: 'MIA', time: '10/17/2026 10:30PM ET' }
];

// UTC instants around the tips (EDT = UTC-4)
export const BEFORE_ALL = '2026-10-17T22:00:00Z'; // 6:00 PM ET
export const AFTER_EARLY = '2026-10-18T00:15:00Z'; // 8:15 PM ET: first two games locked

// [position, salary, projection]
const TEMPLATE = [
  ['PG', 9600, 48],
  ['SG', 7000, 34],
  ['SF', 6200, 30],
  ['PF', 5400, 27],
  ['C', 8200, 41],
  ['PG/SG', 4600, 22],
  ['SF/PF', 4000, 19],
  ['PF/C', 3400, 16]
];

export function buildSlate() {
  const players = [];
  let n = 0;
  GAMES.forEach((g, gi) => {
    [g.away, g.home].forEach((team, side) => {
      const opponent = side === 0 ? g.home : g.away;
      TEMPLATE.forEach(([position, salary, proj], k) => {
        n++;
        players.push({
          siteId: String(1000 + n),
          name: `${team} Player ${k + 1}`,
          team,
          opponent,
          position,
          salary: salary + gi * 100 - side * 200,
          projection: proj + gi * 0.9 + side * 0.4,
          gameInfo: `${g.away}@${g.home} ${g.time}`
        });
      });
    });
  });
  return players;
}

/** DB rows as playerModel returns them (RotoWire ids, comma positions, no site ids). */
export function toDbRows(players, { injuries = {}, projections = {} } = {}) {
  return players.map((p, i) => ({
    id: i + 1,
    player_id: `rw${i + 1}`,
    site_player_id: null,
    name: p.name,
    team: p.team,
    opponent: p.opponent,
    position: p.position.replace('/', ','),
    salary: p.salary,
    projected_points: projections[p.name] ?? p.projection,
    injury_status: injuries[p.name] ?? null,
    raw_data: null,
    game_info: `${p.team} vs ${p.opponent}`
  }));
}

const DK_SLOTS = ['PG', 'SG', 'SF', 'PF', 'C', 'G', 'F', 'UTIL'];

/**
 * DKEntries.csv. lineups: array of 8-length arrays of player siteIds (or null),
 * optional `locked` set of siteIds rendered with DK's " (LOCKED)" suffix.
 */
export function dkEntriesCsv(players, lineups, { locked = new Set() } = {}) {
  const byId = new Map(players.map(p => [p.siteId, p]));
  const left = lineups.map((ids, i) => [
    String(4500000000 + i),
    'NBA $5 Late Swap Special',
    '170000001',
    '$5',
    ...ids.map(id => (id ? `${byId.get(id).name} (${id})${locked.has(id) ? ' (LOCKED)' : ''}` : ''))
  ]);
  const tableHeader = ['Position', 'Name + ID', 'Name', 'ID', 'Roster Position', 'Salary', 'Game Info', 'TeamAbbrev', 'AvgPointsPerGame'];
  const table = players.map(p => [
    p.position, `${p.name} (${p.siteId})`, p.name, p.siteId, `${p.position}/UTIL`, p.salary, p.gameInfo, p.team, p.projection
  ]);
  // DK: instructions in column 13, player table header a few rows down at column 13
  const rows = [['Entry ID', 'Contest Name', 'Contest ID', 'Entry Fee', ...DK_SLOTS, '', 'Instructions']];
  const instructions = ['1. Locate the player you want to select in the list below', '2. Copy the ID of your player', ''];
  const total = Math.max(left.length, instructions.length + 1 + table.length);
  for (let r = 0; r < total; r++) {
    const row = left[r] ? [...left[r], ''] : new Array(13).fill('');
    if (r < instructions.length) row.push(instructions[r]);
    else if (r === instructions.length) row.push(...tableHeader);
    else if (table[r - instructions.length - 1]) row.push(...table[r - instructions.length - 1]);
    rows.push(row);
  }
  return toCsv(rows);
}

/** FanDuel-style entries file with its player list (no game times, FD id:name cells). */
export function fdEntriesCsv(fdPlayers, lineups) {
  const byId = new Map(fdPlayers.map(p => [p.siteId, p]));
  const rows = [['entry_id', 'contest_id', 'contest_name', 'entry_fee', 'PG', 'PG', 'SG', 'SG', 'SF', 'SF', 'PF', 'PF', 'C', '', 'Instructions']];
  lineups.forEach((ids, i) => rows.push([
    String(900 + i), '12345-678', 'NBA Hoops', '5', ...ids.map(id => (id ? `${id}:${byId.get(id).name}` : '')), '', ''
  ]));
  rows.push(new Array(14).fill('').concat(['Player ID + Player Name', 'Id', 'Position', 'First Name', 'Nickname', 'Last Name', 'FPPG', 'Played', 'Salary', 'Game', 'Team', 'Opponent', 'Injury Indicator', 'Injury Details']));
  fdPlayers.forEach(p => rows.push(new Array(14).fill('').concat([
    `${p.siteId}:${p.name}`, p.siteId, p.position, p.name.split(' ')[0], p.name, p.name.split(' ').slice(1).join(' '),
    p.projection, 20, p.salary, `${p.team}@${p.opponent}`, p.team, p.opponent, p.injury ?? '', ''
  ])));
  return toCsv(rows);
}
