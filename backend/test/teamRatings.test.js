import { test, describe, beforeAll as before, beforeEach, afterAll as after } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nba-dfs-team-ratings-'));
process.env.DATABASE_TYPE = 'sqlite';
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');

let db;
let ratings;
let teamDefenseModel;
let projectionService;

before(async () => {
  db = (await import('../src/config/database.js')).default;
  const { createTables } = await import('../src/config/schema.js');
  await createTables(db);
  ratings = await import('../src/services/teamRatingsService.js');
  teamDefenseModel = (await import('../src/models/teamDefenseModel.js')).default;
  projectionService = (await import('../src/services/projectionService.js')).default;
});

after(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await db.run('DELETE FROM team_game_stats');
  await db.run('DELETE FROM team_defense_rankings');
});

const close = (actual, expected, msg) => assert.ok(Math.abs(actual - expected) < 1e-9, `${msg ?? ''} ${actual} != ${expected}`);

/** Both team rows of one game; a/b: { team, pts, possessions, ...box } */
let gameSeq = 0;
function game(date, a, b, { season = '2026-27', seasonType = 'regular' } = {}) {
  const id = `g${++gameSeq}`;
  const box = { fgm: 40, fga: 88, fg3m: 12, fta: 20, oreb: 10, dreb: 34, ast: 25, tov: 13 };
  return [
    { game_id: id, game_date: date, season, season_type: seasonType, team: a.team, opponent: b.team, ...box, ...a },
    { game_id: id, game_date: date, season, season_type: seasonType, team: b.team, opponent: a.team, ...box, ...b }
  ];
}

describe('computeTeamRatings', () => {
  test('pace, efficiencies and rates from season totals', () => {
    const rows = [
      ...game('2026-10-21', { team: 'TOR', pts: 110, possessions: 100 }, { team: 'MIN', pts: 100, possessions: 98 }),
      ...game('2026-10-23', { team: 'TOR', pts: 120, possessions: 104 }, { team: 'PHI', pts: 90, possessions: 102,
        fgm: 33, fga: 90, fg3m: 9, fta: 18, oreb: 8, dreb: 30, ast: 20, tov: 16 })
    ];
    const { teams, league } = ratings.computeTeamRatings(rows, { season: '2026-27', priorGames: 0 });
    const tor = teams.find(t => t.team === 'TOR');
    assert.equal(tor.games, 2);
    close(tor.pace, 102);
    close(tor.offEff, (100 * 230) / 204, 'off_eff');
    close(tor.defEff, (100 * 190) / 200, 'def_eff');
    close(tor.effFgPct, (100 * (80 + 12)) / 176);
    close(tor.tsPct, (100 * 230) / (2 * (176 + 0.44 * 40)));
    const plays = 176 + 0.44 * 40 + 50 + 26;
    close(tor.astRatio, (100 * 50) / plays);
    close(tor.toRatio, (100 * 26) / plays);
    close(tor.rebr, (100 * 88) / (88 + 44 + 38));
    assert.equal(league.games, 4);
  });

  test('defense is the opponent rate (100 x opp pts / opp possessions)', () => {
    const rows = game('2026-10-21', { team: 'BOS', pts: 105, possessions: 95 }, { team: 'NYK', pts: 99, possessions: 96 });
    const { teams } = ratings.computeTeamRatings(rows, { season: '2026-27' });
    const bos = teams.find(t => t.team === 'BOS');
    close(bos.raw.defEff, (100 * 99) / 96);
    close(bos.raw.offEff, (100 * 105) / 95);
  });

  test('early season is shrunk toward last season (team, else league)', () => {
    const prior = [];
    for (let i = 0; i < 4; i++) {
      prior.push(...game(`2026-01-0${i + 1}`, { team: 'DEN', pts: 120, possessions: 100 }, { team: 'UTA', pts: 100, possessions: 100 }, { season: '2025-26' }));
    }
    const current = [
      ...game('2026-10-21', { team: 'DEN', pts: 100, possessions: 100 }, { team: 'UTA', pts: 110, possessions: 100 }),
      ...game('2026-10-22', { team: 'SAC', pts: 130, possessions: 110 }, { team: 'UTA', pts: 100, possessions: 100 })
    ];
    const { teams } = ratings.computeTeamRatings([...prior, ...current], { season: '2026-27' });
    const den = teams.find(t => t.team === 'DEN');
    // 1 game at 100 off / 110 def vs prior 120 / 100: (1 x cur + 10 x prior) / 11
    close(den.offEff, (100 + 10 * 120) / 11);
    close(den.defEff, (110 + 10 * 100) / 11);
    assert.deepEqual([den.raw.offEff, den.prior.offEff], [100, 120]);
    // SAC has no prior season: the league's last season (110 off / 110 def)
    const sac = teams.find(t => t.team === 'SAC');
    close(sac.offEff, ((100 * 130) / 110 + 10 * 110) / 11);
    close(sac.prior.offEff, 110);
  });

  test('asOf counts only earlier games; playoffs are ignored', () => {
    const rows = [
      ...game('2026-10-21', { team: 'LAL', pts: 100, possessions: 100 }, { team: 'GSW', pts: 90, possessions: 100 }),
      ...game('2026-10-25', { team: 'LAL', pts: 140, possessions: 100 }, { team: 'GSW', pts: 130, possessions: 100 }),
      ...game('2026-05-01', { team: 'LAL', pts: 50, possessions: 100 }, { team: 'GSW', pts: 50, possessions: 100 }, { season: '2025-26', seasonType: 'playoffs' })
    ];
    const asOf = ratings.computeTeamRatings(rows, { asOf: '2026-10-25' });
    assert.equal(asOf.season, '2026-27');
    const lal = asOf.teams.find(t => t.team === 'LAL');
    assert.equal(lal.games, 1);
    assert.equal(lal.offEff, 100, 'no regular-season prior, playoff game skipped');
    assert.equal(ratings.computeTeamRatings(rows, { season: '2026-27' }).teams.find(t => t.team === 'LAL').games, 2);
  });
});

describe('teamDefenseModel.bulkUpsert (sqlite)', () => {
  test('writes and updates rows', async () => {
    const before = teamDefenseModel.version;
    await teamDefenseModel.bulkUpsert([
      { team: 'BOS', defEff: 105.5, offEff: 118, pace: 98.2, tsPct: 59.1 },
      { team: 'NYK', defEff: 110, offEff: 0 }
    ]);
    await teamDefenseModel.bulkUpsert([{ team: 'BOS', defEff: 104, pace: 99 }]);
    const rows = await teamDefenseModel.getAll();
    assert.deepEqual(rows.map(r => [r.team, r.def_eff, r.off_eff, r.pace]), [['BOS', 104, null, 99], ['NYK', 110, 0, null]]);
    assert.equal(teamDefenseModel.version, before + 2);
  });
});

describe('refreshTeamRatings', () => {
  async function seed(rows) {
    for (const r of rows) {
      await db.run(`INSERT INTO team_game_stats (game_id, game_date, season, season_type, team, opponent, pts, fgm, fga, fg3m, fta, oreb, dreb, ast, tov, possessions)
        VALUES (@game_id, @game_date, @season, @season_type, @team, @opponent, @pts, @fgm, @fga, @fg3m, @fta, @oreb, @dreb, @ast, @tov, @possessions)`, r);
    }
  }

  test('writes team_defense_rankings under the table abbreviations', async () => {
    await seed(game('2026-10-21', { team: 'PHX', pts: 110, possessions: 100 }, { team: 'WAS', pts: 100, possessions: 100 }));
    const result = await ratings.refreshTeamRatings({ season: '2026-27' });
    assert.equal(result.teams, 2);
    const rows = await teamDefenseModel.getAll();
    assert.deepEqual(rows.map(r => [r.team, r.def_eff, r.off_eff, r.pace]), [['PHO', 100, 110, 100], ['WSH', 110, 100, 100]]);
  });

  test('ensureTeamRatings only fills an empty table', async () => {
    const { getCurrentSeason, seasonStartDate } = await import('../src/utils/season.js');
    const season = getCurrentSeason();
    await seed(game(seasonStartDate(season), { team: 'MIA', pts: 110, possessions: 100 }, { team: 'ORL', pts: 100, possessions: 100 }, { season }));
    const first = await ratings.ensureTeamRatings();
    assert.equal(first.teams, 2, 'computed when empty');
    assert.equal(await ratings.ensureTeamRatings(), null, 'skipped when filled');
  });

  test('projectionService reloads after a refresh and centers on the league mean', async () => {
    const teams = Array.from({ length: 20 }, (_, i) => ({ team: `T${String(i).padStart(2, '0')}`, defEff: 100 + i, pace: 95 + i }));
    await teamDefenseModel.bulkUpsert(teams);
    await projectionService.loadDefenseRankings();
    close(projectionService.LEAGUE_AVG_DEF_EFF, 109.5);
    close(projectionService.LEAGUE_AVG_PACE, 104.5);
    close(projectionService.getDefenseAdjustment('T19'), (119 - 109.5) * 0.25);

    await teamDefenseModel.bulkUpsert([{ team: 'T19', defEff: 139, pace: 114 }]);
    await projectionService.loadDefenseRankings();
    assert.equal(projectionService.defenseRankings.T19.def_eff, 139, 'reloaded after the write');
  });
});
