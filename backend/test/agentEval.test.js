import { test, describe, beforeAll as before, afterAll as after } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';
import { scriptedClient, useClient } from './helpers/scriptedLlm.js';

/*
 * AI CHAT SMOKE / EVAL SUITE
 *
 * Six fixed chat questions, each through the real chat path
 * (agenticChatService -> delegate_to_agent -> ResearchAgent / AnalystAgent ->
 * chatTools) against a copy of the real local DB (backend/data/nba_dfs.db):
 *
 * Deterministic (default, no LLM, ~2s): a scripted client (helpers/scriptedLlm.js)
 * stands in for the model and makes the expected delegation and tool call.
 * Each case asserts that
 *   - the orchestrator delegated to the expected agent,
 *   - that agent offers the tool to the model and names it in its prompt,
 *   - the tool ran and its output matches independent SQL on the same DB,
 *   - the final answer carries the key numbers.
 * Renaming a tool, dropping it from an agent or its prompt, or breaking the
 * service behind it fails here.
 *
 * Live (opt-in): RUN_LIVE_AGENT_EVAL=1 sends the same questions to the
 * configured Azure OpenAI deployment (backend/.env) and checks the answer
 * contains the key numbers. Skipped by default and in CI.
 *
 *   cd backend && npx vitest run test/agentEval.test.js
 *   RUN_LIVE_AGENT_EVAL=1 npx vitest run test/agentEval.test.js   (bash)
 *   $env:RUN_LIVE_AGENT_EVAL=1; npx vitest run test/agentEval.test.js   (PowerShell)
 *
 * The whole suite skips when the DB is missing (CI has none); point
 * NBA_DFS_EVAL_DB at another copy to use it.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REAL_DB = process.env.NBA_DFS_EVAL_DB || path.join(__dirname, '../data/nba_dfs.db');
const HAS_DB = fs.existsSync(REAL_DB);
const LIVE = process.env.RUN_LIVE_AGENT_EVAL === '1';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nba-dfs-agent-eval-'));
process.env.DATABASE_TYPE = 'sqlite';
process.env.DATABASE_PATH = path.join(tmpDir, 'eval.db');

let db;
let service;

before(async () => {
  if (!HAS_DB) return;
  // Snapshot (WAL included) so tests never touch the real file
  const source = new Database(REAL_DB, { readonly: true, fileMustExist: true });
  fs.writeFileSync(process.env.DATABASE_PATH, source.serialize());
  source.close();
  if (LIVE) (await import('dotenv')).config({ path: path.join(__dirname, '../.env') });
  db = (await import('../src/config/database.js')).default;
  // The copy may predate the code's snapshot schema (startup runs these too)
  const { migrateSlatePlayerSnapshots, migrateSlateCatalog } = await import('../src/config/snapshotMigrations.js');
  await migrateSlatePlayerSnapshots(db);
  await migrateSlateCatalog(db);
  service = (await import('../src/services/agenticChatService.js')).default;
});

after(() => {
  db?.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const round1 = (x) => Math.round(x * 10) / 10;
const round2 = (x) => Math.round(x * 100) / 100;
const round3 = (x) => Math.round(x * 1000) / 1000;

/** text contains x as written, to 2 or 1 decimals, or as an integer when whole. */
export function containsNumber(text, x) {
  const variants = new Set([String(x), x.toFixed(2), x.toFixed(1)]);
  if (Number.isInteger(x)) variants.add(String(x));
  return [...variants].some(v => new RegExp(`(^|[^\\d.])${v.replace('.', '\\.')}(?![\\d])`).test(text));
}

const F2_LINEUP = ['Domantas Sabonis', 'Darius Garland', 'Franz Wagner', 'Lauri Markkanen', 'Dennis Schroder',
  'Jaren Jackson Jr.', 'Jalen Smith', 'Cedric Coward'];

// Each case: the question, the expected route, and verify(output) -> key facts
// ({ numbers, names }) the answer must contain.
const CASES = [
  {
    id: 'player-history',
    question: 'Luka Doncic last 10 games',
    agent: 'analyst',
    tool: 'get_player_history',
    args: { playerName: 'Luka Doncic', limit: 10 },
    async verify(out) {
      assert.equal(out.success, true);
      assert.equal(out.player.key, 'luka doncic');
      const games = await db.all(`SELECT game_date, dk_fantasy_points AS dk, minutes FROM historical_games
        WHERE player_key = 'luka doncic' AND season_type = 'regular' AND minutes > 0 ORDER BY game_date DESC LIMIT 10`);
      assert.equal(games.length, 10);
      assert.deepEqual(out.recentGames.map(g => [g.date, g.fpts, g.minutes]), games.map(g => [g.game_date, g.dk, g.minutes]));
      return { numbers: [games[0].dk], names: [] };
    },
  },
  {
    id: 'archetype-matchups',
    question: 'Who has the best archetype matchups tonight?',
    agent: 'research',
    tool: 'get_archetype_matchups',
    args: {},
    async verify(out) {
      assert.equal(out.success, true);
      const latest = await db.get('SELECT slate_id FROM slates ORDER BY created_at DESC LIMIT 1');
      assert.equal(out.slateId, String(latest.slate_id));
      assert.ok(out.players.length > 0, 'no matchups on the latest slate');
      const edges = out.players.map(p => p.adjustedEdge);
      assert.deepEqual(edges, [...edges].sort((a, b) => b - a), 'ranked by adjusted edge');
      for (const p of out.players) {
        const row = await db.get('SELECT salary, projected_points FROM players WHERE slate_id = ? AND name = ?', out.slateId, p.name);
        assert.ok(row, `${p.name} not on slate ${out.slateId}`);
        assert.equal(p.salary, row.salary, p.name);
        assert.equal(p.projectedPoints, row.projected_points, p.name);
        const defense = await db.get(`SELECT fp_over_expectation AS fp,
            (SELECT COUNT(*) FROM team_archetype_defense o WHERE o.season = d.season AND o.site = d.site AND o.group_by = d.group_by
               AND o.group_key = d.group_key AND o.fp_over_expectation > d.fp_over_expectation) + 1 AS rank
          FROM team_archetype_defense d WHERE season = ? AND site = ? AND group_by = 'archetype' AND team = ? AND group_key = ?`,
        out.season, out.site, p.opponent, p.archetype);
        assert.ok(defense, `${p.opponent} vs ${p.archetype} missing in ${out.season}`);
        assert.equal(p.matchupEdge, defense.fp, `${p.name} matchup edge`);
        assert.ok(defense.fp > 0 && p.rank <= Math.ceil(p.teams / 3), `${p.name}: ${p.opponent} not in the weak tier`);
      }
      return { numbers: [], names: [out.players[0].name] };
    },
  },
  {
    id: 'team-defense',
    question: 'What does IND allow to primary creators?',
    agent: 'analyst',
    tool: 'get_team_defense_profile',
    args: { team: 'IND', groupBy: 'archetype' },
    async verify(out) {
      assert.equal(out.success, true);
      // Thin current season -> last season (20+ defenses need 10+ games)
      const qualified = async (season) => (await db.get(`SELECT COUNT(*) AS n FROM (SELECT team FROM team_archetype_defense
        WHERE season = ? AND site = 'draftkings' AND group_by = 'archetype' GROUP BY team HAVING MAX(games) >= 10) t`, season)).n;
      if (out.fallback) {
        assert.ok(await qualified(out.fallback.from) < 20);
        assert.ok(await qualified(out.season) > await qualified(out.fallback.from));
      } else {
        assert.ok(await qualified(out.season) >= 20);
      }
      const row = out.archetype.rows.find(r => r.group === 'primary_creator');
      const sql = await db.get(`SELECT fp_over_expectation AS fp, pts_delta AS pts, games FROM team_archetype_defense
        WHERE season = ? AND site = 'draftkings' AND group_by = 'archetype' AND team = 'IND' AND group_key = 'primary_creator'`, out.season);
      const rank = (await db.get(`SELECT COUNT(*) + 1 AS r FROM team_archetype_defense WHERE season = ? AND site = 'draftkings'
        AND group_by = 'archetype' AND group_key = 'primary_creator' AND fp_over_expectation > ?`, out.season, sql.fp)).r;
      assert.equal(row.fpOverExpectation, round2(sql.fp));
      assert.equal(row.ptsDelta, round2(sql.pts));
      assert.equal(row.games, sql.games);
      assert.equal(row.rank, rank);
      return { numbers: [row.fpOverExpectation], names: [] };
    },
  },
  {
    id: 'usage-bumps',
    question: 'Usage bumps on DET when Tobias Harris is out',
    agent: 'analyst',
    tool: 'analyze_roster_context',
    args: { team: 'DET', absentPlayers: ['Tobias Harris'], season: '2025-26' },
    async verify(out) {
      assert.equal(out.success, true);
      assert.equal(out.scenario.absentPlayers[0].key, 'tobias harris');
      // Team games inside Harris's DET window that he did not play
      const WINDOW = `WITH w AS (SELECT MIN(game_date) AS a, MAX(game_date) AS b FROM historical_games
          WHERE player_key = 'tobias harris' AND team = 'DET' AND season = '2025-26' AND season_type = 'regular'),
        tg AS (SELECT DISTINCT game_date FROM historical_games, w WHERE team = 'DET' AND season = '2025-26'
          AND season_type = 'regular' AND game_date BETWEEN w.a AND w.b),
        out AS (SELECT game_date FROM tg WHERE game_date NOT IN
          (SELECT game_date FROM historical_games WHERE player_key = 'tobias harris' AND minutes > 0))`;
      const { n } = await db.get(`${WINDOW} SELECT COUNT(*) AS n FROM out`);
      assert.equal(out.matchingGames.count, n);
      assert.ok(out.usageBumps.length >= 3);
      for (const b of out.usageBumps.slice(0, 3)) {
        const split = await db.get(`${WINDOW} SELECT
            AVG(CASE WHEN h.game_date IN (SELECT game_date FROM out) THEN dk_fantasy_points END) AS ctx,
            AVG(CASE WHEN h.game_date NOT IN (SELECT game_date FROM out) THEN dk_fantasy_points END) AS other,
            SUM(CASE WHEN h.game_date IN (SELECT game_date FROM out) THEN 1 ELSE 0 END) AS ctx_games
          FROM historical_games h, w WHERE h.player_key = ? AND h.team = 'DET' AND h.season = '2025-26'
            AND h.season_type = 'regular' AND h.minutes > 0 AND h.game_date BETWEEN w.a AND w.b`, b.key);
        assert.equal(b.gamesInContext, split.ctx_games, b.player);
        assert.equal(b.contextAvgFpts, round1(split.ctx), b.player);
        assert.equal(b.otherAvgFpts, round1(split.other), b.player);
      }
      return { numbers: [out.usageBumps[0].fptsBump], names: [out.usageBumps[0].player] };
    },
  },
  {
    id: 'score-lineup',
    question: `Score this lineup from 2026-10-21: ${F2_LINEUP.join(', ')}`,
    agent: 'research',
    tool: 'score_lineup',
    args: { date: '2026-10-21', players: F2_LINEUP },
    async verify(out) {
      assert.equal(out.success, true);
      assert.equal(out.notFound, undefined);
      assert.equal(out.players.length, 8);
      assert.equal(out.totalPoints, 273);
      for (const p of out.players) {
        const { dk } = await db.get(`SELECT dk_fantasy_points AS dk FROM historical_games WHERE player_key = ? AND game_date = '2026-10-21'`, p.key);
        assert.equal(p.points, dk, p.name);
      }
      return { numbers: [273], names: [] };
    },
  },
  {
    id: 'opportunity-radar',
    question: 'Who was in a good spot for cash under $6,500 on 2026-10-21?',
    agent: 'research',
    tool: 'get_opportunity_radar',
    args: { slateDate: '2026-10-21', mode: 'cash', maxSalary: 6500, limit: 5 },
    async verify(out) {
      assert.equal(out.success, true, out.message);
      assert.equal(out.backtest, true);
      assert.equal(out.mode, 'cash');
      assert.equal(out.players.length, 5);
      const scores = out.players.map(p => p.score);
      assert.deepEqual(scores, [...scores].sort((a, b) => b - a), 'ranked by score');
      for (const p of out.players) {
        assert.equal(p.score, p.cashScore, p.name);
        assert.ok(p.salary <= 6500, p.name);
        const snap = await db.get(`SELECT salary, projected_points FROM slate_player_snapshots
          WHERE game_date = '2026-10-21' AND site = 'draftkings' AND slate_id = ? AND player_name = ?`, out.slateId, p.name);
        assert.ok(snap, `${p.name} not on the saved slate`);
        assert.equal(p.salary, snap.salary, p.name);
        assert.equal(p.projectedPoints, snap.projected_points, p.name);
        const game = await db.get(`SELECT dk_fantasy_points AS dk FROM historical_games
          WHERE player_name = ? AND game_date = '2026-10-21'`, p.name);
        if (game) assert.equal(p.actualPoints, game.dk, p.name);
      }
      return { numbers: [], names: [out.players[0].name] };
    },
  },
  {
    id: 'projection-accuracy',
    question: 'How accurate were projections on 2026-10-21?',
    agent: 'research',
    tool: 'get_projection_results',
    args: { date: '2026-10-21' },
    async verify(out) {
      assert.equal(out.success, true);
      const sql = await db.get(`SELECT COUNT(*) AS players,
          SUM(CASE WHEN h.minutes > 0 THEN 1 ELSE 0 END) AS played,
          AVG(CASE WHEN h.minutes > 0 THEN ABS(s.projected_points - h.dk_fantasy_points) END) AS mae,
          AVG(CASE WHEN h.minutes > 0 THEN s.projected_points - h.dk_fantasy_points END) AS bias,
          AVG(CASE WHEN h.minutes > 0 THEN (CASE WHEN h.dk_fantasy_points >= 5 * s.salary / 1000.0 THEN 100.0 ELSE 0 END) END) AS hit5
        FROM (
          -- one row per player: the main slate's, else a live capture's, else the latest
          SELECT x.*, ROW_NUMBER() OVER (PARTITION BY x.player_key ORDER BY COALESCE(c.is_main, 0) DESC,
            CASE WHEN x.capture_source IS NULL THEN 1 ELSE 0 END DESC, x.captured_at DESC) AS pick
          FROM slate_player_snapshots x LEFT JOIN slate_catalog c ON c.site = x.site AND c.slate_id = x.slate_id
          WHERE x.game_date = '2026-10-21' AND x.site = 'draftkings'
        ) s LEFT JOIN historical_games h ON h.player_key = s.player_key AND h.game_date = s.game_date
        WHERE s.pick = 1`);
      assert.equal(out.overall.players, sql.players);
      assert.equal(out.overall.played, sql.played);
      assert.equal(out.overall.projection.mae, round3(sql.mae));
      assert.equal(out.overall.projection.bias, round3(sql.bias));
      assert.equal(out.overall.hitRates['5x'], round1(sql.hit5));
      // as the tool reports it (3 decimals), not re-rounded
      return { numbers: [out.overall.projection.mae], names: [] };
    },
  },
];

function assertMentions(answer, facts) {
  for (const x of facts.numbers) assert.ok(containsNumber(answer, x), `answer is missing ${x}`);
  for (const name of facts.names) assert.ok(answer.toLowerCase().includes(name.toLowerCase()), `answer is missing ${name}`);
}

describe.skipIf(!HAS_DB)('chat tool routing (scripted LLM, real DB)', () => {
  for (const c of CASES) {
    test(`${c.id}: "${c.question}" -> ${c.agent}.${c.tool}`, async () => {
      const client = scriptedClient({ agent: c.agent, task: c.question, tool: c.tool, args: c.args });
      useClient(service, client);
      const toolCalls = [];
      const toolResults = new Map();
      const response = await service.chat(c.question, `eval-${c.id}`, {
        onToolCall: (name, args) => toolCalls.push({ name, args }),
        onToolResult: (name, result) => { if (name !== 'delegate_to_agent') toolResults.set(name, result); },
      });

      assert.equal(response.success, true);
      assert.deepEqual(response.agentsUsed, [c.agent]);
      const agentCall = client.calls.find(call => call.role === 'agent');
      assert.ok(agentCall.offered.includes(c.tool), `${c.agent} does not offer ${c.tool}`);
      assert.ok(agentCall.system.includes(c.tool), `${c.agent} prompt does not name ${c.tool}`);
      assert.deepEqual(toolCalls.map(t => t.name), ['delegate_to_agent', c.tool]);

      const facts = await c.verify(toolResults.get(c.tool));
      assertMentions(response.message, facts);
    });
  }

  test('containsNumber matches written, rounded and integer forms only', () => {
    assert.ok(containsNumber('total 273.0 DK', 273));
    assert.ok(containsNumber('MAE was 7.8 points', 7.82));
    assert.ok(containsNumber('allows +5.76 FP', 5.76));
    assert.ok(!containsNumber('1273 DK', 273));
    assert.ok(!containsNumber('5.761', 5.76));
  });
});

describe.skipIf(!HAS_DB)('value-pick backtest (real DB, deterministic agent)', () => {
  test('2026-10-21: agent picks use matchups (live tool or snapshot replay); baselines match the reference', async () => {
    const bt = await import('../src/services/agentValueBacktest.js');
    const { dates: [d] } = await bt.runValueBacktest({ from: '2026-10-21', to: '2026-10-21', persist: false });
    // DK slate 29805 runs through the live tool only while it is still in players;
    // once a newer slate is synced it is replayed from slate_player_snapshots.
    // The baselines below come from the same snapshot either way.
    const loaded = await db.get(`SELECT 1 FROM players WHERE slate_id = '29805' LIMIT 1`);
    assert.equal(d.source, loaded ? 'get_archetype_matchups' : 'snapshot_replay');
    assert.equal(d.methods.agent.picks, 5);
    assert.ok(d.methods.agent.players.every(p => p.salary <= 6500));
    assert.deepEqual(d.methods.baseline_value.names, ['Dennis Schroder', 'Jalen Smith', 'Isaiah Jackson', 'Draymond Green', 'Grayson Allen']);
    assert.equal(d.methods.baseline_value.totalDk, 133);
    assert.equal(d.methods.baseline_value.valuePer1k, 5.99);
    assert.equal(d.methods.baseline_value.hits5x, 3);
    assert.equal(d.methods.band_average.valuePer1k, 4.14);
    assert.equal(d.methods.band_average.hit5x, 0.31);
    // opportunity_top: radar cash score, $3,500-6,500, games before 10/21 only
    const opp = d.methods.opportunity_top;
    assert.equal(opp.picks, 5);
    assert.ok(opp.players.every(p => p.salary >= 3500 && p.salary <= 6500));
    assert.deepEqual(opp.names, ['Ayo Dosunmu', 'RJ Barrett', 'Ty Jerome', 'Jrue Holiday', 'Gui Santos']);
    assert.equal(opp.totalDk, 161.75);
    assert.equal(opp.valuePer1k, 5.78);
  });

  test('a slate no longer loaded is replayed from its snapshot', async () => {
    const bt = await import('../src/services/agentValueBacktest.js');
    const unloaded = await db.get(`SELECT game_date, slate_id FROM slate_player_snapshots s WHERE site = 'draftkings'
      AND NOT EXISTS (SELECT 1 FROM players p WHERE p.slate_id = s.slate_id) LIMIT 1`);
    if (!unloaded) return;
    const { getPlayerResults } = await import('../src/services/resultsService.js');
    const date = unloaded.game_date instanceof Date ? unloaded.game_date.toISOString().slice(0, 10) : unloaded.game_date;
    const pool = await getPlayerResults({ from: date, to: date, site: 'draftkings', slateId: String(unloaded.slate_id) });
    const picked = await bt.deterministicAgentPicker({ date, slateId: unloaded.slate_id, site: 'draftkings', pool });
    assert.equal(picked.source, 'snapshot_replay');
    // Matchups only adjust the ranking, so every eligible player is a candidate
    assert.equal(picked.names.length, Math.min(5, picked.eligible));
  });
});

describe.skipIf(!HAS_DB || !LIVE)('chat answers (live LLM, RUN_LIVE_AGENT_EVAL=1)', () => {
  for (const c of CASES) {
    test(`${c.id}: "${c.question}"`, async () => {
      // Expected facts from the deterministic tool output on the same DB
      const tool = [...service.agents[c.agent].tools].find(t => t.name === c.tool);
      const facts = await c.verify(await tool.execute(c.args));
      const response = await service.chat(c.question, `live-eval-${c.id}`, {});
      assert.equal(response.success, true, response.error);
      assertMentions(response.message, facts);
    }, 180000);
  }
});
