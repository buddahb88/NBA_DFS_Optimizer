import { test, describe, beforeAll as before, afterAll as after } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  questionableConfirmedStarter,
  healthyUnconfirmed,
  noLineupBlock
} from './fixtures/rotowirePlayers.js';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nba-dfs-rotowire-'));
process.env.DATABASE_TYPE = 'sqlite';
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');

let db;
let rotowireService;
let playerModel;

before(async () => {
  db = (await import('../src/config/database.js')).default;
  const { createTables } = await import('../src/config/schema.js');
  await createTables(db);
  rotowireService = (await import('../src/services/rotowireService.js')).default;
  playerModel = (await import('../src/models/playerModel.js')).default;

  // Defense tables use their own abbreviations: PHX is stored as PHO in both
  await db.run(`INSERT INTO team_defense_rankings (team, def_eff, pace) VALUES ('PHO', 116.2, 101.5)`);
  await db.run(`INSERT INTO team_defense_rankings (team, def_eff, pace) VALUES ('SAS', 109.8, 99.0)`);
  await db.run(`INSERT INTO team_defense_vs_position (team, position, rank, pts_allowed) VALUES ('PHO', 'C', 120, 25.4)`);
  await db.run(`INSERT INTO team_defense_vs_position (team, position, rank, pts_allowed) VALUES ('SAS', 'PG', 30, 21.7)`);
});

after(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const byId = (players) => new Map(players.map(p => [p.playerId, p]));

describe('transformPlayerData', () => {
  test('maps RotoWire injuryStatus to injuryStatus', () => {
    const players = byId(rotowireService.transformPlayerData([questionableConfirmedStarter, healthyUnconfirmed]));
    assert.equal(players.get('5809').injuryStatus, 'QUES');
    assert.equal(players.get('6001').injuryStatus, null);
  });

  test('extracts lineup.isConfirmed as 1/0, null when RotoWire omits it', () => {
    const players = byId(rotowireService.transformPlayerData([questionableConfirmedStarter, healthyUnconfirmed, noLineupBlock]));
    assert.equal(players.get('5809').lineupConfirmed, 1);
    assert.equal(players.get('6001').lineupConfirmed, 0);
    assert.equal(players.get('6002').lineupConfirmed, null);
  });

  test('fills dvp_pts_allowed / opp_def_eff from pre-loaded defense lookups', async () => {
    const lookups = await rotowireService.loadDefenseLookups();
    const players = byId(rotowireService.transformPlayerData([questionableConfirmedStarter, healthyUnconfirmed, noLineupBlock], lookups));

    // SAS C vs PHX -> normalized to PHO in both tables
    assert.equal(players.get('5809').dvpPtsAllowed, 25.4);
    assert.equal(players.get('5809').oppDefEff, 116.2);
    // PHX PG vs SAS
    assert.equal(players.get('6001').dvpPtsAllowed, 21.7);
    assert.equal(players.get('6001').oppDefEff, 109.8);
  });

  test('defense fields stay null without lookups (sync callers like scripts)', () => {
    const [p] = rotowireService.transformPlayerData([questionableConfirmedStarter]);
    assert.equal(p.dvpPtsAllowed, null);
    assert.equal(p.oppDefEff, null);
  });
});

test('injury_status, lineup_confirmed and defense fields persist and come back from the players query', async () => {
  const lookups = await rotowireService.loadDefenseLookups();
  const transformed = rotowireService.transformPlayerData([questionableConfirmedStarter, healthyUnconfirmed, noLineupBlock], lookups);
  await db.run(`INSERT INTO slates (slate_id, name) VALUES ('30011', 'Test slate')`);
  await playerModel.bulkCreateOrUpdate('30011', transformed);

  const rows = new Map((await playerModel.getBySlateId('30011')).map(r => [r.player_id, r]));
  const wemby = rows.get('5809');
  assert.equal(wemby.injury_status, 'QUES');
  assert.equal(wemby.lineup_confirmed, 1);
  assert.equal(wemby.dvp_pts_allowed, 25.4);
  assert.equal(wemby.opp_def_eff, 116.2);
  assert.equal(rows.get('6001').lineup_confirmed, 0);
  assert.equal(rows.get('6002').lineup_confirmed, null);
});
