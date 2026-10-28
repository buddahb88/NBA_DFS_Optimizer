/**
 * PROJECTOR INTERFACE + BASELINE REGISTRY (model evaluation harness)
 *
 * A projector turns one player's pre-game context into a prediction:
 *
 *   {
 *     name, label, description,
 *     modes: ['replay', 'slate'],      // where it can run (RotoWire only exists on slates)
 *     version: '1',                    // bump when output changes (invalidates the prediction cache)
 *     cacheable: true,                 // predictions may be cached on disk per data signature
 *     fit?({ store, until, seasons, site }),   // once per run; store holds only rows before `until`
 *     prepareDate?(dateCtx),           // once per date / slate, before project() (batch work)
 *     project(ctx) -> Prediction | null,       // null = cannot project this player
 *     finish?()                        // after the run (release / restore state)
 *   }
 *
 *   Prediction: { dk_points, minutes?, stats?: { pts, reb, ast, stl, blk, tov, fg3m }, p10?, p90? }
 *
 *   ctx = dateCtx + { player }:
 *     mode, date, season, site
 *     view      featureStore.asOf(date): everything strictly before the date
 *     day       { teams: Map(team -> { opponent, isHome, gameId, out: [...] }) }
 *     players   every player's context on the date / slate (player fields + slate)
 *     shared    Map for batch work shared by projectors on this date
 *     slate     null in replay; on slates { slateId, salary, rotowire, rotowireMinutes,
 *               adjusted, adjustedMinutes, floor, ceiling, adjustedFloor, adjustedCeiling,
 *               spread, impliedTotal, overUnder, injuryStatus, ownership }
 *     player    { key, name, team, opponent, position, gameId, isHome, seasonType,
 *               restDays, isB2B, out, teamOut, opponentOut } - no outcome fields
 *
 * Register a new model with registerProjector(name, factory, meta); the
 * harness, script and API pick it up by name.
 */

import projectionService from '../projectionService.js';
import { buildOpponentFactors, projectFppm, projectPlayers, resolveConfig } from '../minutesModel.js';
import { fantasyPointsColumn } from '../scoring.js';
import { playerKey } from '../../utils/playerKey.js';
import { quantile, STATS } from './metrics.js';
import { STAT_FIELDS } from './featureStore.js';
import { createMinutesV2Projector } from './minutesV2.js';
import { createRatesV1Projector } from './ratesV1.js';

const n = (v) => Number(v) || 0;
const mean = (xs) => (xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : null);
const RANGE_GAMES = 20;
const RANGE_MIN_GAMES = 5;

/** Per-game means of fantasy points, minutes and box stats over games. */
function averages(games) {
  return {
    dk_points: mean(games.map(g => n(g.fp))),
    minutes: mean(games.map(g => n(g.minutes))),
    stats: Object.fromEntries(STATS.map(s => [s, mean(games.map(g => n(g[STAT_FIELDS[s]])))]))
  };
}

/** Empirical p10 / p90 of a player's last RANGE_GAMES fantasy scores (current + last season). */
function empiricalRange(view, key) {
  const recent = view.playerGames(key).slice(0, RANGE_GAMES).map(g => n(g.fp)).sort((a, b) => a - b);
  if (recent.length < RANGE_MIN_GAMES) return {};
  return { p10: quantile(recent, 0.1), p90: quantile(recent, 0.9) };
}

/** This season's games before the date, else last season's. */
function seasonGames(view, key) {
  const current = view.playerGames(key, { seasons: 'current' });
  if (current.length) return current;
  return view.playerGames(key).filter(g => g.season === view.priorSeason);
}

/** Players ruled OUT before lock (slate injury status) project 0 in our models. */
const knownOut = (project) => (ctx) => (ctx.player.out ? { dk_points: 0, minutes: 0 } : project(ctx));

function seasonAverage() {
  return {
    project: knownOut(({ view, player }) => {
      const games = seasonGames(view, player.key);
      if (!games.length) return null;
      return { ...averages(games), ...empiricalRange(view, player.key) };
    })
  };
}

function lastFiveAverage() {
  return {
    project: knownOut(({ view, player }) => {
      const games = view.playerGames(player.key).slice(0, 5);
      if (!games.length) return null;
      return averages(games);
    })
  };
}

function minutesTimesFppm() {
  return {
    project: knownOut(({ view, player }) => {
      const recent = view.playerGames(player.key).slice(0, 10);
      const season = seasonGames(view, player.key);
      const minutes = season.reduce((s, g) => s + n(g.minutes), 0);
      if (!recent.length || !(minutes > 0)) return null;
      const fppm = season.reduce((s, g) => s + n(g.fp), 0) / minutes;
      const l10 = mean(recent.map(g => n(g.minutes)));
      return { minutes: l10, dk_points: l10 * fppm };
    })
  };
}

/**
 * projectionService.calculateEnhancedProjection (the app's historical blend +
 * adjustments) with point-in-time inputs and no RotoWire baseline:
 *   - game logs primed into its cache from the feature store (no DB reads)
 *   - archetype DVP from the as-of context (featureStore.dvpContext)
 *   - defense / pace rankings and the legacy position DVP excluded: their
 *     tables (team_defense_rankings, team_defense_vs_position) hold current
 *     values only, so they would leak
 *   - Vegas inputs on slates only (no lines exist for past seasons)
 */
function legacyEnhanced() {
  let dvp = null;
  const saved = { defenseRankings: undefined, positionDefenseData: undefined };
  return {
    async prepareDate({ date, view, players, site }) {
      if (saved.defenseRankings === undefined) {
        saved.defenseRankings = projectionService.defenseRankings;
        saved.positionDefenseData = projectionService.positionDefenseData;
      }
      projectionService.clearCache();
      projectionService.defenseRankings = {};
      projectionService.positionDefenseData = {};
      const column = fantasyPointsColumn(site);
      for (const p of players) {
        const games = view.playerGames(p.key, { regularOnly: true }).map(g => ({
          player_key: g.player_key, team: g.team, opponent: g.opponent, game_date: g.game_date, season: g.season,
          minutes: g.minutes, is_home: g.is_home, is_back_to_back: g.is_back_to_back, fp: n(g.fp)
        }));
        for (const k of new Set([p.key, playerKey(p.name)])) projectionService.gamesCache.set(`${k}|${date}|${column}`, games);
      }
      dvp = { context: view.dvpContext() };
    },
    async project({ date, site, player, slate }) {
      if (player.out) return { dk_points: 0, minutes: 0 };
      const r = await projectionService.calculateEnhancedProjection({
        name: player.name,
        team: player.team,
        opponent: player.opponent,
        position: player.position,
        is_home: player.isHome ? 1 : 0,
        rest_days: player.restDays,
        vegas_implied_total: slate?.impliedTotal ?? null,
        vegas_over_under: slate?.overUnder ?? null,
        vegas_spread: slate?.spread ?? null
      }, { slateDate: date, site, isB2B: player.isB2B, isHome: player.isHome, dvp });
      if (!r.enhanced) return null;
      return { dk_points: r.enhanced_projection };
    },
    finish() {
      projectionService.clearCache();
      projectionService.defenseRankings = saved.defenseRankings ?? null;
      projectionService.positionDefenseData = saved.positionDefenseData ?? null;
    }
  };
}

/**
 * minutesModel.projectPlayers over every played game before the date (as
 * projectionReplayBacktest), OUT players from the day's lists (and slate
 * injury statuses) handed to teammates; slate spread / implied total when
 * known. No RotoWire minutes.
 */
function minutesModelProjector({ redistribute = true, config = {} } = {}) {
  const resolved = resolveConfig(config);
  const memoKey = `minutesModel|${redistribute}|${JSON.stringify(config)}`;
  return {
    prepareDate({ view, day, players, slate, shared }) {
      if (shared.has(memoKey)) return;
      const input = players.map(p => ({
        id: `${p.key}|${p.team}`,
        name: p.name,
        team: p.team,
        opponent: p.opponent,
        isB2B: p.isB2B,
        spread: p.slate?.spread ?? null,
        impliedTotal: p.slate?.impliedTotal ?? null,
        out: p.out
      }));
      const onDate = new Set(players.map(p => p.team));
      const extraOut = [...day.teams.values()].filter(t => onDate.has(t.team))
        .flatMap(t => t.out.map(o => ({ name: o.name, team: t.team })));
      shared.set(memoKey, projectPlayers(input, view.minutesLogs(), { extraOut, config: resolved, redistribute }));
    },
    project({ player, shared }) {
      const m = shared.get(memoKey)?.get(`${player.key}|${player.team}`);
      if (!m) return null;
      if (m.out) return { dk_points: 0, minutes: 0 };
      if (!m.hasModel) return null;
      return { dk_points: m.points, minutes: m.minutes };
    }
  };
}

const rotowire = (field, minutesField, floorField, ceilingField) => () => ({
  project({ slate }) {
    const points = slate?.[field];
    if (!Number.isFinite(points)) return null;
    const out = { dk_points: points, minutes: Number.isFinite(slate[minutesField]) ? slate[minutesField] : null };
    if (Number.isFinite(slate[floorField]) && Number.isFinite(slate[ceilingField])) {
      out.p10 = slate[floorField];
      out.p90 = slate[ceilingField];
    }
    return out;
  }
});

/**
 * RotoWire's minutes x our FPPM (minutesModel.projectFppm, as minutes_v2), so
 * minutes sources compare in DK points with everything else equal.
 */
function rotowireMinutesTimesFppm() {
  const memoKey = 'opponentFactors';
  const config = resolveConfig();
  return {
    prepareDate({ view, shared }) {
      if (!shared.has(memoKey)) shared.set(memoKey, buildOpponentFactors(view.minutesLogs(), config));
    },
    project({ view, player, slate, shared }) {
      const minutes = slate?.rotowireMinutes;
      if (!Number.isFinite(minutes)) return null;
      if (player.out) return { dk_points: 0, minutes: 0 };
      const games = view.playerGames(player.key, { seasons: 'all' }).map(g => ({ minutes: n(g.minutes), fp: n(g.fp) }));
      const factors = shared.get(memoKey);
      const fppm = projectFppm(games, { opponent: player.opponent, impliedTotal: slate.impliedTotal ?? null, opponentFactors: factors }, config)?.fppm
        ?? factors.leagueFppm * 0.8;
      return { dk_points: minutes * fppm, minutes };
    }
  };
}

const REGISTRY = new Map();

/**
 * Add a projector. factory(options) returns { project, prepareDate?, fit?, finish? };
 * meta: { label, description, modes = ['replay', 'slate'], version = '1', cacheable = true }.
 */
export function registerProjector(name, factory, meta = {}) {
  REGISTRY.set(name, { name, factory, label: meta.label ?? name, description: meta.description ?? '', modes: meta.modes ?? ['replay', 'slate'], version: String(meta.version ?? '1'), cacheable: meta.cacheable !== false });
}

registerProjector('season_avg', seasonAverage, {
  label: 'Season avg', description: 'Season-to-date DK average (last season before the first game); p10/p90 from the last 20 games'
});
registerProjector('last5_avg', lastFiveAverage, { label: 'Last 5 avg', description: 'Mean of the last 5 played games' });
registerProjector('l10_minutes_x_fppm', minutesTimesFppm, {
  label: 'L10 min x FPPM', description: 'Last-10 average minutes x season-to-date FP per minute'
});
registerProjector('legacy', legacyEnhanced, {
  label: 'Legacy enhanced', version: '1',
  description: 'projectionService.calculateEnhancedProjection, point-in-time inputs, no RotoWire blend'
});
registerProjector('minutes_model', () => minutesModelProjector(), {
  label: 'Minutes model', description: 'minutesModel minutes x FPPM with OUT-teammate redistribution'
});
registerProjector('minutes_model_no_redistribution', () => minutesModelProjector({ redistribute: false }), {
  label: 'Minutes model (no redist.)', description: 'minutesModel minutes x FPPM, no injury redistribution'
});
registerProjector('minutes_v2', (options) => createMinutesV2Projector(options), {
  label: 'Minutes v2', version: '2',
  description: 'Our minutes model (recency / role / p_play / team total / blowout, fit on 2024-25) x FPPM; minutes p10/p90'
});
registerProjector('rates_v1', (options) => createRatesV1Projector(options), {
  label: 'Rates v1', version: '1',
  description: 'Our per-minute production (per-stat rates: shrinkage, usage with OUT teammates, pace, archetype defense; fit on 2024-25) x minutes_v2, DK by simulation'
});
registerProjector('rates_v1_rotowire_minutes', (options) => createRatesV1Projector({ ...options, minutesSource: 'rotowire' }), {
  label: 'Rates v1 x RotoWire min', modes: ['slate'], version: '1',
  description: 'rates_v1 per-minute production x RotoWire projected minutes (rates compared with the minutes held equal)'
});
registerProjector('rotowire_minutes_x_fppm', rotowireMinutesTimesFppm, {
  label: 'RotoWire min x FPPM', modes: ['slate'],
  description: 'RotoWire projected minutes x the minutesModel FPPM (as minutes_v2): a minutes-only comparison in DK points'
});
registerProjector('rotowire_raw', rotowire('rotowire', 'rotowireMinutes', 'floor', 'ceiling'), {
  label: 'RotoWire raw', modes: ['slate'], cacheable: false,
  description: 'Posted RotoWire projection / minutes; floor / ceiling stand in for p10 / p90'
});
registerProjector('rotowire_adjusted', rotowire('adjusted', 'adjustedMinutes', 'adjustedFloor', 'adjustedCeiling'), {
  label: 'RotoWire sanity-adjusted', modes: ['slate'], cacheable: false,
  description: 'RotoWire after the projection sanity layer with the app default components'
});

/** Registered projectors: [{ name, label, description, modes, version, cacheable }]. */
export function listProjectors() {
  return [...REGISTRY.values()].map(({ factory, ...meta }) => meta);
}

/** A fresh projector instance (state is per run). */
export function createProjector(name, options = {}) {
  const entry = REGISTRY.get(name);
  if (!entry) throw new Error(`Unknown projector "${name}" (known: ${[...REGISTRY.keys()].join(', ')})`);
  const { factory, ...meta } = entry;
  return { ...meta, ...factory(options) };
}

export const DEFAULT_PROJECTORS = Object.freeze([...REGISTRY.keys()]);

export default { registerProjector, listProjectors, createProjector, DEFAULT_PROJECTORS };
