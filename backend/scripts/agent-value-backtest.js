#!/usr/bin/env node

/**
 * AGENT VALUE-PICK BACKTEST
 *
 * For every past date with slate_player_snapshots, the chat agent's top 5
 * value plays at <= $6,500 vs (a) the top 5 by projected points per $1K
 * ($3,500-6,500, not OUT) and (b) the average played player at $4,500-6,500,
 * scored against historical_games (services/agentValueBacktest.js). Rows are
 * saved to agent_value_backtests so the trend can be tracked.
 *
 * The agent's picks come from the chat tool layer with no LLM: the
 * get_archetype_matchups tool (or its snapshot replay once the slate is no
 * longer loaded) ranked by matchup-adjusted projection per $1K. With
 * RUN_LIVE_AGENT_EVAL=1 the question goes to the configured LLM through the
 * chat orchestrator instead and the picks are read from its answer.
 *
 * Usage:
 *   node scripts/agent-value-backtest.js [--from 2026-10-20] [--to 2026-10-21] [--site draftkings] [--no-save]
 */

import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Load env before the database module reads DATABASE_TYPE
dotenv.config({ path: path.join(__dirname, '../.env') });

const { default: db } = await import('../src/config/database.js');
const { createTables } = await import('../src/config/schema.js');
const { runValueBacktest, deterministicAgentPicker, liveAgentPicker } = await import('../src/services/agentValueBacktest.js');

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const LIVE = process.env.RUN_LIVE_AGENT_EVAL === '1';
const LABELS = { agent: 'agent', baseline_value: '(a) top proj/1K', band_average: '(b) band avg' };
const pct = (x) => `${Math.round(x * 100)}%`;

const row = (date, method, m) => ({
  date,
  method: LABELS[method],
  total_dk: m.totalDk,
  per_1k: m.valuePer1k,
  hit_5x: method === 'band_average' ? pct(m.hit5x) : `${m.hits5x}/${m.picks}`,
  min_proj: m.projectedMinutes,
  min_actual: m.actualMinutes,
  players: method === 'band_average' ? `${m.players} played` : m.names.join(', '),
});

try {
  await createTables(db);
  const result = await runValueBacktest({
    site: arg('site') || 'draftkings',
    from: arg('from'),
    to: arg('to'),
    agentPicker: LIVE ? liveAgentPicker : deterministicAgentPicker,
    persist: !process.argv.includes('--no-save'),
  });

  if (result.dates.length === 0) {
    console.log('No slate_player_snapshots to replay.');
  } else {
    console.log(`\nAgent value backtest (${LIVE ? 'live LLM' : 'deterministic tool output'}), ${result.site}, run ${result.runAt}`);
    console.table(result.dates.flatMap(d => Object.entries(d.methods).map(([method, m]) => row(d.date, method, m))));
    console.log('Agent pick source per date:', result.dates.map(d => `${d.date} ${d.source}`).join('; '));

    const s = result.summary;
    console.log(`\nCumulative over ${result.dates.length} date(s):`);
    console.table(Object.fromEntries(['agent', 'baseline_value', 'band_average'].map(method => [LABELS[method], {
      total_dk: s[method].totalDk, per_1k: s[method].valuePer1k, hit_5x: pct(s[method].hit5x),
      min_proj: s[method].projectedMinutes, min_actual: s[method].actualMinutes,
    }])));
    console.log(`Agent ${s.agentBeatsBaseline ? 'BEATS' : 'does NOT beat'} baseline (a) on points per $1K (${s.agent.valuePer1k} vs ${s.baseline_value.valuePer1k}).`);
    if (!process.argv.includes('--no-save')) console.log('Saved to agent_value_backtests.');
  }
} finally {
  db.close();
}
