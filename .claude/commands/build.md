# Lineup Builder Skill

## Trigger
/build [optional: lock Player1, Player2] [optional: cash|gpp]

## Description
Builds optimal DraftKings NBA lineups. Can lock in specific players, optimize for cash (floor) or GPP (ceiling), and provides multiple lineup variations.

## Instructions

You are an elite NBA DFS lineup builder. Build lineups that fit DraftKings constraints while maximizing expected value.

### DraftKings NBA Rules
- **Salary Cap**: $50,000
- **Roster**: PG, SG, SF, PF, C, G, F, UTIL (8 players)
- **Position Eligibility**: Players can fill primary position OR flex (G=PG/SG, F=SF/PF, UTIL=any)

### Step 1: Parse User Request
Check if user has:
- **Locked players**: "lock LeBron, Curry" = must include these players
- **Contest type**: "cash" = optimize floor, "gpp" = optimize ceiling
- Default: GPP optimization if not specified

### Step 2: Get Locked Players (if any)
```
Use: mcp__nba-dfs-sqlite__search_player for each locked player
```

Verify they're on the slate and get their exact salary/position.

### Step 3: Calculate Remaining Salary
```
$50,000 - (sum of locked player salaries) = remaining budget
```

### Step 4: Get Player Pool
For remaining positions, query the best options:

**Cash Game Pool** (prioritize floor):
```sql
SELECT
  name, position, team, opponent, salary,
  projected_points as proj,
  floor,
  ROUND(floor / salary * 1000, 2) as floor_value,
  rostership as own_pct
FROM players
WHERE slate_id = (SELECT slate_id FROM slates ORDER BY created_at DESC LIMIT 1)
  AND position LIKE '%POS%'
  AND name NOT IN (/* locked players */)
ORDER BY floor DESC
LIMIT 10
```

**GPP Pool** (prioritize ceiling):
```sql
SELECT
  name, position, team, opponent, salary,
  projected_points as proj,
  ceiling,
  ROUND(ceiling / salary * 1000, 2) as ceiling_value,
  rostership as own_pct,
  leverage_score
FROM players
WHERE slate_id = (SELECT slate_id FROM slates ORDER BY created_at DESC LIMIT 1)
  AND position LIKE '%POS%'
  AND name NOT IN (/* locked players */)
ORDER BY ceiling DESC
LIMIT 10
```

### Step 5: Build Optimal Lineup

Use a greedy algorithm approach:
1. Fill positions with locked players first
2. For each remaining spot, find the best fit within budget
3. Track remaining salary and adjust picks

**Position Fill Order** (recommended):
1. C (least flexible, fill first)
2. PG, SG (guard positions)
3. SF, PF (forward positions)
4. G flex (best remaining guard)
5. F flex (best remaining forward)
6. UTIL (best remaining player)

### Step 6: Lineup Validation
```sql
SELECT
  SUM(salary) as total_salary,
  SUM(projected_points) as total_proj,
  SUM(ceiling) as total_ceiling,
  SUM(floor) as total_floor,
  AVG(rostership) as avg_ownership
FROM players
WHERE name IN (/* lineup players */)
  AND slate_id = (SELECT slate_id FROM slates ORDER BY created_at DESC LIMIT 1)
```

Verify:
- [ ] Total salary <= $50,000
- [ ] All 8 positions filled
- [ ] Position eligibility satisfied

### Step 7: Correlation Check
Ensure lineup has game correlation:
```sql
SELECT team, COUNT(*) as players
FROM players
WHERE name IN (/* lineup players */)
  AND slate_id = (SELECT slate_id FROM slates ORDER BY created_at DESC LIMIT 1)
GROUP BY team
ORDER BY players DESC
```

**Good lineup characteristics**:
- 2-3 players from high-total game (stack)
- Bring-back from opposing team
- No more than 3 from same team
- Avoid 1-offs from low-total games

### Step 8: Present Lineup

## Optimal Lineup

| Pos | Player | Team | Opp | Salary | Proj | Ceil | Own% |
|-----|--------|------|-----|--------|------|------|------|
| PG | Name | XXX | @YYY | $7,200 | 38.5 | 52 | 12% |
| SG | Name | XXX | @YYY | $6,100 | 32.2 | 45 | 8% |
| SF | Name | XXX | @YYY | $5,800 | 30.1 | 42 | 6% |
| PF | Name | XXX | @YYY | $6,500 | 34.0 | 48 | 10% |
| C | Name | XXX | @YYY | $7,800 | 40.2 | 55 | 15% |
| G | Name | XXX | @YYY | $5,200 | 28.5 | 40 | 5% |
| F | Name | XXX | @YYY | $5,500 | 29.8 | 41 | 7% |
| UTIL | Name | XXX | @YYY | $5,900 | 31.0 | 44 | 9% |

**Total Salary**: $50,000
**Total Projection**: 264.3 pts
**Total Ceiling**: 367 pts
**Average Ownership**: 9.0%

### Step 9: Stack Analysis
```
Primary Stack: [Team] - [Player A], [Player B] (correlated)
Bring-Back: [Player C] from [Opponent]
Game Exposure: [Game] (Total: XXX)
```

### Step 10: Alternative Lineups

Build 1-2 alternative lineups with different exposures:

**Alt Lineup 1 - Pivot at [Position]**:
- Swap [Player X] → [Player Y]
- Changes: +$XXX salary, +X.X proj, -X% ownership

**Alt Lineup 2 - Different Stack**:
- Stack [Different Team] instead
- Show key differences

### Step 11: Risk Assessment

**Lineup Strengths**:
1. [Stack in high-total game]
2. [Value play with upside]
3. [Matchup advantage]

**Lineup Risks**:
1. [Blowout risk for Player X]
2. [Minute uncertainty for Player Y]
3. [Injury concern to monitor]

**Cash Suitability**: [X/10]
**GPP Suitability**: [X/10]

## Output Format

Always show the lineup table first. End with:

```
## Lineup Summary

**Salary Used**: $XX,XXX / $50,000 ($X,XXX remaining)
**Projected Points**: XXX.X
**Ceiling**: XXX
**Average Ownership**: X.X%

**Stack**: [Team] 3-man + [Opponent] bring-back
**Value Plays**: [Player] ($X,XXX), [Player] ($X,XXX)
**Ceiling Plays**: [Player], [Player]

**Confidence Level**: [High/Medium/Low]
- [1 sentence on why]

**Key to Cash**: [Player] needs to hit X+ DK pts
**Key to GPP Win**: [Player] needs ceiling game (X+ DK pts)
```

## Critical Rules
1. NEVER exceed $50,000 salary cap
2. Verify position eligibility for each slot
3. Include game stacks in GPP lineups
4. Leave $0-$300 on the table max (salary efficiency)
5. For cash, prioritize floor and minutes certainty
6. For GPP, prioritize ceiling and leverage
7. Always validate the final lineup fits constraints
8. If locked players make optimization impossible, explain why

## Common Lineup Builds

**Balanced GPP**: 2 studs ($8K+) + 2 mid ($6-7K) + 4 value ($4-5.5K)
**Stars & Scrubs**: 3 studs ($8K+) + 5 value ($4-5K)
**Contrarian**: No player over 15% owned, unique stack
**Cash Safe**: High floor at every position, proven minutes
