# Matchups & DVP Analysis Skill

## Trigger
/matchups

## Description
Matchup analysis for the current slate using `team_archetype_defense`: how each defense performs against each player archetype (and each G/F/C position) relative to what those players normally score. This is the same data the projections' DVP adjustment uses. Identifies smash spots, fades, pace-up spots and low-owned matchup leverage.

## How to read the data

- `team_archetype_defense.team` is the **defending** team (match it to `players.opponent`).
- `fp_over_expectation` = fantasy points per player-game the defense allows **above (+) or below (-)** what those players normally score. Already shrunk toward 0 by sample size (`games`).
  - **+1.5 or more** = soft spot, **-1.5 or less** = tough. Compare within an archetype.
  - `pts_delta`, `reb_delta`, `ast_delta`, `fg3m_delta`, `stocks_delta` break it down by stat (real stats, not fantasy points).
- Always filter `season`, `site` and `group_by` (`'archetype'` or `'position'`).
- Players reach their archetype through `player_season_profiles` (by name) → `player_archetypes` (same season).
- `team_defense_vs_position` / `players.dvp_pts_allowed` are the legacy HashtagBasketball numbers: **real points** allowed to a position (about 18-28), not fantasy points. Use them only as a secondary check.

## Instructions

You are an elite NBA DFS matchup analyst. Run through ALL of the following analyses.

### Step 1: Get Current Slate
```
Use: mcp__nba-dfs-sqlite__get_current_slate
```
Confirm the slate and games available.

### Step 2: Pick the Season and Site
Early in a season the current season's defense numbers are too thin. Use the latest season where 20+ defenses have 10+ games, and the slate's site:
```sql
SELECT
  (SELECT season FROM team_archetype_defense
   WHERE group_by = 'position' AND games >= 10
     AND site = (SELECT site FROM slates ORDER BY created_at DESC LIMIT 1)
   GROUP BY season HAVING COUNT(DISTINCT team) >= 20
   ORDER BY season DESC LIMIT 1) AS season,
  (SELECT site FROM slates ORDER BY created_at DESC LIMIT 1) AS site
```
**Use the returned season and site in every query below** (they are written as `'2025-26'` and `'draftkings'` here). Tell the user which season the matchup numbers come from.

### Step 3: Archetype Defense Board for Tonight's Opponents
```sql
SELECT
  d.group_key AS archetype,
  d.team AS defense,
  d.games,
  ROUND(d.fp_over_expectation, 2) AS fp_over_exp,
  ROUND(d.pts_delta, 2) AS pts_delta,
  ROUND(d.reb_delta, 2) AS reb_delta,
  ROUND(d.ast_delta, 2) AS ast_delta
FROM team_archetype_defense d
WHERE d.season = '2025-26' AND d.site = 'draftkings' AND d.group_by = 'archetype'
  AND d.team IN (SELECT DISTINCT opponent FROM players
                 WHERE slate_id = (SELECT slate_id FROM slates ORDER BY created_at DESC LIMIT 1))
ORDER BY d.group_key, d.fp_over_expectation DESC
```

Present one table per archetype that matters tonight showing the softest and toughest defenses on the slate.

### Step 4: Tonight's Best Matchups
```sql
SELECT
  p.name, p.position, p.team, p.opponent, p.salary,
  p.projected_points AS proj,
  ROUND(p.projected_points / p.salary * 1000, 2) AS value,
  p.rostership AS own_pct,
  a.archetype,
  ROUND(d.fp_over_expectation, 2) AS fp_over_exp,
  d.games
FROM players p
JOIN player_season_profiles sp ON (sp.player_key = LOWER(p.name) OR sp.player_name = p.name)
JOIN player_archetypes a ON a.player_key = sp.player_key AND a.season = sp.season
JOIN team_archetype_defense d ON d.team = p.opponent AND d.season = a.season
  AND d.site = 'draftkings' AND d.group_by = 'archetype' AND d.group_key = a.archetype
WHERE p.slate_id = (SELECT slate_id FROM slates ORDER BY created_at DESC LIMIT 1)
  AND d.season = '2025-26'
  AND (p.injury_status IS NULL OR p.injury_status = '')
  AND d.fp_over_expectation >= 1
ORDER BY d.fp_over_expectation DESC, p.projected_points DESC
LIMIT 20
```

Players with no profile (rookies, name mismatches) drop out of this join. Mention any notable ones from Step 8.

### Step 5: Tonight's Worst Matchups (Fades)
```sql
SELECT
  p.name, p.position, p.team, p.opponent, p.salary,
  p.projected_points AS proj,
  p.rostership AS own_pct,
  a.archetype,
  ROUND(d.fp_over_expectation, 2) AS fp_over_exp,
  d.games
FROM players p
JOIN player_season_profiles sp ON (sp.player_key = LOWER(p.name) OR sp.player_name = p.name)
JOIN player_archetypes a ON a.player_key = sp.player_key AND a.season = sp.season
JOIN team_archetype_defense d ON d.team = p.opponent AND d.season = a.season
  AND d.site = 'draftkings' AND d.group_by = 'archetype' AND d.group_key = a.archetype
WHERE p.slate_id = (SELECT slate_id FROM slates ORDER BY created_at DESC LIMIT 1)
  AND d.season = '2025-26'
  AND (p.injury_status IS NULL OR p.injury_status = '')
  AND d.fp_over_expectation <= -1
ORDER BY p.rostership DESC
LIMIT 15
```

**Flag high-owned players in tough matchups** - potential leverage fades.

### Step 6: Pace-Adjusted Opportunities
Combine pace with archetype defense for the best matchup spots:
```sql
SELECT
  p.name, p.position, p.team, p.opponent, p.salary,
  p.projected_points AS proj,
  tdr.pace AS opp_pace,
  tdr.def_eff AS opp_def_eff,
  a.archetype,
  ROUND(d.fp_over_expectation, 2) AS fp_over_exp
FROM players p
JOIN team_defense_rankings tdr ON p.opponent = tdr.team
JOIN player_season_profiles sp ON (sp.player_key = LOWER(p.name) OR sp.player_name = p.name)
JOIN player_archetypes a ON a.player_key = sp.player_key AND a.season = sp.season
JOIN team_archetype_defense d ON d.team = p.opponent AND d.season = a.season
  AND d.site = 'draftkings' AND d.group_by = 'archetype' AND d.group_key = a.archetype
WHERE p.slate_id = (SELECT slate_id FROM slates ORDER BY created_at DESC LIMIT 1)
  AND d.season = '2025-26'
  AND tdr.pace >= 100
  AND d.fp_over_expectation >= 0.5
ORDER BY tdr.pace DESC, d.fp_over_expectation DESC
LIMIT 15
```

**PACE UP + SOFT ARCHETYPE DEFENSE = SMASH SPOT**

### Step 7: Team Defense Overview
Overall defense and pace for tonight's opponents:
```sql
SELECT
  tdr.team,
  tdr.pace,
  tdr.def_eff
FROM team_defense_rankings tdr
WHERE tdr.team IN (SELECT DISTINCT opponent FROM players
                   WHERE slate_id = (SELECT slate_id FROM slates ORDER BY created_at DESC LIMIT 1))
ORDER BY tdr.def_eff DESC
```

Highlight teams that are:
- **Pace Up**: pace 100+
- **Bad Defense**: def_eff 116+

### Step 8: G/F/C DvP (In-House)
Position view from the same table (ESPN positions are G / F / C, so this is 3-bucket DvP). Also covers players with no archetype:
```sql
SELECT
  p.name, p.position, p.team, p.opponent, p.salary,
  p.projected_points AS proj,
  d.group_key AS dvp_bucket,
  ROUND(d.fp_over_expectation, 2) AS fp_over_exp,
  d.games
FROM players p
JOIN team_archetype_defense d ON d.team = p.opponent
  AND d.season = '2025-26' AND d.site = 'draftkings' AND d.group_by = 'position'
  AND d.group_key = CASE
    WHEN p.position LIKE 'PG%' OR p.position LIKE 'SG%' OR p.position LIKE 'G%' THEN 'G'
    WHEN p.position LIKE 'SF%' OR p.position LIKE 'PF%' OR p.position LIKE 'F%' THEN 'F'
    WHEN p.position LIKE 'C%' THEN 'C'
  END
WHERE p.slate_id = (SELECT slate_id FROM slates ORDER BY created_at DESC LIMIT 1)
  AND (p.injury_status IS NULL OR p.injury_status = '')
ORDER BY d.fp_over_expectation DESC, p.projected_points DESC
LIMIT 20
```

### Step 9: Historical Validation
For tonight's players, check how they have done against tonight's opponent:
```sql
SELECT
  p.name,
  h.opponent,
  COUNT(*) AS games_vs,
  ROUND(AVG(h.dk_fantasy_points), 1) AS avg_dk_vs_opp,
  ROUND(MAX(h.dk_fantasy_points), 1) AS best_game,
  ROUND(MIN(h.dk_fantasy_points), 1) AS worst_game
FROM players p
JOIN historical_games h ON (h.player_key = LOWER(p.name) OR h.player_name = p.name)
  AND h.opponent = p.opponent
WHERE p.slate_id = (SELECT slate_id FROM slates ORDER BY created_at DESC LIMIT 1)
  AND h.minutes > 0
GROUP BY p.name, h.opponent
HAVING COUNT(*) >= 2
ORDER BY avg_dk_vs_opp DESC
LIMIT 25
```

Use `fd_fantasy_points` / `yahoo_fantasy_points` on other sites. Head-to-head samples are small - treat them as a tiebreaker, not a signal on their own.

### Step 10: Leverage Matchup Plays
Good matchups with low ownership (GPP gold):
```sql
SELECT
  p.name, p.position, p.team, p.opponent, p.salary,
  p.projected_points AS proj,
  p.rostership AS own_pct,
  p.ceiling,
  a.archetype,
  ROUND(d.fp_over_expectation, 2) AS fp_over_exp
FROM players p
JOIN player_season_profiles sp ON (sp.player_key = LOWER(p.name) OR sp.player_name = p.name)
JOIN player_archetypes a ON a.player_key = sp.player_key AND a.season = sp.season
JOIN team_archetype_defense d ON d.team = p.opponent AND d.season = a.season
  AND d.site = 'draftkings' AND d.group_by = 'archetype' AND d.group_key = a.archetype
WHERE p.slate_id = (SELECT slate_id FROM slates ORDER BY created_at DESC LIMIT 1)
  AND d.season = '2025-26'
  AND d.fp_over_expectation >= 0.5
  AND p.rostership < 10
ORDER BY p.ceiling DESC
LIMIT 10
```

### Step 11: Matchup Summary

Provide archetype-by-archetype recommendations:

## Matchup Summary by Archetype

| Archetype | Softest Defense Tonight | Toughest Defense Tonight | Top Play |
|-----------|-------------------------|--------------------------|----------|
| primary_creator | XXX (+2.1) | XXX (-1.8) | Player Name |
| rim_running_big | XXX (+1.6) | XXX (-2.0) | Player Name |
| ... | ... | ... | ... |

## Output Format

Use tables and clear headers. End with:

```
## Quick Hits

**SMASH Matchups** (Pace + archetype defense aligned):
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
2. Show `fp_over_exp` with its sample (`games`) and say which season it comes from
3. Cross-reference pace with archetype defense for true smash spots
4. Flag high-owned players in bad matchups as fades
5. Identify low-owned players in good matchups for GPP
6. Never describe `pts_allowed` / `dvp_pts_allowed` as fantasy points - they are real points
