#!/usr/bin/env node

/**
 * AGENT VALUE-PICK BACKTEST
 *
 * For every past date with slate_player_snapshots, the chat agent's top 5
 * value plays at <= $6,500 vs (a) the top 5 by projected points per $1K
 * ($3,500-6,500, not OUT), (b) the average played player at $4,500-6,500
 * and (c) opportunity_top, the top 5 by Opportunity Radar score at
 * $3,500-6,500 (cash score, or gpp with --opportunity-mode gpp), scored against historical_games (services/agentValueBacktest.js). Rows are
 * saved to agent_value_backtests so the trend can be tracked.
 *
 * The agent's picks come from the chat tool layer with no LLM: every eligible
 * slate player ranked by projection per $1K, adjusted by the
 * get_archetype_matchups edge (or its snapshot replay once the slate is no
 * longer loaded). A method with fewer than 5 picks is flagged incomplete and
 * its date is left out of the cumulative comparison. With
 * RUN_LIVE_AGENT_EVAL=1 the question goes to the configured LLM through the
 * chat orchestrator instead and the picks are read from its answer.
 *
 * Usage:
 *   node scripts/agent-value-backtest.js [--from 2026-10-20] [--to 2026-10-21] [--site draftkings]
 *     [--opportunity-mode cash|gpp] [--no-save]
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
const LABELS = { agent: 'agent', baseline_value: '(a) top proj/1K', band_average: '(b) band avg', opportunity_top: '(c) opportunity top' };
const pct = (x) => `${Math.round(x * 100)}%`;

const row = (date, method, m) => ({
  date,
  method: LABELS[method],
  picks: method === 'band_average' ? '-' : m.picks,
  incomplete: m.incomplete ? 'YES' : '',
  dk_per_player: m.avgDk,
  per_1k: m.valuePer1k,
  total_dk: m.totalDk,
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
    opportunityMode: arg('opportunity-mode') === 'gpp' ? 'gpp' : 'cash',
    persist: !process.argv.includes('--no-save'),
  });

  if (result.dates.length === 0) {
    console.log('No slate_player_snapshots to replay.');
  } else {
    console.log(`\nAgent value backtest (${LIVE ? 'live LLM' : 'deterministic tool output'}), ${result.site}, run ${result.runAt}`);
    console.table(result.dates.flatMap(d => Object.entries(d.methods).map(([method, m]) => row(d.date, method, m))));
    console.log('Agent pick source per date:', result.dates.map(d => `${d.date} ${d.source}`).join('; '));

    for (const d of result.dates) {
      const agent = d.methods.agent;
      if (agent.incomplete && agent.eligible != null && agent.eligible < 5) {
        console.warn(`WARNING ${d.date}: only ${agent.eligible} eligible player(s) at <= $6,500 (not OUT, with a projection).`);
      }
    }
    const s = result.summary;
    if (s.excluded.length) {
      console.warn(`\nWARNING: ${s.excluded.join(', ')} excluded from the cumulative comparison (a method returned fewer than 5 picks).`);
    }
    console.log(`\nCumulative over ${result.dates.length - s.excluded.length} complete date(s):`);
    console.table(Object.fromEntries(['agent', 'baseline_value', 'opportunity_top', 'band_average'].map(method => [LABELS[method], {
      dk_per_player: s[method].avgDk, per_1k: s[method].valuePer1k, hit_5x: pct(s[method].hit5x),
      min_proj: s[method].projectedMinutes, min_actual: s[method].actualMinutes,
    }])));
    console.log(`Agent ${s.agentBeatsBaseline ? 'BEATS' : 'does NOT beat'} baseline (a) on points per $1K (${s.agent.valuePer1k} vs ${s.baseline_value.valuePer1k}; `
      + `DK per player ${s.agent.avgDk} vs ${s.baseline_value.avgDk}).`);
    console.log(`Opportunity top (${result.dates[0]?.methods.opportunity_top.mode}) ${s.opportunityBeatsBaseline ? 'BEATS' : 'does NOT beat'} baseline (a) on points per $1K `
      + `(${s.opportunity_top.valuePer1k} vs ${s.baseline_value.valuePer1k}; DK per player ${s.opportunity_top.avgDk} vs ${s.baseline_value.avgDk}).`);
    if (!process.argv.includes('--no-save')) console.log('Saved to agent_value_backtests.');
  }
} finally {
  db.close();
}
