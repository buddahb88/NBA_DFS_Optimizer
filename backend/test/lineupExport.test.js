import { test, describe } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  parseCsv,
  formatCsvRow,
  validateLineupForSite,
  buildLineupExport,
  locateSlotColumns
} from '../src/services/lineupExportService.js';

const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'entries');
// Read as binary-safe text so CRLF line endings are kept exactly
const fixture = (name) => fs.readFileSync(path.join(fixtureDir, name), 'utf8');

// Entries fixtures are modeled on each site's downloaded entries file:
// DKEntries.csv (entry columns, slots, blank column, Instructions + player list),
// FanDuel's CSV-edit template (entry_id, contest_id, contest_name, entry_fee, slots,
// blank, Instructions + player list). Yahoo doesn't document its contest template,
// so YahooEntries.csv is an assumed layout; export only depends on the slot header.

const p = (id, name, position, salary, team, opponent, sitePlayerId, extra = {}) =>
  ({ id, name, position, salary, team, opponent, site_player_id: sitePlayerId, slate_id: 's1', ...extra });

// DK: 8 players, 2 games, 49,600 salary
const dkLineup = () => ({
  name: 'DK 1',
  slateSite: 'draftkings',
  players: [
    p(1, 'Guard One', 'PG', 9500, 'AAA', 'BBB', '39000001'),
    p(2, 'Wing One', 'SG', 7000, 'BBB', 'AAA', '39000002'),
    p(3, 'Forward One', 'SF', 6000, 'CCC', 'DDD', '39000003'),
    p(4, 'Big One', 'PF', 5500, 'DDD', 'CCC', '39000004'),
    p(5, 'Center One', 'C', 8000, 'AAA', 'BBB', '39000005'),
    p(6, 'Combo Guard', 'PG/SG', 4800, 'CCC', 'DDD', '39000006'),
    p(7, 'Combo Forward', 'SF/PF', 4400, 'BBB', 'AAA', '39000007'),
    p(8, 'Util Big', 'PF/C', 4400, 'DDD', 'CCC', '39000008')
  ]
});

const fdLineup = () => ({
  name: 'FD 1',
  slateSite: 'fanduel',
  players: [
    p(11, 'LeBron James', 'SF', 10000, 'LAL', 'BOS', '118012-15500'),
    p(12, 'Point A', 'PG', 7000, 'BOS', 'LAL', '118012-1'),
    p(13, 'Point B', 'PG', 6000, 'MIA', 'NYK', '118012-2'),
    p(14, 'Shoot A', 'SG', 6000, 'NYK', 'MIA', '118012-3'),
    p(15, 'Shoot B', 'SG', 5500, 'LAL', 'BOS', '118012-4'),
    p(16, 'Small B', 'SF', 5000, 'BOS', 'LAL', '118012-5'),
    p(17, 'Power A', 'PF', 6500, 'MIA', 'NYK', '118012-6'),
    p(18, 'Power B', 'PF', 5000, 'NYK', 'MIA', '118012-7'),
    p(19, 'Center A', 'C', 8000, 'LAL', 'BOS', '118012-8')
  ]
});

const yahooLineup = () => ({
  name: 'Y 1',
  slateSite: 'yahoo',
  players: [
    p(21, 'Y PG', 'PG', 30, 'AAA', 'BBB', 'nba.p.1'),
    p(22, 'Y SG', 'SG', 25, 'BBB', 'AAA', 'nba.p.2'),
    p(23, 'Y G', 'PG', 20, 'CCC', 'DDD', 'nba.p.3'),
    p(24, 'Y SF', 'SF', 25, 'DDD', 'CCC', 'nba.p.4'),
    p(25, 'Y PF', 'PF', 25, 'AAA', 'BBB', 'nba.p.5'),
    p(26, 'Y F', 'SF', 20, 'BBB', 'AAA', 'nba.p.6'),
    p(27, 'Y C', 'C', 30, 'CCC', 'DDD', 'nba.p.7'),
    p(28, 'Y UTIL', 'C', 20, 'DDD', 'CCC', 'nba.p.8')
  ]
});

describe('csv helpers', () => {
  test('parses quotes, escaped quotes, CRLF and keeps raw text', () => {
    const { records, newline, trailingNewline } = parseCsv('a,"b,c","d ""e"""\r\n1,2,3\r\n');
    assert.equal(newline, '\r\n');
    assert.equal(trailingNewline, true);
    assert.deepEqual(records[0].cells, ['a', 'b,c', 'd "e"']);
    assert.equal(records[0].raw, 'a,"b,c","d ""e"""');
    assert.equal(records.length, 2);
  });

  test('strips a BOM and handles a file without trailing newline', () => {
    const { records, bom, trailingNewline } = parseCsv('﻿PG,SG\n1,2');
    assert.equal(bom, true);
    assert.equal(trailingNewline, false);
    assert.deepEqual(records.map(r => r.cells), [['PG', 'SG'], ['1', '2']]);
  });

  test('formatCsvRow quotes only when needed', () => {
    assert.equal(formatCsvRow(['1', 'a,b', 'say "hi"', '']), '1,"a,b","say ""hi""",');
  });
});

describe('validation', () => {
  test('valid DK lineup is ordered into DK slot order', () => {
    const { errors, ordered } = validateLineupForSite('draftkings', dkLineup());
    assert.deepEqual(errors, []);
    assert.deepEqual(ordered.map(x => x.sitePlayerId),
      ['39000001', '39000002', '39000003', '39000004', '39000005', '39000006', '39000007', '39000008']);
  });

  test('keeps the saved slot when it is still valid', () => {
    const lineup = dkLineup();
    // Combo Guard saved at PG, Guard One at G: both are legal, so keep it
    lineup.players[0].position_slot = 'G';
    lineup.players[5].position_slot = 'PG';
    const { ordered } = validateLineupForSite('draftkings', lineup);
    assert.equal(ordered[0].name, 'Combo Guard');
    assert.equal(ordered[5].name, 'Guard One');
  });

  test('uses roster_positions from the salary file over position', () => {
    const lineup = dkLineup();
    lineup.players[7] = { ...lineup.players[7], position: 'PF', roster_positions: 'UTIL' };
    const { errors, ordered } = validateLineupForSite('draftkings', lineup);
    assert.deepEqual(errors, []);
    assert.equal(ordered[7].name, 'Util Big');
  });

  test('reports salary, size, ids, duplicates, eligibility, games and site', () => {
    const lineup = dkLineup();
    lineup.players[0].salary = 20000;
    lineup.players[1].site_player_id = null;
    let { errors } = validateLineupForSite('draftkings', lineup);
    assert.ok(errors.some(e => /over the \$50,000 cap/.test(e)), errors.join());
    assert.ok(errors.some(e => /No DraftKings player ID for Wing One/.test(e)), errors.join());

    ({ errors } = validateLineupForSite('draftkings', { players: dkLineup().players.slice(0, 7) }));
    assert.ok(errors.some(e => /Has 7 players; DraftKings needs 8/.test(e)));

    const dup = dkLineup();
    dup.players[7] = dup.players[0];
    ({ errors } = validateLineupForSite('draftkings', dup));
    assert.ok(errors.some(e => /twice/.test(e)));

    const noCenter = dkLineup();
    noCenter.players[4] = { ...noCenter.players[4], position: 'SF' };
    noCenter.players[7] = { ...noCenter.players[7], position: 'PF' };
    ({ errors } = validateLineupForSite('draftkings', noCenter));
    assert.ok(errors.some(e => /can't fill the DraftKings slots/.test(e)), errors.join());

    const oneGame = dkLineup();
    oneGame.players.forEach(pl => { pl.team = pl.team === 'CCC' ? 'AAA' : pl.team === 'DDD' ? 'BBB' : pl.team; pl.opponent = pl.team === 'AAA' ? 'BBB' : 'AAA'; });
    ({ errors } = validateLineupForSite('draftkings', oneGame));
    assert.ok(errors.some(e => /1 game\(s\); needs at least 2/.test(e)), errors.join());

    ({ errors } = validateLineupForSite('fanduel', dkLineup()));
    assert.ok(errors.some(e => /from a DraftKings slate, not FanDuel/.test(e)));
  });

  test('FanDuel team limit and min teams', () => {
    const lineup = fdLineup();
    ['LAL', 'LAL', 'LAL', 'LAL', 'LAL'].forEach((t, i) => { lineup.players[i].team = t; });
    const { errors } = validateLineupForSite('fanduel', lineup);
    assert.ok(errors.some(e => /6 players from LAL; max is 4/.test(e)), errors.join());

    const twoTeams = fdLineup();
    twoTeams.players.forEach((pl, i) => { pl.team = i % 2 ? 'LAL' : 'BOS'; });
    assert.ok(validateLineupForSite('fanduel', twoTeams).errors.some(e => /2 team\(s\); needs at least 3/.test(e)));
  });

  test('Yahoo cap is $200', () => {
    const lineup = yahooLineup();
    assert.deepEqual(validateLineupForSite('yahoo', lineup).errors, []);
    lineup.players[0].salary = 60;
    assert.ok(validateLineupForSite('yahoo', lineup).errors.some(e => /\$225 is over the \$200 cap/.test(e)));
  });
});

describe('new lineups mode', () => {
  test('DraftKings: slot header and one row of IDs per lineup', () => {
    const r = buildLineupExport({ site: 'draftkings', mode: 'new', lineups: [dkLineup(), dkLineup()] });
    assert.equal(r.success, true, JSON.stringify(r.errors));
    assert.equal(r.csv,
      'PG,SG,SF,PF,C,G,F,UTIL\r\n' +
      '39000001,39000002,39000003,39000004,39000005,39000006,39000007,39000008\r\n'.repeat(2));
    assert.equal(r.rowCount, 2);
  });

  test('FanDuel: repeated slots and id:name cells', () => {
    const r = buildLineupExport({ site: 'fanduel', mode: 'new', lineups: [fdLineup()] });
    assert.equal(r.success, true, JSON.stringify(r.errors));
    const [header, row] = r.csv.trim().split('\r\n');
    assert.equal(header, 'PG,PG,SG,SG,SF,SF,PF,PF,C');
    assert.equal(row,
      '118012-1:Point A,118012-2:Point B,118012-3:Shoot A,118012-4:Shoot B,118012-15500:LeBron James,' +
      '118012-5:Small B,118012-6:Power A,118012-7:Power B,118012-8:Center A');
  });

  test('Yahoo: slot header in Yahoo order with Yahoo IDs', () => {
    const r = buildLineupExport({ site: 'yahoo', mode: 'new', lineups: [yahooLineup()] });
    assert.equal(r.success, true, JSON.stringify(r.errors));
    assert.equal(r.csv, 'PG,SG,G,SF,PF,F,C,UTIL\r\nnba.p.1,nba.p.2,nba.p.3,nba.p.4,nba.p.5,nba.p.6,nba.p.7,nba.p.8\r\n');
  });

  test('any invalid lineup blocks the export and is reported with its CSV row', () => {
    const bad = dkLineup();
    bad.name = 'Too rich';
    bad.lineupId = 42;
    bad.players[0].salary = 30000;
    const r = buildLineupExport({ site: 'draftkings', mode: 'new', lineups: [dkLineup(), bad] });
    assert.equal(r.success, false);
    assert.equal(r.csv, undefined);
    assert.equal(r.errors.length, 1);
    assert.deepEqual({ ...r.errors[0], messages: undefined },
      { index: 2, lineupId: 42, name: 'Too rich', csvRow: 3, messages: undefined });
  });

  test('not found lineups and bad mode', () => {
    let r = buildLineupExport({ site: 'draftkings', mode: 'new', lineups: [{ lineupId: 9, missing: true, players: [] }] });
    assert.deepEqual(r.errors[0].messages, ['Lineup not found']);
    r = buildLineupExport({ site: 'draftkings', mode: 'bulk', lineups: [dkLineup()] });
    assert.match(r.errors[0].messages[0], /Unknown mode/);
    r = buildLineupExport({ site: 'draftkings', mode: 'new', lineups: [] });
    assert.match(r.errors[0].messages[0], /No lineups/);
  });
});

describe('entries mode', () => {
  test('DraftKings: fills slot cells in place and keeps everything else byte-for-byte', () => {
    const template = fixture('DKEntries.csv');
    const r = buildLineupExport({ site: 'draftkings', mode: 'entries', lineups: [dkLineup(), dkLineup(), dkLineup()], entriesTemplate: template });
    assert.equal(r.success, true, JSON.stringify(r.errors));
    assert.deepEqual(r.warnings, []);

    const inLines = template.split('\r\n');
    const outLines = r.csv.split('\r\n');
    assert.equal(outLines.length, inLines.length);
    // Header and player-list rows unchanged
    assert.equal(outLines[0], inLines[0]);
    assert.deepEqual(outLines.slice(4), inLines.slice(4));

    const ids = '39000001,39000002,39000003,39000004,39000005,39000006,39000007,39000008';
    assert.equal(outLines[1], `4512345001,NBA $5K Shot [20 Entry Max],180001234,$3,${ids},,1. Column A lists all of your contest entries for this draftgroup`);
    // Existing lineup replaced, quoted contest name and instructions kept
    assert.equal(outLines[3], `4512345003,"NBA $100K Main Event, Single Entry",180005678,$20,${ids},,3. You can change the lineup for an entry by entering the IDs of the players`);
  });

  test('DraftKings: fewer lineups than entries leaves the rest and warns', () => {
    const r = buildLineupExport({ site: 'draftkings', mode: 'entries', lineups: [dkLineup()], entriesTemplate: fixture('DKEntries.csv') });
    assert.equal(r.success, true);
    assert.equal(r.rowCount, 1);
    assert.match(r.warnings[0], /2 entries left unchanged/);
    const out = r.csv.split('\r\n');
    assert.match(out[3], /Guard One \(39000001\),Wing One \(39000002\)/);
  });

  test('FanDuel: fills both entries, extra lineups are left out with a warning', () => {
    const template = fixture('FanDuelEntries.csv');
    const r = buildLineupExport({ site: 'fanduel', mode: 'entries', lineups: [fdLineup(), fdLineup(), fdLineup()], entriesTemplate: template });
    assert.equal(r.success, true, JSON.stringify(r.errors));
    assert.match(r.warnings[0], /1 lineup\(s\) left out: the file only has 2 entries/);
    const out = r.csv.split('\r\n');
    assert.equal(out[0], template.split('\r\n')[0]);
    assert.ok(out[1].startsWith('3790001111,118012-276031234,NBA $50K Tuesday Tip-Off,5,118012-1:Point A,118012-2:Point B,'));
    // Edited rows are re-written with minimal quoting; untouched rows stay as-is
    assert.ok(out[1].endsWith(',118012-8:Center A,,1. Locate the player you want to select in the list below'));
    assert.equal(parseCsv(out[1]).records[0].cells.length, 15);
    assert.deepEqual(out.slice(3), template.split('\r\n').slice(3));
  });

  test('extra lineups beyond the entries are not validated', () => {
    const bad = fdLineup();
    bad.players[0].salary = 99999;
    const r = buildLineupExport({ site: 'fanduel', mode: 'entries', lineups: [fdLineup(), fdLineup(), bad], entriesTemplate: fixture('FanDuelEntries.csv') });
    assert.equal(r.success, true);
  });

  test('Yahoo: slot columns found after the contest/entry columns, LF kept', () => {
    const r = buildLineupExport({ site: 'yahoo', mode: 'entries', lineups: [yahooLineup(), yahooLineup()], entriesTemplate: fixture('YahooEntries.csv') });
    assert.equal(r.success, true, JSON.stringify(r.errors));
    assert.equal(r.csv,
      'Contest Title,Contest ID,Entry ID,Entry Fee,PG,SG,G,SF,PF,F,C,UTIL\n' +
      'NBA $10K Saturday,13450001,98760001,$1,nba.p.1,nba.p.2,nba.p.3,nba.p.4,nba.p.5,nba.p.6,nba.p.7,nba.p.8\n' +
      'NBA $10K Saturday,13450001,98760002,$1,nba.p.1,nba.p.2,nba.p.3,nba.p.4,nba.p.5,nba.p.6,nba.p.7,nba.p.8\n');
  });

  test('errors point at the entries file row', () => {
    const bad = dkLineup();
    bad.players[3].site_player_id = '';
    const r = buildLineupExport({ site: 'draftkings', mode: 'entries', lineups: [dkLineup(), bad], entriesTemplate: fixture('DKEntries.csv') });
    assert.equal(r.success, false);
    assert.equal(r.errors[0].index, 2);
    assert.equal(r.errors[0].csvRow, 3);
    assert.match(r.errors[0].messages[0], /No DraftKings player ID for Big One/);
  });

  test('rejects a file for the wrong site or with no entries', () => {
    let r = buildLineupExport({ site: 'draftkings', mode: 'entries', lineups: [dkLineup()], entriesTemplate: fixture('FanDuelEntries.csv') });
    assert.match(r.errors[0].messages[0], /Couldn't find the DraftKings NBA Classic slot columns/);
    r = buildLineupExport({ site: 'draftkings', mode: 'entries', lineups: [dkLineup()], entriesTemplate: 'Entry ID,Contest Name,Contest ID,Entry Fee,PG,SG,SF,PF,C,G,F,UTIL\r\n' });
    assert.match(r.errors[0].messages[0], /no entries/);
    r = buildLineupExport({ site: 'draftkings', mode: 'entries', lineups: [dkLineup()] });
    assert.match(r.errors[0].messages[0], /Upload your DraftKings entries file/);
  });

  test('locateSlotColumns finds the entry id column', () => {
    const { records } = parseCsv(fixture('FanDuelEntries.csv'));
    assert.deepEqual(locateSlotColumns('fanduel', records), { headerIndex: 0, slotStart: 4, entryIdCol: 0 });
  });
});
