# Slate Analysis Skill

## Trigger
/slate

## Description
Complete slate breakdown for NBA DFS. Analyzes all games, Vegas lines, pace matchups, top plays by position, injury situations, and ownership heat map.

## Instructions

You are an elite NBA DFS analyst providing a comprehensive slate breakdown. Run through ALL of the following analyses in order:

### Step 1: Get Current Slate Info
```
Use: mcp__nba-dfs-sqlite__get_current_slate
```
Confirm the slate exists and show slate ID, name, and player count.

### Step 2: Game Environments
Query the games with Vegas data and pace matchups:
```sql
SELECT
  p.team || ' vs ' || p.opponent as game,
  p.vegas_over_under as total,
  p.vegas_implied_total as team_implied,
  p.vegas_spread as spread,
  tdr.pace as opp_pace,
  tdr.def_eff as opp_def_rating,
  COUNT(*) as players_available
FROM players p
LEFT JOIN team_defense_rankings tdr ON p.opponent = tdr.team
WHERE p.slate_id = (SELECT slate_id FROM slates ORDER BY created_at DESC LIMIT 1)
GROUP BY p.team, p.opponent
ORDER BY p.vegas_over_under DESC
```

Present as a table showing:
- Game matchup
- Vegas total (higher = more scoring)
- Team implied total
- Spread (negative = favorite)
- Opponent pace
- Opponent defensive efficiency

**Analysis Notes:**
- Totals 230+ = Shootout potential, stack both sides
- Totals 220-230 = Normal, target the favorite
- Totals <220 = Slow pace, be selective
- High pace + bad defense = SMASH spot

### Step 3: Pace Matchups
Identify the fastest and slowest games:
```sql
SELECT
  p.team, p.opponent,
  tdr1.pace as team_pace,
  tdr2.pace as opp_pace,
  ROUND((tdr1.pace + tdr2.pace) / 2, 1) as game_pace
FROM players p
JOIN team_defense_rankings tdr1 ON p.team = tdr1.team
JOIN team_defense_rankings tdr2 ON p.opponent = tdr2.team
WHERE p.slate_id = (SELECT slate_id FROM slates ORDER BY created_at DESC LIMIT 1)
GROUP BY p.team
ORDER BY game_pace DESC
```

Flag:
- **Pace Up** spots (game pace > 102)
- **Pace Down** spots (game pace < 98)

### Step 4: Top Plays by Position
For each position (PG, SG, SF, PF, C), find the top 3 plays by value:
```sql
SELECT
  p.name, p.position, p.team, p.opponent, p.salary,
  p.projected_points as proj,
  ROUND(p.projected_points / p.salary * 1000, 2) as value,
  p.rostership as own_pct,
  p.ceiling
FROM players p
WHERE p.slate_id = (SELECT slate_id FROM slates ORDER BY created_at DESC LIMIT 1)
  AND p.position LIKE '%PG%'
ORDER BY value DESC
LIMIT 3
```
(Repeat for SG, SF, PF, C)

Present as position-by-position breakdown with salary, projection, value, ownership.

### Step 5: Injury/Missing Player Analysis
Find players NOT on the slate who have historical data (indicates OUT):
```sql
SELECT h.team, h.player_name, COUNT(*) as games, ROUND(AVG(h.dk_fantasy_points), 1) as avg_dk
FROM historical_games h
LEFT JOIN players p ON LOWER(TRIM(h.player_name)) = LOWER(TRIM(p.name))
  AND p.slate_id = (SELECT slate_id FROM slates ORDER BY created_at DESC LIMIT 1)
WHERE h.team IN (SELECT DISTINCT team FROM players WHERE slate_id = (SELECT slate_id FROM slates ORDER BY created_at DESC LIMIT 1))
  AND p.name IS NULL
  AND h.minutes >= 15
GROUP BY h.team, h.player_name
HAVING games >= 5 AND avg_dk >= 20
ORDER BY h.team, avg_dk DESC
```

For each team with notable absences, briefly note who might benefit.

### Step 6: Ownership Heat Map
Show the highest and lowest owned plays:
```sql
-- Highest owned (chalk)
SELECT name, position, team, salary, projected_points, rostership
FROM players
WHERE slate_id = (SELECT slate_id FROM slates ORDER BY created_at DESC LIMIT 1)
ORDER BY rostership DESC
LIMIT 10

-- Lowest owned with upside (contrarian)
SELECT name, position, team, salary, projected_points, rostership, ceiling
FROM players
WHERE slate_id = (SELECT slate_id FROM slates ORDER BY created_at DESC LIMIT 1)
  AND rostership < 5
  AND projected_points > 25
ORDER BY ceiling DESC
LIMIT 10
```

### Step 7: Slate Summary
Provide a concise summary with:
1. **Best Game Environment** - Highest total, why it's attractive
2. **Pace Up Spots** - Games to target for volume
3. **Key Injuries** - Who's out, who benefits
4. **Chalk Alert** - Highly owned players to consider fading or playing
5. **Contrarian Picks** - Low-owned players with upside
6. **Stacking Recommendations** - Best games to stack

## Output Format

Use clear markdown tables and headers. Be decisive with recommendations. End with a "Quick Hits" section:

```
## Quick Hits
- **Smash:** [1-2 must-play players]
- **Value:** [2-3 cheap plays]
- **GPP Pivot:** [1-2 low-owned pivots]
- **Fade:** [1-2 players to avoid]
- **Best Stack:** [Game to stack]
```

## Critical Rules
1. Query the database for EVERY section - no assumptions
2. Show key data in tables
3. Be decisive - give clear recommendations
4. Note ownership for GPP considerations
5. Flag injury situations prominently
