import fetch from 'node-fetch';
import teamDefenseModel from '../models/teamDefenseModel.js';
import teamDefenseVsPositionModel from '../models/teamDefenseVsPositionModel.js';
import { normalizeForRankings, normalizeForVsPosition } from '../utils/teamMapping.js';

class RotowireService {
  constructor() {
    this.baseUrl = 'https://www.rotowire.com/daily/nba/api';
    this.cookie = process.env.ROTOWIRE_COOKIE || '';
    this.defenseRankings = null;
    this.positionDefenseData = null;
  }

  loadDefenseRankings() {
    if (!this.defenseRankings) {
      const rankings = teamDefenseModel.getAll();
      this.defenseRankings = {};
      for (const team of rankings) {
        this.defenseRankings[team.team] = team;
      }
    }
    return this.defenseRankings;
  }

  loadPositionDefenseData() {
    if (!this.positionDefenseData) {
      const allData = teamDefenseVsPositionModel.getAll();
      this.positionDefenseData = {};
      for (const data of allData) {
        const key = `${data.team}_${data.position}`;
        this.positionDefenseData[key] = data;
      }
    }
    return this.positionDefenseData;
  }

  getPrimaryPosition(positionString) {
    // Handle multi-position eligibility (e.g., "PG,SG" → "PG")
    // Use the FIRST position as primary (most likely their actual position)
    if (!positionString) return null;

    const positions = positionString.split(',').map(p => p.trim());
    return positions[0]; // Return first position
  }

  getDefenseAdjustment(opponentTeam) {
    // ADDITIVE MODEL: Returns fantasy point adjustment (not multiplier)
    const rankings = this.loadDefenseRankings();
    const normalizedTeam = normalizeForRankings(opponentTeam);
    const oppDefense = rankings[normalizedTeam];

    if (!oppDefense) {
      return 0; // No data, no adjustment
    }

    // League average DEF EFF is around 113.0
    // Lower DEF EFF = better defense = negative FP adjustment (harder)
    // Higher DEF EFF = worse defense = positive FP adjustment (easier)
    const leagueAvg = 113.0;
    const defEff = oppDefense.def_eff;
    const diff = defEff - leagueAvg;

    // 0.30 FP per DEF EFF point from league average
    // Example: WAS (123.4) = +10.4 DEF EFF × 0.30 = +3.1 FP
    // Example: OKC (102.6) = -10.4 DEF EFF × 0.30 = -3.1 FP
    return diff * 0.30;
  }

  getPaceAdjustment(opponentTeam) {
    // ADDITIVE MODEL: Returns fantasy point adjustment (not multiplier)
    const rankings = this.loadDefenseRankings();
    const normalizedTeam = normalizeForRankings(opponentTeam);
    const oppStats = rankings[normalizedTeam];

    if (!oppStats || !oppStats.pace) {
      return 0;
    }

    // League average pace is around 100.0 possessions per game
    // Higher pace = more possessions = more fantasy opportunities
    const leagueAvgPace = 100.0;
    const pace = oppStats.pace;
    const diff = pace - leagueAvgPace;

    // 0.25 FP per pace point from league average
    // Example: Fast pace (104) = +4 pace × 0.25 = +1.0 FP
    // Example: Slow pace (96) = -4 pace × 0.25 = -1.0 FP
    return diff * 0.25;
  }

  getPositionDefenseAdjustment(opponentTeam, playerPosition) {
    // ADDITIVE MODEL: Returns fantasy point adjustment (not multiplier)
    const primaryPosition = this.getPrimaryPosition(playerPosition);
    if (!primaryPosition) {
      return 0; // No position data
    }

    const normalizedTeam = normalizeForVsPosition(opponentTeam);
    const positionData = this.loadPositionDefenseData();
    const key = `${normalizedTeam}_${primaryPosition}`;
    const defenseVsPos = positionData[key];

    if (!defenseVsPos) {
      return 0; // No data, no adjustment
    }

    // Rankings are 1-150 (30 teams × 5 positions)
    // Lower rank = better defense (harder matchup) = negative FP
    // Higher rank = worse defense (easier matchup) = positive FP
    const rank = defenseVsPos.rank;
    const avgRank = 75; // Middle of 1-150
    const diff = rank - avgRank;

    // 0.04 FP per rank from average
    // Example: Rank 140 (weak) = +65 ranks × 0.04 = +2.6 FP
    // Example: Rank 10 (elite) = -65 ranks × 0.04 = -2.6 FP
    return diff * 0.04;
  }

  getVegasAdjustment(vegasImpliedTotal) {
    // ADDITIVE MODEL: Returns fantasy point adjustment based on vegas implied total
    if (!vegasImpliedTotal || vegasImpliedTotal === 0) {
      return 0;
    }

    // League average implied team total is around 110 points
    // Higher implied total = more expected scoring = more fantasy opportunities
    const leagueAvg = 110.0;
    const diff = vegasImpliedTotal - leagueAvg;

    // 0.15 FP per point of implied total above/below average
    // Example: 115 implied total = +5 × 0.15 = +0.75 FP
    // Example: 105 implied total = -5 × 0.15 = -0.75 FP
    return diff * 0.15;
  }

  getFavoriteAdjustment(vegasSpread) {
    // ADDITIVE MODEL: Returns fantasy point adjustment based on spread
    if (vegasSpread === 0 || vegasSpread == null) {
      return 0;
    }

    // Negative spread = favorite (expected to win)
    // Positive spread = underdog (expected to lose)
    if (vegasSpread < -5) {
      return +1.5; // Big favorite: More scoring opportunities, starters play full game
    } else if (vegasSpread > 5) {
      return -1.5; // Big underdog: Garbage time risk, may rest starters
    }

    return 0; // Close game, no adjustment
  }

  getRestAdjustment(restDays) {
    // ADDITIVE MODEL: Returns fantasy point adjustment based on days of rest
    if (!restDays || restDays < 0) {
      return 0;
    }

    // Rest impact on performance:
    // 0 days = back-to-back (fatigue, reduced minutes, lower efficiency)
    // 1 day = normal rest (standard performance)
    // 2 days = good rest (slightly elevated performance)
    // 3+ days = extended rest (well-rested but possible rust)

    if (restDays === 0) {
      return -2.5; // Back-to-back: significant negative impact
    } else if (restDays === 1) {
      return 0; // Normal rest: baseline (no adjustment)
    } else if (restDays === 2) {
      return +1.0; // Extra day of rest: slight boost
    } else if (restDays === 3) {
      return +1.5; // Good rest: noticeable boost
    } else if (restDays >= 4) {
      return +0.5; // Extended rest: minimal boost (possible rust)
    }

    return 0;
  }

  getMinutesAdjustment(projectedMinutes, seasonMinutes, recentFormBase) {
    // ADDITIVE MODEL: Returns fantasy point adjustment for minutes change
    // Only adjust if minutes differ significantly from season average

    if (!projectedMinutes || !seasonMinutes || seasonMinutes === 0) {
      return 0;
    }

    // CRITICAL FIX: Don't extrapolate for players with very low season minutes
    // Deep bench players (< 10 mpg) have unreliable per-minute rates due to:
    // - Small sample size (1-2 garbage time games skew the average)
    // - Inflated efficiency in limited minutes that won't scale
    // - No reliable baseline to project from
    if (seasonMinutes < 10) {
      console.log(`⚠️  Skipping minutes adjustment for low-minute player (${seasonMinutes.toFixed(1)} mpg baseline)`);
      return 0;
    }

    const minutesDiff = projectedMinutes - seasonMinutes;

    // Only adjust if difference is 3+ minutes (significant change)
    if (Math.abs(minutesDiff) < 3) {
      return 0;
    }

    // Calculate player's fantasy points per minute rate from recent form
    const fptsPerMinute = recentFormBase / seasonMinutes;

    // Apply 70% efficiency for extra/reduced minutes
    // Why 70%? Diminishing returns due to:
    // - Fatigue for extra minutes
    // - Reduced role if minutes are cut
    // - Possible garbage time
    const minutesAdj = minutesDiff * fptsPerMinute * 0.70;

    return minutesAdj;
  }

  async fetchPlayers(slateId) {
    try {
      const url = `${this.baseUrl}/players.php?slateID=${slateId}`;
      console.log(`🌐 Fetching from RotoWire: ${url}`);

      const response = await fetch(url, {
        headers: {
          'accept': 'application/json, text/plain, */*',
          'accept-language': 'en-US,en;q=0.9',
          'priority': 'u=1, i',
          'sec-ch-ua': '"Google Chrome";v="141", "Not?A_Brand";v="8", "Chromium";v="141"',
          'sec-ch-ua-mobile': '?0',
          'sec-ch-ua-platform': '"Windows"',
          'sec-fetch-dest': 'empty',
          'sec-fetch-mode': 'cors',
          'sec-fetch-site': 'same-origin',
          'cookie': this.cookie,
          'Referer': 'https://www.rotowire.com/daily/nba/optimizer.php'
        },
        method: 'GET'
      });

      console.log(`📡 RotoWire Response: ${response.status} ${response.statusText}`);

      if (!response.ok) {
        // Get response body for debugging
        const errorBody = await response.text();
        console.error(`❌ RotoWire Error Body:`, errorBody.substring(0, 500));
        throw new Error(`RotoWire API error: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();
      return this.transformPlayerData(data);
    } catch (error) {
      console.error('Error fetching RotoWire data:', error);
      throw error;
    }
  }

  transformPlayerData(data) {
    // Transform RotoWire response to our format
    // This will need to be adjusted based on the actual API response structure
    if (!data || !Array.isArray(data)) {
      return [];
    }

    return data
      .map((player) => {
      // derive safe primitive values
      // helper to convert possible object/array values to a readable string
      const stringifyField = (val) => {
        if (val == null) return null;
        if (typeof val === 'string') return val;
        if (typeof val === 'number' || typeof val === 'bigint') return String(val);
        if (typeof val === 'object') {
          // try common fields
          const candidates = [
            'abbr', 'abbrev', 'abbreviation', 'code', 'id', 'name', 'displayName', 'fullName', 'shortName', 'team'
          ];
          for (const key of candidates) {
            if (val[key] != null) return String(val[key]);
          }
          // fallback to join values if it's a simple object
          return JSON.stringify(val);
        }
        return String(val);
      };

      // prefer rotowire specific fields (rwID, firstName/lastName, pos array, team.abbr, opponent.team)
      const playerId = String(player.rwID ?? player.rwid ?? player.id ?? player.player_id ?? player.pid ?? '');
      const nameRaw = player.name ?? `${player.firstName ?? player.first_name ?? ''} ${player.lastName ?? player.last_name ?? ''}`;
      const name = nameRaw ? stringifyField(nameRaw).trim() : null;

      // team: prefer object.abbr or string
      let team = null;
      if (player.team) {
        if (typeof player.team === 'object') team = stringifyField(player.team.abbr ?? player.team.code ?? player.team.name ?? player.team.team ?? player.team);
        else team = stringifyField(player.team);
      } else if (player.teamLink) {
        team = stringifyField(player.teamLink);
      }

      // opponent
      let opponent = null;
      if (player.opponent && typeof player.opponent === 'object') opponent = stringifyField(player.opponent.team ?? player.opponent.abbr ?? player.opponent.name);
      else opponent = stringifyField(player.opp ?? player.opponent ?? player.opponentTeam ?? player.opponent?.team);

      // position: handle array or string
      let position = null;
      if (Array.isArray(player.pos)) position = player.pos.join(',');
      else if (Array.isArray(player.position)) position = player.position.join(',');
      else position = stringifyField(player.rotoPos ?? player.roto_pos ?? player.position ?? player.pos ?? player.positionType);
      const salary = Number.isFinite(Number(player.salary)) ? Number(player.salary) : 0;

      // Extract recent form (avgFpts)
      const fptsLast3 = parseFloat(player.stats?.avgFpts?.last3) || 0;
      const fptsLast5 = parseFloat(player.stats?.avgFpts?.last5) || 0;
      const fptsLast7 = parseFloat(player.stats?.avgFpts?.last7) || 0;
      const fptsLast14 = parseFloat(player.stats?.avgFpts?.last14) || 0;
      const fptsSeason = parseFloat(player.stats?.avgFpts?.season) || 0;

      // Extract vegas data
      const vegasImpliedTotal = parseFloat(player.odds?.impliedPts) || 0;
      const vegasSpread = parseFloat(player.odds?.spread) || 0;
      const vegasOverUnder = parseFloat(player.odds?.overUnder) || 0;
      const vegasWinProb = parseFloat(player.odds?.impliedWinProb) || 0;

      // Extract rostership (ownership %)
      const rostership = parseFloat(player.rostership) || 0;

      // Extract minutes
      const projectedMinutes = parseFloat(player.minutes) || 0;
      const seasonMinutes = parseFloat(player.stats?.season?.minutes) || 0;
      const minutes = projectedMinutes > 0 ? projectedMinutes : seasonMinutes;

      // Extract advanced stats
      const per = parseFloat(player.stats?.advanced?.per) || 0;
      const usage = parseFloat(player.stats?.advanced?.usage) || 0;
      const restDays = parseInt(player.stats?.advanced?.rest) || 1; // Default to 1 day rest

      // EARLY REJECTION: Check raw data for explicit 0.0 pts (injured/inactive)
      const rawGamePts = parseFloat(player.game?.pts ?? player.pts ?? -1);
      const isExplicitlyInactive = rawGamePts === 0.0;

      // If explicitly marked inactive, skip this player entirely
      if (isExplicitlyInactive) {
        console.log(`❌ REJECTED: ${name} - RotoWire marked inactive (pts = 0.0)`);
        return null; // Will be filtered out
      }

      // ═══════════════════════════════════════════════════════════════
      // PROJECTION ALGORITHM
      // ═══════════════════════════════════════════════════════════════
      let projectedPoints = 0;

      // Check if player is actually playing - must have projected minutes
      const isPlaying = minutes > 0 && projectedMinutes > 0;

      if (isPlaying && (fptsLast3 > 0 || fptsLast5 > 0 || fptsSeason > 0)) {
        
        // ───────────────────────────────────────────────────────────
        // STEP 1: Calculate Recent Form Baseline
        // ───────────────────────────────────────────────────────────
        // Weight recent games more heavily to capture hot/cold streaks
        // This baseline ALREADY includes the player's efficiency, usage, and role
        const recentFormBase = (fptsLast3 * 0.40) + (fptsLast5 * 0.30) + (fptsLast7 * 0.20) + (fptsSeason * 0.10);

        // ───────────────────────────────────────────────────────────
        // STEP 2: Minutes Adjustment
        // ───────────────────────────────────────────────────────────
        // Only adjust if minutes change significantly (3+ minutes)
        // This accounts for role changes (starter out, etc.)
        const minutesAdj = this.getMinutesAdjustment(projectedMinutes, seasonMinutes, recentFormBase);

        // ───────────────────────────────────────────────────────────
        // STEP 3: Base Projection (Before Matchup)
        // ───────────────────────────────────────────────────────────
        const baseProjection = recentFormBase + minutesAdj;

        // ───────────────────────────────────────────────────────────
        // STEP 4: Matchup Adjustments
        // ───────────────────────────────────────────────────────────
        const defenseAdj = this.getDefenseAdjustment(opponent);
        const paceAdj = this.getPaceAdjustment(opponent);
        const positionDefenseAdj = this.getPositionDefenseAdjustment(opponent, position);
        const vegasAdj = this.getVegasAdjustment(vegasImpliedTotal);
        const favoriteAdj = this.getFavoriteAdjustment(vegasSpread);
        const restAdj = this.getRestAdjustment(restDays);

        // ───────────────────────────────────────────────────────────
        // STEP 5: Final Projection
        // ───────────────────────────────────────────────────────────
        const totalMatchupAdjustment = defenseAdj + paceAdj + positionDefenseAdj + vegasAdj + favoriteAdj + restAdj;
        projectedPoints = baseProjection + totalMatchupAdjustment;

        // ───────────────────────────────────────────────────────────
        // LOGGING: Show projection breakdown
        // ───────────────────────────────────────────────────────────
        const shouldLog = Math.abs(totalMatchupAdjustment) > 0.5 || Math.abs(minutesAdj) > 1.0;

        if (shouldLog) {
          console.log(`  📊 ${name} (${position}) vs ${opponent}:`);
          console.log(`     Recent Form Base: ${recentFormBase.toFixed(1)} FP`);

          // Only show minutes adjustment if significant
          if (Math.abs(minutesAdj) > 0.1) {
            const minChange = projectedMinutes - seasonMinutes;
            console.log(`     Minutes Adj: ${minutesAdj > 0 ? '+' : ''}${minutesAdj.toFixed(1)} FP (${minChange > 0 ? '+' : ''}${minChange.toFixed(0)} min: ${seasonMinutes.toFixed(0)} → ${projectedMinutes.toFixed(0)})`);
          }

          console.log(`     Base Projection: ${baseProjection.toFixed(1)} FP`);
          console.log(`     Matchup Adjustments: ${totalMatchupAdjustment > 0 ? '+' : ''}${totalMatchupAdjustment.toFixed(1)} FP`);
          console.log(`       └─ Defense: ${defenseAdj > 0 ? '+' : ''}${defenseAdj.toFixed(1)} | Pace: ${paceAdj > 0 ? '+' : ''}${paceAdj.toFixed(1)} | Position: ${positionDefenseAdj > 0 ? '+' : ''}${positionDefenseAdj.toFixed(1)} | Vegas: ${vegasAdj > 0 ? '+' : ''}${vegasAdj.toFixed(1)} | Favorite: ${favoriteAdj > 0 ? '+' : ''}${favoriteAdj.toFixed(1)} | Rest: ${restAdj > 0 ? '+' : ''}${restAdj.toFixed(1)} (${restDays}d)`);
          console.log(`     Final Projection: ${projectedPoints.toFixed(1)} FP`);
        }
      }

      // ═══════════════════════════════════════════════════════════════
      // VALUE CALCULATION (Points per $1000)
      // ═══════════════════════════════════════════════════════════════
      let value = 0;
      let valueGpp = 0;

      if (salary !== 0 && projectedPoints > 0) {
        // Base value: points per $1000
        const baseValue = (projectedPoints / salary) * 1000;

        // ADDITIVE MODEL: Convert all bonuses to value point adjustments
        // This prevents exponential compounding while maintaining differentiation

        // Minute adjustment: More minutes = more opportunity
        const minuteAdj = minutes >= 35 ? 0.5 :   // Elite minutes
                         minutes >= 30 ? 0.3 :     // Good minutes
                         minutes >= 25 ? 0.1 :     // Decent minutes
                         minutes >= 20 ? 0 :       // Average minutes
                         -0.5;                     // Low minutes

        // PER adjustment: Efficiency matters
        const perAdj = per >= 25 ? 0.8 :           // Elite efficiency
                      per >= 20 ? 0.5 :             // Very good efficiency
                      per >= 15 ? 0.3 :             // Good efficiency
                      per >= 10 ? 0 :               // Average efficiency
                      -0.2;                         // Below average

        // Usage adjustment: High usage = more fantasy production
        const usageAdj = usage >= 30 ? 0.4 :       // Very high usage
                        usage >= 25 ? 0.2 :         // High usage
                        0;                          // Normal usage

        // Recent form adjustment: Hot hand theory
        const recentFormAdj = fptsLast3 > fptsLast7 * 1.15 ? 0.3 :  // Hot streak
                             fptsLast3 < fptsLast7 * 0.85 ? -0.3 :   // Cold streak
                             0;                                       // Consistent

        // Vegas pace adjustment: High O/U = more possessions
        const vegasPaceAdj = vegasOverUnder >= 230 ? 0.2 :   // Very high O/U
                            vegasOverUnder >= 220 ? 0.1 :     // High O/U
                            0;                                 // Normal O/U

        // CASH GAME VALUE: Slight boost for high ownership (safe chalk plays)
        const ownershipAdjCash = rostership >= 20 ? 0.2 :     // Popular play, likely safe
                                rostership >= 10 ? 0.1 :      // Moderately popular
                                0;                             // Normal ownership

        // GPP VALUE: Boost for low ownership (contrarian leverage)
        const ownershipAdjGpp = rostership <= 5 ? 0.6 :       // Very low owned - huge leverage
                               rostership <= 10 ? 0.4 :       // Low owned - good leverage
                               rostership <= 15 ? 0.2 :       // Medium-low owned
                               rostership >= 30 ? -0.3 :      // Very chalky - fade
                               0;                              // Normal ownership

        // Sum all adjustments and apply to base value
        const cashAdjustments = minuteAdj + perAdj + usageAdj + recentFormAdj + vegasPaceAdj + ownershipAdjCash;
        const gppAdjustments = minuteAdj + perAdj + usageAdj + recentFormAdj + vegasPaceAdj + ownershipAdjGpp;

        value = baseValue + cashAdjustments;
        value = Math.round(value * 100) / 100;

        valueGpp = baseValue + gppAdjustments;
        valueGpp = Math.round(valueGpp * 100) / 100;
      }

      // Build readable gameInfo from team/opponent or game object
      let teamAbbr = team ?? (player.team && typeof player.team === 'object' ? stringifyField(player.team.abbr) : null);
      if (!teamAbbr && player.team) teamAbbr = stringifyField(player.team);
      let oppAbbr = opponent ?? (player.opponent && typeof player.opponent === 'object' ? stringifyField(player.opponent.team) : null);
      if (!oppAbbr && player.opp) oppAbbr = stringifyField(player.opp);
      let gameInfo = null;
      if (teamAbbr || oppAbbr) {
        gameInfo = `${teamAbbr ?? ''} vs ${oppAbbr ?? ''}`.trim();
      } else if (player.game && (player.game.dateTime || player.game.date)) {
        gameInfo = stringifyField(player.game.dateTime ?? player.game.date);
      } else if (player.game_info) {
        gameInfo = stringifyField(player.game_info);
      }

      const injuryRaw = player.injury_status ?? player.injury ?? null;
      let injuryStatus = null;
      if (injuryRaw != null) {
        injuryStatus = typeof injuryRaw === 'object' ? JSON.stringify(injuryRaw) : String(injuryRaw);
      }

      // Extract headshot URL from RotoWire data
      const headshot = player.imageURL ??
                       player.imageUrl ??
                       player.image_url ??
                       player.headshot ??
                       player.headshotUrl ??
                       player.photo ??
                       null;

      // Get opponent defense data for display
      let dvpPtsAllowed = null;
      let oppDefEff = null;

      if (opponent) {
        // Get DVP points allowed for this player's position vs opponent
        // Use primary position (first one) since defense table stores single positions
        const primaryPosition = position.split(',')[0].trim();
        const normalizedVsPos = normalizeForVsPosition(opponent);
        const defenseVsPos = teamDefenseVsPositionModel.getByTeamAndPosition(normalizedVsPos, primaryPosition);
        if (defenseVsPos) {
          dvpPtsAllowed = defenseVsPos.pts_allowed;
        }

        // Get opponent's overall defensive efficiency
        const normalizedRankings = normalizeForRankings(opponent);
        const oppDefense = teamDefenseModel.getByTeam(normalizedRankings);
        if (oppDefense) {
          oppDefEff = oppDefense.def_eff;
        }
      }

      return {
        playerId,
        name,
        team,
        opponent,
        position,
        salary,
        projectedPoints,
        projectedMinutes: minutes,
        value,
        valueGpp,
        gameInfo,
        injuryStatus,
        per,
        usage,
        restDays,
        fptsLast3,
        fptsLast5,
        fptsLast7,
        fptsLast14,
        vegasImpliedTotal,
        vegasSpread,
        vegasOverUnder,
        vegasWinProb,
        rostership,
        headshot,
        dvpPtsAllowed,
        oppDefEff,
        rawData: JSON.stringify(player)
      };
    })
    .filter(player => {
      // Filter out null players (rejected earlier) and players with no projection
      if (!player) return false;

      const hasProjection = player.projectedPoints > 0;
      const hasMinutes = player.projectedMinutes > 0;

      if (!hasProjection || !hasMinutes) {
        console.log(`⏭️  Filtered: ${player.name} - No projection (${player.projectedPoints} pts, ${player.projectedMinutes} min)`);
        return false;
      }

      return true;
    });
  }

  async fetchSlateList() {
    try {
      // Fetch available slates from RotoWire
      const url = 'https://www.rotowire.com/daily/nba/api/slate-list.php?siteID=1';

      const response = await fetch(url, {
        headers: {
          'accept': 'application/json, text/plain, */*',
          'accept-language': 'en-US,en;q=0.9',
          'sec-fetch-dest': 'empty',
          'sec-fetch-mode': 'cors',
          'sec-fetch-site': 'same-origin',
          'cookie': this.cookie,
          'Referer': 'https://www.rotowire.com/daily/nba/optimizer.php'
        },
        method: 'GET'
      });

      if (!response.ok) {
        throw new Error(`RotoWire slate-list API error: ${response.status}`);
      }

      const data = await response.json();

      // Filter to only Classic contests (exclude Showdown)
      const classicSlates = data.slates.filter(slate => slate.contestType === 'Classic');

      console.log(`✅ Fetched ${classicSlates.length} Classic slates`);

      return classicSlates.map(slate => ({
        slateId: slate.slateID.toString(),
        name: slate.slateName,
        contestType: slate.contestType,
        startDate: slate.startDate,
        startTime: slate.timeOnly,
        games: Array.isArray(slate.games) ? slate.games.length : slate.games,
        isDefault: slate.defaultSlate,
        salaryCap: slate.salaryCap
      }));
    } catch (error) {
      console.error('Error fetching slate list:', error);
      throw error;
    }
  }

  async fetchSlates() {
    try {
      // This endpoint may vary - adjust as needed
      const url = `${this.baseUrl}/slates.php`;

      const response = await fetch(url, {
        headers: {
          'accept': 'application/json, text/plain, */*',
          'cookie': this.cookie,
          'Referer': 'https://www.rotowire.com/daily/nba/optimizer.php'
        },
        method: 'GET'
      });

      if (!response.ok) {
        // If slates endpoint doesn't exist, return empty array
        console.warn('Slates endpoint not available');
        return [];
      }

      const data = await response.json();
      return data;
    } catch (error) {
      console.warn('Could not fetch slates:', error.message);
      return [];
    }
  }
}

export default new RotowireService();