import { test, describe, beforeAll as before, afterAll as after } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Chat research tools (ResearchAgent, AnalystAgent, aiChatService): archetype
// matchups, player profiles, team defense, insights cards, lineup scoring and
// projection results, each wrapping an existing backend service.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nba-dfs-research-tools-'));
process.env.DATABASE_TYPE = 'sqlite';
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');

let db;
let playerKey;
let tools;
let CURRENT;
let PRIOR;
let day;

const addDays = (date, n) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const gameId = (date, team, opp) => `${date}-${[team, opp].sort().join('-')}`;
const TEAMS = Array.from({ length: 24 }, (_, i) => `T${String(i).padStart(2, '0')}`);

async function game(name, team, opp, date, minutes, dk, { fd = dk } = {}) {
  await db.run(`
    INSERT INTO historical_games (player_name, player_key, team, opponent, game_id, game_date, season, season_type,
      is_home, is_starter, minutes, points, rebounds, assists, dk_fantasy_points, fd_fantasy_points, yahoo_fantasy_points)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'regular', 1, 1, ?, ?, 5, 3, ?, ?, ?)
  `, name, playerKey(name), team, opp, gameId(date, team, opp), date, CURRENT, minutes, Math.round(dk), dk, fd, dk);
  for (const [t, o] of [[team, opp], [opp, team]]) {
    await db.run(`
      INSERT OR IGNORE INTO team_game_stats (game_id, game_date, season, season_type, team, opponent)
      VALUES (?, ?, ?, 'regular', ?, ?)
    `, gameId(date, team, opp), date, CURRENT, t, o);
  }
}

async function status(name, team, opp, date, value, reason) {
  await db.run(`
    INSERT INTO game_player_status (game_id, game_date, team, player_key, player_name, status, reason)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `, gameId(date, team, opp), date, team, playerKey(name), name, value, reason);
}

async function snapshot(name, team, opp, date, salary, projected, { slateId = 'past', minutes = 30 } = {}) {
  await db.run(`
    INSERT INTO slate_player_snapshots (snapshot_date, game_date, slate_id, site, player_key, player_name, team, opponent,
      position, salary, projected_points, projected_minutes, rostership)
    VALUES (?, ?, ?, 'draftkings', ?, ?, ?, ?, 'PG', ?, ?, ?, 10)
  `, date, date, slateId, playerKey(name), name, team, opp, salary, projected, minutes);
}

const defenseRow = (season, team, group_by, group_key, games, fp, { site = 'draftkings', pts = fp } = {}) => db.run(
  `INSERT INTO team_archetype_defense (season, site, group_by, team, group_key, games, player_games,
    avg_minutes, avg_fp, avg_expected_fp, fp_over_expectation_raw, shrink, fp_over_expectation,
    pts_delta, reb_delta, ast_delta, fg3m_delta, stocks_delta)
   VALUES (?, ?, ?, ?, ?, ?, ?, 30, 40, 38, ?, 0.5, ?, ?, 0.5, 0.25, 0.1, 0)`,
  season, site, group_by, team, group_key, games, games * 2, fp, fp, pts);

async function seed() {
  // ── Tonight's slate (latest slate) and last season's defense ──
  await db.run(`INSERT INTO slates (slate_id, name, site, created_at) VALUES ('old', 'Old', 'draftkings', '2020-01-01 00:00:00')`);
  await db.run(`INSERT INTO slates (slate_id, name, site, created_at) VALUES ('s1', 'Main', 'draftkings', '2030-01-01 00:00:00')`);
  const slatePlayer = (id, name, team, opp, pos, salary, proj, minutes) => db.run(
    `INSERT INTO players (slate_id, player_id, name, team, opponent, position, salary, projected_points, projected_minutes)
     VALUES ('s1', ?, ?, ?, ?, ?, ?, ?, ?)`, id, name, team, opp, pos, salary, proj, minutes);
  await slatePlayer('1', 'Steady Guard', 'MIL', 'T00', 'PG', 7000, 35, 34);
  await slatePlayer('2', 'Bench Guard', 'MIL', 'T00', 'SG', 4000, 18, 20);
  await slatePlayer('3', 'Soft Wing', 'BOS', 'T01', 'SF', 5000, 25, 30);
  await slatePlayer('4', 'Tyrese Maxey', 'PHI', 'T05', 'PG', 9000, 40, 36);
  await slatePlayer('5', 'Kelly Oubre Jr.', 'PHI', 'T05', 'SF', 5000, 25, 30);

  await db.run(`INSERT INTO player_archetypes (season, player_key, archetype, secondary_archetype) VALUES
    (?, 'steady guard', 'scoring_guard', NULL), (?, 'bench guard', 'scoring_guard', NULL), (?, 'soft wing', 'three_and_d_wing', NULL)`,
  CURRENT, CURRENT, CURRENT);
  await db.run(`INSERT INTO player_season_profiles (season, player_key, player_name, team, games, minutes_pg) VALUES
    (?, 'steady guard', 'Steady Guard', 'MIL', 70, 33), (?, 'bench guard', 'Bench Guard', 'MIL', 60, 28),
    (?, 'soft wing', 'Soft Wing', 'BOS', 60, 30)`, PRIOR, PRIOR, PRIOR);

  // Current season: one night in (thin). Prior: 24 full-season defenses.
  for (const [i, team] of TEAMS.slice(0, 6).entries()) await defenseRow(CURRENT, team, 'archetype', 'scoring_guard', 1, 5 - i);
  for (const [i, team] of TEAMS.entries()) {
    await defenseRow(PRIOR, team, 'archetype', 'scoring_guard', 41, 4 - i * 0.25);
    await defenseRow(PRIOR, team, 'archetype', 'three_and_d_wing', 41, i === 1 ? 2.5 : -1 - i * 0.1);
    await defenseRow(PRIOR, team, 'archetype', 'rim_running_big', 41, i === 0 ? -3 : 1 - i * 0.1);
    await defenseRow(PRIOR, team, 'position', 'G', 41, 2 - i * 0.2);
    await defenseRow(PRIOR, team, 'position', 'C', 41, i === 0 ? -2.5 : 0.5);
  }

  // ── PHI history (current season): Embiid is a regular missing from the slate ──
  const PHI_DAYS = 14;
  const EMBIID_OUT = new Set([4, 11, 12, 13]);
  for (let i = 0; i < PHI_DAYS; i++) {
    const date = day(2 * i);
    if (!EMBIID_OUT.has(i)) await game('Joel Embiid', 'PHI', 'ORL', date, 34, 50);
    await game('Tyrese Maxey', 'PHI', 'ORL', date, 36, EMBIID_OUT.has(i) ? 45 : 30, { fd: 28 });
    await game('Kelly Oubre Jr.', 'PHI', 'ORL', date, 30, 22);
  }

  // Maxey's role profile, both seasons
  await db.run(`INSERT INTO player_season_profiles (season, player_key, player_name, team, position, games, starts, minutes_pg,
      usg_pct, ast_pct, reb_pct, three_pa_rate, ts_pct, pts_per36, reb_per36, ast_per36, fg3m_per36, dk_fppm, fd_fppm) VALUES
    (?, 'tyrese maxey', 'Tyrese Maxey', 'PHI', 'G', 70, 70, 37.5, 0.281, 0.298, 0.052, 0.402, 0.571, 26.4, 3.4, 6.1, 3.1, 1.12, 1.05),
    (?, 'tyrese maxey', 'Tyrese Maxey', 'PHI', 'G', 50, 50, 36.0, 0.25, 0.27, 0.05, 0.39, 0.56, 24.0, 3.3, 5.8, 2.9, 1.05, 0.98)`,
  PRIOR, addPrev(PRIOR));
  await db.run(`INSERT INTO player_archetypes (season, player_key, archetype, secondary_archetype) VALUES
    (?, 'tyrese maxey', 'primary_creator', 'scoring_guard')`, PRIOR);

  // ── A past night for score_lineup (inside the PHI window) ──
  const NIGHT = day(10);
  await game('Luka Dončić', 'LAL', 'BOS', NIGHT, 38, 61.5);
  await game('Jaren Jackson Jr.', 'MEM', 'NOP', NIGHT, 30, 28.75);
  await game('Reggie Jackson', 'MEM', 'NOP', NIGHT, 12, 6);
  await status('Bench Wing', 'MEM', 'NOP', NIGHT, 'DNP', "COACH'S DECISION");
  await status('Hurt Center', 'LAL', 'BOS', NIGHT, 'INACTIVE', 'Injury/Illness - Knee');
  // Bench Wing / Hurt Center appear in an earlier box score so they resolve
  await game('Bench Wing', 'MEM', 'NOP', day(0), 10, 8);
  await game('Hurt Center', 'LAL', 'BOS', day(0), 20, 20);
  await snapshot('Luka Doncic', 'LAL', 'BOS', NIGHT, 11000, 55);
  await snapshot('Jaren Jackson Jr.', 'MEM', 'NOP', NIGHT, 7000, 35);
  await snapshot('Hurt Center', 'LAL', 'BOS', NIGHT, 4000, 20);
}

// 2025-26 -> 2024-25
function addPrev(season) {
  const year = Number(season.slice(0, 4)) - 1;
  return `${year}-${String((year + 1) % 100).padStart(2, '0')}`;
}

before(async () => {
  db = (await import('../src/config/database.js')).default;
  await (await import('../src/config/schema.js')).createTables(db);
  ({ playerKey } = await import('../src/utils/playerKey.js'));
  const season = await import('../src/utils/season.js');
  CURRENT = season.getCurrentSeason();
  PRIOR = addPrev(CURRENT);
  const start = season.seasonStartDate(CURRENT);
  day = (i) => addDays(start, 1 + i);
  const mod = await import('../src/services/chatTools/researchTools.js');
  tools = new Map(mod.createResearchTools().map(t => [t.name, t]));
  await seed();
});

after(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const run = (name, args) => tools.get(name).execute(args);

describe('get_archetype_matchups', () => {
  test('defaults to the latest slate and ranks by the Tonight adjusted edge', async () => {
    const r = await run('get_archetype_matchups', {});
    assert.equal(r.success, true);
    assert.equal(r.slateId, 's1');
    assert.equal(r.site, 'draftkings');
    // Thin current season -> last season's defense, said so
    assert.equal(r.season, PRIOR);
    assert.equal(r.fallback.from, CURRENT);
    assert.match(r.note, new RegExp(PRIOR));
    assert.deepEqual(r.players.map(p => p.name), ['Steady Guard', 'Soft Wing', 'Bench Guard']);

    const steady = r.players[0];
    assert.equal(steady.archetype, 'scoring_guard');
    assert.equal(steady.opponent, 'T00');
    assert.equal(steady.matchupEdge, 4);
    assert.equal(steady.rank, 1);
    assert.equal(steady.teams, 24);
    assert.equal(steady.games, 41);
    assert.equal(steady.minutes.projected, 34);
    // Same team/opponent/archetype as Bench Guard (20 min) -> crowded
    assert.equal(steady.crowding.count, 1);
    assert.deepEqual(steady.crowding.teammates, ['Bench Guard']);
    // 4 x min(1, 34/32) x role 1 x crowding 1/(1+0.25)
    assert.equal(steady.adjustedEdge, 3.2);
    assert.equal(steady.components.crowding_factor, 0.8);

    const bench = r.players.find(p => p.name === 'Bench Guard');
    assert.equal(bench.role, 'role_down');
    assert.ok(bench.flags.includes('role_down'));
  });

  test('minEdge and limit filter the list', async () => {
    const r = await run('get_archetype_matchups', { slateId: 's1', minEdge: 2, limit: 1 });
    assert.deepEqual(r.players.map(p => p.name), ['Steady Guard']);
    assert.equal(r.totalMatches, 2);
  });

  test('unknown slate is reported, not thrown', async () => {
    const r = await run('get_archetype_matchups', { slateId: 'nope' });
    assert.equal(r.success, false);
    assert.match(r.message, /nope not found/);
  });
});

describe('get_player_profile', () => {
  test('season role profiles with archetypes, newest first, plus current-season games so far', async () => {
    const r = await run('get_player_profile', { name: 'tyrese  maxey' });
    assert.equal(r.success, true);
    assert.equal(r.player.key, 'tyrese maxey');
    assert.deepEqual(r.profiles.map(p => p.season), [PRIOR, addPrev(PRIOR)]);
    const [latest] = r.profiles;
    assert.equal(latest.archetype, 'primary_creator');
    assert.equal(latest.secondaryArchetype, 'scoring_guard');
    assert.equal(latest.minutesPg, 37.5);
    // Rates stay fractions
    assert.equal(latest.usgPct, 0.281);
    assert.equal(latest.threePaRate, 0.402);
    assert.equal(latest.ptsPer36, 26.4);
    assert.equal(latest.dkFppm, 1.12);
    assert.equal(r.profiles[1].archetype, null);

    assert.equal(r.currentSeason.season, CURRENT);
    assert.equal(r.currentSeason.games, 14);
    assert.equal(r.currentSeason.minutesPg, 36);
    assert.equal(r.currentSeason.dkAvg, 34.3);
    assert.equal(r.currentSeason.profile, null);
  });

  test('seasons filter', async () => {
    const r = await run('get_player_profile', { name: 'Tyrese Maxey', seasons: [addPrev(PRIOR)] });
    assert.deepEqual(r.profiles.map(p => p.season), [addPrev(PRIOR)]);
  });

  test('unknown names return closest matches', async () => {
    const r = await run('get_player_profile', { name: 'Tyrese Maxy' });
    assert.equal(r.success, false);
    assert.ok(r.closestMatches.includes('Tyrese Maxey'));
  });
});

describe('get_team_defense_profile', () => {
  test('weakest and strongest archetypes and G/F/C with ranks, deltas and samples; thin season falls back', async () => {
    const r = await run('get_team_defense_profile', { team: 'T01' });
    assert.equal(r.success, true);
    assert.equal(r.team, 'T01');
    assert.equal(r.season, PRIOR);
    assert.equal(r.fallback.from, CURRENT);

    const arch = r.archetype;
    // Sorted most allowed first: wing +2.5 (rank 1 of 24), guard +3.75, big +0.9
    assert.deepEqual(arch.rows.map(x => x.group), ['scoring_guard', 'three_and_d_wing', 'rim_running_big']);
    const wing = arch.rows.find(x => x.group === 'three_and_d_wing');
    assert.equal(wing.fpOverExpectation, 2.5);
    assert.equal(wing.rank, 1);
    assert.equal(wing.teams, 24);
    assert.equal(wing.games, 41);
    assert.equal(wing.ptsDelta, 2.5);
    assert.equal(wing.rebDelta, 0.5);
    assert.equal(wing.label, '3-and-D Wing');
    assert.equal(arch.weakestVs[0].group, 'scoring_guard');
    assert.equal(arch.strongestVs[0].group, 'rim_running_big');

    assert.deepEqual(r.position.rows.map(x => x.group), ['G', 'C']);
    assert.equal(r.position.rows[0].rank, 2);
  });

  test('explicit season and groupBy', async () => {
    const r = await run('get_team_defense_profile', { team: 'T00', season: CURRENT, groupBy: 'archetype' });
    assert.equal(r.season, CURRENT);
    assert.equal(r.fallback, null);
    assert.equal(r.position, undefined);
    assert.equal(r.archetype.rows[0].games, 1);
    assert.equal(r.archetype.rows[0].lowSample, true);
  });

  test('unknown team', async () => {
    const r = await run('get_team_defense_profile', { team: 'ZZZ', season: PRIOR });
    assert.equal(r.success, false);
  });
});

describe('insights tools', () => {
  test('get_usage_bumps: slate teammates of a missing regular', async () => {
    const r = await run('get_usage_bumps', { team: 'PHI' });
    assert.equal(r.success, true);
    assert.equal(r.slateId, 's1');
    const maxey = r.usageBumps.find(b => b.player === 'Tyrese Maxey');
    assert.equal(maxey.missingPlayer, 'Joel Embiid');
    assert.equal(maxey.gamesWithout, 4);
    assert.equal(maxey.gamesWith, 10);
    assert.equal(maxey.avgWithout, 45);
    assert.equal(maxey.avgWith, 30);
    assert.equal(maxey.absenceReason, 'OUT');
  });

  test('get_usage_bumps: team filter excludes other teams', async () => {
    const r = await run('get_usage_bumps', { team: 'MIL' });
    assert.equal(r.success, true);
    assert.equal(r.count, 0);
    // Empty results say how to widen the window
    assert.match(r.note, /startDate/);
  });

  test('get_missing_players: regulars of slate teams not on the slate', async () => {
    const r = await run('get_missing_players', { slateId: 's1' });
    assert.equal(r.success, true);
    const phi = r.report.find(t => t.team === 'PHI');
    assert.deepEqual(phi.missingPlayers.map(p => p.name), ['Joel Embiid']);
  });

  test('get_streaks_and_consistency: hot, consistency and fd site', async () => {
    const hot = await run('get_streaks_and_consistency', { type: 'hot' });
    assert.equal(hot.success, true);
    assert.equal(hot.type, 'hot');
    assert.equal(hot.players[0].player_name, 'Tyrese Maxey');
    assert.equal(hot.players[0].last3_avg, 45);

    const steady = await run('get_streaks_and_consistency', { type: 'consistency', minGames: 8 });
    assert.equal(steady.players[0].player_name, 'Joel Embiid');
    assert.equal(steady.players[0].consistency_score, 100);

    const fd = await run('get_streaks_and_consistency', { type: 'boom_bust', site: 'fd', minGames: 8 });
    assert.equal(fd.site, 'fanduel');

    const bad = await run('get_streaks_and_consistency', { type: 'lukewarm' });
    assert.equal(bad.success, false);
  });
});

describe('score_lineup', () => {
  test('actual points per player and total, DNP/inactive flagged, proj vs actual from snapshots', async () => {
    const r = await run('score_lineup', {
      players: ['Luka Doncic', 'Jaren Jackson Jr.', 'Bench Wing', 'Hurt Center'],
      date: day(10),
    });
    assert.equal(r.success, true);
    assert.equal(r.site, 'draftkings');
    assert.equal(r.totalPoints, 90.25);
    const by = Object.fromEntries(r.players.map(p => [p.name, p]));

    const luka = by['Luka Dončić'];
    assert.equal(luka.status, 'PLAYED');
    assert.equal(luka.minutes, 38);
    assert.equal(luka.points, 61.5);
    assert.equal(luka.salary, 11000);
    assert.equal(luka.projected, 55);
    assert.equal(luka.vsProjection, 6.5);
    assert.equal(luka.valuePer1k, 5.59);

    // Jaren Jackson Jr. is not Reggie Jackson
    assert.equal(by['Jaren Jackson Jr.'].points, 28.75);

    assert.equal(by['Bench Wing'].status, 'DNP');
    assert.equal(by['Bench Wing'].points, 0);
    assert.match(by['Bench Wing'].statusReason, /COACH/);
    assert.equal(by['Bench Wing'].salary, null);

    assert.equal(by['Hurt Center'].status, 'INACTIVE');
    assert.equal(by['Hurt Center'].points, 0);
    assert.equal(by['Hurt Center'].projected, 20);

    assert.equal(r.totalSalary, 22000);
    assert.equal(r.totalProjected, 110);
    assert.equal(r.playersWithSnapshot, 3);
    assert.deepEqual(r.notPlayed, ['Bench Wing', 'Hurt Center']);
  });

  test('unknown names are listed with closest matches; bad date rejected', async () => {
    const r = await run('score_lineup', { players: ['Luka Doncic', 'Lukka Dončič Sr'], date: day(10) });
    assert.equal(r.success, true);
    assert.equal(r.totalPoints, 61.5);
    assert.equal(r.notFound.length, 1);
    // A total missing a player is flagged
    assert.equal(r.incomplete, true);
    assert.match(r.message, /Lukka/);

    const bad = await run('score_lineup', { players: ['Luka Doncic'], date: 'yesterday' });
    assert.equal(bad.success, false);
  });

  test('a date with no game for the player', async () => {
    const r = await run('score_lineup', { players: ['Luka Doncic'], date: day(11) });
    assert.equal(r.players[0].status, 'NO_GAME');
    assert.equal(r.totalPoints, 0);
  });
});

describe('get_projection_results', () => {
  test('one date: error metrics, value hit rates and biggest misses', async () => {
    const r = await run('get_projection_results', { date: day(10) });
    assert.equal(r.success, true);
    assert.equal(r.site, 'draftkings');
    assert.equal(r.overall.players, 3);
    assert.equal(r.overall.played, 2);
    assert.equal(r.overall.inactive, 1);
    // (55 - 61.5) and (35 - 28.75): MAE 6.375
    assert.equal(r.overall.projection.mae, 6.375);
    assert.equal(r.overall.hitRates['5x'], 50);
    assert.equal(r.biggestMisses.over[0].name, 'Jaren Jackson Jr.');
    assert.equal(r.biggestMisses.under[0].name, 'Luka Doncic');
  });

  test('no snapshots in range', async () => {
    const r = await run('get_projection_results', { startDate: '2019-01-01', endDate: '2019-01-31' });
    assert.equal(r.success, false);
  });
});

describe('wiring', () => {
  test('research tools are on ResearchAgent, AnalystAgent and aiChatService; sql is a fallback', async () => {
    const { RESEARCH_TOOL_NAMES } = await import('../src/services/chatTools/researchTools.js');
    assert.equal(RESEARCH_TOOL_NAMES.length, 10);
    const aiChatService = (await import('../src/services/aiChatService.js')).default;
    const ResearchAgent = (await import('../src/agents/ResearchAgent.js')).default;
    const AnalystAgent = (await import('../src/agents/AnalystAgent.js')).default;
    const chatNames = aiChatService.createTools().map(t => t.name);
    const research = new ResearchAgent();
    const analystNames = new AnalystAgent().tools.map(t => t.name);
    for (const name of RESEARCH_TOOL_NAMES) {
      assert.ok(chatNames.includes(name), `aiChatService has ${name}`);
      assert.ok(research.tools.some(t => t.name === name), `ResearchAgent has ${name}`);
      assert.ok(analystNames.includes(name), `AnalystAgent has ${name}`);
    }
    assert.match(research.tools.find(t => t.name === 'sql_query').description, /fallback/i);
    assert.match(research.systemPrompt, /get_archetype_matchups/);
  });
});

describe('ui blocks', () => {
  let getUiBlocks;
  let validateUiBlock;
  before(async () => {
    ({ getUiBlocks, validateUiBlock } = await import('../src/services/chatTools/uiBlocks.js'));
  });

  // Every block is schema-valid and invisible to the LLM's JSON
  const blocksOf = (result) => {
    const blocks = getUiBlocks(result);
    for (const b of blocks) assert.equal(validateUiBlock(b).success, true, validateUiBlock(b).error);
    assert.doesNotMatch(JSON.stringify(result), /"version":1/);
    return blocks;
  };

  test('get_archetype_matchups -> player_list with edges, minutes, headshot and ownership', async () => {
    await db.run(`UPDATE players SET headshot = 'https://img/steady.png', rostership = 18.5 WHERE slate_id = 's1' AND name = 'Steady Guard'`);
    const [block, ...rest] = blocksOf(await run('get_archetype_matchups', {}));
    assert.equal(rest.length, 0);
    assert.equal(block.type, 'player_list');
    assert.equal(block.context.slate_id, 's1');
    assert.equal(block.context.season, PRIOR);
    const steady = block.players[0];
    assert.equal(steady.name, 'Steady Guard');
    assert.equal(steady.player_key, 'steady guard');
    assert.equal(steady.opponent, 'T00');
    assert.equal(steady.archetype, 'scoring_guard');
    assert.equal(steady.matchup_edge, 4);
    assert.equal(steady.adjusted_edge, 3.2);
    assert.equal(steady.projected_minutes, 34);
    assert.equal(steady.last_season_minutes, 33);
    assert.equal(steady.headshot, 'https://img/steady.png');
    assert.equal(steady.ownership, 18.5);
    assert.ok(steady.flags.includes('crowded'));
    assert.ok(block.players.find(p => p.name === 'Bench Guard').flags.includes('role_down'));
  });

  test('get_player_profile -> single-player player_list with role stats', async () => {
    const [block] = blocksOf(await run('get_player_profile', { name: 'Tyrese Maxey' }));
    assert.equal(block.type, 'player_list');
    const [maxey] = block.players;
    assert.equal(maxey.player_key, 'tyrese maxey');
    assert.equal(maxey.archetype, 'primary_creator');
    assert.equal(maxey.last_season_minutes, 37.5);
    assert.equal(maxey.stats.usg_pct, 0.281);
    assert.equal(maxey.stats.games, 14);
  });

  test('get_team_defense_profile -> team_defense plus a matchup_table per grouping', async () => {
    const blocks = blocksOf(await run('get_team_defense_profile', { team: 'T01' }));
    assert.deepEqual(blocks.map(b => b.type), ['team_defense', 'matchup_table', 'matchup_table']);
    const [defense, archetypes, positions] = blocks;
    assert.equal(defense.team, 'T01');
    assert.deepEqual(defense.groups.map(g => g.group_by), ['archetype', 'position']);
    assert.equal(defense.groups[0].strongest[0].group_key, 'rim_running_big');
    assert.equal(archetypes.group_by, 'archetype');
    const wing = archetypes.rows.find(r => r.group_key === 'three_and_d_wing');
    assert.equal(wing.fp_over_expectation, 2.5);
    assert.equal(wing.games, 41);
    assert.equal(wing.rank, 1);
    assert.equal(positions.rows.length, 2);
  });

  test('get_usage_bumps and get_missing_players', async () => {
    const [bumps] = blocksOf(await run('get_usage_bumps', { team: 'PHI' }));
    assert.equal(bumps.type, 'usage_bumps');
    const maxey = bumps.bumps.find(b => b.player.name === 'Tyrese Maxey');
    assert.equal(maxey.player.player_key, 'tyrese maxey');
    assert.equal(maxey.missing_player, 'Joel Embiid');
    assert.equal(maxey.avg_without, 45);
    assert.equal(maxey.avg_with, 30);
    // No bumps -> no block
    assert.deepEqual(blocksOf(await run('get_usage_bumps', { team: 'MIL' })), []);

    const [missing] = blocksOf(await run('get_missing_players', { slateId: 's1' }));
    assert.equal(missing.type, 'player_list');
    const embiid = missing.players.find(p => p.name === 'Joel Embiid');
    assert.equal(embiid.team, 'PHI');
    assert.deepEqual(embiid.flags, ['missing']);
  });

  test('get_streaks_and_consistency -> streaks', async () => {
    const [hot] = blocksOf(await run('get_streaks_and_consistency', { type: 'hot' }));
    assert.equal(hot.kind, 'hot');
    assert.equal(hot.players[0].name, 'Tyrese Maxey');
    assert.equal(hot.players[0].last3_avg, 45);
    assert.ok(hot.players[0].pct > 0);
    const [steady] = blocksOf(await run('get_streaks_and_consistency', { type: 'consistency', minGames: 8 }));
    assert.equal(steady.kind, 'consistency');
    assert.equal(steady.players[0].consistency_score, 100);
    assert.deepEqual(blocksOf(await run('get_streaks_and_consistency', { type: 'lukewarm' })), []);
  });

  test('score_lineup -> lineup_score with totals and not-found names', async () => {
    const [block] = blocksOf(await run('score_lineup', {
      players: ['Luka Doncic', 'Hurt Center', 'Lukka Dončič Sr'], date: day(10),
    }));
    assert.equal(block.type, 'lineup_score');
    assert.equal(block.context.date, day(10));
    const luka = block.players.find(p => p.player_key === 'luka doncic');
    assert.equal(luka.actual, 61.5);
    assert.equal(luka.projected, 55);
    assert.equal(luka.value_per_1k, 5.59);
    assert.equal(block.players.find(p => p.name === 'Hurt Center').status, 'INACTIVE');
    assert.equal(block.totals.actual, 61.5);
    assert.equal(block.totals.salary, 15000);
    assert.equal(block.incomplete, true);
    assert.deepEqual(block.not_found, ['Lukka Dončič Sr']);
  });

  test('get_projection_results -> projection_results; failures get no block', async () => {
    const [block] = blocksOf(await run('get_projection_results', { date: day(10) }));
    assert.equal(block.type, 'projection_results');
    assert.equal(block.overall.mae, 6.375);
    assert.equal(block.overall.hit_rates['5x'], 50);
    assert.deepEqual(block.misses.map(m => m.name), ['Jaren Jackson Jr.', 'Luka Doncic']);
    assert.deepEqual(blocksOf(await run('get_projection_results', { startDate: '2019-01-01', endDate: '2019-01-31' })), []);
  });
});
