/**
 * ENTRIES FILE PARSING / WRITING (DraftKings DKEntries.csv, FanDuel entries upload)
 *
 * An entries file has one row per contest entry: a few meta columns (entry id,
 * contest, fee) followed by one column per roster slot. Both sites also append
 * the slate's player list to the right of the entries (DK: "Name + ID" table,
 * FD: "Player ID + Player Name" table); when present we read it for salaries,
 * positions, teams and (DK only) game start times.
 *
 * Cell formats:
 *   DK  "LeBron James (39971234)", "39971234", "LeBron James (39971234) (LOCKED)"
 *   FD  "12345-67890:Stephen Curry", "12345-67890"
 */

import { getSiteConfig } from '../../config/sites.js';
import { parseGameInfo } from './gameTimes.js';

/** RFC 4180-ish CSV parser: quoted fields, "" escapes, CRLF/LF, leading BOM. */
export function parseCsv(text) {
  const src = String(text ?? '').replace(/^﻿/, '');
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

const csvCell = (value) => {
  const s = value == null ? '' : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export const toCsv = (rows) => rows.map(r => r.map(csvCell).join(',')).join('\r\n') + '\r\n';

const norm = (s) => String(s ?? '').trim().toLowerCase().replace(/[\s_]+/g, ' ');

const ENTRY_ID_HEADERS = new Set(['entry id', 'entryid']);
const PLAYER_TABLE_HEADERS = new Set(['name + id', 'player id + player name']);

/**
 * Parse one roster cell into { siteId, name, locked }. Empty cell -> null.
 * Unrecognized text is kept as `name` so it can still be matched by name.
 */
export function parsePlayerCell(cell) {
  let text = String(cell ?? '').trim();
  if (!text) return null;
  let locked = false;
  if (/\(locked\)/i.test(text)) {
    locked = true;
    text = text.replace(/\(locked\)/ig, '').trim();
  }
  let m = text.match(/^([0-9][\w-]*):(.*)$/); // FD "id:name"
  if (m) return { siteId: m[1], name: m[2].trim() || null, locked };
  m = text.match(/^(.*?)\s*\(([\w.-]+)\)$/); // DK "Name (id)"
  if (m && /\d/.test(m[2])) return { siteId: m[2], name: m[1].trim() || null, locked };
  if (/^[\w.-]+$/.test(text) && /\d/.test(text)) return { siteId: text, name: null, locked };
  return { siteId: null, name: text, locked };
}

/** Format a player for upload using the site's csvExport.playerFormat. */
export function formatPlayerCell(site, player) {
  if (!player) return '';
  const { playerFormat } = getSiteConfig(site).csvExport;
  const id = player.siteId ?? '';
  if (playerFormat === 'id:name') return player.name ? `${id}:${player.name}` : String(id);
  return String(id);
}

function detectSite(header) {
  const cells = header.map(c => String(c).trim());
  if (cells.includes('entry_id')) return 'fanduel';
  if (cells.filter(c => c.toUpperCase() === 'PG').length >= 2) return 'fanduel';
  return 'draftkings';
}

/** Index of the first run of columns matching the site's slot header, or -1. */
function findSlotColumns(header, slotHeader) {
  const up = header.map(c => String(c).trim().toUpperCase());
  for (let i = 0; i + slotHeader.length <= up.length; i++) {
    if (slotHeader.every((s, k) => up[i + k] === s.toUpperCase())) return i;
  }
  return -1;
}

const pick = (row, cols, ...names) => {
  for (const n of names) {
    const idx = cols.get(n);
    if (idx !== undefined && String(row[idx] ?? '').trim() !== '') return String(row[idx]).trim();
  }
  return null;
};

/** Read the player list the sites append to the right of the entries. */
function parsePlayerTable(rows) {
  for (let r = 0; r < rows.length; r++) {
    const c = rows[r].findIndex(cell => PLAYER_TABLE_HEADERS.has(norm(cell)));
    if (c < 0) continue;
    // The table may start a column before the "Name + ID" header (DK puts Position first)
    let start = c;
    while (start > 0 && String(rows[r][start - 1] ?? '').trim() !== '') start--;
    const cols = new Map();
    rows[r].slice(start).forEach((h, k) => {
      const key = norm(h);
      if (key && !cols.has(key)) cols.set(key, start + k);
    });

    const players = [];
    for (let rr = r + 1; rr < rows.length; rr++) {
      const row = rows[rr];
      const siteId = pick(row, cols, 'id', 'player id');
      if (!siteId) continue;
      const first = pick(row, cols, 'first name');
      const last = pick(row, cols, 'last name');
      const name = pick(row, cols, 'name', 'nickname') || [first, last].filter(Boolean).join(' ') || null;
      const gameText = pick(row, cols, 'game info', 'game');
      const game = gameText ? parseGameInfo(gameText) : null;
      const team = pick(row, cols, 'teamabbrev', 'team');
      let opponent = pick(row, cols, 'opponent');
      if (!opponent && game && team) {
        opponent = game.home === team.toUpperCase() ? game.away : game.away === team.toUpperCase() ? game.home : null;
      }
      const salary = Number(String(pick(row, cols, 'salary') ?? '').replace(/[$,]/g, ''));
      players.push({
        siteId,
        name,
        position: pick(row, cols, 'position'),
        rosterPositions: pick(row, cols, 'roster position'),
        salary: Number.isFinite(salary) && salary > 0 ? salary : null,
        team: team ? team.toUpperCase() : null,
        opponent: opponent ? opponent.toUpperCase() : null,
        gameText,
        startTime: game?.startTime ?? null,
        injury: pick(row, cols, 'injury indicator'),
        injuryDetails: pick(row, cols, 'injury details'),
        avgPoints: Number(pick(row, cols, 'avgpointspergame', 'fppg')) || null
      });
    }
    return players;
  }
  return [];
}

/**
 * Parse an entries CSV.
 * @param {string} text - file contents
 * @param {{site?: string}} opts - force a site; otherwise detected from the header
 * @returns {{site, header, metaColumns, slots, entries: [{entryId, meta: string[], players: (cell|null)[]}], playerPool}}
 */
export function parseEntriesFile(text, { site } = {}) {
  const rows = parseCsv(text);
  const headerRow = rows.findIndex(r => r.some(c => ENTRY_ID_HEADERS.has(norm(c))));
  if (headerRow < 0) {
    throw Object.assign(new Error('Could not find an "Entry ID" header row. Upload the entries CSV downloaded from DraftKings or FanDuel.'), { status: 400 });
  }
  const header = rows[headerRow];
  const siteKey = site || detectSite(header);
  const config = getSiteConfig(siteKey);
  const slotHeader = config.csvExport.header;
  const slotStart = findSlotColumns(header, slotHeader);
  if (slotStart < 0) {
    throw Object.assign(new Error(`Header does not contain the ${config.name} roster columns (${slotHeader.join(', ')}).`), { status: 400 });
  }
  const entryIdCol = header.findIndex(c => ENTRY_ID_HEADERS.has(norm(c)));

  const entries = [];
  for (let r = headerRow + 1; r < rows.length; r++) {
    const row = rows[r];
    const entryId = String(row[entryIdCol] ?? '').trim();
    if (!entryId) continue;
    entries.push({
      entryId,
      meta: header.slice(0, slotStart).map((_, k) => String(row[k] ?? '')),
      players: slotHeader.map((_, k) => parsePlayerCell(row[slotStart + k]))
    });
  }
  if (entries.length === 0) {
    throw Object.assign(new Error('No entries found in the file.'), { status: 400 });
  }

  return {
    site: config.key,
    metaColumns: header.slice(0, slotStart).map(c => String(c)),
    slots: [...config.csvExport.slotOrder],
    entries,
    playerPool: parsePlayerTable(rows)
  };
}

/**
 * Build the upload CSV: original meta columns, then the site's slot columns.
 * @param lineups - [{ meta: string[], players: [{siteId, name}] }] in slot order
 */
export function writeEntriesFile(site, metaColumns, lineups) {
  const { header } = getSiteConfig(site).csvExport;
  return toCsv([
    [...metaColumns, ...header],
    ...lineups.map(l => [...l.meta, ...l.players.map(p => formatPlayerCell(site, p))])
  ]);
}
