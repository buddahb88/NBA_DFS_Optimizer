/**
 * PROJECTION REPLAY BACKTEST
 *
 * The stored-projection backtest (projectionBacktestService) can only score
 * slates whose projections are still in the players table. This replays
 * history instead: for every date in historical_games it projects each player
 * who played, using only box scores from before that date, and scores the
 * projection against what he actually scored.
 *
 * Compared:
 *   - legacy:  projectionService.calculateEnhancedProjection (the historical
 *              blend + adjustments, no RotoWire input available in replay)
 *   - minutes: minutes x FPPM model, with and without injury redistribution
 *   - blends of the two at several weights
 *   - optionally (dvpVariants) the legacy model under several DVP settings,
 *     e.g. off vs legacy points-allowed vs archetype defense at a few weights
 *
 * Replay limits (read results with these in mind):
 *   - No RotoWire projections, Vegas lines or injury reports exist for past
 *     dates. OUT players are inferred: a regular (15+ min over his last games)
 *     who appeared in the team's recent games but has no box score that day.
 *   - Only players who played are scored (DNPs have no box score row).
 *   - Defense rankings used by the legacy model are current, not point-in-time.
 *     The archetype DVP is point-in-time: team_archetype_defense is rebuilt
 *     for each date from that season's games before it (the prior season's
 *     full table before the first game). Archetype labels are season-level.
 *
 * The model evaluation harness (services/modelEval, npm run backtest:model)
 * reuses this module's OUT inference and removes the two lookahead sources
 * above: archetype labels are rebuilt as-of each date and the current-only
 * defense rankings are excluded from the legacy model.
 */

import db from '../config/database.js';
import projectionService from './projectionService.js';
import { computeErrorMetrics } from './projectionBacktestService.js';
import { HISTORY_COLUMNS, toGameLogs } from './minutesProjectionService.js';
import { blendProjection, playerKey, projectPlayers, resolveConfig } from './minutesModel.js';
import { aggregateDefense, GROUPINGS, loadSeasonExpectations, previousSeason } from './archetypeDefenseService.js';
import { buildDvpContext } from './dvpAdjustment.js';
import { seasonForDate } from '../utils/season.js';

const DEFAULT_WEIGHTS = [0, 0.25, 0.4, 0.5, 0.6, 0.75, 1];
const WARMUP_DAYS = 14;
const OUT_REGULAR_MINUTES = 15;
const OUT_LOOKBACK_GAMES = 5;

const addDays = (dateStr, days) => {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

const round = (v, d = 3) => (Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d : null);

/**
 * Regulars who missed this date: appeared in one of the team's last
 * OUT_LOOKBACK_GAMES games averaging 15+ minutes, but have no row today.
 */
export function inferOutPlayers(prior, todayByTeam) {
  const byTeam = new Map();
  for (const g of prior) {
    if (!todayByTeam.has(g.team)) continue;
    if (!byTeam.has(g.team)) byTeam.set(g.team, []);
    byTeam.get(g.team).push(g);
  }
  const out = [];
  for (const [team, logs] of byTeam) {
    const recentIds = [...new Map(logs.map(g => [g.gameId || g.date, g.date])).entries()]
      .sort((a, b) => (a[1] < b[1] ? 1 : -1))
      .slice(0, OUT_LOOKBACK_GAMES)
      .map(([id]) => id);
    const recent = new Set(recentIds);
    const playedToday = todayByTeam.get(team);
    const minutesByPlayer = new Map();
    for (const g of logs) {
      if (!recent.has(g.gameId || g.date)) continue;
      const key = playerKey(g.name);
      if (!minutesByPlayer.has(key)) minutesByPlayer.set(key, { name: g.name, minutes: [] });
      minutesByPlayer.get(key).minutes.push(g.minutes);
    }
    for (const [key, p] of minutesByPlayer) {
      if (playedToday.has(key)) continue;
      const avg = p.minutes.reduce((s, m) => s + m, 0) / p.minutes.length;
      if (avg >= OUT_REGULAR_MINUTES) out.push({ name: p.name, team });
    }
  }
  return out;
}

/**
 * Point-in-time archetype DVP contexts: contextFor(date) aggregates the
 * date's season's expectation rows before that date.
 */
export async function createDvpContexts(site) {
  const seasons = new Map();
  const loadSeason = async (season) => {
    if (!seasons.has(season)) {
      const [games, archetypes] = await Promise.all([
        loadSeasonExpectations(season),
        db.all('SELECT player_key, archetype FROM player_archetypes WHERE season = ?', season)
      ]);
      seasons.set(season, { games, archetypes: new Map(archetypes.map(r => [r.player_key, r.archetype])) });
    }
    return seasons.get(season);
  };
  const aggregate = (games) => GROUPINGS.flatMap(grouping => aggregateDefense(games, { site, grouping }));

  return async function contextFor(date) {
    const season = seasonForDate(date);
    const prior = previousSeason(season);
    const current = await loadSeason(season);
    const previous = await loadSeason(prior);
    const before = current.games.filter(g => g.game_date < date);
    return buildDvpContext({
      defenseRows: before.length ? aggregate(before) : aggregate(previous.games),
      archetypes: current.archetypes,
      priorArchetypes: previous.archetypes,
      season: before.length ? season : prior,
      site
    });
  };
}

function summarize(samples, field) {
  return computeErrorMetrics(samples.map(s => ({ projected: s[field], actual: s.actual })));
}

/**
 * @param {Object} options
 * @param {string} [options.from] - first date scored (default: 14 days after the first box score)
 * @param {string} [options.to]
 * @param {string} [options.site='draftkings']
 * @param {number[]} [options.weights]
 * @param {boolean} [options.legacy=true] - also run the legacy model (slower)
 * @param {Object} [options.config] - minutes model config overrides
 * @param {Array} [options.dvpVariants] - [{ label, mode, weight, cap }] DVP
 *   configs to also run the legacy model under (needs legacy)
 */
export async function runReplayBacktest(options = {}) {
  const { site = 'draftkings', weights = DEFAULT_WEIGHTS, legacy = true } = options;
  const dvpVariants = legacy ? options.dvpVariants || [] : [];
  const config = resolveConfig(options.config);

  const rows = await db.all(`
    SELECT ${HISTORY_COLUMNS}, position
    FROM historical_games
    WHERE minutes > 0
    ORDER BY game_date
  `);
  const logs = toGameLogs(rows, site).map((g, i) => ({ ...g, position: rows[i].position }));
  if (!logs.length) {
    return { sample: { playerGames: 0, dates: 0 }, insights: ['No box scores in historical_games.'] };
  }

  const allDates = [...new Set(logs.map(g => g.date))].sort();
  const from = options.from || addDays(allDates[0], WARMUP_DAYS);
  const to = options.to || allDates[allDates.length - 1];
  const dates = allDates.filter(d => d >= from && d <= to);

  const contextFor = legacy ? await createDvpContexts(site) : null;
  const samples = [];
  let priorEnd = 0;
  for (const date of dates) {
    const dvpContext = contextFor ? await contextFor(date) : null;
    while (priorEnd < logs.length && logs[priorEnd].date < date) priorEnd++;
    const prior = logs.slice(0, priorEnd);
    const today = logs.filter(g => g.date === date);

    const todayByTeam = new Map();
    for (const g of today) {
      if (!todayByTeam.has(g.team)) todayByTeam.set(g.team, new Set());
      todayByTeam.get(g.team).add(playerKey(g.name));
    }
    const extraOut = inferOutPlayers(prior, todayByTeam);

    const players = today.map(g => ({
      id: `${playerKey(g.name)}|${g.team}`,
      name: g.name,
      team: g.team,
      opponent: g.opponent,
      isB2B: g.isB2B
    }));
    const withInjuries = projectPlayers(players, prior, { extraOut, config });
    const withoutInjuries = projectPlayers(players, prior, { config, redistribute: false });

    for (let i = 0; i < today.length; i++) {
      const g = today[i];
      const m = withInjuries.get(players[i].id);
      const m0 = withoutInjuries.get(players[i].id);
      if (!m.hasModel) continue;

      let legacyProjection = null;
      const dvp = {};
      if (legacy) {
        const player = {
          name: g.name,
          team: g.team,
          opponent: g.opponent,
          position: g.position,
          rest_days: g.isB2B ? 0 : 1
        };
        const project = (dvpConfig) => projectionService.calculateEnhancedProjection(player, {
          slateDate: date, site, isB2B: g.isB2B, dvp: { config: dvpConfig, context: dvpContext }
        });
        const result = await project(undefined);
        if (!result.enhanced) continue;
        legacyProjection = result.enhanced_projection;
        for (const v of dvpVariants) {
          const r = await project({ mode: v.mode, weight: v.weight, cap: v.cap });
          dvp[v.label] = { projected: r.enhanced_projection, adjustment: r.adjustments.dvp };
        }
      }

      samples.push({
        date,
        name: g.name,
        team: g.team,
        actual: g.fp,
        actualMinutes: g.minutes,
        legacy: legacyProjection,
        dvp,
        minutes: m.points,
        minutesNoInjury: m0.points,
        projectedMinutes: m.minutes,
        projectedMinutesNoInjury: m0.minutes,
        seasonAvgMinutes: m.minutesBreakdown.seasonAvg,
        injuryAffected: Boolean(m.injury)
      });
    }
    projectionService.clearCache();
  }

  const minutesError = (field) => {
    const pairs = samples.map(s => ({ projected: s[field], actual: s.actualMinutes }));
    return computeErrorMetrics(pairs);
  };

  const blends = legacy
    ? weights.map(w => {
      const metrics = computeErrorMetrics(samples.map(s => ({ projected: blendProjection(s.minutes, s.legacy, w), actual: s.actual })));
      return { weight: w, ...metrics };
    })
    : [];

  const injured = samples.filter(s => s.injuryAffected);
  const report = {
    site,
    sample: {
      playerGames: samples.length,
      dates: new Set(samples.map(s => s.date)).size,
      dateRange: samples.length ? { from: samples[0].date, to: samples[samples.length - 1].date } : null,
      injuryAffected: injured.length
    },
    points: {
      legacy: legacy ? summarize(samples, 'legacy') : null,
      minutesModel: summarize(samples, 'minutes'),
      minutesModelNoInjury: summarize(samples, 'minutesNoInjury')
    },
    blends,
    dvpVariants: dvpVariants.map(v => {
      const rowsWithAdj = samples.filter(s => s.dvp[v.label]?.adjustment);
      return {
        ...v,
        ...computeErrorMetrics(samples.map(s => ({ projected: s.dvp[v.label].projected, actual: s.actual }))),
        adjusted: rowsWithAdj.length,
        meanAbsAdjustment: rowsWithAdj.length
          ? round(rowsWithAdj.reduce((sum, s) => sum + Math.abs(s.dvp[v.label].adjustment), 0) / rowsWithAdj.length)
          : 0
      };
    }),
    injuryAffected: {
      legacy: legacy ? summarize(injured, 'legacy') : null,
      minutesModel: summarize(injured, 'minutes'),
      minutesModelNoInjury: summarize(injured, 'minutesNoInjury')
    },
    minutes: {
      model: minutesError('projectedMinutes'),
      modelNoInjury: minutesError('projectedMinutesNoInjury'),
      seasonAverage: minutesError('seasonAvgMinutes'),
      injuryAffected: {
        model: computeErrorMetrics(injured.map(s => ({ projected: s.projectedMinutes, actual: s.actualMinutes }))),
        modelNoInjury: computeErrorMetrics(injured.map(s => ({ projected: s.projectedMinutesNoInjury, actual: s.actualMinutes })))
      }
    }
  };

  const best = blends.filter(b => b.mae !== null).sort((a, b) => a.mae - b.mae)[0];
  report.bestWeight = best ? best.weight : null;
  report.insights = [];
  if (legacy && report.points.legacy.mae !== null && best) {
    report.insights.push(`Best blend weight ${best.weight}: MAE ${best.mae} vs legacy ${report.points.legacy.mae} (${round(report.points.legacy.mae - best.mae)} FP better).`);
  }
  return report;
}

export default { runReplayBacktest };
