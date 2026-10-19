/**
 * MINUTES x FPPM MODEL (pure functions, no database)
 *
 * Projects a player's minutes first, then fantasy points per minute, and
 * multiplies: projection = minutes x FPPM.
 *
 * Minutes:
 *   - recency-weighted last 5 games blended with the season average (leans
 *     harder on recent games when the role clearly changed)
 *   - optional RotoWire minutes projection blended in when present
 *   - B2B: player's own B2B vs rested minutes split, else a role default
 *   - blowout risk from the spread: starters lose minutes, bench gains
 *   - injury redistribution: when a teammate is OUT his minutes are handed to
 *     active teammates using with/without splits (same definition as
 *     nbaStatsService.getUsageWithoutTeammate: "without" = games where the
 *     teammate logged no minutes)
 *
 * FPPM:
 *   - recent (last 10 games) and season FPPM, season regressed toward the
 *     league rate on small samples
 *   - matchup: how many fantasy points per minute the opponent allows vs the
 *     league, regressed by sample size and capped
 *   - Vegas implied team total when present
 *   - usage bump from with/without splits when a teammate is OUT
 *
 * Game logs passed in here are plain objects:
 *   { name, team, opponent, gameId, date: 'YYYY-MM-DD', minutes, fp, isB2B }
 * where fp is already scored for the requested site (see scoring.js).
 */

export const DEFAULT_MINUTES_CONFIG = Object.freeze({
  // Final projection = weight x (minutes x FPPM) + (1 - weight) x existing projection.
  // Override with PROJECTION_MINUTES_WEIGHT or per request.
  blendWeight: 0.6,

  minGames: 3,                 // fewer prior games -> no minutes model for the player
  recentGames: 5,
  recentMinutesWeight: 0.6,    // weighted L5 vs season average
  roleChangeMinutes: 6,        // |L3 - season| above this = role change
  roleChangeRecentWeight: 0.85,
  rotowireMinutesWeight: 0.3,  // used only when the slate has a minutes projection
  maxMinutes: 42,

  // B2B minutes change by role when the player has no B2B history of his own
  b2bMinutesByRole: { starter: -1.5, rotation: -0.75, bench: 0, fringe: 0 },
  b2bMinSamples: 3,
  b2bShrinkGames: 4,

  // Blowout risk: every point of spread beyond the threshold
  blowoutThreshold: 6,
  blowoutMinutesPerPoint: { starter: -0.3, rotation: -0.1, bench: 0.15, fringe: 0.2 },
  blowoutMaxMinutes: 4,

  fppmRecentGames: 10,
  fppmRecentWeight: 0.35,
  fppmPriorMinutes: 60,        // pseudo-minutes of league-average FPPM mixed into season FPPM
  matchupPriorGames: 10,
  matchupCap: 0.08,
  vegasPerPoint: 0.004,        // FPPM change per point of implied total vs league average
  vegasCap: 0.06,
  leagueImpliedTotal: 113,

  // Injury redistribution
  outMinMinutes: 8,            // ignore OUT players who barely play
  splitMinWithGames: 3,
  splitShrinkGames: 3,         // regression for minutes delta
  presenceGames: 5,            // team games checked for how long an OUT player has been out
  usageShrinkGames: 20,        // regression for FPPM delta (splits are noisy; replay backtest favoured heavy shrinkage)
  usageBumpCap: 0.15,
  usageDropCap: -0.05,
  historyConfidenceGames: 8,   // team games without the OUT player for full trust in history
  maxRedistributedMinutes: 40, // nobody gets pushed above this by redistribution
  redistributionScale: 0.4,    // share of the OUT player's minutes handed out (replay backtest: 0.4 removed the minutes bias)
  teamMinutes: 240,            // rotation players can't be projected past this in total
  rotationMinMinutes: 10       // players below this don't count toward the team total
});

const round1 = (v) => Math.round(v * 10) / 10;
const round3 = (v) => Math.round(v * 1000) / 1000;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const sum = (arr, fn) => arr.reduce((s, x) => s + fn(x), 0);

export function resolveConfig(overrides = {}) {
  return { ...DEFAULT_MINUTES_CONFIG, ...overrides };
}

export function classifyRole(minutes) {
  if (minutes >= 28) return 'starter';
  if (minutes >= 18) return 'rotation';
  if (minutes >= 10) return 'bench';
  return 'fringe';
}

/**
 * Weighted average of the most recent games (most recent first), weights n..1
 */
export function recencyWeightedAverage(values) {
  if (!values.length) return 0;
  let total = 0, weights = 0;
  values.forEach((v, i) => {
    const w = values.length - i;
    total += v * w;
    weights += w;
  });
  return total / weights;
}

/**
 * Minutes projection before injury redistribution.
 * @param {Array} games - player's prior games, most recent first
 * @param {Object} context - { isB2B, spread, rotowireMinutes }
 */
export function projectBaseMinutes(games, context = {}, config = DEFAULT_MINUTES_CONFIG) {
  const played = games.filter(g => g.minutes > 0);
  if (played.length < config.minGames) return null;

  const seasonAvg = sum(played, g => g.minutes) / played.length;
  const recent = played.slice(0, config.recentGames).map(g => g.minutes);
  const recentAvg = recencyWeightedAverage(recent);
  const last3 = played.slice(0, 3);
  const last3Avg = sum(last3, g => g.minutes) / last3.length;

  const roleChange = Math.abs(last3Avg - seasonAvg) >= config.roleChangeMinutes;
  const recentWeight = roleChange ? config.roleChangeRecentWeight : config.recentMinutesWeight;
  let minutes = recentWeight * recentAvg + (1 - recentWeight) * seasonAvg;

  const rotowireMinutes = Number(context.rotowireMinutes);
  const usedRotowire = Number.isFinite(rotowireMinutes) && rotowireMinutes > 0 && config.rotowireMinutesWeight > 0;
  if (usedRotowire) {
    minutes = config.rotowireMinutesWeight * rotowireMinutes + (1 - config.rotowireMinutesWeight) * minutes;
  }

  const role = classifyRole(minutes);

  let b2b = 0;
  if (context.isB2B) {
    const b2bGames = played.filter(g => g.isB2B);
    const restedGames = played.filter(g => !g.isB2B);
    if (b2bGames.length >= config.b2bMinSamples && restedGames.length >= config.b2bMinSamples) {
      const diff = sum(b2bGames, g => g.minutes) / b2bGames.length - sum(restedGames, g => g.minutes) / restedGames.length;
      const shrink = b2bGames.length / (b2bGames.length + config.b2bShrinkGames);
      b2b = clamp(diff * shrink, -4, 1);
    } else {
      b2b = config.b2bMinutesByRole[role] || 0;
    }
  }

  let blowout = 0;
  const spread = Number(context.spread);
  if (Number.isFinite(spread) && Math.abs(spread) > config.blowoutThreshold) {
    const excess = Math.abs(spread) - config.blowoutThreshold;
    blowout = clamp(excess * (config.blowoutMinutesPerPoint[role] || 0), -config.blowoutMaxMinutes, config.blowoutMaxMinutes);
  }

  const projected = clamp(minutes + b2b + blowout, 0, config.maxMinutes);

  return {
    minutes: projected,
    role,
    breakdown: {
      seasonAvg: round1(seasonAvg),
      recentAvg: round1(recentAvg),
      last3Avg: round1(last3Avg),
      roleChange,
      rotowireMinutes: usedRotowire ? rotowireMinutes : null,
      b2b: round1(b2b),
      blowout: round1(blowout)
    },
    games: played.length
  };
}

/**
 * League FPPM and per-opponent "FPPM allowed" ratios from prior game logs.
 * Returns { leagueFppm, opponents: { [team]: { ratio, games } } }
 */
export function buildOpponentFactors(games, config = DEFAULT_MINUTES_CONFIG) {
  let fp = 0, min = 0;
  const byOpp = new Map();
  for (const g of games) {
    if (!(g.minutes > 0)) continue;
    fp += g.fp;
    min += g.minutes;
    if (!g.opponent) continue;
    if (!byOpp.has(g.opponent)) byOpp.set(g.opponent, { fp: 0, min: 0, gameIds: new Set() });
    const o = byOpp.get(g.opponent);
    o.fp += g.fp;
    o.min += g.minutes;
    o.gameIds.add(g.gameId || g.date);
  }
  const leagueFppm = min > 0 ? fp / min : 0;
  const opponents = {};
  for (const [team, o] of byOpp) {
    const n = o.gameIds.size;
    const raw = leagueFppm > 0 && o.min > 0 ? (o.fp / o.min) / leagueFppm : 1;
    const shrunk = 1 + (raw - 1) * (n / (n + config.matchupPriorGames));
    opponents[team] = { ratio: clamp(shrunk, 1 - config.matchupCap, 1 + config.matchupCap), games: n };
  }
  return { leagueFppm, opponents };
}

/**
 * FPPM projection (before usage bump).
 * @param {Array} games - player's prior games, most recent first
 * @param {Object} context - { opponent, impliedTotal, opponentFactors }
 */
export function projectFppm(games, context = {}, config = DEFAULT_MINUTES_CONFIG) {
  const played = games.filter(g => g.minutes > 0);
  if (!played.length) return null;

  const leagueFppm = context.opponentFactors?.leagueFppm || 0;
  const seasonFp = sum(played, g => g.fp);
  const seasonMin = sum(played, g => g.minutes);
  const prior = leagueFppm > 0 ? config.fppmPriorMinutes : 0;
  const season = (seasonFp + prior * leagueFppm) / (seasonMin + prior);

  const recentGames = played.slice(0, config.fppmRecentGames);
  const recentMin = sum(recentGames, g => g.minutes);
  const recent = recentMin > 0 ? sum(recentGames, g => g.fp) / recentMin : season;
  // Trust the recent rate less when it rests on few minutes
  const recentWeight = config.fppmRecentWeight * Math.min(1, recentMin / 100);
  const base = recentWeight * recent + (1 - recentWeight) * season;

  const matchupRatio = context.opponentFactors?.opponents?.[context.opponent]?.ratio ?? 1;

  let vegasRatio = 1;
  const implied = Number(context.impliedTotal);
  if (Number.isFinite(implied) && implied > 0) {
    vegasRatio = clamp(1 + (implied - config.leagueImpliedTotal) * config.vegasPerPoint, 1 - config.vegasCap, 1 + config.vegasCap);
  }

  return {
    fppm: base * matchupRatio * vegasRatio,
    breakdown: {
      season: round3(season),
      recent: round3(recent),
      base: round3(base),
      matchup: round3(matchupRatio),
      vegas: round3(vegasRatio)
    }
  };
}

/**
 * With/without split for one teammate vs one OUT player.
 * teamGames: the team's prior logs (all players), any order.
 * Only games since the OUT player's first appearance for the team count, so
 * games before he joined are not read as "without him".
 */
export function computeWithWithoutSplit(teamGames, outKey, teammateKey, keyFn = g => g.name) {
  const outGames = teamGames.filter(g => keyFn(g) === outKey && g.minutes > 0);
  if (!outGames.length) return null;
  const firstDate = outGames.reduce((d, g) => (g.date < d ? g.date : d), outGames[0].date);
  const withIds = new Set(outGames.map(g => g.gameId || g.date));

  const mine = teamGames.filter(g => keyFn(g) === teammateKey && g.minutes > 0 && g.date >= firstDate);
  const withRows = mine.filter(g => withIds.has(g.gameId || g.date));
  const withoutRows = mine.filter(g => !withIds.has(g.gameId || g.date));

  const avg = (rows) => {
    if (!rows.length) return null;
    const min = sum(rows, g => g.minutes);
    return { games: rows.length, minutes: min / rows.length, fppm: min > 0 ? sum(rows, g => g.fp) / min : 0 };
  };
  return { with: avg(withRows), without: avg(withoutRows) };
}

/**
 * Hand an OUT player's minutes (and usage) to his active teammates.
 *
 * @param {Array} active - [{ key, minutes, fixed }] teammates with a base
 *   projection. fixed (manual minutes override) players count toward the team
 *   minutes budget but receive nothing.
 * @param {Array} out - [{ key, minutes, presence }] OUT players with their
 *   expected minutes. presence (0..1, default 1) is the share of the team's
 *   recent games he played: if he has already been out for a while his absence
 *   is baked into teammates' recent minutes, so only the rest is handed out.
 * @param {Array} teamGames - team's prior game logs
 * @returns {Object} { [key]: { addedMinutes, fppmMultiplier, sources: [] } }
 */
export function redistributeInjuries(active, out, teamGames, config = DEFAULT_MINUTES_CONFIG, keyFn = g => g.name) {
  const result = {};
  const receivers = active.filter(p => !p.fixed);
  for (const p of receivers) result[p.key] = { addedMinutes: 0, fppmMultiplier: 1, sources: [] };

  // Minutes left before the rotation's projections add up to a full game
  let budget = Math.max(0, config.teamMinutes - sum(active.filter(p => p.minutes >= config.rotationMinMinutes), p => p.minutes));

  for (const o of out) {
    if (!(o.minutes >= config.outMinMinutes)) continue;
    const presence = clamp(o.presence ?? 1, 0, 1);
    if (presence === 0) continue;
    const outMinutes = Math.min(budget, o.minutes * presence * config.redistributionScale);

    const withIds = new Set(teamGames.filter(g => keyFn(g) === o.key && g.minutes > 0).map(g => g.gameId || g.date));
    const firstDate = teamGames
      .filter(g => keyFn(g) === o.key && g.minutes > 0)
      .reduce((d, g) => (d === null || g.date < d ? g.date : d), null);
    const teamGameIdsWithout = new Set(
      teamGames.filter(g => firstDate !== null && g.date >= firstDate && !withIds.has(g.gameId || g.date)).map(g => g.gameId || g.date)
    );
    const historyConfidence = Math.min(1, teamGameIdsWithout.size / config.historyConfidenceGames);

    // Prior: players with headroom absorb more (a 34-minute starter can't take 12 more)
    const prior = {};
    let priorTotal = 0;
    for (const p of receivers) {
      const w = p.minutes >= 10 ? p.minutes * Math.max(0, config.maxRedistributedMinutes - p.minutes) : 0;
      prior[p.key] = w;
      priorTotal += w;
    }

    const hist = {};
    let histTotal = 0;
    const splits = {};
    for (const p of receivers) {
      const split = historyConfidence > 0 ? computeWithWithoutSplit(teamGames, o.key, p.key, keyFn) : null;
      splits[p.key] = split;
      let w = 0;
      if (split?.with && split?.without && split.with.games >= config.splitMinWithGames) {
        const n = split.without.games;
        w = Math.max(0, (split.without.minutes - split.with.minutes) * (n / (n + config.splitShrinkGames)));
      }
      hist[p.key] = w;
      histTotal += w;
    }

    const c = histTotal > 0 ? historyConfidence : 0;
    for (const p of receivers) {
      const priorShare = priorTotal > 0 ? prior[p.key] / priorTotal : 0;
      const histShare = histTotal > 0 ? hist[p.key] / histTotal : 0;
      const share = (1 - c) * priorShare + c * histShare;
      const r = result[p.key];
      const room = Math.max(0, config.maxRedistributedMinutes - p.minutes - r.addedMinutes);
      const added = Math.min(room, outMinutes * share);

      let usage = 0;
      const split = splits[p.key];
      if (split?.with && split?.without && split.with.games >= config.splitMinWithGames && split.with.fppm > 0) {
        const n = split.without.games;
        usage = (split.without.fppm / split.with.fppm - 1) * (n / (n + config.usageShrinkGames));
        usage = clamp(usage, config.usageDropCap, config.usageBumpCap) * presence;
      }

      if (added > 0.05 || Math.abs(usage) > 0.001) {
        r.addedMinutes += added;
        budget = Math.max(0, budget - added);
        r.fppmMultiplier *= 1 + usage;
        r.sources.push({
          out: o.key,
          addedMinutes: round1(added),
          usageBump: round3(usage),
          gamesWithout: split?.without?.games || 0
        });
      }
    }
  }

  for (const r of Object.values(result)) {
    r.fppmMultiplier = clamp(r.fppmMultiplier, 1 + config.usageDropCap, 1 + config.usageBumpCap);
  }
  return result;
}

/**
 * Blend the minutes model with the existing projection.
 */
export function blendProjection(modelPoints, existingPoints, weight) {
  const w = clamp(Number(weight) || 0, 0, 1);
  if (!Number.isFinite(modelPoints)) return existingPoints;
  if (!Number.isFinite(existingPoints) || existingPoints <= 0) return modelPoints;
  return w * modelPoints + (1 - w) * existingPoints;
}

/**
 * Name key for matching slate names to box score names (diacritics,
 * punctuation and Jr./III suffixes ignored).
 */
export function playerKey(name) {
  if (!name) return '';
  return String(name)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[.'’`-]/g, '')
    .replace(/\b(jr|sr|ii|iii|iv|v)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Share of the team's last n games a player appeared in, as a lookup function.
 */
function presenceFn(teamLogs, n) {
  const dateByGame = new Map();
  for (const g of teamLogs) dateByGame.set(g.gameId || g.date, g.date);
  const recent = new Set([...dateByGame.entries()]
    .sort((a, b) => (a[1] < b[1] ? 1 : a[1] > b[1] ? -1 : 0))
    .slice(0, n)
    .map(([id]) => id));
  return (key) => {
    if (!recent.size) return 1;
    const played = new Set(teamLogs
      .filter(g => g.minutes > 0 && recent.has(g.gameId || g.date) && playerKey(g.name) === key)
      .map(g => g.gameId || g.date));
    return played.size / recent.size;
  };
}

/**
 * Minutes x FPPM projections for a whole slate, including injury
 * redistribution and manual overrides.
 *
 * @param {Array} players - [{ id, name, team, opponent, isB2B, spread,
 *   impliedTotal, rotowireMinutes, out, override: { minutes, points } }]
 * @param {Array} history - prior game logs (all teams), fp scored for the site
 * @param {Object} options
 * @param {Array} [options.extraOut] - [{ name, team }] OUT players not on the slate
 * @param {Object} [options.config]
 * @param {boolean} [options.redistribute=true]
 * @returns {Map} id -> projection
 */
export function projectPlayers(players, history, { extraOut = [], config = DEFAULT_MINUTES_CONFIG, redistribute = true } = {}) {
  const logsByPlayer = new Map();
  const logsByTeam = new Map();
  for (const g of history) {
    const key = playerKey(g.name);
    if (!logsByPlayer.has(key)) logsByPlayer.set(key, []);
    logsByPlayer.get(key).push(g);
    if (!logsByTeam.has(g.team)) logsByTeam.set(g.team, []);
    logsByTeam.get(g.team).push(g);
  }
  for (const logs of logsByPlayer.values()) {
    logs.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  }
  const opponentFactors = buildOpponentFactors(history, config);
  const keyFn = g => playerKey(g.name);

  const results = new Map();
  for (const p of players) {
    const key = playerKey(p.name);
    const games = logsByPlayer.get(key) || [];
    const minutesProj = projectBaseMinutes(games, {
      isB2B: p.isB2B,
      spread: p.spread,
      rotowireMinutes: p.rotowireMinutes
    }, config);
    const fppmProj = projectFppm(games, {
      opponent: p.opponent,
      impliedTotal: p.impliedTotal,
      opponentFactors
    }, config);

    const overrideMinutes = Number.isFinite(p.override?.minutes) ? p.override.minutes : null;
    const out = Boolean(p.out) || overrideMinutes === 0;

    results.set(p.id, {
      key,
      team: p.team,
      out,
      hasModel: Boolean(minutesProj && fppmProj),
      baseMinutes: minutesProj?.minutes ?? null,
      // Expected minutes if he did play, used to size redistribution
      expectedMinutes: minutesProj?.minutes ?? (games.length ? sum(games.slice(0, 5), g => g.minutes) / Math.min(5, games.length) : 0),
      role: minutesProj?.role ?? null,
      minutesBreakdown: minutesProj?.breakdown ?? null,
      fppm: fppmProj?.fppm ?? null,
      fppmBreakdown: fppmProj?.breakdown ?? null,
      overrideMinutes,
      overridePoints: Number.isFinite(p.override?.points) ? p.override.points : null,
      injury: null,
      games: games.length
    });
  }

  if (redistribute) {
    const teams = new Set(players.map(p => p.team));
    for (const team of teams) {
      const teamPlayers = players.filter(p => p.team === team).map(p => results.get(p.id));
      const teamLogs = logsByTeam.get(team) || [];
      const presence = presenceFn(teamLogs, config.presenceGames);
      const outList = teamPlayers.filter(r => r.out).map(r => ({ key: r.key, minutes: r.expectedMinutes, presence: presence(r.key) }));
      const onSlate = new Set(teamPlayers.map(r => r.key));
      for (const e of extraOut) {
        if (e.team !== team) continue;
        const key = playerKey(e.name);
        if (onSlate.has(key)) continue;
        const games = logsByPlayer.get(key) || [];
        const proj = projectBaseMinutes(games, {}, config);
        outList.push({ key, minutes: proj?.minutes ?? 0, presence: presence(key) });
      }
      if (!outList.length) continue;

      const active = teamPlayers
        .filter(r => !r.out && (r.overrideMinutes !== null || r.hasModel))
        .map(r => ({ key: r.key, minutes: r.overrideMinutes ?? r.baseMinutes, fixed: r.overrideMinutes !== null }));
      const redistribution = redistributeInjuries(active, outList, teamLogs, config, keyFn);
      for (const r of teamPlayers) {
        if (redistribution[r.key]?.sources.length) r.injury = redistribution[r.key];
      }
    }
  }

  for (const r of results.values()) {
    if (r.out) {
      r.minutes = 0;
      r.points = 0;
    } else if (r.hasModel) {
      const added = r.injury?.addedMinutes || 0;
      r.minutes = r.overrideMinutes ?? Math.min(config.maxMinutes, r.baseMinutes + added);
      r.fppm = r.fppm * (r.injury?.fppmMultiplier || 1);
      r.points = r.minutes * r.fppm;
    } else {
      // Too few games for a minutes projection; a minutes override still works
      r.minutes = r.overrideMinutes;
      r.points = r.overrideMinutes !== null && r.fppm !== null ? r.overrideMinutes * r.fppm : null;
    }
    if (r.overridePoints !== null) r.points = r.overridePoints;
  }
  return results;
}

const OUT_STATUSES = new Set(['OUT', 'O', 'OFS', 'INJ', 'SUSP', 'SUSPENDED', 'NWT']);

/**
 * True when a RotoWire/DFS injury status means the player will not play.
 */
export function isOutStatus(status) {
  if (status === null || status === undefined) return false;
  let s = status;
  if (typeof s === 'string' && s.trim().startsWith('{')) {
    try {
      const parsed = JSON.parse(s);
      s = parsed.status ?? parsed.injuryStatus ?? parsed.designation ?? '';
    } catch {
      // not JSON, use as-is
    }
  } else if (typeof s === 'object') {
    s = s.status ?? s.injuryStatus ?? s.designation ?? '';
  }
  return OUT_STATUSES.has(String(s).trim().toUpperCase());
}
