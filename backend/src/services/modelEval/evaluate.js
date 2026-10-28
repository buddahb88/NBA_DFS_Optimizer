/**
 * Evaluation loop of the model harness: runs projectors walk-forward over
 * replay dates or saved slates and scores them. Pure apart from the
 * projectors themselves (the database is read by modelEvalService).
 *
 * Each date: view = store.asOf(date) (history strictly before it) and the
 * day's teams / OUT lists; every projector gets prepareDate(dateCtx) once and
 * project(ctx) per player. ctx.player carries no outcome (actual, played,
 * starter); those stay on the scored row.
 *
 * Rows: { mode, date, season, seasonType, slateId, key, name, team, played,
 *   status, salary, actual: { dk, minutes, pts, ... }, tags, preds: { [name]: Prediction | null } }
 * Tags (breakdowns): minutesBucket (as-of last-5 average minutes), role
 * (started the game; DNPs are bench), archetype (as-of), rest (team rest
 * days), teammateOut (an OUT teammate averaging 20+ minutes), salaryTier (slates).
 */

import { salaryTier, SALARY_TIERS } from '../projectionBacktestService.js';
import { inferOutPlayers } from '../projectionReplayBacktest.js';
import { playerKey as modelKey } from '../minutesModel.js';
import { playerKey } from '../../utils/playerKey.js';
import { seasonStartDate } from '../../utils/season.js';
import { breakdown, pairedBootstrap, scoreProjector } from './metrics.js';

const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const now = () => Number(process.hrtime.bigint() / 1000000n);

export const MINUTES_BUCKETS = ['no history', '<15', '15-24', '24-30', '30+'];
export const REST_BUCKETS = ['B2B', '1 day', '2+ days', 'first game'];
const TEAMMATE_OUT_MINUTES = 20;

/** Pre-game player context (no outcome fields) for a gameDay player. */
export function contextPlayer(p, view, day, { out = false } = {}) {
  const rest = view.teamRest(p.team);
  const teamOut = (day.teams.get(p.team)?.out ?? []).filter(o => o.key !== p.key);
  return {
    key: p.key,
    name: p.name,
    team: p.team,
    opponent: p.opponent,
    position: p.position ?? null,
    gameId: p.gameId ?? null,
    isHome: Boolean(p.isHome),
    seasonType: p.seasonType ?? 'regular',
    restDays: rest.restDays,
    isB2B: rest.restDays === 0,
    out: Boolean(out),
    teamOut,
    opponentOut: day.teams.get(p.opponent)?.out ?? []
  };
}

function minutesBucket(view, key) {
  const recent = view.playerGames(key).slice(0, 5);
  if (!recent.length) return 'no history';
  const avg = recent.reduce((s, g) => s + (Number(g.minutes) || 0), 0) / recent.length;
  return avg < 15 ? '<15' : avg < 24 ? '15-24' : avg < 30 ? '24-30' : '30+';
}

function tagsFor(outcome, player, view, salary) {
  const r = player.restDays;
  return {
    minutesBucket: minutesBucket(view, player.key),
    role: outcome.isStarter ? 'starter' : 'bench',
    archetype: view.archetype(player.key).archetype,
    rest: r === null ? 'first game' : r === 0 ? 'B2B' : r === 1 ? '1 day' : '2+ days',
    teammateOut: player.teamOut.some(o => o.expectedMinutes >= TEAMMATE_OUT_MINUTES) ? 'teammate out' : 'none out',
    salaryTier: salary > 0 ? salaryTier(salary) : null
  };
}

const normalize = (pred) => (pred && finite(pred.dk_points) ? pred : null);

/**
 * Score one date / slate. entries: [{ outcome, player, slate }] where outcome
 * holds { played, status, actual, isStarter }.
 */
async function scoreEntries({ mode, date, slateId = null, view, day, site, entries, projectors, timings }) {
  const dateCtx = {
    mode, date, season: view.season, site, view, day: { teams: day.teams },
    players: entries.map(e => ({ ...e.player, slate: e.slate })),
    shared: new Map()
  };
  const preds = entries.map(() => ({}));
  for (const proj of projectors) {
    const t0 = now();
    if (proj.prepareDate) await proj.prepareDate({ ...dateCtx, slate: slateId ? { slateId } : null });
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      preds[i][proj.name] = normalize(await proj.project({ ...dateCtx, player: e.player, slate: e.slate }));
    }
    timings[proj.name] = (timings[proj.name] ?? 0) + now() - t0;
  }
  return entries.map((e, i) => ({
    mode,
    date,
    season: view.season,
    seasonType: e.player.seasonType,
    slateId,
    key: e.player.key,
    name: e.player.name,
    team: e.player.team,
    played: e.outcome.played,
    status: e.outcome.status,
    salary: e.slate?.salary ?? null,
    actual: e.outcome.actual,
    tags: tagsFor(e.outcome, e.player, view, e.slate?.salary ?? null),
    preds: preds[i]
  }));
}

const supports = (mode) => (p) => (p.modes ?? ['replay', 'slate']).includes(mode);

/**
 * Walk-forward replay over the store's dates. options: { from, to, seasons,
 * onDate(date, i, total) }. Returns { rows, dates, timings: { [projector]: ms } }.
 */
export async function runReplay(store, projectors, { from = null, to = null, seasons = null, onDate = null } = {}) {
  const active = projectors.filter(supports('replay'));
  const dates = store.dates.filter(d => (!from || d >= from) && (!to || d <= to));
  const timings = {};
  const rows = [];
  let used = 0;
  for (let i = 0; i < dates.length; i++) {
    const date = dates[i];
    const view = store.asOf(date);
    if (seasons && !seasons.includes(view.season)) continue;
    const day = store.gameDay(date);
    if (!day.players.length) continue;
    const entries = day.players.map(p => ({ outcome: p, player: contextPlayer(p, view, day), slate: null }));
    rows.push(...await scoreEntries({ mode: 'replay', date, view, day, site: store.site, entries, projectors: active, timings }));
    used++;
    onDate?.(date, i, dates.length);
  }
  return { rows, dates: used, timings };
}

/**
 * Saved slates. slates: [{ slateId, date, players: [{ key, name, team, opponent,
 * position, isHome, out, slate: {...}, outcome: { played, status, actual, isStarter } }] }].
 * OUT lists are what was known before lock: the game's INACTIVE listing, the
 * slate's OUT injury statuses, and regulars (15+ min over the team's last 5
 * games this season) missing from the slate pool - RotoWire leaves OUT players
 * out rather than flagging them (no box-score inference).
 */
export async function runSlates(store, projectors, slates, { onSlate = null } = {}) {
  const active = projectors.filter(supports('slate'));
  const timings = {};
  const rows = [];
  for (const s of slates) {
    const view = store.asOf(s.date);
    const base = store.gameDay(s.date);
    const teams = new Map([...base.teams].map(([team, t]) => [team, { ...t, out: t.out.filter(o => o.source === 'status') }]));
    const expectedMinutes = (key) => {
      const recent = view.playerGames(key, { seasons: 'all' }).slice(0, 5);
      return recent.length ? recent.reduce((x, g) => x + (Number(g.minutes) || 0), 0) / recent.length : 0;
    };
    const addOut = (t, o) => { if (!t.out.some(x => x.key === o.key)) t.out.push({ ...o, expectedMinutes: expectedMinutes(o.key) }); };
    for (const p of s.players) {
      if (!p.out) continue;
      const t = teams.get(p.team) ?? { team: p.team, opponent: p.opponent, isHome: p.isHome, gameId: null, out: [] };
      teams.set(p.team, t);
      addOut(t, { key: p.key, name: p.name, source: 'slate', reason: p.slate?.injuryStatus ?? null });
    }
    // RotoWire drops OUT players from the pool instead of flagging them: regulars of the
    // slate's teams missing from the pool (and from the listings) are OUT, as replay infers
    // from the box score
    const present = new Map();
    for (const p of s.players) {
      if (!present.has(p.team)) present.set(p.team, new Set());
      present.get(p.team).add(p.key).add(modelKey(p.name));
    }
    for (const [team, keys] of present) for (const o of teams.get(team)?.out ?? []) keys.add(o.key).add(modelKey(o.name));
    for (const o of inferOutPlayers(view.minutesLogs().filter(g => g.date >= seasonStartDate(view.season)), present)) {
      const t = teams.get(o.team);
      if (t) addOut(t, { key: playerKey(o.name), name: o.name, source: 'slate-pool', reason: null });
    }
    const day = { teams };
    const entries = s.players.map(p => ({
      outcome: p.outcome,
      player: contextPlayer({ ...p, seasonType: p.seasonType ?? 'regular' }, view, day, { out: p.out }),
      slate: { ...p.slate, slateId: s.slateId }
    }));
    rows.push(...await scoreEntries({ mode: 'slate', date: s.date, slateId: s.slateId, view, day, site: store.site, entries, projectors: active, timings }));
    onSlate?.(s);
  }
  return { rows, slates: slates.length, timings };
}

/** Call fit() on projectors that have one, with a store cut at `until`. */
export async function fitProjectors(store, projectors, { until, seasons = [] } = {}) {
  const fitting = projectors.filter(p => p.fit);
  if (!fitting.length) return {};
  const train = store.restrictTo(until);
  const timings = {};
  for (const p of fitting) {
    const t0 = now();
    await p.fit({ store: train, until, seasons, site: store.site });
    timings[p.name] = now() - t0;
  }
  return timings;
}

/** Rows grouped by season with a role: train | validation | holdout. */
export function segmentBySeason(rows, { train = [], validation = [] } = {}) {
  const bySeason = new Map();
  for (const r of rows) {
    if (!bySeason.has(r.season)) bySeason.set(r.season, []);
    bySeason.get(r.season).push(r);
  }
  return [...bySeason.keys()].sort().map(season => ({
    season,
    role: train.includes(season) ? 'train' : validation.includes(season) ? 'validation' : 'holdout',
    rows: bySeason.get(season)
  }));
}

/**
 * Leaderboard, paired bootstrap vs the baseline and breakdowns, on the rows
 * every projector in `names` projected (common set), for players who played
 * and for everyone (DNPs score 0).
 * options: { baseline, iterations, seed, cluster(row) for the bootstrap }
 */
export function summarizeRows(rows, names, { baseline = null, iterations = 1000, seed = 1, cluster = null } = {}) {
  const summarize = (subset) => {
    const common = subset.filter(r => names.every(name => r.preds[name]));
    const leaderboard = names.map(name => ({ projector: name, ...scoreProjector(common, name) }))
      .sort((a, b) => (a.mae ?? Infinity) - (b.mae ?? Infinity));
    const paired = baseline && names.includes(baseline)
      ? names.filter(name => name !== baseline).map(name => ({ projector: name, vs: baseline, ...pairedBootstrap(common, name, baseline, { iterations, seed, cluster }) }))
      : [];
    const by = (fn, order) => breakdown(common, fn, names, order);
    const breakdowns = {
      minutes: by(r => r.tags.minutesBucket, MINUTES_BUCKETS),
      role: by(r => r.tags.role, ['starter', 'bench']),
      archetype: by(r => r.tags.archetype),
      rest: by(r => r.tags.rest, REST_BUCKETS),
      teammateOut: by(r => r.tags.teammateOut, ['teammate out', 'none out'])
    };
    if (common.some(r => r.tags.salaryTier)) breakdowns.salaryTier = by(r => r.tags.salaryTier, SALARY_TIERS.map(t => t.label));
    if (new Set(common.map(r => r.seasonType)).size > 1) breakdowns.seasonType = by(r => r.seasonType, ['regular', 'play-in', 'playoffs']);
    return {
      rows: subset.length,
      common: common.length,
      coverage: Object.fromEntries(names.map(name => [name, subset.filter(r => r.preds[name]).length])),
      leaderboard,
      paired,
      breakdowns
    };
  };
  return { played: summarize(rows.filter(r => r.played)), withDnp: summarize(rows) };
}

/**
 * Wrap a projector so predictions already in `cache` (Map) are reused and
 * new ones are added. prepareDate is skipped when the whole date is cached.
 */
export function withPredictionCache(projector, cache) {
  const keyOf = (ctx, player) => `${ctx.mode}|${ctx.date}|${ctx.slate?.slateId ?? ''}|${player.key}|${player.team}`;
  return {
    ...projector,
    async prepareDate(dateCtx) {
      if (!projector.prepareDate) return;
      if (dateCtx.players.every(p => cache.has(keyOf({ ...dateCtx, slate: p.slate ?? dateCtx.slate }, p)))) return;
      await projector.prepareDate(dateCtx);
    },
    async project(ctx) {
      const k = keyOf(ctx, ctx.player);
      if (cache.has(k)) return cache.get(k);
      const pred = normalize(await projector.project(ctx));
      cache.set(k, pred);
      return pred;
    }
  };
}

export default { runReplay, runSlates, fitProjectors, summarizeRows, segmentBySeason, contextPlayer, withPredictionCache };
