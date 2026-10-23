/**
 * SALARY CSV IMPORT
 *
 * Imports the official player/salary CSV each DFS site publishes, so players
 * carry the site's own player ID (needed for bulk lineup upload):
 *   - DraftKings DKSalaries.csv: Position, Name + ID, Name, ID, Roster Position,
 *     Salary, Game Info, TeamAbbrev, AvgPointsPerGame
 *   - FanDuel players list: Id, Position, First Name, Nickname, Last Name, FPPG,
 *     Salary, Game, Team, Opponent, Injury Indicator
 *   - Yahoo player list: columns found by header; IDs look like nba.p.1234
 *
 * Each CSV player is matched by normalized name (+ team) to, in order:
 *   1. a player already on the target slate (row is updated in place)
 *   2. a projected player on another slate (projection columns are copied)
 *   3. a historical_games player (name is aligned with history)
 * Anything else is inserted with the CSV's average points and reported as unmatched.
 */

import db, { DATABASE_TYPE } from '../config/database.js';
import { getSiteConfig, getEligibleSlots, isValidSite } from '../config/sites.js';
import { parseCsv } from '../utils/csvParser.js';
import { normalizeName, normalizeTeam } from '../utils/nameNormalizer.js';
import { easternToIso, snapshotSlate } from './slateSnapshotService.js';
import { recomputeSlateRanges } from './variance/outcomeRangeService.js';

export class SalaryImportError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const NBA_POSITIONS = ['PG', 'SG', 'SF', 'PF', 'C'];
const OUT_STATUSES = new Set(['O', 'OUT', 'INJ', 'IR', 'NA', 'SUSP']);

// Header aliases (lowercase). First match wins.
const COLUMNS = {
  id: ['id', 'player id', 'playerid'],
  nameId: ['name + id'],
  name: ['name', 'player name', 'player'],
  nickname: ['nickname'],
  firstName: ['first name', 'firstname'],
  lastName: ['last name', 'lastname'],
  position: ['position', 'pos'],
  rosterPosition: ['roster position'],
  salary: ['salary'],
  game: ['game info', 'game'],
  time: ['time', 'start time', 'game time'],
  team: ['teamabbrev', 'team'],
  opponent: ['opponent', 'opp'],
  fppg: ['avgpointspergame', 'fppg'],
  injury: ['injury indicator', 'injury status', 'injury']
};

// Projection columns copied from a matched player on another slate
const PROJECTION_COLUMNS = [
  'projected_points', 'projected_minutes', 'value_gpp', 'per', 'usage', 'rest_days',
  'fpts_last3', 'fpts_last5', 'fpts_last7', 'fpts_last14', 'vegas_implied_total',
  'vegas_spread', 'vegas_over_under', 'vegas_win_prob', 'rostership', 'headshot',
  'dvp_pts_allowed', 'opp_def_eff', 'floor', 'ceiling', 'volatility', 'boom_probability',
  'bust_probability', 'fppm', 'leverage_score', 'blowout_risk', 'std_dev',
  'rotowire_projection', 'raw_data'
];

// ─────────────────────────────────────────────────────────────
// CSV parsing (pure)
// ─────────────────────────────────────────────────────────────

const findHeaderRow = (rows) => {
  for (let i = 0; i < Math.min(rows.length, 50); i++) {
    const cells = rows[i].map(c => c.trim().toLowerCase());
    const hasSalary = cells.includes('salary');
    const hasName = ['name', 'name + id', 'nickname', 'first name', 'player name'].some(h => cells.includes(h));
    if (hasSalary && hasName) return i;
  }
  return -1;
};

const columnIndexes = (headerRow) => {
  const cells = headerRow.map(c => c.trim().toLowerCase());
  const idx = {};
  for (const [key, aliases] of Object.entries(COLUMNS)) {
    for (const alias of aliases) {
      const i = cells.indexOf(alias);
      if (i !== -1) {
        idx[key] = i;
        break;
      }
    }
  }
  return idx;
};

/** Guess the site from header names and ID shapes. Returns a site key or null. */
export function detectSite(headerRow, sampleIds = []) {
  const cells = new Set(headerRow.map(c => c.trim().toLowerCase()));
  if (cells.has('name + id') || cells.has('roster position') || cells.has('teamabbrev') || cells.has('avgpointspergame')) {
    return 'draftkings';
  }
  if (cells.has('nickname') || cells.has('injury indicator')) return 'fanduel';
  const ids = sampleIds.filter(Boolean);
  if (ids.length && ids.every(id => /^nba\.p\.\d+$/i.test(id))) return 'yahoo';
  if (ids.length && ids.every(id => /^\d+-\d+$/.test(id))) return 'fanduel';
  return null;
}

const parsePositions = (raw) => {
  const parts = String(raw || '').toUpperCase().split(/[/,\s]+/).filter(Boolean);
  const out = new Set();
  for (const p of parts) {
    if (NBA_POSITIONS.includes(p)) out.add(p);
    else if (p === 'G') ['PG', 'SG'].forEach(x => out.add(x));
    else if (p === 'F') ['SF', 'PF'].forEach(x => out.add(x));
  }
  return NBA_POSITIONS.filter(p => out.has(p));
};

const parseNumber = (raw) => {
  const n = parseFloat(String(raw ?? '').replace(/[$,\s]/g, ''));
  return Number.isFinite(n) ? n : null;
};

/**
 * Parse "AWAY@HOME [MM/DD/YYYY HH:MMAM ET]" into teams and an ISO UTC start time.
 * Times on DFS CSVs are US Eastern.
 */
export function parseGameInfo(raw) {
  const text = String(raw || '').trim();
  const teams = /([A-Za-z]{2,4})\s*@\s*([A-Za-z]{2,4})/.exec(text);
  const result = {
    away: teams ? normalizeTeam(teams[1]) : null,
    home: teams ? normalizeTeam(teams[2]) : null,
    startTime: null
  };
  const dt = /(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})\s*([AP]M)/i.exec(text);
  if (dt) {
    let hour = parseInt(dt[4], 10) % 12;
    if (dt[6].toUpperCase() === 'PM') hour += 12;
    result.startTime = easternToIso(+dt[3], +dt[1], +dt[2], hour, +dt[5]);
  }
  return result;
}

/**
 * Parse a site salary CSV.
 * siteHint: optional site key; must agree with the detected site when both are known.
 * Returns { site, detectedSite, players, skipped }.
 */
export function parseSalaryCsv(text, siteHint) {
  const rows = parseCsv(text);
  const headerIndex = findHeaderRow(rows);
  if (headerIndex === -1) {
    throw new SalaryImportError('Could not find a header row with player name and salary columns');
  }

  const col = columnIndexes(rows[headerIndex]);
  const dataRows = rows.slice(headerIndex + 1);
  const cell = (row, key) => (col[key] === undefined ? '' : (row[col[key]] ?? '').trim());

  const idOf = (row) => {
    const id = cell(row, 'id');
    if (id) return id;
    // DK "Name + ID": "LeBron James (12345678)"
    return /\(([^)]+)\)\s*$/.exec(cell(row, 'nameId'))?.[1]?.trim() || '';
  };

  const detectedSite = detectSite(rows[headerIndex], dataRows.slice(0, 20).map(idOf));
  const hint = siteHint ? String(siteHint).toLowerCase() : null;
  if (hint && !isValidSite(hint)) {
    throw new SalaryImportError(`Unknown site "${siteHint}"`);
  }
  if (hint && detectedSite && hint !== detectedSite) {
    throw new SalaryImportError(
      `This looks like a ${getSiteConfig(detectedSite).name} file, but ${getSiteConfig(hint).name} was selected`
    );
  }
  const site = hint || detectedSite;
  if (!site) {
    throw new SalaryImportError('Could not detect the DFS site from this file; please choose a site');
  }

  const players = [];
  const skipped = [];
  const seenIds = new Set();

  dataRows.forEach((row, i) => {
    const line = headerIndex + i + 2; // 1-based line number in the file
    const sitePlayerId = idOf(row);
    const name = cell(row, 'name')
      || cell(row, 'nickname')
      || [cell(row, 'firstName'), cell(row, 'lastName')].filter(Boolean).join(' ')
      || cell(row, 'nameId').replace(/\s*\([^)]*\)\s*$/, '');
    const salary = parseNumber(cell(row, 'salary'));
    const positions = parsePositions(cell(row, 'position'));

    if (!sitePlayerId || !name) {
      skipped.push({ line, reason: 'missing player id or name' });
      return;
    }
    if (salary === null || positions.length === 0) {
      skipped.push({ line, name, reason: 'missing salary or position' });
      return;
    }
    if (seenIds.has(sitePlayerId)) {
      skipped.push({ line, name, reason: 'duplicate player id' });
      return;
    }
    seenIds.add(sitePlayerId);

    const gameText = [cell(row, 'game'), cell(row, 'time')].filter(Boolean).join(' ');
    const game = parseGameInfo(gameText);
    const team = normalizeTeam(cell(row, 'team'));
    let opponent = normalizeTeam(cell(row, 'opponent'));
    if (!opponent && game.away && game.home) {
      opponent = team === game.away ? game.home : team === game.home ? game.away : '';
    }

    const rosterPositions = cell(row, 'rosterPosition')
      ? cell(row, 'rosterPosition').toUpperCase().split(/[/,]/).map(s => s.trim()).filter(Boolean).join('/')
      : getEligibleSlots(site, positions).join('/');

    players.push({
      sitePlayerId,
      name,
      positions,
      rosterPositions,
      salary: Math.round(salary),
      team,
      opponent: opponent || null,
      gameInfo: gameText || null,
      startTime: game.startTime,
      fppg: parseNumber(cell(row, 'fppg')),
      injuryStatus: cell(row, 'injury') || null
    });
  });

  if (players.length === 0) {
    throw new SalaryImportError('No players found in this file');
  }

  return { site, detectedSite, players, skipped };
}

// ─────────────────────────────────────────────────────────────
// Matching
// ─────────────────────────────────────────────────────────────

/**
 * Index rows for name matching. Rows earlier in the list win ties,
 * so pass them most-relevant first.
 */
export function buildNameIndex(rows, nameField = 'name', teamField = 'team') {
  const byName = new Map();
  const byTeamLast = new Map();
  for (const row of rows) {
    const key = normalizeName(row[nameField]);
    if (!key) continue;
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(row);

    const last = key.split(' ').at(-1);
    const teamKey = `${normalizeTeam(row[teamField])}|${last}`;
    if (!byTeamLast.has(teamKey)) byTeamLast.set(teamKey, []);
    byTeamLast.get(teamKey).push(row);
  }
  return { byName, byTeamLast, nameField, teamField };
}

/**
 * Find the best row for a name/team. Exact normalized-name match first
 * (preferring the same team), then same team + last name + first initial
 * when that is unambiguous. `isAvailable` filters rows already claimed.
 */
export function findNameMatch(index, name, team, isAvailable = () => true) {
  const key = normalizeName(name);
  if (!key) return null;
  const teamNorm = normalizeTeam(team);

  const exact = (index.byName.get(key) || []).filter(isAvailable);
  if (exact.length) {
    return exact.find(r => normalizeTeam(r[index.teamField]) === teamNorm) || exact[0];
  }

  const tokens = key.split(' ');
  if (tokens.length < 2 || !teamNorm) return null;
  const fuzzy = (index.byTeamLast.get(`${teamNorm}|${tokens.at(-1)}`) || [])
    .filter(isAvailable)
    .filter(r => normalizeName(r[index.nameField])[0] === tokens[0][0]);
  return fuzzy.length === 1 ? fuzzy[0] : null;
}

// ─────────────────────────────────────────────────────────────
// Database import
// ─────────────────────────────────────────────────────────────

// Points per $1,000 on a DraftKings-sized ($50k) cap so values compare across sites
const valueFor = (projected, salary, salaryCap) => {
  if (!projected || !salary) return 0;
  const dkEquivalentSalary = salary * (50000 / salaryCap);
  return Math.round((projected / (dkEquivalentSalary / 1000)) * 100) / 100;
};

const dateParam = (iso) => (iso && DATABASE_TYPE === 'azuresql' ? new Date(iso) : iso || null);

async function resolveSlate({ site, slateId, slateName, startTime, siteName }) {
  let slate = null;

  if (slateId) {
    slate = await db.get(`SELECT * FROM slates WHERE slate_id = ?`, slateId);
    if (slate && slate.site && slate.site !== site) {
      const count = await db.get(`SELECT COUNT(*) AS n FROM players WHERE slate_id = ?`, slateId);
      if ((count?.n || 0) > 0) {
        throw new SalaryImportError(
          `Slate ${slateId} is a ${getSiteConfig(slate.site).name} slate; cannot import ${siteName} salaries into it`
        );
      }
    }
  } else {
    // Default: the active slate (most recent) if it is for the same site
    const [active] = await db.all(`SELECT * FROM slates ORDER BY created_at DESC`);
    if (active && active.site === site) slate = active;
  }

  if (slate) {
    await db.run(`
      UPDATE slates SET site = ?, start_time = COALESCE(start_time, ?), updated_at = CURRENT_TIMESTAMP
      WHERE slate_id = ?
    `, site, dateParam(startTime), slate.slate_id);
    return db.get(`SELECT * FROM slates WHERE slate_id = ?`, slate.slate_id);
  }

  // New slate, named after the site and first game date
  const day = (startTime || new Date().toISOString()).slice(0, 10);
  const id = slateId || `${site}-${day.replace(/-/g, '')}`;
  const existing = await db.get(`SELECT slate_id FROM slates WHERE slate_id = ?`, id);
  if (existing) {
    await db.run(`UPDATE slates SET site = ?, updated_at = CURRENT_TIMESTAMP WHERE slate_id = ?`, site, id);
  } else {
    await db.run(
      `INSERT INTO slates (slate_id, name, sport, start_time, site) VALUES (?, ?, ?, ?, ?)`,
      id, slateName || `${siteName} ${day}`, 'NBA', dateParam(startTime), site
    );
  }
  return db.get(`SELECT * FROM slates WHERE slate_id = ?`, id);
}

async function loadHistoricalPlayers() {
  try {
    return await db.all(`
      SELECT player_id, player_name, team, MAX(game_date) AS last_game
      FROM historical_games
      GROUP BY player_id, player_name, team
      ORDER BY last_game DESC
    `);
  } catch {
    return []; // table missing on a fresh database
  }
}

const summarize = (p) => ({
  name: p.name,
  team: p.team,
  position: p.positions.join('/'),
  salary: p.salary,
  sitePlayerId: p.sitePlayerId
});

/**
 * Import a salary CSV into a slate.
 * Options: { csvText, site?, slateId?, slateName? }
 */
export async function importSalaries({ csvText, site: siteHint, slateId, slateName }) {
  const parsed = parseSalaryCsv(csvText, siteHint);
  const { site, players } = parsed;
  const config = getSiteConfig(site);

  const startTimes = players.map(p => p.startTime).filter(Boolean).sort();
  const slate = await resolveSlate({
    site, slateId, slateName, startTime: startTimes[0] || null, siteName: config.name
  });
  const targetId = slate.slate_id;

  const slateRows = await db.all(`SELECT * FROM players WHERE slate_id = ?`, targetId);
  const otherRows = await db.all(
    `SELECT * FROM players WHERE slate_id <> ? AND projected_points > 0 ORDER BY updated_at DESC`, targetId
  );
  const historical = await loadHistoricalPlayers();

  const slateBySiteId = new Map(slateRows.filter(r => r.site_player_id).map(r => [String(r.site_player_id), r]));
  const slateIndex = buildNameIndex(slateRows);
  const otherIndex = buildNameIndex(otherRows);
  const histIndex = buildNameIndex(historical, 'player_name');

  const claimed = new Set();
  const usedPlayerIds = new Set(slateRows.map(r => String(r.player_id)));
  const isFree = (row) => !claimed.has(row.id);

  const report = {
    site,
    detectedSite: parsed.detectedSite,
    slate,
    total: players.length,
    updated: 0,
    inserted: 0,
    matched: { slate: 0, projections: 0, historical: 0 },
    unmatched: [],
    noProjection: [],
    missingFromCsv: [],
    skipped: parsed.skipped
  };

  for (const p of players) {
    const out = p.injuryStatus && OUT_STATUSES.has(p.injuryStatus.toUpperCase());
    const existing = (slateBySiteId.get(p.sitePlayerId) && isFree(slateBySiteId.get(p.sitePlayerId))
      ? slateBySiteId.get(p.sitePlayerId)
      : null) || findNameMatch(slateIndex, p.name, p.team, isFree);

    if (existing) {
      claimed.add(existing.id);
      await db.run(`
        UPDATE players SET
          site_player_id = ?, roster_positions = ?, position = ?, salary = ?, team = ?,
          opponent = COALESCE(?, opponent), game_info = COALESCE(?, game_info),
          injury_status = COALESCE(?, injury_status), value = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `,
        p.sitePlayerId, p.rosterPositions, p.positions.join(','), p.salary, p.team,
        p.opponent, p.gameInfo, p.injuryStatus,
        valueFor(existing.projected_points, p.salary, config.salaryCap),
        existing.id
      );
      report.matched.slate++;
      report.updated++;
      continue;
    }

    const source = findNameMatch(otherIndex, p.name, p.team);
    const hist = source ? null : findNameMatch(histIndex, p.name, p.team);

    const row = {
      slate_id: targetId,
      player_id: null,
      name: hist?.player_name || p.name,
      team: p.team,
      opponent: p.opponent,
      position: p.positions.join(','),
      salary: p.salary,
      game_info: p.gameInfo,
      injury_status: p.injuryStatus,
      site_player_id: p.sitePlayerId,
      roster_positions: p.rosterPositions
    };

    if (source) {
      for (const colName of PROJECTION_COLUMNS) {
        if (colName in source) row[colName] = source[colName];
      }
      if (source.injury_status && !row.injury_status) row.injury_status = source.injury_status;
      if (!usedPlayerIds.has(String(source.player_id))) row.player_id = String(source.player_id);
      report.matched.projections++;
    } else {
      // No projection to copy: fall back to the site's average (0 if ruled out)
      row.projected_points = out ? 0 : (p.fppg ?? 0);
      if (hist) report.matched.historical++;
      else report.unmatched.push(summarize(p));
      report.noProjection.push(summarize(p));
    }

    row.player_id = row.player_id || `${site}-${p.sitePlayerId}`;
    usedPlayerIds.add(row.player_id);
    row.value = valueFor(row.projected_points, p.salary, config.salaryCap);

    const cols = Object.keys(row);
    await db.run(
      `INSERT INTO players (${cols.map(c => `[${c}]`).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
      ...cols.map(c => row[c] ?? null)
    );
    report.inserted++;
  }

  report.missingFromCsv = slateRows
    .filter(r => !claimed.has(r.id))
    .map(r => ({ name: r.name, team: r.team, salary: r.salary }));

  // Ranges copied from another site's slate used that site's salary and scoring
  await recomputeSlateRanges(targetId);
  await snapshotSlate(targetId);

  return report;
}

export default { importSalaries, parseSalaryCsv, detectSite, parseGameInfo };
