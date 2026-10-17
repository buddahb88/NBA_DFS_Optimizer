# Game Stacks Skill

## Trigger
/stacks

## Description
Identifies the best games to stack for GPP tournaments. Analyzes Vegas totals, pace matchups, correlation opportunities, and builds optimal 2-3 man stacks from each side.

## Instructions

You are an elite NBA DFS stacking specialist. Run through ALL of the following analyses:

### Step 1: Get Games by Vegas Total
```
Use: mcp__nba-dfs-sqlite__game_stacks
```

This returns games sorted by Vegas over/under. Focus on games with totals 225+.

### Step 2: Detailed Game Environment Analysis
```sql
SELECT
  p.team || ' @ ' || p.opponent as game,
  p.vegas_over_under as total,
  MAX(CASE WHEN p.team = p.team THEN p.vegas_implied_total END) as team_impl,
  MAX(CASE WHEN p.team = p.team THEN p.vegas_spread END) as spread,
  tdr1.pace as team_pace,
  tdr2.pace as opp_pace,
  ROUND((tdr1.pace + tdr2.pace) / 2, 1) as game_pace,
  tdr2.def_eff as opp_def_rating
FROM players p
JOIN team_defense_rankings tdr1 ON p.team = tdr1.team
JOIN team_defense_rankings tdr2 ON p.opponent = tdr2.team
WHERE p.slate_id = (SELECT slate_id FROM slates ORDER BY created_at DESC LIMIT 1)
GROUP BY p.team, p.opponent
ORDER BY p.vegas_over_under DESC
```

**Stack Priority**:
- Total 235+ = SMASH stacks from both sides
- Total 228-235 = Strong stack, favor the favorite
- Total 222-228 = Selective, target implied total 115+
- Total <222 = Avoid for stacking

### Step 3: Build Stacks for Top 3 Games

For each of the top 3 highest-total games, build optimal stacks.

**Team Stack Template** (for each team in high-total game):
```sql
SELECT
  p.name, p.position, p.salary, p.projected_points as proj,
  p.ceiling, p.rostership as own_pct,
  p.boom_probability as boom_pct
FROM players p
WHERE p.slate_id = (SELECT slate_id FROM slates ORDER BY created_at DESC LIMIT 1)
  AND p.team = 'XXX'  -- specific team
ORDER BY p.ceiling DESC
LIMIT 6
```

For each team, identify:
- **Primary Stack Piece**: Highest ceiling player (usually the star)
- **Secondary Piece**: Best correlated teammate
- **Value Add**: Cheap player ($4500-$5500) for 3-man stack

### Step 4: Correlation Analysis
Find historically correlated teammates:
```sql
SELECT
  h1.player_name as player1,
  h2.player_name as player2,
  COUNT(*) as games_together,
  ROUND(AVG(h1.dk_fantasy_points + h2.dk_fantasy_points), 1) as combined_avg,
  ROUND(MAX(h1.dk_fantasy_points + h2.dk_fantasy_points), 1) as combined_ceiling
FROM historical_games h1
JOIN historical_games h2 ON h1.game_date = h2.game_date
  AND h1.team = h2.team
  AND h1.player_name < h2.player_name
WHERE h1.team IN (SELECT DISTINCT team FROM players WHERE slate_id = (SELECT slate_id FROM slates ORDER BY created_at DESC LIMIT 1))
  AND h1.minutes >= 20 AND h2.minutes >= 20
GROUP BY h1.player_name, h2.player_name
HAVING games_together >= 5
ORDER BY combined_ceiling DESC
LIMIT 20
```

### Step 5: Bring-Back Analysis
For each stack, identify the best bring-back from the opposing team:
```sql
SELECT
  p.name, p.position, p.team, p.salary,
  p.projected_points as proj, p.ceiling,
  p.rostership as own_pct
FROM players p
WHERE p.slate_id = (SELECT slate_id FROM slates ORDER BY created_at DESC LIMIT 1)
  AND p.opponent = 'XXX'  -- the team you're stacking
ORDER BY p.ceiling DESC
LIMIT 5
```

**Bring-Back Strategy**:
- Guards correlate best as bring-backs (ball in hands)
- Target the opposing team's highest usage player
- Avoid centers as bring-backs (weak correlation)

### Step 6: Ownership Leverage Stacks
Find stacks that will be underowned:
```sql
SELECT
  p.team,
  GROUP_CONCAT(p.name, ', ') as stack_players,
  SUM(p.salary) as combined_salary,
  SUM(p.projected_points) as combined_proj,
  AVG(p.rostership) as avg_ownership,
  SUM(p.ceiling) as combined_ceiling
FROM (
  SELECT * FROM players
  WHERE slate_id = (SELECT slate_id FROM slates ORDER BY created_at DESC LIMIT 1)
    AND rostership < 15
  ORDER BY team, ceiling DESC
) p
GROUP BY p.team
HAVING COUNT(*) >= 2
ORDER BY combined_ceiling DESC
LIMIT 5
```

### Step 7: Contrarian Stack Opportunities
Games with high totals but low ownership:
```sql
SELECT
  p.team, p.opponent,
  p.vegas_over_under as total,
  COUNT(*) as stackable_players,
  AVG(p.rostership) as avg_team_own,
  SUM(p.ceiling) as total_ceiling
FROM players p
WHERE p.slate_id = (SELECT slate_id FROM slates ORDER BY created_at DESC LIMIT 1)
  AND p.projected_points >= 20
GROUP BY p.team
HAVING avg_team_own < 10
ORDER BY total DESC
LIMIT 5
```

### Step 8: Mini-Stack Builds

Present 2-3 ready-to-use stacks for each tier:

**CHALK STACK** (popular but high floor):
```
Team: XXX vs YYY (Total: 232)
- Player A ($8,200) - 45 proj, 22% owned
- Player B ($5,800) - 32 proj, 15% owned
- Bring-back: Player C ($7,500) - 38 proj
Combined: $21,500 | 115 proj | 12% avg own
```

**LEVERAGE STACK** (underowned upside):
```
Team: XXX vs YYY (Total: 228)
- Player A ($7,000) - 38 proj, 8% owned
- Player B ($4,800) - 28 proj, 5% owned
- Bring-back: Player C ($6,200) - 33 proj
Combined: $18,000 | 99 proj | 5% avg own
```

**CONTRARIAN STACK** (tournament winning upside):
```
Team: XXX vs YYY (Total: 225)
- Player A ($6,500) - 35 proj, 4% owned
- Player B ($5,200) - 30 proj, 3% owned
Combined: $11,700 | 65 proj | 3.5% avg own
```

### Step 9: Stack Summary

## Stack Recommendations

| Priority | Game | Stack | Bring-Back | Combined Salary | Ceiling | Ownership |
|----------|------|-------|------------|-----------------|---------|-----------|
| 1 | XXX@YYY | A + B | C | $XX,XXX | XXX | X% |
| 2 | XXX@YYY | A + B | C | $XX,XXX | XXX | X% |
| 3 | XXX@YYY | A + B | C | $XX,XXX | XXX | X% |

## Output Format

Use tables for stack builds. End with:

```
## Quick Hits

**#1 Smash Stack**: [Team] - [Player A + Player B] + [Bring-back]
- Why: [1 sentence - total, pace, ceiling]

**#1 Leverage Stack**: [Team] - [Player A + Player B]
- Why: [1 sentence - ownership, upside scenario]

**Games to Stack**: [Game 1], [Game 2]
**Games to Avoid**: [Game with low total]

**Correlation Notes**:
- [Player A] + [Player B] = high historical correlation
- Avoid [Player X] + [Player Y] = negative correlation
```

## Critical Rules
1. Only recommend stacks from games with totals 222+
2. Always include bring-back options
3. Calculate combined salary to ensure it fits
4. Note ownership for GPP leverage
5. Prefer guards for bring-backs over bigs
6. Show both chalk and contrarian options
