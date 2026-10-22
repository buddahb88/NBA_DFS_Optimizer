import { test, describe, beforeAll as before, afterAll as after } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import yaml from 'js-yaml';
import { fileURLToPath } from 'url';

// AI/chat layer docs and prompts vs. the real schema: every documented column
// and example query must exist / compile against a freshly migrated database
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..', '..');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nba-dfs-ai-chat-'));
const schemaYaml = fs.readFileSync(path.join(__dirname, '..', 'src', 'config', 'database-schema.yaml'), 'utf8');
const schemaDoc = yaml.load(schemaYaml);

const NEW_TABLES = ['historical_games', 'slate_player_snapshots', 'player_season_profiles', 'player_archetypes', 'team_archetype_defense'];
// Old guidance treated pts_allowed as fantasy points (">= 45 is a great matchup")
const STALE_DVP = /pts_allowed\s*(>=|<=|>|<)\s*\d|≥\s*45/;
let db;

before(async () => {
  process.env.DATABASE_TYPE = 'sqlite';
  process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');
  db = (await import('../src/config/database.js')).default;
  await (await import('../src/config/schema.js')).createTables(db);
});

after(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const columnsOf = async (table) => (await db.all(`PRAGMA table_info(${table})`)).map(c => c.name);
const compiles = (sql) => db.all(`EXPLAIN ${sql}`);
const sqlBlocks = (markdown) => [...markdown.matchAll(/```sql\r?\n([\s\S]*?)```/g)].map(m => m[1].trim());

describe('database-schema.yaml', () => {
  test('documents the new tables with columns that exist', async () => {
    for (const table of NEW_TABLES) {
      const doc = schemaDoc.tables[table];
      assert.ok(doc, `${table} is documented`);
      assert.ok(doc.description, `${table} has a description`);
      const actual = await columnsOf(table);
      for (const col of doc.columns) {
        assert.ok(actual.includes(col.name), `${table}.${col.name} exists`);
      }
    }
    assert.ok(schemaDoc.tables.historical_games.columns.some(c => c.name === 'player_key'));
  });

  test('every table example query compiles', async () => {
    for (const [table, doc] of Object.entries(schemaDoc.tables)) {
      const examples = Array.isArray(doc.example_queries) ? doc.example_queries : [];
      for (const ex of examples) {
        const sql = typeof ex === 'string' ? ex : ex.query;
        await assert.doesNotReject(compiles(sql), `${table}: ${ex.description || sql}`);
      }
    }
  });

  test('DVP points allowed is real points with no fantasy-point thresholds', () => {
    const ptsAllowed = schemaDoc.tables.team_defense_vs_position.columns.find(c => c.name === 'pts_allowed');
    assert.match(ptsAllowed.description, /real points/i);
    const dvp = schemaDoc.tables.players.columns.find(c => c.name === 'dvp_pts_allowed');
    assert.match(dvp.description, /real points/i);
    assert.doesNotMatch(schemaYaml, STALE_DVP);
  });
});

describe('chat and agent prompts', () => {
  test('aiChatService system prompt covers the new tables, not stale DVP guidance', async () => {
    const aiChatService = (await import('../src/services/aiChatService.js')).default;
    const prompt = aiChatService.getSystemPrompt();
    for (const table of NEW_TABLES) assert.match(prompt, new RegExp(`\\b${table}\\b`));
    assert.match(prompt, /fp_over_expectation/);
    assert.doesNotMatch(prompt, STALE_DVP);
    assert.doesNotMatch(prompt, /7000\+/);
    // Names resolve through the tools, not a LOWER(name) join
    assert.doesNotMatch(prompt, /player_key = LOWER\(players\.name\)/);
    assert.match(prompt, /resolve them with the history tools/);
  });

  test('Research and Analyst prompts point matchups at team_archetype_defense', async () => {
    const ResearchAgent = (await import('../src/agents/ResearchAgent.js')).default;
    const AnalystAgent = (await import('../src/agents/AnalystAgent.js')).default;
    for (const agent of [new ResearchAgent(), new AnalystAgent()]) {
      assert.match(agent.systemPrompt, /team_archetype_defense/, agent.name);
      assert.match(agent.systemPrompt, /player_archetypes/, agent.name);
      assert.doesNotMatch(agent.systemPrompt, /7000\+/, agent.name);
    }
    assert.match(new ResearchAgent().systemPrompt, /dvp_pts_allowed[^\n]*real points/);
    for (const agent of [new ResearchAgent(), new AnalystAgent()]) {
      assert.doesNotMatch(agent.systemPrompt, /LOWER\(players\.name\)/, agent.name);
    }
    for (const file of [path.join(root, 'CLAUDE.md'), path.join(__dirname, '..', 'src', 'config', 'database-schema.yaml')]) {
      assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /player_key = LOWER\(players\.name\)/, file);
    }
  });

  test('Analyst custom queries may read the archetype tables but stay read-only', async () => {
    const AnalystAgent = (await import('../src/agents/AnalystAgent.js')).default;
    const tool = new AnalystAgent().tools.find(t => t.name === 'query_historical_data');
    const ok = await tool.execute({
      query: 'SELECT team, group_key, fp_over_expectation FROM team_archetype_defense WHERE site = \'draftkings\'',
      explanation: 'archetype defense',
    });
    assert.equal(ok.success, true, ok.error);
    const joined = await tool.execute({
      query: 'SELECT a.archetype FROM player_archetypes a JOIN player_season_profiles p ON p.player_key = a.player_key',
      explanation: 'archetypes',
    });
    assert.equal(joined.success, true, joined.error);
    assert.equal((await tool.execute({ query: 'SELECT * FROM lineups', explanation: 'x' })).success, false);
    assert.equal((await tool.execute({ query: 'DELETE FROM player_archetypes', explanation: 'x' })).success, false);
  });
});

describe('Claude Code commands', () => {
  test('/matchups uses team_archetype_defense and every SQL block compiles', async () => {
    const md = fs.readFileSync(path.join(root, '.claude', 'commands', 'matchups.md'), 'utf8');
    assert.doesNotMatch(md, /dk_pts_allowed/);
    assert.match(md, /team_archetype_defense/);
    const blocks = sqlBlocks(md);
    assert.ok(blocks.length >= 5);
    for (const sql of blocks) await assert.doesNotReject(compiles(sql), sql);
  });

  test('no command references the non-existent dk_pts_allowed column', () => {
    const dir = path.join(root, '.claude', 'commands');
    for (const file of fs.readdirSync(dir)) {
      assert.doesNotMatch(fs.readFileSync(path.join(dir, file), 'utf8'), /dk_pts_allowed/, file);
    }
  });
});
