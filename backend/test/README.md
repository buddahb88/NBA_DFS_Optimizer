# Backend tests

```bash
cd backend
npx vitest run                     # full suite
npx vitest run test/agentEval.test.js test/agentValueBacktest.test.js   # AI chat eval only (~2s)
```

Most tests build their own temp SQLite DB. Two suites cover the AI chat tool layer.

## AI chat smoke / eval: `agentEval.test.js`

This suite sends six fixed questions through the real chat path: `agenticChatService`, then `delegate_to_agent`, then `ResearchAgent` or `AnalystAgent`, then `services/chatTools`. It runs against a copy of the real local DB (`backend/data/nba_dfs.db`). The copy is serialized into a temp file, so the real DB is never modified.

| Question | Agent → tool | Checked against SQL |
|---|---|---|
| Luka Doncic last 10 games | analyst → `get_player_history` | last 10 regular-season games (date, DK, minutes) |
| Who has the best archetype matchups tonight? | research → `get_archetype_matchups` | latest slate, salary/projection from `players`, edge = `team_archetype_defense`, weak tier, sort order |
| What does IND allow to primary creators? | analyst → `get_team_defense_profile` | thin-season fallback, fp over expectation, pts delta, rank, games |
| Usage bumps on DET when Tobias Harris is out | analyst → `analyze_roster_context` | games without Harris in his DET window, top-3 with/without averages |
| Score this lineup from 2026-10-21: (F2 lineup) | research → `score_lineup` | **273.0 DK**, each player's points |
| How accurate were projections on 2026-10-21? | research → `get_projection_results` | players, played, MAE, bias, 5x hit rate |

- **Deterministic (default):** `helpers/scriptedLlm.js` stands in for the model. It makes the expected delegation and tool call, so no LLM is needed. Each case asserts that:
  - the orchestrator picked the expected agent;
  - that agent offers the tool and names it in its prompt;
  - the tool output matches the DB;
  - the final answer contains the key numbers.

  Renaming a tool, dropping it from an agent or its prompt, or breaking the service behind it fails the case.
- **Live (opt-in):** set `RUN_LIVE_AGENT_EVAL=1` to send the same questions to the LLM configured in `backend/.env`. Each answer must contain the key numbers. This mode is skipped by default and in CI.
  - bash: `RUN_LIVE_AGENT_EVAL=1 npx vitest run test/agentEval.test.js`
  - PowerShell: `$env:RUN_LIVE_AGENT_EVAL=1; npx vitest run test/agentEval.test.js`
- The whole file skips when there is no DB at that path (as in CI). Set `NBA_DFS_EVAL_DB=/path/to/copy.db` to use another DB.

## Value-pick backtest: `agentValueBacktest.test.js` and `scripts/agent-value-backtest.js`

The backtest compares the agent's top 5 value plays (salary up to $6,500) with two baselines:

- **(a)** the top 5 by projected points per $1K, at $3,500–6,500 and not OUT;
- **(b)** the average player at $4,500–6,500 who played.

Picks are scored against `historical_games`. Logic lives in `src/services/agentValueBacktest.js`.

The test pins the scoring math to the real 2026-10-21 pool, stored in `fixtures/agentEval/valuePool-2026-10-21.json`:

| Method | Total DK | Per $1K | 5x hits |
|---|---|---|---|
| Assistant picks | 98.75 | 3.71 | 0/5 |
| Baseline (a) | 133.0 | 5.99 | 3/5 |
| Band average | | 4.14 | 31% |

The test also covers persistence to `agent_value_backtests`.

```bash
node scripts/agent-value-backtest.js [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--site draftkings] [--no-save]
RUN_LIVE_AGENT_EVAL=1 node scripts/agent-value-backtest.js   # ask the live LLM instead
```

Without the flag, the agent's picks come from the tool layer with no LLM. The script calls `get_archetype_matchups` when the slate is still loaded, and otherwise replays the same ranking from the saved snapshot. It then ranks the matchups by (projection + adjusted edge) per $1K. Each run saves one row per date and method to `agent_value_backtests`.
