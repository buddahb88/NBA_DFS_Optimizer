import { test, describe, beforeAll as before, afterAll as after } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';

import { normalizeName, normalizeTeam } from '../src/utils/nameNormalizer.js';
import { parseCsv } from '../src/utils/csvParser.js';
import { parseMultipart } from '../src/utils/multipart.js';

const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'salaries');
const fixture = (name) => fs.readFileSync(path.join(fixtureDir, name), 'utf8');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nba-dfs-salaries-'));
process.env.DATABASE_TYPE = 'sqlite';
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');

let db;
let service;

before(async () => {
  db = (await import('../src/config/database.js')).default;
  const { createTables } = await import('../src/config/schema.js');
  await createTables(db);
  service = await import('../src/services/salaryImportService.js');
});

after(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('normalizeName', () => {
  test('strips accents, suffixes and punctuation', () => {
    assert.equal(normalizeName('Luka Dončić'), normalizeName('Luka Doncic'));
    assert.equal(normalizeName('Jaren Jackson Jr.'), 'jaren jackson');
    assert.equal(normalizeName('Trey Murphy III'), 'trey murphy');
    assert.equal(normalizeName('P.J. Washington'), 'pj washington');
    assert.equal(normalizeName('A. J. Green'), 'aj green');
    assert.equal(normalizeName("De'Aaron Fox"), 'deaaron fox');
    assert.equal(normalizeName('Nikola Jokić'), 'nikola jokic');
    assert.equal(normalizeName('Shai Gilgeous-Alexander'), 'shai gilgeous alexander');
  });

  test('maps known nicknames to one key', () => {
    assert.equal(normalizeName('Nicolas Claxton'), normalizeName('Nic Claxton'));
    assert.equal(normalizeName('Herbert Jones'), normalizeName('Herb Jones'));
    assert.equal(normalizeName('Moe Wagner'), normalizeName('Moritz Wagner'));
  });

  test('normalizes team abbreviations', () => {
    assert.equal(normalizeTeam('GS'), 'GSW');
    assert.equal(normalizeTeam('pho'), 'PHX');
    assert.equal(normalizeTeam('NO'), 'NOP');
    assert.equal(normalizeTeam('LAL'), 'LAL');
  });
});

test('parseCsv handles quotes, embedded commas and BOM', () => {
  const rows = parseCsv('﻿a,"b, c","say ""hi"""\r\n\r\n1,2,3');
  assert.deepEqual(rows, [['a', 'b, c', 'say "hi"'], ['1', '2', '3']]);
});

test('parseMultipart extracts file and fields', () => {
  const b = 'XyZ';
  const body = Buffer.from(
    `--${b}\r\nContent-Disposition: form-data; name="site"\r\n\r\nfanduel\r\n` +
    `--${b}\r\nContent-Disposition: form-data; name="file"; filename="p.csv"\r\nContent-Type: text/csv\r\n\r\nId,Name\r\n1,Dončić\r\n` +
    `--${b}--\r\n`
  );
  const { fields, files } = parseMultipart(body, `multipart/form-data; boundary=${b}`);
  assert.equal(fields.site, 'fanduel');
  assert.equal(files.file.filename, 'p.csv');
  assert.equal(files.file.buffer.toString('utf8'), 'Id,Name\r\n1,Dončić');
});

describe('parseSalaryCsv', () => {
  test('DraftKings: detects site, ids, roster positions, opponent and ET start time', () => {
    const { site, players } = service.parseSalaryCsv(fixture('DKSalaries.csv'));
    assert.equal(site, 'draftkings');
    assert.equal(players.length, 7);
    const luka = players[0];
    assert.equal(luka.sitePlayerId, '39000001');
    assert.equal(luka.name, 'Luka Dončić');
    assert.deepEqual(luka.positions, ['PG']);
    assert.equal(luka.rosterPositions, 'PG/G/UTIL');
    assert.equal(luka.salary, 11200);
    assert.equal(luka.team, 'LAL');
    assert.equal(luka.opponent, 'DAL');
    assert.equal(luka.fppg, 56.2);
    // 10:00PM EDT on 10/22/2025 = 02:00 UTC next day
    assert.equal(luka.startTime, '2025-10-23T02:00:00.000Z');
    const curry = players.find(p => p.name === 'Stephen Curry');
    assert.equal(curry.team, 'GSW');
    assert.equal(curry.opponent, 'SAS');
  });

  test('FanDuel: detects site, builds names, roster positions and injuries', () => {
    const { site, players } = service.parseSalaryCsv(fixture('FanDuelPlayers.csv'));
    assert.equal(site, 'fanduel');
    const lebron = players.find(p => p.sitePlayerId === '118012-15500');
    assert.equal(lebron.name, 'LeBron James');
    assert.deepEqual(lebron.positions, ['SF', 'PF']);
    assert.equal(lebron.rosterPositions, 'SF/PF');
    assert.equal(lebron.injuryStatus, 'GTD');
    assert.equal(lebron.opponent, 'DAL');
  });

  test('Yahoo: detects site from nba.p ids', () => {
    const { site, players } = service.parseSalaryCsv(fixture('YahooPlayers.csv'));
    assert.equal(site, 'yahoo');
    const jjj = players.find(p => p.sitePlayerId === 'nba.p.6611');
    assert.equal(jjj.name, 'Jaren Jackson Jr.');
    assert.equal(jjj.salary, 41);
    assert.equal(jjj.rosterPositions, 'PF/F/C/UTIL');
    assert.equal(jjj.gameInfo, 'MEM@BKN 7:30PM EDT');
  });

  test('rejects a site that contradicts the file', () => {
    assert.throws(() => service.parseSalaryCsv(fixture('DKSalaries.csv'), 'fanduel'), /looks like a DraftKings file/);
  });

  test('rejects files without a header row', () => {
    assert.throws(() => service.parseSalaryCsv('foo,bar\n1,2'), /header row/);
  });

  test('finds the player table inside a DK entries template', () => {
    const csv = 'Entry ID,Contest Name,,Instructions\n,,,1. Locate the player\n' +
      fixture('DKSalaries.csv').split(/\r?\n/).map(l => (l ? `,,,${l}` : l)).join('\n');
    const { site, players } = service.parseSalaryCsv(csv);
    assert.equal(site, 'draftkings');
    assert.equal(players.length, 7);
  });
});

describe('importSalaries', () => {
  before(async () => {
    // RotoWire-style DK slate with projections (no site IDs, slightly different names)
    await db.run(`INSERT INTO slates (slate_id, name, site) VALUES ('rw1', 'RotoWire Main', 'draftkings')`);
    const seed = [
      ['101', 'Luka Doncic', 'LAL', 'PG', 11000, 58.5],
      ['102', 'LeBron James', 'LAL', 'SF,PF', 9800, 47],
      ['103', 'PJ Washington', 'DAL', 'PF', 5500, 30],
      ['104', 'Jaren Jackson', 'MEM', 'PF,C', 8000, 41],
      ['105', 'Nicolas Claxton', 'BKN', 'C', 6000, 31],
      ['106', 'Old Guy', 'MIA', 'C', 3000, 12]
    ];
    for (const [id, name, team, pos, salary, proj] of seed) {
      await db.run(
        `INSERT INTO players (slate_id, player_id, name, team, position, salary, projected_points, projected_minutes)
         VALUES ('rw1', ?, ?, ?, ?, ?, ?, 30)`, id, name, team, pos, salary, proj
      );
    }
    await db.run(`
      INSERT INTO historical_games (player_id, player_name, team, opponent, game_date)
      VALUES ('201939', 'Stephen Curry', 'GSW', 'LAL', '2025-04-10')
    `);
  });

  test('DraftKings CSV updates the active DK slate in place', async () => {
    const r = await service.importSalaries({ csvText: fixture('DKSalaries.csv') });
    assert.equal(r.slate.slate_id, 'rw1');
    assert.equal(r.site, 'draftkings');
    assert.equal(r.updated, 5);
    assert.equal(r.inserted, 2);
    assert.deepEqual(r.matched, { slate: 5, projections: 0, historical: 1 });
    assert.deepEqual(r.unmatched.map(p => p.name), ['Zyxw Qwerty']);
    assert.deepEqual(r.missingFromCsv.map(p => p.name), ['Old Guy']);

    const luka = await db.get(`SELECT * FROM players WHERE slate_id = 'rw1' AND player_id = '101'`);
    assert.equal(luka.site_player_id, '39000001');
    assert.equal(luka.roster_positions, 'PG/G/UTIL');
    assert.equal(luka.salary, 11200);
    assert.equal(luka.opponent, 'DAL');
    assert.equal(luka.projected_points, 58.5);

    const curry = await db.get(`SELECT * FROM players WHERE slate_id = 'rw1' AND site_player_id = '39000006'`);
    assert.equal(curry.player_id, 'draftkings-39000006');
    assert.equal(curry.projected_points, 47.5); // site average fallback

    const slate = await db.get(`SELECT * FROM slates WHERE slate_id = 'rw1'`);
    assert.equal(slate.start_time, '2025-10-22T23:30:00.000Z');
  });

  test('re-importing the same file is idempotent', async () => {
    const r = await service.importSalaries({ csvText: fixture('DKSalaries.csv'), site: 'draftkings' });
    assert.equal(r.updated, 7);
    assert.equal(r.inserted, 0);
    assert.equal(r.unmatched.length, 0);
    const count = await db.get(`SELECT COUNT(*) AS n FROM players WHERE slate_id = 'rw1'`);
    assert.equal(count.n, 8);
  });

  test('FanDuel CSV creates a FanDuel slate and copies projections by name', async () => {
    const r = await service.importSalaries({ csvText: fixture('FanDuelPlayers.csv'), slateId: 'fd-main' });
    assert.equal(r.slate.site, 'fanduel');
    assert.equal(r.inserted, 4);
    assert.equal(r.matched.projections, 4); // all four are on rw1 now

    const lebron = await db.get(`SELECT * FROM players WHERE slate_id = 'fd-main' AND site_player_id = '118012-15500'`);
    assert.equal(lebron.player_id, '102');
    assert.equal(lebron.projected_points, 47);
    assert.equal(lebron.projected_minutes, 30);
    assert.equal(lebron.roster_positions, 'SF/PF');
    assert.equal(lebron.injury_status, 'GTD');
    assert.equal(lebron.salary, 10000);
  });

  test('Yahoo CSV goes into its own slate; ruled-out unmatched players get 0', async () => {
    await db.run(`DELETE FROM players WHERE name = 'Zyxw Qwerty'`);
    const r = await service.importSalaries({ csvText: fixture('YahooPlayers.csv'), slateId: 'yh-main' });
    assert.equal(r.slate.site, 'yahoo');
    assert.deepEqual(r.unmatched.map(p => p.name), ['Zyxw Qwerty']);
    const ghost = await db.get(`SELECT * FROM players WHERE slate_id = 'yh-main' AND site_player_id = 'nba.p.9999'`);
    assert.equal(ghost.projected_points, 0);
    const jjj = await db.get(`SELECT * FROM players WHERE slate_id = 'yh-main' AND site_player_id = 'nba.p.6611'`);
    assert.equal(jjj.player_id, '104');
  });

  test('refuses to import into a slate for another site', async () => {
    await assert.rejects(
      service.importSalaries({ csvText: fixture('YahooPlayers.csv'), slateId: 'rw1' }),
      /DraftKings slate/
    );
  });

  test('POST /api/slates/import-salaries accepts a multipart upload', async () => {
    const slatesRouter = (await import('../src/routes/slates.js')).default;
    const app = express();
    app.use('/api/slates', slatesRouter);
    const server = app.listen(0);
    try {
      const { port } = server.address();
      const form = new FormData();
      form.append('site', 'draftkings');
      form.append('slateId', 'rw1');
      form.append('file', new Blob([fixture('DKSalaries.csv')], { type: 'text/csv' }), 'DKSalaries.csv');
      const res = await fetch(`http://127.0.0.1:${port}/api/slates/import-salaries`, { method: 'POST', body: form });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.total, 7);
      assert.equal(body.slate.slate_id, 'rw1');

      const bad = new FormData();
      bad.append('site', 'fanduel');
      bad.append('file', new Blob([fixture('DKSalaries.csv')]), 'DKSalaries.csv');
      const badRes = await fetch(`http://127.0.0.1:${port}/api/slates/import-salaries`, { method: 'POST', body: bad });
      assert.equal(badRes.status, 400);

      const empty = await fetch(`http://127.0.0.1:${port}/api/slates/import-salaries`, { method: 'POST', body: new FormData() });
      assert.equal(empty.status, 400);
    } finally {
      server.close();
    }
  });
});
