/**
 * RotoWire players.php payload entries, trimmed from a real 2026-27 slate
 * response (raw_data). Field names and shapes match what RotoWire sends:
 * injuryStatus is a string or null, lineup.isConfirmed is a boolean.
 */

const base = {
  slateID: 30011,
  pos: ['C', 'UTIL'],
  rotoPos: 'C',
  isHome: true,
  game: { dateTime: '2026-10-20 21:30:00' },
  odds: { moneyline: '100', overUnder: '231.0', spread: '1.0', impliedPts: 115, impliedWinProb: 48.3 },
  stats: {
    season: { games: 86, minutes: '30.4' },
    advanced: { per: '30.38', usage: '32.43', rest: '2' },
    avgFpts: { last3: '54.1', last5: '53.6', last7: '51.8', last14: '53.1', season: '52.5' }
  }
};

export const questionableConfirmedStarter = {
  ...base,
  rwID: 5809,
  firstName: 'Victor',
  lastName: 'Wembanyama',
  injuryStatus: 'QUES',
  imageURL: 'https://assets.rotowire.com/images/headshots/nba/imagn-811889.jpg',
  team: { abbr: 'SAS', city: 'San Antonio', nickname: 'Spurs' },
  opponent: { team: 'PHX' },
  salary: 10500,
  pts: '49.20',
  rostership: 7.5,
  minutes: 31,
  lineup: { slot: 'Yes', isConfirmed: true }
};

export const healthyUnconfirmed = {
  ...base,
  rwID: 6001,
  firstName: 'Bench',
  lastName: 'Guard',
  pos: ['PG', 'SG', 'G', 'UTIL'],
  rotoPos: 'PG',
  injuryStatus: null,
  team: { abbr: 'PHX', city: 'Phoenix', nickname: 'Suns' },
  opponent: { team: 'SAS' },
  salary: 4200,
  pts: '22.10',
  rostership: 3.1,
  minutes: 24,
  lineup: { slot: 'No', isConfirmed: false }
};

export const noLineupBlock = {
  ...base,
  rwID: 6002,
  firstName: 'Two',
  lastName: 'Way',
  team: { abbr: 'SAS' },
  opponent: { team: 'PHX' },
  salary: 3000,
  pts: '8.50',
  minutes: 10
};
