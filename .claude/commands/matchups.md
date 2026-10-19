# Matchups & DVP Analysis Skill

## Trigger
/matchups

## Description
Defense vs Position (DVP) analysis for the current slate. Identifies the best and worst matchups at each position, pace-adjusted opportunities, and exploitable defensive weaknesses.

## Instructions

You are an elite NBA DFS matchup analyst. Run through ALL of the following analyses:

### Step 1: Get Current Slate
```
Use: mcp__nba-dfs-sqlite__get_current_slate
```
Confirm the slate and games available.

### Step 2: DVP Rankings by Position
Query the full DVP rankings:
```sql
SELECT
  team,
  position,
  dk_pts_allowed,
  rank as dvp_rank
FROM team_defense_vs_position
ORDER BY position, rank
```

Present as 5 tables (one per position: PG, SG, SF, PF, C) showing:
- Top 5 BEST matchups (most points allowed, highest rank)
- Top 5 WORST matchups (fewest points allowed, lowest rank)

### Step 3: Tonight's Best Matchups
Cross-reference DVP with current slate players:
```sql
SELECT
  p.name, p.position, p.team, p.opponent, p.salary,
  p.projected_points as proj,
  ROUND(p.projected_points / p.salary * 1000, 2) as value,
  p.rostership as own_pct,
  tdvp.dk_pts_allowed, tdvp.rank as dvp_rank
FROM players p
JOIN team_defense_vs_position tdvp
  ON p.opponent = tdvp.team
  AND (p.position LIKE '%' || tdvp.position || '%')
WHERE p.slate_id = (SELECT slate_id FROM slates ORDER BY created_at DESC LIMIT 1)
  AND tdvp.rank >= 25  -- Bottom 6 defenses at position
ORDER BY tdvp.rank DESC, p.projected_points DESC
LIMIT 20
```

**Analysis Notes**: Players facing bottom-6 defenses at their position have a significant edge.

### Step 4: Tonight's Worst Matchups (Fades)
```sql
SELECT
  p.name, p.position, p.team, p.opponent, p.salary,
  p.projected_points as proj,
  p.rostership as own_pct,
  tdvp.dk_pts_allowed, tdvp.rank as dvp_rank
FROM players p
JOIN team_defense_vs_position tdvp
  ON p.opponent = tdvp.team
  AND (p.position LIKE '%' || tdvp.position || '%')
WHERE p.slate_id = (SELECT slate_id FROM slates ORDER BY created_at DESC LIMIT 1)
  AND tdvp.rank <= 5  -- Top 5 defenses at position
ORDER BY p.rostership DESC
LIMIT 15
```

**Flag high-owned players in tough matchups** - potential leverage fades.

### Step 5: Pace-Adjusted Opportunities
Combine pace with DVP for the ultimate matchup spots:
```sql
SELECT
  p.name, p.position, p.team, p.opponent, p.salary,
  p.projected_points as proj,
  tdr.pace as opp_pace,
  tdr.def_eff as opp_def_rating,
  tdvp.rank as dvp_rank
FROM players p
JOIN team_defense_rankings tdr ON p.opponent = tdr.team
JOIN team_defense_vs_position tdvp
  ON p.opponent = tdvp.team
  AND (p.position LIKE '%' || tdvp.position || '%')
WHERE p.slate_id = (SELECT slate_id FROM slates ORDER BY created_at DESC LIMIT 1)
  AND tdr.pace >= 100  -- Fast pace
  AND tdvp.rank >= 20  -- Bad defense at position
ORDER BY tdr.pace DESC, tdvp.rank DESC
LIMIT 15
```

**PACE UP + BAD DVP = SMASH SPOT**

### Step 6: Team Defense Overview
Show overall defensive rankings for tonight's opponents:
```sql
SELECT
  tdr.team,
  tdr.pace,
  tdr.def_eff,
  tdr.pts_allowed,
  -- Check if on tonight's slate
  CASE WHEN EXISTS (
    SELECT 1 FROM players p
    WHERE p.opponent = tdr.team
    AND p.slate_id = (SELECT slate_id FROM slates ORDER BY created_at DESC LIMIT 1)
  ) THEN 'YES' ELSE 'NO' END as on_slate
FROM team_defense_rankings tdr
ORDER BY tdr.def_eff DESC
```

Highlight teams on tonight's slate that are:
- **Pace Up**: Top 10 in pace
- **Bad Defense**: Bottom 10 in def efficiency
- **Points Allowed**: Top 10 in points allowed

### Step 7: Position-by-Position Best Plays

For each position, identify the top 3 matchup-based plays:

**PG Smash Spots**:
```sql
SELECT p.name, p.team, p.opponent, p.salary, p.projected_points,
  tdvp.dk_pts_allowed, tdvp.rank
FROM players p
JOIN team_defense_vs_position tdvp ON p.opponent = tdvp.team AND tdvp.position = 'PG'
WHERE p.slate_id = (SELECT slate_id FROM slates ORDER BY created_at DESC LIMIT 1)
  AND p.position LIKE '%PG%'
ORDER BY tdvp.rank DESC, p.projected_points DESC
LIMIT 3
```

Repeat for SG, SF, PF, C.

### Step 8: Historical DVP Validation
For the top recommended matchup plays, validate with historical data:
```sql
SELECT
  h.player_name,
  h.opponent,
  COUNT(*) as games_vs,
  ROUND(AVG(h.dk_fantasy_points), 1) as avg_dk_vs_opp,
  ROUND(MAX(h.dk_fantasy_points), 1) as best_game,
  ROUND(MIN(h.dk_fantasy_points), 1) as worst_game
FROM historical_games h
WHERE h.player_name IN (/* top recommended players */)
  AND h.opponent IN (/* tonight's opponents */)
GROUP BY h.player_name, h.opponent
```

Check if players have historically crushed (or struggled against) tonight's opponent.

### Step 9: Leverage Matchup Plays
Find good matchups with low ownership (GPP gold):
```sql
SELECT
  p.name, p.position, p.team, p.opponent, p.salary,
  p.projected_points as proj,
  p.rostership as own_pct,
  p.ceiling,
  tdvp.rank as dvp_rank
FROM players p
JOIN team_defense_vs_position tdvp
  ON p.opponent = tdvp.team
  AND (p.position LIKE '%' || tdvp.position || '%')
WHERE p.slate_id = (SELECT slate_id FROM slates ORDER BY created_at DESC LIMIT 1)
  AND tdvp.rank >= 20  -- Good matchup
  AND p.rostership < 10  -- Low ownership
ORDER BY p.ceiling DESC
LIMIT 10
```

### Step 10: Matchup Summary

Provide position-by-position recommendations:

## Matchup Summary by Position

| Position | Best Matchup Team | Fade Matchup Team | Top Play |
|----------|-------------------|-------------------|----------|
| PG | XXX (rank 30) | XXX (rank 1) | Player Name |
| SG | XXX (rank 28) | XXX (rank 3) | Player Name |
| SF | XXX (rank 29) | XXX (rank 2) | Player Name |
| PF | XXX (rank 27) | XXX (rank 4) | Player Name |
| C | XXX (rank 30) | XXX (rank 1) | Player Name |

## Output Format

Use tables and clear headers. End with:

```
## Quick Hits

**SMASH Matchups** (Pace + DVP aligned):
1. [Player] vs [Team] - [why]
2. [Player] vs [Team] - [why]
3. [Player] vs [Team] - [why]

**Fade Matchups** (Tough defense, high ownership):
1. [Player] vs [Team] - [why]
2. [Player] vs [Team] - [why]

**GPP Leverage** (Good matchup, low ownership):
1. [Player] (X% owned) vs [Team] - [upside]
2. [Player] (X% owned) vs [Team] - [upside]

**Pace Up Games**:
- [Game] - Combined pace: XXX
- [Game] - Combined pace: XXX
```

## Critical Rules
1. Query the database for EVERY section - no assumptions
2. Show DVP ranks with context (1 = best defense, 30 = worst)
3. Cross-reference pace with DVP for true smash spots
4. Flag high-owned players in bad matchups as fades
5. Identify low-owned players in good matchups for GPP
