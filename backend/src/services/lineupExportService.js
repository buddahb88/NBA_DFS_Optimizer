import { getSiteConfig, getEligibleSlots, isValidSite } from '../config/sites.js';

/**
 * LINEUP EXPORT - bulk CSV upload files for DraftKings, FanDuel and Yahoo
 *
 * Two modes:
 *   new      Site's "upload lineups" template: a header of slot names, then one
 *            row per lineup with player IDs in slot order (config/sites.js csvExport).
 *   entries  The user's own entries file from the site's edit-entries / CSV edit
 *            page (DKEntries.csv, FanDuel ...-entries-upload-template.csv, Yahoo's
 *            contest template). We find the slot columns by matching the site's
 *            slot header in the file and only overwrite those cells on entry
 *            rows. Every other cell and row (entry/contest columns, DK's
 *            instructions and player list off to the right) is left byte-for-byte.
 *
 * The entry/contest column names differ per site and aren't documented
 * publicly, so we don't depend on them beyond spotting an "Entry ID" column.
 *
 * Every lineup is validated against the site's rules before anything is built;
 * if any lineup fails, no CSV is returned.
 */

// ---------------------------------------------------------------------------
// CSV helpers
// ---------------------------------------------------------------------------

/**
 * Parse CSV text (RFC 4180 quoting). Each record keeps its raw source text so
 * rows we don't change can be written back exactly as they came in.
 * Returns { records: [{ cells, raw }], newline, bom, trailingNewline }.
 */
export function parseCsv(text) {
  let src = String(text ?? '');
  const bom = src.charCodeAt(0) === 0xfeff;
  if (bom) src = src.slice(1);
  const newline = src.includes('\r\n') ? '\r\n' : '\n';

  const records = [];
  let cells = [];
  let cell = '';
  let inQuotes = false;
  let start = 0;
  let i = 0;

  const endRecord = (end) => {
    cells.push(cell);
    records.push({ cells, raw: src.slice(start, end) });
    cells = [];
    cell = '';
  };

  while (i < src.length) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
      } else {
        cell += ch;
      }
      i++;
    } else if (ch === '"') {
      inQuotes = true;
      i++;
    } else if (ch === ',') {
      cells.push(cell);
      cell = '';
      i++;
    } else if (ch === '\r' || ch === '\n') {
      endRecord(i);
      i += ch === '\r' && src[i + 1] === '\n' ? 2 : 1;
      start = i;
    } else {
      cell += ch;
      i++;
    }
  }

  const trailingNewline = start === src.length && src.length > 0;
  if (!trailingNewline && src.length > 0) endRecord(src.length);

  return { records, newline, bom, trailingNewline };
}

const csvCell = (value) => {
  const s = value === null || value === undefined ? '' : String(value);
  return /[",\r\n]/.test(s) || s !== s.trim() ? `"${s.replace(/"/g, '""')}"` : s;
};

export const formatCsvRow = (cells) => cells.map(csvCell).join(',');

// ---------------------------------------------------------------------------
// Lineup normalization and validation
// ---------------------------------------------------------------------------

/**
 * Normalize a player row (DB row or API object) into what export needs.
 */
export function normalizePlayer(p) {
  return {
    id: p.id ?? null,
    name: p.name || '',
    sitePlayerId: String(p.site_player_id ?? p.sitePlayerId ?? '').trim(),
    position: p.position || '',
    rosterPositions: p.roster_positions ?? p.rosterPositions ?? null,
    salary: Number(p.salary) || 0,
    team: p.team || '',
    opponent: p.opponent || '',
    slateId: p.slate_id ?? p.slateId ?? null,
    positionSlot: p.position_slot ?? p.positionSlot ?? null
  };
}

// Slots a player can fill on this site. Prefer roster_positions from the
// site's own salary file; fall back to deriving from the player's position.
function eligibleSlotsFor(site, player) {
  const siteSlots = new Set(getSiteConfig(site).rosterSlots.map(s => s.slot));
  if (player.rosterPositions) {
    const fromFile = String(player.rosterPositions)
      .split(/[/,]/)
      .map(s => s.trim().toUpperCase())
      .filter(s => siteSlots.has(s));
    if (fromFile.length > 0) return new Set(fromFile);
  }
  return new Set(getEligibleSlots(site, player.position));
}

/**
 * Assign players to the site's roster slots (in roster order). Players keep
 * the slot they were saved in when it still works. Returns players in slot
 * order, or null when no valid assignment exists.
 */
function assignSlots(site, players) {
  const slots = getSiteConfig(site).rosterSlots.map(s => s.slot);
  if (players.length !== slots.length) return null;
  const eligible = players.map(p => eligibleSlotsFor(site, p));
  const used = new Array(players.length).fill(false);
  const result = new Array(slots.length);

  const order = (slot) => players
    .map((p, idx) => idx)
    .filter(idx => !used[idx] && eligible[idx].has(slot))
    .sort((a, b) =>
      (String(players[b].positionSlot).toUpperCase() === slot) - (String(players[a].positionSlot).toUpperCase() === slot));

  const fill = (s) => {
    if (s === slots.length) return true;
    for (const idx of order(slots[s])) {
      used[idx] = true;
      result[s] = players[idx];
      if (fill(s + 1)) return true;
      used[idx] = false;
    }
    return false;
  };

  return fill(0) ? result : null;
}

const money = (site, n) => (site === 'yahoo' ? `$${n}` : `$${n.toLocaleString('en-US')}`);

/**
 * Validate one lineup for a site. lineup: { players, slateSite? }
 * Returns { errors: string[], ordered: players in slot order (when valid) }.
 */
export function validateLineupForSite(site, lineup) {
  const config = getSiteConfig(site);
  const players = (lineup.players || []).map(normalizePlayer);
  const errors = [];
  const size = config.rosterSlots.length;

  if (lineup.missing) {
    return { errors: ['Lineup not found'], ordered: null, totalSalary: 0 };
  }
  if (lineup.unknownPlayers?.length > 0) {
    errors.push(`Unknown player(s): ${lineup.unknownPlayers.join(', ')}`);
  }

  if (lineup.slateSite && String(lineup.slateSite).toLowerCase() !== config.key) {
    const siteName = isValidSite(lineup.slateSite) ? getSiteConfig(lineup.slateSite).name : lineup.slateSite;
    errors.push(`Lineup is from a ${siteName} slate, not ${config.name}`);
  }

  if (players.length !== size) {
    errors.push(`Has ${players.length} players; ${config.name} needs ${size}`);
  }

  const seen = new Set();
  for (const p of players) {
    const key = p.id ?? (p.sitePlayerId || p.name);
    if (seen.has(key)) errors.push(`${p.name || key} is in the lineup twice`);
    seen.add(key);
  }

  const missingIds = players.filter(p => !p.sitePlayerId).map(p => p.name || `player ${p.id}`);
  if (missingIds.length > 0) {
    errors.push(`No ${config.name} player ID for ${missingIds.join(', ')} (import the ${config.name} salary file for this slate)`);
  }

  const totalSalary = players.reduce((sum, p) => sum + p.salary, 0);
  if (totalSalary > config.salaryCap) {
    errors.push(`Salary ${money(config.key, totalSalary)} is over the ${money(config.key, config.salaryCap)} cap`);
  }

  if (config.maxPlayersPerTeam) {
    const perTeam = {};
    players.forEach(p => { if (p.team) perTeam[p.team] = (perTeam[p.team] || 0) + 1; });
    for (const [team, count] of Object.entries(perTeam)) {
      if (count > config.maxPlayersPerTeam) {
        errors.push(`${count} players from ${team}; max is ${config.maxPlayersPerTeam}`);
      }
    }
  }

  const teams = new Set(players.map(p => p.team).filter(Boolean));
  if (config.minTeams && teams.size < config.minTeams) {
    errors.push(`Players from ${teams.size} team(s); needs at least ${config.minTeams}`);
  }

  if (config.minGames) {
    const games = new Set(players.filter(p => p.team).map(p => [p.team, p.opponent || p.team].sort().join('@')));
    if (games.size < config.minGames) {
      errors.push(`Players from ${games.size} game(s); needs at least ${config.minGames}`);
    }
  }

  let ordered = null;
  if (players.length === size) {
    ordered = assignSlots(config.key, players);
    if (!ordered) {
      const slots = config.rosterSlots.map(s => s.slot).join(', ');
      errors.push(`Players can't fill the ${config.name} slots (${slots}) with their positions`);
    }
  }

  return { errors, ordered: errors.length === 0 ? ordered : null, totalSalary };
}

const formatPlayerCell = (config, player) =>
  config.csvExport.playerFormat === 'id:name' ? `${player.sitePlayerId}:${player.name}` : player.sitePlayerId;

// ---------------------------------------------------------------------------
// Entries template
// ---------------------------------------------------------------------------

const norm = (s) => String(s ?? '').trim().toUpperCase();

/**
 * Find the header row and where the slot columns start in an entries file.
 * Returns { headerIndex, slotStart, entryIdCol } or null.
 */
export function locateSlotColumns(site, records) {
  const header = getSiteConfig(site).csvExport.header.map(norm);
  const scan = Math.min(records.length, 10);
  for (let r = 0; r < scan; r++) {
    const cells = records[r].cells.map(norm);
    for (let c = 0; c + header.length <= cells.length; c++) {
      if (header.every((h, k) => cells[c + k] === h)) {
        const entryIdCol = records[r].cells.findIndex(h => /^entry[\s_]*id$/i.test(String(h).trim()));
        return { headerIndex: r, slotStart: c, entryIdCol };
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

/**
 * Build the upload CSV.
 *
 * @param {object} opts
 * @param {string} opts.site            draftkings | fanduel | yahoo
 * @param {'new'|'entries'} opts.mode
 * @param {Array}  opts.lineups         [{ lineupId?, name?, slateSite?, players: [player rows] }]
 * @param {string} [opts.entriesTemplate]  entries file text (entries mode)
 * @returns {{ success, csv?, rowCount?, warnings, errors }}
 *   errors: [{ index (1-based lineup #), lineupId, name, csvRow, messages }]
 *           or [{ index: null, messages }] for request/template problems
 */
export function buildLineupExport({ site, mode = 'new', lineups, entriesTemplate }) {
  const config = getSiteConfig(site);
  const warnings = [];
  const fail = (message) => ({ success: false, warnings, errors: [{ index: null, messages: [message] }] });

  if (mode !== 'new' && mode !== 'entries') return fail(`Unknown mode "${mode}". Use "new" or "entries".`);
  if (!Array.isArray(lineups) || lineups.length === 0) return fail('No lineups to export');

  // Entries mode: read the template first so we know which CSV row each lineup lands on
  let template = null;
  let entryRows = [];
  if (mode === 'entries') {
    if (!entriesTemplate || !String(entriesTemplate).trim()) {
      return fail(`Upload your ${config.name} entries file to fill it`);
    }
    template = parseCsv(entriesTemplate);
    const loc = locateSlotColumns(config.key, template.records);
    if (!loc) {
      return fail(
        `Couldn't find the ${config.name} NBA Classic slot columns (${config.csvExport.header.join(',')}) in the uploaded file. ` +
        `Make sure it's the entries file you downloaded from ${config.name} for an NBA Classic contest.`
      );
    }
    template.loc = loc;
    for (let r = loc.headerIndex + 1; r < template.records.length; r++) {
      const cells = template.records[r].cells;
      const isEntry = loc.entryIdCol >= 0
        ? String(cells[loc.entryIdCol] ?? '').trim() !== ''
        : cells.slice(0, loc.slotStart).some(c => String(c).trim() !== '');
      if (isEntry) entryRows.push(r);
    }
    if (entryRows.length === 0) return fail('The uploaded entries file has no entries in it');
  }

  // Validate everything that will be written
  const used = mode === 'entries' ? lineups.slice(0, entryRows.length) : lineups;
  const errors = [];
  const orderedLineups = used.map((lineup, i) => {
    const { errors: messages, ordered } = validateLineupForSite(config.key, lineup);
    if (messages.length > 0) {
      errors.push({
        index: i + 1,
        lineupId: lineup.lineupId ?? null,
        name: lineup.name || `Lineup ${i + 1}`,
        csvRow: mode === 'entries' ? entryRows[i] + 1 : i + 2,
        messages
      });
    }
    return ordered;
  });

  const slates = new Set(lineups.map(l => (l.players || [])[0]).filter(Boolean).map(p => normalizePlayer(p).slateId).filter(Boolean));
  if (slates.size > 1) {
    warnings.push(`Lineups come from ${slates.size} different slates; a site upload only accepts players from one contest slate`);
  }

  if (errors.length > 0) return { success: false, warnings, errors };

  if (mode === 'new') {
    const rows = [formatCsvRow(config.csvExport.header)];
    orderedLineups.forEach(ordered => rows.push(formatCsvRow(ordered.map(p => formatPlayerCell(config, p)))));
    return { success: true, csv: rows.join('\r\n') + '\r\n', rowCount: orderedLineups.length, warnings, errors: [] };
  }

  // entries mode
  if (lineups.length > entryRows.length) {
    warnings.push(`${lineups.length - entryRows.length} lineup(s) left out: the file only has ${entryRows.length} entries`);
  } else if (lineups.length < entryRows.length) {
    warnings.push(`${entryRows.length - lineups.length} entr${entryRows.length - lineups.length === 1 ? 'y' : 'ies'} left unchanged: only ${lineups.length} lineup(s) were exported`);
  }

  const { records, newline, bom, trailingNewline, loc } = template;
  const out = records.map(rec => rec.raw);
  orderedLineups.forEach((ordered, i) => {
    const r = entryRows[i];
    const cells = [...records[r].cells];
    while (cells.length < loc.slotStart + ordered.length) cells.push('');
    ordered.forEach((p, k) => { cells[loc.slotStart + k] = formatPlayerCell(config, p); });
    out[r] = formatCsvRow(cells);
  });

  const csv = (bom ? '﻿' : '') + out.join(newline) + (trailingNewline ? newline : '');
  return { success: true, csv, rowCount: orderedLineups.length, warnings, errors: [] };
}
