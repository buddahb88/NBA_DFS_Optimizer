/**
 * PLAYER CARD MATH (pure)
 *
 * Game-log summaries, consistency vs salary, projection track record and
 * team rating ranks for the player card (playerCardService.js).
 */

const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const r1 = (x) => (x === null || !Number.isFinite(x) ? null : Math.round(x * 10) / 10 + 0);
const r2 = (x) => (x === null || !Number.isFinite(x) ? null : Math.round(x * 100) / 100 + 0);
const r3 = (x) => (x === null || !Number.isFinite(x) ? null : Math.round(x * 1000) / 1000 + 0);
const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);
const sd = (xs) => {
  if (xs.length < 2) return null;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / xs.length);
};
const dateStr = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : v ? String(v).slice(0, 10) : null);

export const LOG_GAMES = 15;
export const VALUE_MULTIPLE = 5;

/** One played game (historical_games row) as a card game-log entry; salary from that night's snapshot. */
export function gameEntry(g, { fpColumn = 'dk_fantasy_points', salary = null } = {}) {
  const fp = num(g[fpColumn]);
  const minutes = num(g.minutes);
  const sal = num(salary);
  const target = sal ? (sal / 1000) * VALUE_MULTIPLE : null;
  return {
    date: dateStr(g.game_date),
    opponent: g.opponent ?? null,
    is_home: g.is_home === null || g.is_home === undefined ? null : Number(g.is_home) === 1,
    is_starter: g.is_starter === null || g.is_starter === undefined ? null : Number(g.is_starter) === 1,
    back_to_back: Number(g.is_back_to_back) === 1,
    season_type: g.season_type ?? 'regular',
    minutes: r1(minutes),
    fp: r2(fp),
    pts: num(g.points),
    reb: num(g.rebounds),
    ast: num(g.assists),
    stl: num(g.steals),
    blk: num(g.blocks),
    tov: num(g.turnovers),
    fg3m: num(g.fg3_made),
    fppm: fp !== null && minutes > 0 ? r3(fp / minutes) : null,
    salary: sal,
    value: fp !== null && sal ? r2(fp / (sal / 1000)) : null,
    target: target !== null ? r1(target) : null,
    hit: fp !== null && target !== null ? fp >= target : null,
  };
}

/** Averages of game-log entries: { games, fp, minutes, fppm, pts, reb, ast, fg3m, stocks }. */
export function averages(entries) {
  const list = entries.filter(e => e.minutes > 0);
  if (!list.length) return null;
  const avg = (f) => r1(mean(list.map(f).filter(v => v !== null && v !== undefined)));
  const fpSum = list.reduce((s, e) => s + (e.fp ?? 0), 0);
  const minSum = list.reduce((s, e) => s + (e.minutes ?? 0), 0);
  return {
    games: list.length,
    fp: avg(e => e.fp),
    minutes: avg(e => e.minutes),
    fppm: minSum > 0 ? r3(fpSum / minSum) : null,
    pts: avg(e => e.pts),
    reb: avg(e => e.reb),
    ast: avg(e => e.ast),
    fg3m: avg(e => e.fg3m),
    stocks: avg(e => (e.stl ?? 0) + (e.blk ?? 0)),
  };
}

/**
 * Form summary from played games (most recent first, all before the slate
 * date) of the current season and the one before:
 * { log (last LOG_GAMES, oldest first for charts), l5, l10, season, lastSeason,
 *   consistency: { std_dev, hit_rate, hit_games, priced_games }, trend }.
 */
export function summarizeForm(entries, { season, lastSeason } = {}) {
  const played = entries.filter(e => e.minutes > 0);
  const current = played.filter(e => e.seasonKey === season);
  const previous = played.filter(e => e.seasonKey === lastSeason);
  // Early in a season the L5 / L10 reach back into last season (as the radar's sample does)
  const recent = played;
  const l10 = recent.slice(0, 10);
  const priced = l10.filter(e => e.hit !== null);
  const fps = l10.map(e => e.fp).filter(v => v !== null);
  const l5 = averages(recent.slice(0, 5));
  const base = averages(current.length >= 3 ? current : previous);
  return {
    log: recent.slice(0, LOG_GAMES).reverse().map(({ seasonKey, ...e }) => e),
    l5,
    l10: averages(l10),
    season: averages(current),
    lastSeason: averages(previous),
    consistency: {
      std_dev: r1(sd(fps)),
      hit_rate: priced.length ? r3(priced.filter(e => e.hit).length / priced.length) : null,
      hit_games: priced.filter(e => e.hit).length,
      priced_games: priced.length,
      floor_game: fps.length ? Math.min(...fps) : null,
      ceiling_game: fps.length ? Math.max(...fps) : null,
    },
    trend: {
      minutes_delta_l5: l5 && base ? r1(l5.minutes - base.minutes) : null,
      fppm_delta_l5: l5 && base && l5.fppm !== null && base.fppm !== null ? r3(l5.fppm - base.fppm) : null,
      fp_delta_l5: l5 && base ? r1(l5.fp - base.fp) : null,
      baseline: current.length >= 3 ? 'season' : previous.length ? 'last_season' : null,
    },
  };
}

/**
 * Past projections vs actual: snapshots (one per date, before the slate
 * date) against played games by date. Returns { n, dnp, bias (actual -
 * projection), mae, beat_rate, recent: [{ date, projection, actual, salary }] }.
 */
export function trackRecord(snapshots, gamesByDate) {
  const rows = [];
  let dnp = 0;
  for (const s of snapshots) {
    const proj = num(s.projected_points);
    if (!(proj > 0)) continue;
    const g = gamesByDate.get(dateStr(s.game_date));
    if (!g || !(g.minutes > 0)) {
      dnp += 1;
      continue;
    }
    rows.push({ date: dateStr(s.game_date), projection: r1(proj), actual: g.fp, salary: num(s.salary) });
  }
  if (!rows.length) return { n: 0, dnp, bias: null, mae: null, beat_rate: null, recent: [] };
  const errors = rows.map(r => r.actual - r.projection);
  return {
    n: rows.length,
    dnp,
    bias: r1(mean(errors)),
    mae: r1(mean(errors.map(Math.abs))),
    beat_rate: r3(errors.filter(e => e > 0).length / rows.length),
    recent: rows.sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, 10).reverse(),
  };
}

/** One snapshot per game date: the latest captured (rows newest first win). */
export function snapshotsByDate(rows) {
  const out = new Map();
  for (const r of [...rows].sort((a, b) => String(b.captured_at ?? '').localeCompare(String(a.captured_at ?? '')))) {
    const d = dateStr(r.game_date);
    if (!out.has(d)) out.set(d, r);
  }
  return out;
}

/**
 * Ranks of computeTeamRatings teams: def_rank 1 = softest defense (highest
 * def_eff), pace_rank 1 = fastest. Map(team -> { def_eff, off_eff, pace, def_rank, pace_rank, teams, games }).
 */
export function rankTeams(teams, canon = (t) => t) {
  const list = (teams ?? []).filter(t => num(t.defEff) !== null);
  const byDef = [...list].sort((a, b) => b.defEff - a.defEff);
  const byPace = [...list].sort((a, b) => (b.pace ?? 0) - (a.pace ?? 0));
  const out = new Map();
  for (const t of list) {
    out.set(canon(t.team), {
      def_eff: r1(t.defEff),
      off_eff: r1(t.offEff),
      pace: r1(t.pace),
      games: t.games,
      def_rank: byDef.indexOf(t) + 1,
      pace_rank: byPace.indexOf(t) + 1,
      teams: list.length,
    });
  }
  return out;
}

export default { gameEntry, averages, summarizeForm, trackRecord, snapshotsByDate, rankTeams };
