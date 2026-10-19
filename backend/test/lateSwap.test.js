import { describe, it, expect, beforeAll } from 'vitest';
import {
  runLateSwap, parseEntriesFile, parsePlayerCell, parseCsv, parseStartTime, parseGameInfo,
  classifyStatus, buildLockState
} from '../src/services/lateSwap/index.js';
import { searchLineup } from '../src/services/lateSwap/lineupSearch.js';
import {
  buildSlate, toDbRows, dkEntriesCsv, fdEntriesCsv, BEFORE_ALL, AFTER_EARLY
} from './fixtures/lateSwapSlate.js';

const EARLY_TEAMS = new Set(['LAL', 'BOS', 'DAL', 'SAS']);
const players = buildSlate();
const byId = new Map(players.map(p => [p.siteId, p]));
const byName = new Map(players.map(p => [p.name, p]));
const lineupIds = (result) => result.entries.map(e => e.slots.map(s => s.after?.siteId ?? null));
const sortedKey = (ids) => [...ids].sort().join('|');

describe('entries file parsing', () => {
  it('parses DK, FD and locked roster cells', () => {
    expect(parsePlayerCell('LeBron James (39971234)')).toEqual({ siteId: '39971234', name: 'LeBron James', locked: false });
    expect(parsePlayerCell('LeBron James (39971234) (LOCKED)')).toEqual({ siteId: '39971234', name: 'LeBron James', locked: true });
    expect(parsePlayerCell('39971234')).toEqual({ siteId: '39971234', name: null, locked: false });
    expect(parsePlayerCell('12345-67890:Stephen Curry')).toEqual({ siteId: '12345-67890', name: 'Stephen Curry', locked: false });
    expect(parsePlayerCell('  ')).toBeNull();
  });

  it('handles quoted CSV fields, CRLF and a BOM', () => {
    expect(parseCsv('﻿a,"b, c","d ""e"""\r\n1,2,3\n')).toEqual([['a', 'b, c', 'd "e"'], ['1', '2', '3']]);
  });

  it('reads a DKEntries file: entries, slots and the player table with start times', () => {
    const csv = dkEntriesCsv(players, [players.slice(0, 8).map(p => p.siteId), new Array(8).fill(null)]);
    const parsed = parseEntriesFile(csv);
    expect(parsed.site).toBe('draftkings');
    expect(parsed.slots).toEqual(['PG', 'SG', 'SF', 'PF', 'C', 'G', 'F', 'UTIL']);
    expect(parsed.metaColumns).toEqual(['Entry ID', 'Contest Name', 'Contest ID', 'Entry Fee']);
    expect(parsed.entries).toHaveLength(2);
    expect(parsed.entries[0].players[0]).toMatchObject({ siteId: '1001', name: 'LAL Player 1' });
    expect(parsed.entries[1].players.every(p => p === null)).toBe(true);
    expect(parsed.playerPool).toHaveLength(players.length);
    const lal = parsed.playerPool.find(p => p.siteId === '1001');
    expect(lal).toMatchObject({ team: 'LAL', opponent: 'BOS', salary: 9600 });
    expect(lal.startTime.toISOString()).toBe('2026-10-17T23:00:00.000Z');
  });

  it('detects FanDuel files (entry_id header, repeated slots)', () => {
    const fd = players.map(p => ({ ...p, siteId: `999-${p.siteId}`, position: p.position.split('/')[0] }));
    const parsed = parseEntriesFile(fdEntriesCsv(fd, [new Array(9).fill(null)]));
    expect(parsed.site).toBe('fanduel');
    expect(parsed.slots).toEqual(['PG', 'PG', 'SG', 'SG', 'SF', 'SF', 'PF', 'PF', 'C']);
    expect(parsed.playerPool[0]).toMatchObject({ siteId: '999-1001', name: 'LAL Player 1', team: 'LAL' });
  });

  it('rejects files without an entries header', () => {
    expect(() => parseEntriesFile('a,b,c\n1,2,3')).toThrow(/Entry ID/);
  });
});

describe('game times and status', () => {
  it('converts US Eastern times with DST', () => {
    expect(parseStartTime('10/17/2026 07:30PM ET').toISOString()).toBe('2026-10-17T23:30:00.000Z'); // EDT
    expect(parseStartTime('01/15/2027 07:30PM ET').toISOString()).toBe('2027-01-16T00:30:00.000Z'); // EST
    expect(parseStartTime('2026-10-17 19:30:00').toISOString()).toBe('2026-10-17T23:30:00.000Z');
    expect(parseStartTime('2026-10-17T23:30:00Z').toISOString()).toBe('2026-10-17T23:30:00.000Z');
    expect(parseStartTime('TBD')).toBeNull();
    expect(parseGameInfo('DAL@SAS 10/17/2026 08:30PM ET')).toMatchObject({ away: 'DAL', home: 'SAS' });
  });

  it('locks teams by start time, explicit override and alias', () => {
    const locks = buildLockState({
      teamTimes: new Map([['LAL', new Date('2026-10-17T23:00:00Z')], ['GSW', new Date('2026-10-18T02:00:00Z')]]),
      gameTimes: { PHO: '2026-10-17T23:30:00Z' },
      lockedTeams: ['NY'],
      now: new Date(AFTER_EARLY)
    });
    expect(locks.isLocked('LAL')).toBe(true);
    expect(locks.isLocked('GS')).toBe(false);
    expect(locks.isLocked('PHX')).toBe(true);
    expect(locks.isLocked('NYK')).toBe(true);
    expect(locks.hasTime('MIA')).toBe(false);
  });

  it('classifies injury designations', () => {
    expect(classifyStatus('Out')).toBe('OUT');
    expect(classifyStatus('O')).toBe('OUT');
    expect(classifyStatus('{"status":"OFS"}')).toBe('OUT');
    expect(classifyStatus('GTD')).toBe('Q');
    expect(classifyStatus('Questionable')).toBe('Q');
    expect(classifyStatus(null)).toBeNull();
    expect(classifyStatus('')).toBeNull();
  });
});

describe('searchLineup', () => {
  it('finds the best lineup and the next best when the best is forbidden', () => {
    // 3 slots any player can fill; cap forces leaving out the top player
    const items = [
      { id: 'a', proj: 30, salary: 50, mask: 7 },
      { id: 'b', proj: 20, salary: 30, mask: 7 },
      { id: 'c', proj: 18, salary: 30, mask: 7 },
      { id: 'd', proj: 10, salary: 10, mask: 7 },
      { id: 'e', proj: 5, salary: 5, mask: 7 }
    ];
    const best = searchLineup({ items, k: 3, salaryLeft: 90 });
    expect(best.chosen.map(x => x.id).sort()).toEqual(['a', 'b', 'd']);
    const next = searchLineup({ items, k: 3, salaryLeft: 90, forbidden: new Set(['a|b|d']) });
    expect(next.chosen.map(x => x.id).sort()).toEqual(['a', 'c', 'd']);
    expect(searchLineup({ items, k: 3, salaryLeft: 10 })).toBeNull();
  });

  it('respects slot eligibility', () => {
    const items = [
      { id: 'a', proj: 30, salary: 1, mask: 1 },
      { id: 'b', proj: 29, salary: 1, mask: 1 },
      { id: 'c', proj: 1, salary: 1, mask: 2 }
    ];
    expect(searchLineup({ items, k: 2, salaryLeft: 10 }).chosen.map(x => x.id).sort()).toEqual(['a', 'c']);
  });
});

describe('runLateSwap (DraftKings)', () => {
  let base; // 12 lineups built before any game starts
  beforeAll(() => {
    const empty = Array.from({ length: 12 }, () => new Array(8).fill(null));
    const filled = runLateSwap({ csv: dkEntriesCsv(players, empty), dbPlayers: toDbRows(players), now: BEFORE_ALL, maxExposure: 50 });
    base = lineupIds(filled);
  });

  it('fills empty entries before lock: valid, unique, within exposure caps', () => {
    expect(base.every(l => l.every(Boolean))).toBe(true);
    expect(new Set(base.map(sortedKey)).size).toBe(base.length);
    const counts = new Map();
    base.flat().forEach(id => counts.set(id, (counts.get(id) || 0) + 1));
    expect(Math.max(...counts.values())).toBeLessThanOrEqual(6);
    for (const l of base) {
      expect(l.reduce((s, id) => s + byId.get(id).salary, 0)).toBeLessThanOrEqual(50000);
    }
  });

  it('keeps locked players in place, swaps OUT players, flags locked OUT players', () => {
    const lineup = base[0];
    const lockedPlayer = lineup.map(id => byId.get(id)).find(p => EARLY_TEAMS.has(p.team));
    const latePlayer = lineup.map(id => byId.get(id)).find(p => !EARLY_TEAMS.has(p.team));
    expect(lockedPlayer && latePlayer).toBeTruthy();

    const result = runLateSwap({
      csv: dkEntriesCsv(players, base),
      dbPlayers: toDbRows(players, { injuries: { [lockedPlayer.name]: 'Out', [latePlayer.name]: 'Out' } }),
      now: AFTER_EARLY
    });
    expect(result.locks.filter(l => l.locked).map(l => l.team).sort()).toEqual([...EARLY_TEAMS].sort());

    for (const [e, entry] of result.entries.entries()) {
      entry.slots.forEach((slot, i) => {
        const original = byId.get(base[e][i]);
        if (EARLY_TEAMS.has(original.team)) {
          expect(slot.locked).toBe(true);
          expect(slot.after.siteId).toBe(original.siteId);
        } else {
          // nothing from a started game may be swapped in
          expect(EARLY_TEAMS.has(slot.after.team)).toBe(false);
        }
        expect(slot.after.siteId).not.toBe(latePlayer.siteId);
      });
      expect(entry.after.salary).toBeLessThanOrEqual(50000);
    }

    const first = result.entries[0];
    expect(first.flags.map(f => f.type)).toContain('LOCKED_OUT');
    const outSlot = first.slots.find(s => s.before.siteId === latePlayer.siteId);
    expect(outSlot.reason).toBe('out');
    expect(result.summary.lockedOut).toBeGreaterThanOrEqual(1);
    expect(new Set(lineupIds(result).map(sortedKey)).size).toBe(base.length);
  });

  it('outOnly mode swaps only the OUT players and leaves the rest in their slots', () => {
    const late = base[0].map(id => byId.get(id)).filter(p => !EARLY_TEAMS.has(p.team));
    const result = runLateSwap({
      csv: dkEntriesCsv(players, base),
      dbPlayers: toDbRows(players),
      now: AFTER_EARLY,
      mode: 'outOnly',
      outPlayers: [late[0].name]
    });
    let reoptimized = 0;
    for (const [e, entry] of result.entries.entries()) {
      const hadOut = base[e].includes(late[0].siteId);
      expect(entry.slots.some(s => s.after.siteId === late[0].siteId)).toBe(false);
      if (entry.flags.some(f => f.type === 'REOPTIMIZED')) {
        reoptimized++;
        continue;
      }
      expect(entry.swaps).toBe(hadOut ? 1 : 0);
      // only the OUT player's slot changes: nobody else gets shuffled
      entry.slots.forEach((slot, i) => {
        if (base[e][i] !== late[0].siteId) expect(slot.after.siteId).toBe(base[e][i]);
      });
    }
    expect(reoptimized).toBeLessThan(result.entries.length);
  });

  it('outOnly re-optimizes open slots when a like-for-like swap is impossible', () => {
    // A $50,000 lineup whose OUT player is the cheapest at his position with no cheaper fill-in
    const lineup = ['PHX Player 6', 'MIA Player 6', 'MIA Player 7', 'BOS Player 4', 'PHX Player 5', 'PHX Player 1', 'SAS Player 4', 'MIA Player 5']
      .map(n => byName.get(n).siteId);
    const salary = lineup.reduce((s, id) => s + byId.get(id).salary, 0);
    expect(salary).toBeLessThanOrEqual(50000);
    const result = runLateSwap({
      csv: dkEntriesCsv(players, [lineup]),
      dbPlayers: toDbRows(players),
      now: AFTER_EARLY,
      mode: 'outOnly',
      outPlayers: ['MIA Player 6'],
      maxExposure: 100
    });
    const [entry] = result.entries;
    expect(entry.slots.some(s => s.after.name === 'MIA Player 6')).toBe(false);
    expect(entry.status).toBe('changed');
    expect(entry.after.salary).toBeLessThanOrEqual(50000);
  });

  it('honors the (LOCKED) marker and lockedTeams without game times', () => {
    const noTimes = players.map(p => ({ ...p, gameInfo: `${p.team}@${p.opponent}` }));
    const lockedId = base[0].find(id => byId.get(id).team === 'GSW') ?? base[0][0];
    const lockedTeam = byId.get(lockedId).team;
    const result = runLateSwap({
      csv: dkEntriesCsv(noTimes, base, { locked: new Set([lockedId]) }),
      dbPlayers: toDbRows(players),
      now: AFTER_EARLY,
      lockedTeams: ['MIA']
    });
    expect(result.locks.find(l => l.team === lockedTeam).locked).toBe(true);
    expect(result.locks.find(l => l.team === 'MIA').locked).toBe(true);
    expect(result.warnings.join(' ')).toMatch(/No start time/);
    for (const entry of result.entries) {
      for (const slot of entry.slots) {
        if (!slot.locked) expect([lockedTeam, 'MIA']).not.toContain(slot.after.team);
      }
    }
  });

  it('enforces uniqueness for identical entries', () => {
    const same = new Array(5).fill(base[0]);
    const result = runLateSwap({ csv: dkEntriesCsv(players, same), dbPlayers: toDbRows(players), now: AFTER_EARLY });
    expect(new Set(lineupIds(result).map(sortedKey)).size).toBe(5);
    const dupes = runLateSwap({ csv: dkEntriesCsv(players, same), dbPlayers: toDbRows(players), now: AFTER_EARLY, unique: false });
    expect(new Set(lineupIds(dupes).map(sortedKey)).size).toBe(1);
    expect(dupes.entries.flatMap(e => e.flags)).toEqual([]);
  });

  it('applies per-player exposure caps to swapped-in players', () => {
    const star = byName.get('GSW Player 1');
    const result = runLateSwap({
      csv: dkEntriesCsv(players, base),
      dbPlayers: toDbRows(players, { projections: { [star.name]: 90 } }),
      now: AFTER_EARLY,
      playerExposure: { [star.siteId]: 25 }
    });
    // GSW plays late, so the star is swappable everywhere: 25% of 12 entries = 3
    const uses = lineupIds(result).filter(l => l.includes(star.siteId)).length;
    expect(uses).toBe(3);
    expect(result.exposures.find(x => x.siteId === star.siteId).after).toBeLessThanOrEqual(25);
  });

  it('writes an upload CSV that round-trips to the new lineups', () => {
    const result = runLateSwap({ csv: dkEntriesCsv(players, base), dbPlayers: toDbRows(players), now: AFTER_EARLY });
    const lines = result.csv.trim().split('\r\n');
    expect(lines[0]).toBe('Entry ID,Contest Name,Contest ID,Entry Fee,PG,SG,SF,PF,C,G,F,UTIL');
    expect(lines).toHaveLength(base.length + 1);
    const reparsed = parseEntriesFile(result.csv);
    expect(reparsed.entries.map(e => e.players.map(p => p.siteId))).toEqual(lineupIds(result));
    expect(reparsed.entries.map(e => e.entryId)).toEqual(result.entries.map(e => e.entryId));
  });

  it('validates input', () => {
    expect(() => runLateSwap({})).toThrow(/csv/);
    expect(() => runLateSwap({ csv: dkEntriesCsv(players, base), mode: 'nope' })).toThrow(/mode/);
    expect(() => runLateSwap({ csv: dkEntriesCsv(players, base), now: 'not a date' })).toThrow(/now/);
  });
});

describe('runLateSwap (FanDuel)', () => {
  it('fills 9-slot lineups with id:name cells and at most 4 players per team', () => {
    const fd = players.map(p => ({ ...p, siteId: `77-${p.siteId}`, position: p.position.split('/')[0], salary: Math.round(p.salary * 1.2) }));
    // Make one team overwhelmingly good so the per-team cap binds
    const projections = Object.fromEntries(fd.filter(p => p.team === 'GSW').map(p => [p.name, 80]));
    const result = runLateSwap({
      csv: fdEntriesCsv(fd, [new Array(9).fill(null), new Array(9).fill(null)]),
      dbPlayers: toDbRows(fd, { projections }),
      now: BEFORE_ALL
    });
    expect(result.site).toBe('fanduel');
    for (const entry of result.entries) {
      const after = entry.slots.map(s => s.after);
      expect(after.every(Boolean)).toBe(true);
      expect(after.filter(p => p.team === 'GSW').length).toBeLessThanOrEqual(4);
      expect(new Set(after.map(p => p.team)).size).toBeGreaterThanOrEqual(3);
      expect(entry.after.salary).toBeLessThanOrEqual(60000);
      entry.slots.forEach(s => expect(s.after.position).toBe(s.slot));
    }
    const row = result.csv.split('\r\n')[1].split(',');
    expect(row[4]).toMatch(/^77-\d+:.+ Player \d$/);
  });
});
