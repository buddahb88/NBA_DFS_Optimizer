# Contrarian & Leverage Plays Skill

## Trigger
/contrarian

## Description
Finds low-ownership players with high upside for GPP tournaments. Identifies leverage opportunities, ownership mistakes, and tournament-winning differentiators.

## Instructions

You are an elite GPP tournament specialist. Your job is to find the plays that can win tournaments - low ownership with legitimate upside. Run through ALL analyses:

### Step 1: Get Current Slate Ownership Distribution
```sql
SELECT
  CASE
    WHEN rostership >= 25 THEN 'Chalk (25%+)'
    WHEN rostership >= 15 THEN 'Popular (15-25%)'
    WHEN rostership >= 8 THEN 'Moderate (8-15%)'
    WHEN rostership >= 3 THEN 'Low (3-8%)'
    ELSE 'Contrarian (<3%)'
  END as ownership_tier,
  COUNT(*) as players,
  ROUND(AVG(projected_points), 1) as avg_proj,
  ROUND(AVG(ceiling), 1) as avg_ceiling
FROM players
WHERE slate_id = (SELECT slate_id FROM slates ORDER BY created_at DESC LIMIT 1)
GROUP BY ownership_tier
ORDER BY AVG(rostership) DESC
```

### Step 2: GPP Plays Tool
```
Use: mcp__nba-dfs-sqlite__gpp_plays with max_rostership=10, min_ceiling=40
```

Get the built-in GPP leverage plays.

### Step 3: High Leverage Score Players
```sql
SELECT
  name, position, team, opponent, salary,
  projected_points as proj,
  ceiling,
  rostership as own_pct,
  leverage_score,
  boom_probability as boom_pct
FROM players
WHERE slate_id = (SELECT slate_id FROM slates ORDER BY created_at DESC LIMIT 1)
ORDER BY leverage_score DESC
LIMIT 15
```

**Leverage Score** = High ceiling relative to ownership. Higher = more GPP equity.

### Step 4: Ownership Mistakes - Underowned Quality
Find players with good projections but low ownership:
```sql
SELECT
  name, position, team, opponent, salary,
  projected_points as proj,
  ceiling,
  rostership as own_pct,
  ROUND(projected_points - (rostership * 2), 1) as ownership_edge
FROM players
WHERE slate_id = (SELECT slate_id FROM slates ORDER BY created_at DESC LIMIT 1)
  AND projected_points >= 30
  AND rostership < 12
ORDER BY ownership_edge DESC
LIMIT 10
```

**Ownership Edge**: Players projected much higher than their ownership suggests.

### Step 5: Ownership Mistakes - Overowned Risk
Find chalky players with downside risk:
```sql
SELECT
  name, position, team, opponent, salary,
  projected_points as proj,
  floor,
  rostership as own_pct,
  bust_probability as bust_pct,
  volatility
FROM players
WHERE slate_id = (SELECT slate_id FROM slates ORDER BY created_at DESC LIMIT 1)
  AND rostership >= 20
ORDER BY bust_probability DESC
LIMIT 10
```

**Fade Candidates**: High ownership + high bust probability = leverage fade.

### Step 6: Game Stack Leverage
Find underowned game environments:
```sql
SELECT
  p.team || ' vs ' || p.opponent as game,
  p.vegas_over_under as total,
  AVG(p.rostership) as avg_ownership,
  SUM(p.ceiling) as total_ceiling,
  COUNT(*) as players
FROM players p
WHERE p.slate_id = (SELECT slate_id FROM slates ORDER BY created_at DESC LIMIT 1)
GROUP BY p.team, p.opponent
HAVING total >= 222
ORDER BY avg_ownership ASC
LIMIT 5
```

**Contrarian Game Stacks**: High total games where the field isn't going.

### Step 7: Position Scarcity Leverage
Find positions where ownership is concentrated:
```sql
SELECT
  position,
  name,
  salary,
  rostership as own_pct,
  projected_points as proj,
  ceiling
FROM players
WHERE slate_id = (SELECT slate_id FROM slates ORDER BY created_at DESC LIMIT 1)
  AND position LIKE '%PG%'
ORDER BY rostership DESC
LIMIT 5
```

Repeat for each position. Identify where field is concentrated and find pivots.

### Step 8: Salary-Based Leverage
Find contrarian plays at each salary tier:

**Premium ($8000+)**:
```sql
SELECT name, position, team, salary, projected_points, rostership, ceiling
FROM players
WHERE slate_id = (SELECT slate_id FROM slates ORDER BY created_at DESC LIMIT 1)
  AND salary >= 8000
  AND rostership < 15
ORDER BY ceiling DESC
LIMIT 5
```

**Mid-Range ($5500-$7999)**:
```sql
SELECT name, position, team, salary, projected_points, rostership, ceiling
FROM players
WHERE slate_id = (SELECT slate_id FROM slates ORDER BY created_at DESC LIMIT 1)
  AND salary BETWEEN 5500 AND 7999
  AND rostership < 10
ORDER BY ceiling DESC
LIMIT 5
```

**Value ($4000-$5499)**:
```sql
SELECT name, position, team, salary, projected_points, rostership, ceiling
FROM players
WHERE slate_id = (SELECT slate_id FROM slates ORDER BY created_at DESC LIMIT 1)
  AND salary BETWEEN 4000 AND 5499
  AND rostership < 8
ORDER BY ceiling DESC
LIMIT 5
```

### Step 9: Historical Boom Rate Validation
For top contrarian picks, check their boom history:
```sql
SELECT
  player_name,
  COUNT(*) as games,
  ROUND(AVG(dk_fantasy_points), 1) as avg_dk,
  SUM(CASE WHEN dk_fantasy_points >= 40 THEN 1 ELSE 0 END) as boom_games,
  ROUND(SUM(CASE WHEN dk_fantasy_points >= 40 THEN 1 ELSE 0 END) * 100.0 / COUNT(*), 1) as boom_rate,
  ROUND(MAX(dk_fantasy_points), 1) as ceiling_game
FROM historical_games
WHERE player_name IN (/* top contrarian picks */)
GROUP BY player_name
```

### Step 10: Contrarian Build Template
Create a sample contrarian lineup core:
```sql
SELECT
  name, position, team, salary,
  projected_points as proj,
  rostership as own_pct,
  ceiling
FROM players
WHERE slate_id = (SELECT slate_id FROM slates ORDER BY created_at DESC LIMIT 1)
  AND rostership < 10
  AND ceiling >= 35
ORDER BY ceiling DESC
LIMIT 8
```

Show how to build a low-owned lineup with upside.

### Step 11: Leverage Summary

## Contrarian Plays by Tier

### Premium Pivots ($8000+)
| Player | Pos | Salary | Proj | Ceiling | Own% | Why Contrarian |
|--------|-----|--------|------|---------|------|----------------|
| Name | PG | $8,500 | 42 | 58 | 8% | Reason |

### Mid-Range Leverage ($5500-$8000)
| Player | Pos | Salary | Proj | Ceiling | Own% | Why Contrarian |
|--------|-----|--------|------|---------|------|----------------|
| Name | SF | $6,200 | 32 | 48 | 5% | Reason |

### Value Differentiators ($4000-$5500)
| Player | Pos | Salary | Proj | Ceiling | Own% | Why Contrarian |
|--------|-----|--------|------|---------|------|----------------|
| Name | PF | $4,800 | 25 | 40 | 3% | Reason |

### Chalk Fades (Overowned)
| Player | Pos | Salary | Own% | Risk Factor |
|--------|-----|--------|------|-------------|
| Name | C | $9,200 | 28% | High bust%, tough matchup |

## Output Format

End with:

```
## Quick Hits

**#1 Leverage Play**: [Player] ($X,XXX, X% owned)
- Ceiling: XX | Boom scenario: [what needs to happen]

**#2 Leverage Play**: [Player] ($X,XXX, X% owned)
- Ceiling: XX | Boom scenario: [what needs to happen]

**Premium Pivot**: [Player] over [Chalk Player]
- Why: [1 sentence]

**Value Pivot**: [Player] over [Popular Value]
- Why: [1 sentence]

**Game Stack Pivot**: [Underowned Game] instead of [Chalk Game]

**Ownership Fade**: [Player] at X% owned
- Risk: [why to fade]

**Lineup Uniqueness Target**: <X% total ownership for GPP upside
```

## Critical Rules
1. Focus on CEILING not projection for GPP
2. Boom probability matters more than floor
3. Find leverage at EVERY salary tier
4. Identify chalk to fade, not just plays to make
5. Historical boom rate validates contrarian picks
6. Game-level leverage (underowned stacks) is huge
7. Calculate total lineup ownership for uniqueness gauge
