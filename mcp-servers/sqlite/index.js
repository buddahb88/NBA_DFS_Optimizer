#!/usr/bin/env node
/**
 * NBA DFS SQLite MCP Server
 *
 * Provides direct SQL query access to the NBA DFS database.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { archetypeMatchups, gppPlays, playerHistory, playerProfile, valuePlays } from './queries.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Database path - relative to project root
const DB_PATH = process.env.NBA_DFS_DB_PATH || join(__dirname, '..', '..', 'backend', 'data', 'nba_dfs.db');

let db;

try {
  db = new Database(DB_PATH, { readonly: true });
  console.error(`Connected to database: ${DB_PATH}`);
} catch (error) {
  console.error(`Failed to connect to database: ${error.message}`);
  process.exit(1);
}

const server = new Server(
  {
    name: 'nba-dfs-sqlite',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
      resources: {},
    },
  }
);

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'query',
        description: 'Execute a read-only SQL query against the NBA DFS database. Returns results as JSON.',
        inputSchema: {
          type: 'object',
          properties: {
            sql: {
              type: 'string',
              description: 'SQL SELECT query to execute',
            },
            limit: {
              type: 'number',
              description: 'Maximum rows to return (default 100)',
              default: 100,
            },
          },
          required: ['sql'],
        },
      },
      {
        name: 'get_schema',
        description: 'Get the schema for a database table',
        inputSchema: {
          type: 'object',
          properties: {
            table: {
              type: 'string',
              description: 'Table name (players, slates, historical_games, slate_player_snapshots, player_season_profiles, player_archetypes, team_archetype_defense, team_defense_rankings, team_defense_vs_position)',
            },
          },
          required: ['table'],
        },
      },
      {
        name: 'list_tables',
        description: 'List all tables in the database',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'get_current_slate',
        description: 'Get the most recent slate ID and player count',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'search_player',
        description: 'Search for a player by name (partial match) in current slate and historical data',
        inputSchema: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: 'Player name to search for (partial match supported)',
            },
          },
          required: ['name'],
        },
      },
      {
        name: 'player_history',
        description: 'Get recent games played (all season types) and per-season regular-season averages for a player. Matches accents/suffixes via player_key',
        inputSchema: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: 'Player name',
            },
            limit: {
              type: 'number',
              description: 'Number of games to return (default 10)',
              default: 10,
            },
          },
          required: ['name'],
        },
      },
      {
        name: 'player_profile',
        description: "Get a player's season role profiles (usage, assist/rebound rates as fractions, per-36, fantasy points per minute) and archetype for each season",
        inputSchema: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: 'Player name',
            },
          },
          required: ['name'],
        },
      },
      {
        name: 'archetype_matchups',
        description: "Tonight's healthy players with their matchup from team_archetype_defense: fp_over_expectation = fantasy points per player-game the opponent allows above (+) or below (-) expectation to the player's archetype, plus the G/F/C DvP value. Softest matchups first. Defaults to the slate's site and the latest season with 20+ defenses at 10+ games",
        inputSchema: {
          type: 'object',
          properties: {
            site: {
              type: 'string',
              description: "draftkings, fanduel or yahoo (default: the slate's site)",
            },
            season: {
              type: 'string',
              description: 'Season such as 2025-26 (default: latest season with enough games)',
            },
            limit: {
              type: 'number',
              description: 'Number of results (default 50)',
              default: 50,
            },
          },
        },
      },
      {
        name: 'value_plays',
        description: 'Find value plays on current slate (high projection per dollar). Projections carry the app\'s projection sanity layer (blowout trim; projection_raw = RotoWire, projection_reasons = why it moved). slate_date (YYYY-MM-DD) backtests a past night\'s saved slate and adds actual DK points',
        inputSchema: {
          type: 'object',
          properties: {
            slate_date: {
              type: 'string',
              description: 'Past night YYYY-MM-DD to backtest (saved slate + actual points); omit for the current slate',
            },
            max_salary: {
              type: 'number',
              description: 'Maximum salary threshold (default 5500)',
              default: 5500,
            },
            limit: {
              type: 'number',
              description: 'Number of results (default 15)',
              default: 15,
            },
          },
        },
      },
      {
        name: 'gpp_plays',
        description: 'Find GPP leverage plays (low ownership, high ceiling). Projections carry the app\'s projection sanity layer (projection_raw = RotoWire, projection_reasons). slate_date (YYYY-MM-DD) backtests a past night\'s saved slate and adds actual DK points',
        inputSchema: {
          type: 'object',
          properties: {
            slate_date: {
              type: 'string',
              description: 'Past night YYYY-MM-DD to backtest (saved slate + actual points); omit for the current slate',
            },
            max_rostership: {
              type: 'number',
              description: 'Maximum rostership % (default 12)',
              default: 12,
            },
            min_ceiling: {
              type: 'number',
              description: 'Minimum ceiling (default 40)',
              default: 40,
            },
            limit: {
              type: 'number',
              description: 'Number of results (default 15)',
              default: 15,
            },
          },
        },
      },
      {
        name: 'game_stacks',
        description: 'Get games sorted by Vegas total for stacking opportunities',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
    ],
  };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case 'query': {
        const sql = args.sql?.trim();
        const limit = args.limit || 100;

        // Security: Only allow SELECT
        if (!sql.toUpperCase().startsWith('SELECT')) {
          return {
            content: [{ type: 'text', text: 'Error: Only SELECT queries are allowed' }],
            isError: true,
          };
        }

        const results = db.prepare(sql).all().slice(0, limit);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(results, null, 2),
            },
          ],
        };
      }

      case 'get_schema': {
        const table = args.table;
        const schema = db.prepare(`PRAGMA table_info(${table})`).all();
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(schema, null, 2),
            },
          ],
        };
      }

      case 'list_tables': {
        const tables = db
          .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
          .all();
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(tables.map((t) => t.name), null, 2),
            },
          ],
        };
      }

      case 'get_current_slate': {
        const slate = db
          .prepare(
            `SELECT s.slate_id, s.name, s.start_time, s.created_at,
                    (SELECT COUNT(*) FROM players WHERE players.slate_id = s.slate_id) as player_count
             FROM slates s
             ORDER BY s.created_at DESC LIMIT 1`
          )
          .get();
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(slate, null, 2),
            },
          ],
        };
      }

      case 'search_player': {
        const playerName = args.name;

        // Search in current slate
        const slatePlayer = db
          .prepare(
            `SELECT name, position, team, opponent, salary, projected_points, floor, ceiling, rostership, leverage_score
             FROM players
             WHERE LOWER(name) LIKE LOWER(?)
               AND slate_id = (SELECT slate_id FROM slates ORDER BY created_at DESC LIMIT 1)
             LIMIT 5`
          )
          .all(`%${playerName}%`);

        // Search in historical
        const histCount = db
          .prepare(
            `SELECT player_name, COUNT(*) as games, AVG(dk_fantasy_points) as avg_dk
             FROM historical_games
             WHERE LOWER(player_name) LIKE LOWER(?)
             GROUP BY player_name`
          )
          .all(`%${playerName}%`);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ currentSlate: slatePlayer, historical: histCount }, null, 2),
            },
          ],
        };
      }

      case 'player_history': {
        const result = playerHistory(db, args.name, args.limit || 10);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case 'player_profile': {
        const profiles = playerProfile(db, args.name);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(profiles, null, 2),
            },
          ],
        };
      }

      case 'archetype_matchups': {
        const result = archetypeMatchups(db, { site: args?.site, season: args?.season, limit: args?.limit || 50 });
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case 'value_plays': {
        const values = valuePlays(db, {
          maxSalary: args.max_salary || 5500,
          limit: args.limit || 15,
          slateDate: args.slate_date || null,
        });

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(values, null, 2),
            },
          ],
        };
      }

      case 'gpp_plays': {
        const plays = gppPlays(db, {
          maxRostership: args.max_rostership || 12,
          minCeiling: args.min_ceiling || 40,
          limit: args.limit || 15,
          slateDate: args.slate_date || null,
        });

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(plays, null, 2),
            },
          ],
        };
      }

      case 'game_stacks': {
        const games = db
          .prepare(
            `SELECT team, opponent, vegas_over_under, vegas_implied_total, vegas_spread,
                    COUNT(*) as players,
                    ROUND(AVG(projected_points), 1) as avg_projection
             FROM players
             WHERE slate_id = (SELECT slate_id FROM slates ORDER BY created_at DESC LIMIT 1)
             GROUP BY team, opponent
             ORDER BY vegas_over_under DESC`
          )
          .all();

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(games, null, 2),
            },
          ],
        };
      }

      default:
        return {
          content: [{ type: 'text', text: `Unknown tool: ${name}` }],
          isError: true,
        };
    }
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error.message}` }],
      isError: true,
    };
  }
});

// List resources (provide database info)
server.setRequestHandler(ListResourcesRequestSchema, async () => {
  return {
    resources: [
      {
        uri: 'nba-dfs://schema',
        name: 'Database Schema',
        description: 'Full schema of the NBA DFS database',
        mimeType: 'application/json',
      },
      {
        uri: 'nba-dfs://current-slate',
        name: 'Current Slate',
        description: 'Current slate players and projections',
        mimeType: 'application/json',
      },
    ],
  };
});

// Read resources
server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const { uri } = request.params;

  if (uri === 'nba-dfs://schema') {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((t) => t.name);

    const schema = {};
    for (const table of tables) {
      schema[table] = db.prepare(`PRAGMA table_info(${table})`).all();
    }

    return {
      contents: [
        {
          uri,
          mimeType: 'application/json',
          text: JSON.stringify(schema, null, 2),
        },
      ],
    };
  }

  if (uri === 'nba-dfs://current-slate') {
    const players = db
      .prepare(
        `SELECT * FROM players
         WHERE slate_id = (SELECT slate_id FROM slates ORDER BY created_at DESC LIMIT 1)
         ORDER BY projected_points DESC`
      )
      .all();

    return {
      contents: [
        {
          uri,
          mimeType: 'application/json',
          text: JSON.stringify(players, null, 2),
        },
      ],
    };
  }

  throw new Error(`Unknown resource: ${uri}`);
});

// Start the server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('NBA DFS SQLite MCP server running');
}

main().catch((error) => {
  console.error('Server error:', error);
  process.exit(1);
});
