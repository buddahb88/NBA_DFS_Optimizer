/**
 * LATE SWAP
 *
 * Re-optimizes uploaded contest entries after some games have tipped:
 *  - players whose game has started stay fixed in their slot (sites don't let
 *    you move or drop them)
 *  - every other slot is re-filled from the latest projections / injury news,
 *    within the salary left after the locked players, the site's team rules,
 *    exposure caps and lineup uniqueness across the whole entries file
 *  - OUT players in unlocked slots are always swapped; OUT players who are
 *    already locked are flagged so the user knows that entry is compromised
 *
 * runLateSwap() is pure (no DB): the route loads the slate's player rows and
 * passes them in, which keeps this testable with fixtures.
 */

import { searchLineup } from './lineupSearch.js';
import { getSiteConfig, getEligibleSlots } from '../../config/sites.js';
import { parseEntriesFile, writeEntriesFile } from './entriesCsv.js';
import { buildLockState, normalizeTeam, startTimeFromDbPlayer } from './gameTimes.js';

export const MODES = ['optimize', 'outOnly'];

// Extra dominators required before pruning a candidate, as headroom for the
// team rules (which dominance pruning ignores).
const PRUNE_SLACK = 2;

export function nameKey(name) {
  return String(name ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[.'’`-]/g, '')
    .replace(/\b(jr|sr|ii|iii|iv|v)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Injury text -> 'OUT' | 'Q' | null. Handles plain strings ("Out", "GTD", "O"),
 * FanDuel indicators (O, Q, GTD, D, IL, NA) and JSON blobs from RotoWire.
 */
export function classifyStatus(value) {
  if (value == null) return null;
  let text = value;
  if (typeof value === 'string' && /^\s*[{[]/.test(value)) {
    try {
      text = JSON.parse(value);
    } catch {
      // not JSON after all
    }
  }
  if (text && typeof text === 'object') {
    text = text.status ?? text.type ?? text.designation ?? text.injury_status ?? '';
  }
  const s = String(text).trim().toUpperCase();
  if (!s) return null;
  if (/^(O|OUT|OFS|IL|IR|INJ|NA|N\/A|SUSP|SUSPENDED|SCRATCH|SCRATCHED|INACTIVE|DNP)\b/.test(s)) return 'OUT';
  if (/^(Q|GTD|D|P|QUESTIONABLE|DOUBTFUL|PROBABLE|GAME[ -]TIME)/.test(s)) return 'Q';
  return null;
}

const httpError = (message) => Object.assign(new Error(message), { status: 400 });

/**
 * Merge the file's player list with the DB slate (projections, injury status).
 * Keyed by site player id, since that's what the upload file needs.
 */
function buildPool(parsed, dbPlayers, site, outOverride) {
  const bySiteId = new Map();
  const byName = new Map();
  for (const row of dbPlayers) {
    if (row.site_player_id) bySiteId.set(String(row.site_player_id), row);
    const key = nameKey(row.name);
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(row);
  }
  const matchDb = (siteId, name, team) => {
    if (siteId && bySiteId.has(siteId)) return bySiteId.get(siteId);
    const rows = byName.get(nameKey(name)) || [];
    if (rows.length <= 1) return rows[0] || null;
    return rows.find(r => normalizeTeam(r.team) === normalizeTeam(team)) || rows[0];
  };

  const outIds = new Set();
  const outNames = new Set();
  for (const v of outOverride || []) {
    outIds.add(String(v));
    outNames.add(nameKey(v));
  }

  const pool = new Map();
  const make = (src, db) => {
    const position = src.position || db?.position || null;
    const projection = db ? Number(db.projected_points) || 0 : 0;
    const overriddenOut = outIds.has(String(src.siteId)) || outNames.has(nameKey(src.name ?? db?.name));
    const status = overriddenOut ? 'OUT' : classifyStatus(db ? db.injury_status : src.injury);
    return {
      siteId: String(src.siteId),
      name: src.name || db?.name || String(src.siteId),
      team: normalizeTeam(src.team || db?.team),
      opponent: normalizeTeam(src.opponent || db?.opponent),
      position,
      slots: position ? getEligibleSlots(site, position) : [],
      salary: Number(src.salary ?? db?.salary) || 0,
      projection: status === 'OUT' ? 0 : projection,
      rawProjection: projection,
      status,
      injury: db?.injury_status ?? src.injury ?? null,
      startTime: src.startTime || (db ? startTimeFromDbPlayer(db) : null),
      matched: Boolean(db)
    };
  };

  for (const p of parsed.playerPool) {
    pool.set(String(p.siteId), make(p, matchDb(String(p.siteId), p.name, p.team)));
  }
  if (parsed.playerPool.length === 0) {
    // No player list in the file: fall back to DB rows that carry a site id
    for (const row of dbPlayers) {
      if (!row.site_player_id) continue;
      pool.set(String(row.site_player_id), make({ siteId: row.site_player_id, name: row.name }, row));
    }
  }
  // Players in entries that aren't in the pool (e.g. file without a player list)
  for (const entry of parsed.entries) {
    for (const cell of entry.players) {
      if (!cell) continue;
      let id = cell.siteId;
      if (!id) {
        const db = matchDb(null, cell.name, null);
        id = db?.site_player_id ? String(db.site_player_id) : null;
        if (!id) continue;
        cell.siteId = id;
      }
      if (!pool.has(id)) pool.set(id, make({ siteId: id, name: cell.name }, matchDb(id, cell.name, null)));
    }
  }
  return pool;
}

const gameKey = (p) => (p.team && p.opponent ? [p.team, p.opponent].sort().join('@') : p.team);

/**
 * Drop candidates dominated (cheaper-or-equal, better-or-equal projection,
 * fits every slot this one fits) by more than `need` others. Mirrors the
 * k-dominance pruning in portfolio/lineupSolver.js.
 */
function pruneDominated(cands, need, slotSets) {
  return cands.filter((p) => {
    const mine = slotSets.get(p.siteId);
    let dominated = 0;
    for (const q of cands) {
      if (q === p || q.projection < p.projection || q.salary > p.salary) continue;
      if (q.projection === p.projection && q.salary === p.salary && q.siteId > p.siteId) continue;
      const theirs = slotSets.get(q.siteId);
      if (![...mine].every(s => theirs.has(s))) continue;
      if (++dominated >= need) return false;
    }
    return true;
  });
}

/**
 * Assign each chosen player to a distinct open slot (Kuhn's algorithm); null if impossible.
 * Players already in the entry are placed first and try their original slot
 * first, so they only move when a new player can't fit otherwise.
 * @param preferred Map siteId -> original slot index
 */
function matchSlots(chosen, openSlots, slots, preferred = new Map()) {
  const players = [...chosen].sort((a, b) => preferred.has(b.siteId) - preferred.has(a.siteId));
  const owner = new Map(); // slot index -> player position in `players`
  const place = (pi, seen) => {
    const pref = preferred.get(players[pi].siteId);
    const order = pref === undefined ? openSlots : [pref, ...openSlots.filter(i => i !== pref)];
    for (const i of order) {
      if (seen.has(i) || !players[pi].slots.includes(slots[i])) continue;
      seen.add(i);
      if (!owner.has(i) || place(owner.get(i), seen)) {
        owner.set(i, pi);
        return true;
      }
    }
    return false;
  };
  for (let pi = 0; pi < players.length; pi++) {
    if (!place(pi, new Set())) return null;
  }
  return new Map([...owner].map(([i, pi]) => [i, players[pi]]));
}

/**
 * Fill the open slots of one entry.
 * @returns {{ assign: Map<slotIndex, player> } | null}
 */
function solveEntry({ site, slots, openSlots, fixed, required, candidates, salaryLeft, forbidden, preferred }) {
  const config = getSiteConfig(site);
  // Bitmask over the open slots each player can fill
  const toItem = (p) => ({
    id: p.siteId,
    proj: p.projection,
    salary: p.salary,
    team: p.team,
    game: gameKey(p),
    mask: openSlots.reduce((m, i, b) => (p.slots.includes(slots[i]) ? m | (1 << b) : m), 0),
    player: p
  });
  const requiredIds = new Set(required.map(p => p.siteId));
  const items = candidates.filter(p => !requiredIds.has(p.siteId)).map(toItem).filter(x => x.mask);

  const teamCounts = new Map();
  for (const p of fixed) teamCounts.set(p.team, (teamCounts.get(p.team) || 0) + 1);

  const found = searchLineup({
    items,
    required: required.map(toItem),
    k: openSlots.length,
    salaryLeft,
    teamCounts,
    maxPerTeam: config.maxPlayersPerTeam,
    minTeams: config.minTeams || 0,
    minGames: config.minGames || 0,
    fixedTeams: new Set(fixed.map(p => p.team)),
    fixedGames: new Set(fixed.map(gameKey)),
    forbidden
  });
  if (!found) return null;
  const assign = matchSlots(found.chosen.map(x => x.player), openSlots, slots, preferred);
  return assign ? { assign, exhaustive: found.exhaustive } : null;
}


const playerView = (p, extra = {}) => p && ({
  siteId: p.siteId,
  name: p.name,
  team: p.team,
  position: p.position,
  salary: p.salary,
  projection: Math.round(p.projection * 100) / 100,
  status: p.status,
  injury: p.injury,
  startTime: p.startTime ? p.startTime.toISOString() : null,
  ...extra
});

const sum = (arr, f) => arr.reduce((s, x) => s + (x ? f(x) : 0), 0);
const round1 = (x) => Math.round(x * 10) / 10;

/**
 * @param {object} input
 *   csv               entries file text
 *   dbPlayers         rows from the players table for the slate (any projection)
 *   site              force 'draftkings' | 'fanduel' (default: detected)
 *   now               Date | ISO string (default: current time) - for testing
 *   gameTimes         { TEAM: start time } overrides
 *   lockedTeams       teams to treat as locked regardless of time
 *   outPlayers        site ids or names to treat as OUT (late-breaking news)
 *   excludePlayers    site ids or names never to swap in
 *   mode              'optimize' (re-optimize every unlocked slot) | 'outOnly' (swap only OUT players)
 *   swapQuestionable  also treat Q/GTD players in unlocked slots as must-swap
 *   maxExposure       global max % of entries any player may appear in (default 100)
 *   playerExposure    { siteId | name: max % }
 *   unique            keep every final lineup distinct (default true)
 */
export function runLateSwap(input = {}) {
  const {
    csv,
    dbPlayers = [],
    now: nowInput,
    gameTimes = {},
    lockedTeams = [],
    outPlayers = [],
    excludePlayers = [],
    mode = 'optimize',
    swapQuestionable = false,
    maxExposure = 100,
    playerExposure = {},
    unique = true
  } = input;

  if (!csv || typeof csv !== 'string') throw httpError('csv (entries file contents) is required');
  if (!MODES.includes(mode)) throw httpError(`mode must be one of: ${MODES.join(', ')}`);
  const now = nowInput ? new Date(nowInput) : new Date();
  if (Number.isNaN(now.getTime())) throw httpError('now must be a valid date/time');

  const parsed = parseEntriesFile(csv, { site: input.site });
  const { site, slots, entries } = parsed;
  const config = getSiteConfig(site);
  const pool = buildPool(parsed, dbPlayers, site, outPlayers);
  const warnings = [];

  // ---- Locks
  const teamTimes = new Map();
  for (const p of pool.values()) {
    if (p.team && p.startTime && !teamTimes.has(p.team)) teamTimes.set(p.team, p.startTime);
  }
  // DK marks started players "(LOCKED)" in its late-swap download: their whole team has tipped
  const markedTeams = entries.flatMap(e => e.players)
    .filter(cell => cell?.locked && pool.get(cell.siteId)?.team)
    .map(cell => pool.get(cell.siteId).team);
  const locks = buildLockState({ teamTimes, gameTimes, lockedTeams: [...lockedTeams, ...markedTeams], now });
  const isPlayerLocked = (p, cell) => Boolean(cell?.locked) || locks.isLocked(p.team);

  const teams = [...new Set([...pool.values()].map(p => p.team).filter(Boolean))].sort();
  const lockTable = teams.map(team => ({
    team,
    startTime: locks.startOf(team)?.toISOString() ?? null,
    locked: locks.isLocked(team)
  }));
  const unknownTimes = teams.filter(t => !locks.hasTime(t));
  if (unknownTimes.length) {
    warnings.push(`No start time for ${unknownTimes.join(', ')}; treated as unlocked. Pass gameTimes or lockedTeams to override.`);
  }
  const unmatched = [...pool.values()].filter(p => !p.matched).length;
  if (unmatched > 0) {
    warnings.push(`${unmatched} player(s) in the file have no projection on this slate and won't be swapped in.`);
  }

  // ---- Exposure caps
  const N = entries.length;
  const capFor = (p) => {
    let pct = Number(maxExposure);
    const own = playerExposure[p.siteId] ?? playerExposure[p.name];
    if (own !== undefined && own !== null && own !== '') pct = Math.min(pct, Number(own));
    if (!Number.isFinite(pct)) pct = 100;
    return Math.floor((Math.max(0, pct) / 100) * N + 1e-9);
  };
  const excluded = new Set(excludePlayers.map(String));
  const excludedNames = new Set(excludePlayers.map(nameKey));
  const isOut = (p) => p.status === 'OUT' || (swapQuestionable && p.status === 'Q');

  // ---- Per-entry slot state
  const states = entries.map((entry) => {
    const cells = entry.players.map((cell) => {
      const player = cell?.siteId ? pool.get(cell.siteId) : null;
      return { cell, player, locked: Boolean(player && isPlayerLocked(player, cell)) };
    });
    return { entry, cells, flags: [] };
  });

  const count = new Map(); // final appearances so far (locked players count up front)
  const bump = (id) => count.set(id, (count.get(id) || 0) + 1);
  for (const s of states) s.cells.forEach(c => { if (c.locked) bump(c.player.siteId); });

  for (const s of states) {
    for (const c of s.cells) {
      if (c.locked && c.player.status === 'OUT') {
        s.flags.push({ type: 'LOCKED_OUT', player: c.player.name, message: `${c.player.name} is OUT but already locked` });
      }
      if (c.cell && !c.player) {
        s.flags.push({ type: 'UNKNOWN_PLAYER', player: c.cell.name, message: `Could not identify "${c.cell.name ?? c.cell.siteId}"` });
      }
    }
  }

  const candidatePool = [...pool.values()].filter(p =>
    p.projection > 0 && p.salary > 0 && p.slots.length > 0 && p.matched &&
    !isOut(p) && !locks.isLocked(p.team) &&
    !excluded.has(p.siteId) && !excludedNames.has(nameKey(p.name))
  );

  // Fully locked entries are final already; do them first so others avoid duplicating them
  const order = states
    .map((s, i) => ({ s, i, open: s.cells.filter(c => !c.locked).length }))
    .sort((a, b) => (a.open === 0) === (b.open === 0) ? a.i - b.i : a.open === 0 ? -1 : 1);

  const finalSets = [];
  for (const { s } of order) {
    const openSlots = s.cells.map((c, i) => (c.locked ? -1 : i)).filter(i => i >= 0);
    const fixed = s.cells.filter(c => c.locked).map(c => c.player);
    s.final = s.cells.map(c => (c.locked ? c.player : null));

    if (openSlots.length > 0) {
      const fixedIds = new Set(fixed.map(p => p.siteId));
      const keepers = mode === 'outOnly'
        ? s.cells.filter(c => !c.locked && c.player && !isOut(c.player) && c.player.slots.length > 0).map(c => c.player)
        : [];
      const salaryLeft = config.salaryCap - sum(fixed, p => p.salary);
      const preferred = new Map(openSlots.filter(i => s.cells[i].player).map(i => [s.cells[i].player.siteId, i]));
      const keepAsIs = () => s.cells.forEach((c, i) => { if (!c.locked) s.final[i] = c.player; });

      // Earlier lineups with the same locked core: the open slots can't repeat them
      const forbidden = new Set(!unique ? [] : finalSets
        .filter(set => fixed.every(p => set.has(p.siteId)))
        .map(set => [...set].filter(id => !fixedIds.has(id)))
        .filter(rest => rest.length === openSlots.length)
        .map(rest => rest.sort().join('|')));

      const attempt = ({ withCaps, withUnique, required }) => {
        const requiredIds = new Set(required.map(p => p.siteId));
        const cands = candidatePool.filter(p =>
          !fixedIds.has(p.siteId) && !requiredIds.has(p.siteId) &&
          p.slots.some(sl => openSlots.some(i => slots[i] === sl)) &&
          (!withCaps || (count.get(p.siteId) || 0) < capFor(p))
        );
        const openSlotSets = new Map(cands.map(p => [p.siteId, new Set(p.slots.filter(sl => openSlots.some(i => slots[i] === sl)))]));
        // Keeping k + |forbidden| dominators means a swap to an allowed lineup always survives pruning
        const need = openSlots.length + PRUNE_SLACK + (withUnique ? forbidden.size : 0);
        return solveEntry({
          site, slots, openSlots, fixed, required,
          candidates: pruneDominated(cands, need, openSlotSets),
          salaryLeft,
          forbidden: withUnique ? forbidden : new Set(),
          preferred
        });
      };

      if (mode === 'outOnly' && keepers.length === openSlots.length) {
        keepAsIs(); // nothing OUT or empty in the open slots
      } else {
        const uniq = { flag: 'UNIQUENESS_RELAXED', message: 'Could not find a unique lineup; duplicates another entry' };
        const exp = { flag: 'EXPOSURE_RELAXED', message: 'Exposure caps could not be met for this entry' };
        const reopt = { flag: 'REOPTIMIZED', message: 'OUT player could not be replaced on his own; other open slots were re-optimized' };
        const relaxations = forbidden.size === 0
          ? [{ withCaps: true, flags: [] }, { withCaps: false, flags: [exp] }]
          : [
              { withCaps: true, withUnique: true, flags: [] },
              { withCaps: false, withUnique: true, flags: [exp] },
              { withCaps: true, withUnique: false, flags: [uniq] },
              { withCaps: false, withUnique: false, flags: [uniq, exp] }
            ];
        // outOnly: swap like-for-like first; if that's impossible (e.g. no cheaper
        // replacement fits), an OUT player still has to go, so free up the other open slots
        const tries = [
          ...relaxations.map(t => ({ ...t, required: keepers })),
          ...(keepers.length ? relaxations.map(t => ({ ...t, required: [], flags: [reopt, ...t.flags] })) : [])
        ];
        let solved = null;
        for (const t of tries) {
          solved = attempt(t);
          if (!solved) continue;
          t.flags.forEach(f => s.flags.push({ type: f.flag, message: f.message }));
          if (!solved.exhaustive) s.flags.push({ type: 'SEARCH_LIMIT', message: 'Search stopped early; lineup may be slightly suboptimal' });
          openSlots.forEach(i => { s.final[i] = solved.assign.get(i); });
          break;
        }
        if (!solved) {
          s.flags.push({ type: 'NO_SOLUTION', message: 'No valid swap found (salary/roster rules); entry left unchanged' });
          keepAsIs();
        }
      }
      s.cells.forEach((c, i) => { if (!c.locked && s.final[i]) bump(s.final[i].siteId); });
    }

    finalSets.push(new Set(s.final.filter(Boolean).map(p => p.siteId)));
  }

  // ---- Results
  const effective = (p) => (p && p.status !== 'OUT' ? p.projection : 0);
  const results = states.map(({ entry, cells, flags, final }) => {
    const originalIds = new Set(cells.filter(c => c.player).map(c => c.player.siteId));
    const slotRows = cells.map((c, i) => {
      const before = c.player;
      const after = final[i];
      const changed = (before?.siteId ?? null) !== (after?.siteId ?? null);
      let reason = 'kept';
      if (c.locked) reason = 'locked';
      else if (!before && after) reason = 'filled';
      else if (changed && before && isOut(before)) reason = before.status === 'OUT' ? 'out' : 'questionable';
      else if (changed && originalIds.has(after?.siteId)) reason = 'moved';
      else if (changed) reason = 'upgrade';
      return {
        slot: slots[i],
        locked: c.locked,
        changed,
        reason,
        before: before ? playerView(before) : c.cell ? { siteId: c.cell.siteId, name: c.cell.name } : null,
        after: playerView(after)
      };
    });
    const beforeSalary = sum(cells, c => c.player?.salary ?? 0);
    const afterSalary = sum(final, p => p.salary);
    const beforeProj = sum(cells, c => effective(c.player));
    const afterProj = sum(final, effective);
    // Players swapped in (a player who only moved slots doesn't count)
    const swaps = final.filter(p => p && !originalIds.has(p.siteId)).length;
    for (const r of slotRows) {
      if (!r.locked && r.after?.status === 'Q' && originalIds.has(r.after.siteId)) {
        flags.push({ type: 'QUESTIONABLE', player: r.after.name, message: `${r.after.name} is questionable and still in the lineup` });
      }
    }
    return {
      entryId: entry.entryId,
      contestName: entry.meta[parsed.metaColumns.findIndex(h => /contest[ _]?name/i.test(h))] ?? null,
      slots: slotRows,
      lockedSlots: slotRows.filter(r => r.locked).length,
      swaps,
      before: { salary: beforeSalary, projection: round1(beforeProj) },
      after: { salary: afterSalary, projection: round1(afterProj), remainingSalary: config.salaryCap - afterSalary },
      gain: round1(afterProj - beforeProj),
      flags,
      status: flags.some(f => f.type === 'NO_SOLUTION') ? 'error' : slotRows.some(r => r.changed) ? 'changed' : 'unchanged'
    };
  });

  const outputCsv = writeEntriesFile(site, parsed.metaColumns, states.map(s => ({ meta: s.entry.meta, players: s.final })));

  const exposure = (lineups) => {
    const m = new Map();
    lineups.forEach(l => l.forEach(p => { if (p) m.set(p.siteId, (m.get(p.siteId) || 0) + 1); }));
    return m;
  };
  const expBefore = exposure(states.map(s => s.cells.map(c => c.player)));
  const expAfter = exposure(states.map(s => s.final));
  const exposures = [...new Set([...expBefore.keys(), ...expAfter.keys()])]
    .map(id => ({
      siteId: id,
      name: pool.get(id)?.name ?? id,
      locked: locks.isLocked(pool.get(id)?.team),
      before: round1(((expBefore.get(id) || 0) / N) * 100),
      after: round1(((expAfter.get(id) || 0) / N) * 100)
    }))
    .sort((a, b) => b.after - a.after || b.before - a.before);

  return {
    site,
    now: now.toISOString(),
    mode,
    slots,
    summary: {
      entries: N,
      changedEntries: results.filter(r => r.status === 'changed').length,
      swaps: sum(results, r => r.swaps),
      lockedOut: sum(results, r => r.flags.filter(f => f.type === 'LOCKED_OUT').length),
      errors: results.filter(r => r.status === 'error').length,
      projectionBefore: round1(sum(results, r => r.before.projection)),
      projectionAfter: round1(sum(results, r => r.after.projection))
    },
    locks: lockTable,
    warnings,
    exposures,
    entries: results,
    csv: outputCsv
  };
}
