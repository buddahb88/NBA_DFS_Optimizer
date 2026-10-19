/**
 * GAME START TIMES / LOCKS
 *
 * DFS sites lock each player at his game's scheduled tip. Times come from
 * (highest priority first): request overrides, the entries file's "Game Info"
 * column (DK: "DAL@SAS 10/17/2026 08:30PM ET"), then the DB player rows.
 */

// Site / data-feed abbreviations that differ for the same team -> one canonical code
const TEAM_ALIASES = {
  GS: 'GSW', GOS: 'GSW',
  NY: 'NYK', NYC: 'NYK',
  SA: 'SAS', SAN: 'SAS',
  NO: 'NOP', NOR: 'NOP', NOH: 'NOP',
  PHO: 'PHX',
  WSH: 'WAS',
  UTAH: 'UTA', UTH: 'UTA',
  BRK: 'BKN', BK: 'BKN',
  CHO: 'CHA'
};

export function normalizeTeam(team) {
  if (team == null) return null;
  const t = String(team).trim().toUpperCase();
  if (!t) return null;
  return TEAM_ALIASES[t] || t;
}

const NY_FORMAT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
});

/** America/New_York UTC offset in minutes at a UTC timestamp (e.g. -240 in EDT). */
function nyOffsetMinutes(ts) {
  const parts = Object.fromEntries(NY_FORMAT.formatToParts(new Date(ts)).map(p => [p.type, p.value]));
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute);
  return Math.round((asUtc - Math.floor(ts / 60000) * 60000) / 60000);
}

/** Wall-clock US Eastern time -> Date (DST-aware). */
export function easternToDate(year, month, day, hour, minute) {
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  let ts = wall + 5 * 3600000; // EST guess, then correct with the real offset
  for (let i = 0; i < 2; i++) ts = wall - nyOffsetMinutes(ts) * 60000;
  return new Date(ts);
}

/**
 * Parse a start time. Accepts ISO strings with a zone ("2026-10-17T23:30:00Z"),
 * zone-less "YYYY-MM-DD HH:MM[:SS]" (read as US Eastern, like the data feeds),
 * "MM/DD/YYYY hh:mmAM ET", Dates and epoch millis. Returns Date or null.
 */
export function parseStartTime(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === 'number') return Number.isFinite(value) ? new Date(value) : null;
  const s = String(value).trim();

  let m = s.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (m) {
    let hour = Number(m[4]) % 12;
    if (m[6].toUpperCase() === 'PM') hour += 12;
    return easternToDate(+m[3], +m[1], +m[2], hour, +m[5]);
  }
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(s)) {
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
  if (m) return easternToDate(+m[1], +m[2], +m[3], +m[4], +m[5]);
  return null;
}

/** DK "DAL@SAS 10/17/2026 08:30PM ET" / FD "DAL@SAS" -> { away, home, startTime } */
export function parseGameInfo(text) {
  const s = String(text ?? '').trim();
  const teams = s.match(/^([A-Za-z]{2,4})\s*@\s*([A-Za-z]{2,4})/);
  return {
    away: teams ? teams[1].toUpperCase() : null,
    home: teams ? teams[2].toUpperCase() : null,
    startTime: parseStartTime(s)
  };
}

/** Best-effort start time from a DB player row (raw RotoWire JSON, then game_info). */
export function startTimeFromDbPlayer(row) {
  if (row?.raw_data) {
    try {
      const raw = typeof row.raw_data === 'string' ? JSON.parse(row.raw_data) : row.raw_data;
      const t = parseStartTime(raw?.game?.dateTime ?? raw?.game?.date_time ?? raw?.gameTime ?? null);
      if (t) return t;
    } catch {
      // raw_data is optional and free-form
    }
  }
  return parseStartTime(row?.game_info);
}

/**
 * Decide which teams are locked.
 * @param {object} opts
 *   teamTimes   Map<team, Date> collected from the file / DB
 *   gameTimes   request overrides { TEAM: time }
 *   lockedTeams request overrides: always locked
 *   now         Date
 * @returns {{ isLocked(team): boolean, startOf(team): Date|null, hasTime(team): boolean }}
 */
export function buildLockState({ teamTimes = new Map(), gameTimes = {}, lockedTeams = [], now = new Date() }) {
  const starts = new Map();
  for (const [team, t] of teamTimes) {
    const key = normalizeTeam(team);
    if (key && t) starts.set(key, t);
  }
  for (const [team, value] of Object.entries(gameTimes || {})) {
    const t = parseStartTime(value);
    if (t) starts.set(normalizeTeam(team), t);
  }
  const forced = new Set((lockedTeams || []).map(normalizeTeam).filter(Boolean));
  const nowMs = now.getTime();

  const isLocked = (team) => {
    const key = normalizeTeam(team);
    if (!key) return false;
    if (forced.has(key)) return true;
    const t = starts.get(key);
    return Boolean(t && t.getTime() <= nowMs);
  };

  return {
    isLocked,
    startOf: (team) => starts.get(normalizeTeam(team)) ?? null,
    hasTime: (team) => starts.has(normalizeTeam(team)) || forced.has(normalizeTeam(team))
  };
}
