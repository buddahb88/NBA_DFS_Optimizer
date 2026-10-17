# Injuries & Usage Bumps Skill

## Trigger
/injuries

## Description
Identifies players who are OUT for tonight's slate and finds the teammates who benefit most from their absence. Uses historical data to quantify usage bumps and projection adjustments.

## Instructions

You are an elite NBA DFS injury impact analyst. Run through ALL of the following analyses:

### Step 1: Get Current Slate Teams
```sql
SELECT DISTINCT team, opponent
FROM players
WHERE slate_id = (SELECT slate_id FROM slates ORDER BY created_at DESC LIMIT 1)
ORDER BY team
```

List all teams playing tonight.

### Step 2: Identify Missing Players
Compare historical regulars to current slate to find who's OUT:
```sql
SELECT
  h.team,
  h.player_name,
  COUNT(*) as games_played,
  ROUND(AVG(h.dk_fantasy_points), 1) as avg_dk,
  ROUND(AVG(h.minutes), 1) as avg_min,
  ROUND(AVG(h.usg_pct), 1) as avg_usg
FROM historical_games h
LEFT JOIN players p ON LOWER(TRIM(h.player_name)) = LOWER(TRIM(p.name))
  AND p.slate_id = (SELECT slate_id FROM slates ORDER BY created_at DESC LIMIT 1)
WHERE h.team IN (SELECT DISTINCT team FROM players WHERE slate_id = (SELECT slate_id FROM slates ORDER BY created_at DESC LIMIT 1))
  AND p.name IS NULL
  AND h.minutes >= 15
GROUP BY h.team, h.player_name
HAVING games_played >= 5 AND avg_dk >= 15
ORDER BY h.team, avg_dk DESC
```

**Key Output**: Players with significant minutes who are NOT on tonight's slate = OUT/Injured

### Step 3: Categorize Missing Players by Impact

**STAR OUT** (30+ avg DK pts): Massive usage redistribution
**STARTER OUT** (20-30 avg DK pts): Significant bump for backups
**ROTATION OUT** (15-20 avg DK pts): Moderate boost for depth

### Step 4: Find Usage Bump Beneficiaries
For each team with a notable absence, identify who benefits:
```sql
SELECT
  p.name, p.position, p.team, p.salary,
  p.projected_points as proj,
  ROUND(p.projected_points / p.salary * 1000, 2) as value,
  p.rostership as own_pct,
  p.ceiling
FROM players p
WHERE p.slate_id = (SELECT slate_id FROM slates ORDER BY created_at DESC LIMIT 1)
  AND p.team = 'XXX'  -- team with injury
ORDER BY p.salary DESC
LIMIT 8
```

### Step 5: Historical Usage Without Teammate
For key beneficiaries, check their stats when the injured player was OUT:
```sql
SELECT
  h1.player_name as beneficiary,
  COUNT(*) as games_without,
  ROUND(AVG(h1.dk_fantasy_points), 1) as avg_dk_without,
  ROUND(AVG(h1.minutes), 1) as avg_min_without,
  ROUND(AVG(h1.usg_pct), 1) as avg_usg_without
FROM historical_games h1
WHERE h1.team = 'XXX'
  AND h1.player_name IN (/* current slate players */)
  AND h1.game_date NOT IN (
    SELECT game_date FROM historical_games
    WHERE player_name = 'INJURED_PLAYER'
  )
GROUP BY h1.player_name
ORDER BY avg_dk_without DESC
```

Compare to their overall averages to quantify the bump.

### Step 6: Position-Specific Impact
Analyze which positions benefit most from the absence:
```sql
SELECT
  p.position,
  p.name,
  p.salary,
  p.projected_points as current_proj,
  p.ceiling,
  p.rostership as own_pct
FROM players p
WHERE p.slate_id = (SELECT slate_id FROM slates ORDER BY created_at DESC LIMIT 1)
  AND p.team = 'XXX'
  AND p.position LIKE '%POS%'  -- same position as injured player
ORDER BY p.salary DESC
```

**Direct Replacement**: Same position player who slides into starting role
**Usage Beneficiary**: Ball handlers who get more touches
**Minute Beneficiary**: Deep bench who gets rotation minutes

### Step 7: Injury Status Check
Check players ON the slate with injury designations:
```sql
SELECT
  name, position, team, salary,
  injury_status,
  projected_points as proj,
  rostership as own_pct
FROM players
WHERE slate_id = (SELECT slate_id FROM slates ORDER BY created_at DESC LIMIT 1)
  AND injury_status IS NOT NULL
  AND injury_status != ''
ORDER BY salary DESC
```

Flag any questionable/probable players who could be late scratches.

### Step 8: Usage Bump Value Plays
Find the best value from injury situations:
```sql
SELECT
  p.name, p.position, p.team, p.opponent, p.salary,
  p.projected_points as proj,
  ROUND(p.projected_points / p.salary * 1000, 2) as value,
  p.rostership as own_pct,
  p.ceiling
FROM players p
WHERE p.slate_id = (SELECT slate_id FROM slates ORDER BY created_at DESC LIMIT 1)
  AND p.team IN (/* teams with injuries */)
  AND p.salary < 6000
ORDER BY value DESC
LIMIT 10
```

### Step 9: Injury Impact Summary

For each team with significant absences:

## [TEAM] Injury Report

**OUT**: [Player Name] (XX.X avg DK, XX.X min, XX.X% USG)

| Beneficiary | Position | Salary | Proj | Ceiling | Own% | Bump Type |
|-------------|----------|--------|------|---------|------|-----------|
| Player A | PG | $6,200 | 32 | 48 | 8% | Primary Usage |
| Player B | SF | $4,800 | 25 | 38 | 4% | Direct Replace |
| Player C | C | $5,500 | 28 | 42 | 6% | Minutes Boost |

**Historical Data**: When [OUT Player] missed, [Beneficiary] averaged XX.X DK pts (+X.X bump)

### Step 10: Late News Monitoring Flags
Identify situations to monitor:
```sql
SELECT
  name, position, team, salary, injury_status
FROM players
WHERE slate_id = (SELECT slate_id FROM slates ORDER BY created_at DESC LIMIT 1)
  AND (injury_status LIKE '%Questionable%'
       OR injury_status LIKE '%Doubtful%'
       OR injury_status LIKE '%GTD%')
ORDER BY salary DESC
```

List players who could become late scratches and their backup options.

## Output Format

Present team-by-team injury impact. End with:

```
## Quick Hits

**Smash Usage Bumps** (star out, clear beneficiary):
1. [Player] ($X,XXX) - [Who's out], [expected bump]
2. [Player] ($X,XXX) - [Who's out], [expected bump]

**Value Unlocks** (cheap player getting minutes):
1. [Player] ($X,XXX) - [X% owned], steps into rotation
2. [Player] ($X,XXX) - [X% owned], primary backup

**Monitor for News**:
- [Questionable Player] - If OUT, [Beneficiary] becomes smash
- [GTD Player] - Check 30 min before lock

**Teams with Clean Health**: [List teams with no notable injuries]
```

## Critical Rules
1. Compare historical data to current slate to find who's missing
2. Quantify the bump with actual historical data when player was out
3. Distinguish between usage bump vs minutes bump
4. Flag late news risks (Questionable/GTD players)
5. Note ownership - injury news often underpriced by projections
6. Check both the injured player's team AND their opponent for impacts
