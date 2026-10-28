/**
 * POINT-IN-TIME FEATURE STORE (model evaluation harness)
 *
 * Everything a projector may know about a game on date D, built from rows
 * strictly before D. All of historical_games, team_game_stats and
 * game_player_status is loaded once (loadFeatureData) and indexed in memory;
 * asOf(D) answers from binary-searched prefixes, so a two-season replay never
 * goes back to the database. Derived features are computed lazily and
 * memoized per date.
 *
 * asOf(D) (strictly before D):
 *   playerGames      box scores, most recent first (season filter, regular-only)
 *   minutesLogs      every played game as minutesModel game logs (oldest first)
 *   teamRest         days since the team's previous game this season (0 = B2B)
 *   teamGames        the team's games (team_game_stats), most recent first
 *   teamPlayerRows   box score rows of the team's last N games
 *   playerStatuses   a player's INACTIVE / DNP listings
 *   teamRatings      pace / offensive / defensive rating from team_game_stats,
 *                    season-to-date shrunk toward last season (RATING_PRIOR_GAMES)
 *   league           league pace / rating this season (last season while thin)
 *   expectedMargin   -spread, else the as-of net rating gap (blowout risk)
 *   profiles         season-to-date player_season_profiles rows
 *                    (playerProfileService.computeProfiles on games before D)
 *   archetype        classifyProfile on that profile; below the sample minimum,
 *                    last season's label (from last season's full profile)
 *   dvpContext       archetype / G-F-C defense (team_archetype_defense shape)
 *                    aggregated over this season's games before D with the
 *                    as-of labels; last season's table before the first game
 *
 * The stored player_season_profiles / player_archetypes / team_archetype_defense
 * rows for a season are full-season (lookahead) and are never read here: the
 * same code that builds them runs on the as-of rows instead.
 *
 * gameDay(D) is the one same-day read, the information available at lock:
 *   teams    who plays whom, home / away, and who is OUT: the game's INACTIVE
 *            listing (game_player_status), plus regulars missing from both the
 *            box score and the listing (projectionReplayBacktest.inferOutPlayers,
 *            15+ min over the team's last 5 games). Coach's-decision DNPs are
 *            not OUT: nobody knew before the game.
 *   players  the evaluation universe with outcomes: everyone with a box score
 *            row plus coach's-decision DNPs (0 points). The evaluator keeps the
 *            outcome fields away from projectors.
 */

import { computeProfiles } from '../playerProfileService.js';
import { classifyProfile } from '../archetypeService.js';
import { aggregateDefense, computeExpectations, GROUPINGS } from '../archetypeDefenseService.js';
import { buildDvpContext } from '../dvpAdjustment.js';
import { toGameLogs } from '../minutesProjectionService.js';
import { inferOutPlayers } from '../projectionReplayBacktest.js';
import { playerKey as modelKey } from '../minutesModel.js';
import { fantasyPointsColumn } from '../scoring.js';
import { previousSeason, seasonForDate, seasonStartDate } from '../../utils/season.js';
import { playerKey } from '../../utils/playerKey.js';

export const RATING_PRIOR_GAMES = 10;
export const HOME_COURT = 1.5; // points of expected margin each way
const LEAGUE_MIN_TEAM_GAMES = 50;
const VIEW_CACHE = 4;
export const STAT_FIELDS = Object.freeze({
  pts: 'points', reb: 'rebounds', ast: 'assists', stl: 'steals', blk: 'blocks', tov: 'turnovers', fg3m: 'fg3_made'
});

const n = (v) => Number(v) || 0;
const dateStr = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));
const byDateId = (a, b) => (a.game_date < b.game_date ? -1 : a.game_date > b.game_date ? 1 : n(a.id) - n(b.id));
const dayDiff = (a, b) => Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86400000);

/** Index of the first row dated on/after `date` (rows sorted by game_date). */
export function lowerBound(rows, date) {
  let lo = 0;
  let hi = rows.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (rows[mid].game_date < date) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

const push = (map, key, value) => {
  let list = map.get(key);
  if (!list) map.set(key, (list = []));
  list.push(value);
};

/** Per-game actual stats of a historical_games row. */
export function actualStats(row, fpColumn = 'dk_fantasy_points') {
  return {
    dk: n(row[fpColumn]),
    minutes: n(row.minutes),
    ...Object.fromEntries(Object.entries(STAT_FIELDS).map(([k, col]) => [k, n(row[col])]))
  };
}

function ratingsOf(rows, oppOf) {
  if (!rows.length) return null;
  let poss = 0, pts = 0, oppPts = 0, oppPoss = 0;
  for (const g of rows) {
    poss += n(g.possessions);
    pts += n(g.pts);
    const o = oppOf(g);
    if (o) { oppPts += n(o.pts); oppPoss += n(o.possessions); }
  }
  return {
    games: rows.length,
    pace: poss / rows.length,
    offRtg: poss > 0 ? (100 * pts) / poss : null,
    defRtg: oppPoss > 0 ? (100 * oppPts) / oppPoss : null
  };
}

const shrink = (cur, prior, games, k = RATING_PRIOR_GAMES) => {
  if (cur === null || cur === undefined) return prior ?? null;
  if (prior === null || prior === undefined) return cur;
  return (games * cur + k * prior) / (games + k);
};

/**
 * Index loaded rows. data: { site, games, teamGames, statuses } (loadFeatureData shapes).
 */
export function createFeatureStore(data) {
  const site = data.site ?? 'draftkings';
  const fpColumn = fantasyPointsColumn(site);

  const teamGames = (data.teamGames ?? []).map(g => ({
    ...g, game_date: dateStr(g.game_date), season: g.season || seasonForDate(dateStr(g.game_date))
  })).sort(byDateId);
  const teamGameOf = new Map(teamGames.map(g => [`${g.game_id}|${g.team}`, g]));
  const oppOf = (g) => teamGameOf.get(`${g.game_id}|${g.opponent}`);

  const games = (data.games ?? []).filter(r => r.player_key).map(r => {
    const game_date = dateStr(r.game_date);
    const t = teamGameOf.get(`${r.game_id}|${r.team}`);
    const o = t ? oppOf(t) : null;
    return {
      ...r,
      game_date,
      season: r.season || seasonForDate(game_date),
      season_type: r.season_type || 'regular',
      fp: n(r[fpColumn]),
      // computeProfiles' team context (playerProfileService.GAME_ROWS_SELECT)
      tm_minutes: t?.minutes ?? null, tm_fgm: t?.fgm ?? null, tm_fga: t?.fga ?? null, tm_fta: t?.fta ?? null,
      tm_tov: t?.tov ?? null, tm_oreb: t?.oreb ?? null, tm_dreb: t?.dreb ?? null,
      opp_fga: o?.fga ?? null, opp_fg3a: o?.fg3a ?? null, opp_oreb: o?.oreb ?? null, opp_dreb: o?.dreb ?? null,
      opp_possessions: o?.possessions ?? null
    };
  }).sort(byDateId);

  const statuses = (data.statuses ?? []).map(s => ({ ...s, game_date: dateStr(s.game_date) }));

  const byPlayer = new Map();
  const byDate = new Map();
  const bySeason = new Map(); // regular season, played: profiles / expectations input
  const played = [];
  for (const g of games) {
    push(byPlayer, g.player_key, g);
    push(byDate, g.game_date, g);
    if (n(g.minutes) > 0) {
      played.push(g);
      if (g.season_type === 'regular') push(bySeason, g.season, g);
    }
  }
  const playedLogs = toGameLogs(played, site);
  const teamRows = new Map();
  const teamGamesByDate = new Map();
  for (const g of teamGames) {
    push(teamRows, g.team, g);
    push(teamGamesByDate, g.game_date, g);
  }
  const statusesByDate = new Map();
  const statusesByPlayer = new Map();
  for (const s of [...statuses].sort(byDateId)) {
    push(statusesByDate, s.game_date, s);
    push(statusesByPlayer, s.player_key, s);
  }
  const byGame = new Map();
  for (const g of games) push(byGame, g.game_id, g);

  const dates = [...new Set([...byDate.keys(), ...teamGamesByDate.keys()])].sort();

  // Full-season derivations, used only for seasons before the as-of date's
  const memo = new Map();
  const once = (key, fn) => {
    if (!memo.has(key)) memo.set(key, fn());
    return memo.get(key);
  };
  const seasonProfiles = (season) => once(`profiles|${season}`, () =>
    new Map(computeProfiles(season, bySeason.get(season) ?? []).map(p => [p.player_key, p])));
  const seasonLabels = (season) => once(`labels|${season}`, () =>
    new Map([...seasonProfiles(season)].map(([k, p]) => [k, classifyProfile(p).archetype])));
  const seasonRatings = (season) => once(`ratings|${season}`, () => {
    const out = new Map();
    for (const [team, rows] of teamRows) {
      const r = ratingsOf(rows.filter(g => g.season === season), oppOf);
      if (r) out.set(team, r);
    }
    out.league = ratingsOf(teamGames.filter(g => g.season === season), oppOf);
    return out;
  });
  // Expected stats per player-game use earlier dates only, so the season's rows are point-in-time
  const seasonExpectations = (season) => once(`expectations|${season}`, () => {
    const priorTotals = new Map();
    for (const g of bySeason.get(previousSeason(season)) ?? []) {
      let t = priorTotals.get(g.player_key);
      if (!t) priorTotals.set(g.player_key, (t = { minutes: 0, dk: 0, fd: 0, yahoo: 0, pts: 0, reb: 0, ast: 0, fg3m: 0, stocks: 0 }));
      t.minutes += n(g.minutes);
      t.dk += n(g.dk_fantasy_points); t.fd += n(g.fd_fantasy_points); t.yahoo += n(g.yahoo_fantasy_points);
      t.pts += n(g.points); t.reb += n(g.rebounds); t.ast += n(g.assists); t.fg3m += n(g.fg3_made);
      t.stocks += n(g.steals) + n(g.blocks);
    }
    return computeExpectations(bySeason.get(season) ?? [], { priorTotals });
  });

  function createView(date) {
    const season = seasonForDate(date);
    const prior = previousSeason(season);
    const cache = new Map();
    const lazy = (key, fn) => {
      if (!cache.has(key)) cache.set(key, fn());
      return cache.get(key);
    };
    const seasonRowsBefore = () => lazy('seasonRows', () => {
      const rows = bySeason.get(season) ?? [];
      return rows.slice(0, lowerBound(rows, date));
    });

    const view = {
      date,
      season,
      priorSeason: prior,

      /**
       * A player's games before the date, most recent first.
       * seasons: 'current' | 'current+prior' (default) | 'all'; played: minutes > 0 only.
       */
      playerGames(key, { seasons = 'current+prior', regularOnly = false, played: playedOnly = true } = {}) {
        const rows = byPlayer.get(key) ?? [];
        const out = [];
        for (let i = lowerBound(rows, date) - 1; i >= 0; i--) {
          const g = rows[i];
          if (seasons === 'current' && g.season !== season) break;
          if (seasons === 'current+prior' && g.season !== season && g.season !== prior) break;
          if (regularOnly && g.season_type !== 'regular') continue;
          if (playedOnly && !(n(g.minutes) > 0)) continue;
          out.push(g);
        }
        return out;
      },

      /** Played games before the date as minutesModel game logs, oldest first (shared, do not mutate). */
      minutesLogs() {
        return lazy('logs', () => playedLogs.slice(0, lowerBound(played, date)));
      },

      /** { restDays, lastGame }: restDays 0 = back-to-back, null = first game of the season. */
      teamRest(team) {
        const rows = teamRows.get(team) ?? [];
        const last = rows[lowerBound(rows, date) - 1];
        if (!last || last.season !== season) return { restDays: null, lastGame: last?.game_date ?? null };
        return { restDays: dayDiff(date, last.game_date) - 1, lastGame: last.game_date };
      },

      /** A player's INACTIVE / DNP listings before the date, most recent first. */
      playerStatuses(key) {
        const rows = statusesByPlayer.get(key) ?? [];
        return rows.slice(0, lowerBound(rows, date)).reverse();
      },

      /** The team's games (team_game_stats rows) before the date, most recent first; seasons as playerGames. */
      teamGames(team, { seasons = 'current' } = {}) {
        const rows = teamRows.get(team) ?? [];
        const out = [];
        for (let i = lowerBound(rows, date) - 1; i >= 0; i--) {
          const g = rows[i];
          if (seasons === 'current' && g.season !== season) break;
          if (seasons === 'current+prior' && g.season !== season && g.season !== prior) break;
          out.push(g);
        }
        return out;
      },

      /** Box score rows of the team's last `games` games before the date (any season), most recent game first. */
      teamPlayerRows(team, { games: count = 10 } = {}) {
        return view.teamGames(team, { seasons: 'all' }).slice(0, count)
          .flatMap(g => (byGame.get(g.game_id) ?? []).filter(r => r.team === team));
      },

      /** League pace / offensive rating before the date (last season's while under 50 team games). */
      league() {
        return lazy('league', () => {
          const rows = teamGames.slice(0, lowerBound(teamGames, date)).filter(g => g.season === season);
          const cur = rows.length >= LEAGUE_MIN_TEAM_GAMES ? ratingsOf(rows, oppOf) : null;
          const r = cur ?? seasonRatings(prior).league ?? ratingsOf(rows, oppOf);
          return r ? { season: cur ? season : prior, games: r.games, pace: r.pace, rtg: r.offRtg } : null;
        });
      },

      /**
       * Team pace / ratings: season-to-date (raw), last season (prior: the
       * team's, else the league's), and shrunk: (n x raw + 10 x prior) / (n + 10).
       */
      teamRatings(team) {
        return lazy(`ratings|${team}`, () => {
          const rows = teamRows.get(team) ?? [];
          const before = rows.slice(0, lowerBound(rows, date)).filter(g => g.season === season);
          const raw = ratingsOf(before, oppOf);
          const last = seasonRatings(prior);
          const p = last.get(team) ?? last.league ?? null;
          const games = raw?.games ?? 0;
          const l10 = before.slice(-10);
          return {
            games,
            pace: shrink(raw?.pace, p?.pace, games),
            offRtg: shrink(raw?.offRtg, p?.offRtg, games),
            defRtg: shrink(raw?.defRtg, p?.defRtg, games),
            paceL10: l10.length ? l10.reduce((s, g) => s + n(g.possessions), 0) / l10.length : null,
            raw: raw ? { pace: raw.pace, offRtg: raw.offRtg, defRtg: raw.defRtg } : null,
            prior: p ? { pace: p.pace, offRtg: p.offRtg, defRtg: p.defRtg } : null
          };
        });
      },

      /**
       * Expected margin for `team` (+ = favored): -spread when a line is known,
       * else the shrunk net rating gap x average pace / 100 plus home court.
       */
      expectedMargin(team, opponent, isHome, spread = null) {
        if (spread !== null && Number.isFinite(Number(spread))) return -Number(spread);
        const a = view.teamRatings(team);
        const b = view.teamRatings(opponent);
        if (![a.offRtg, a.defRtg, b.offRtg, b.defRtg].every(Number.isFinite)) return 0;
        const pace = ((a.pace ?? 100) + (b.pace ?? 100)) / 2;
        return ((a.offRtg - a.defRtg) - (b.offRtg - b.defRtg)) * pace / 100 + (isHome ? HOME_COURT : -HOME_COURT);
      },

      /** Season-to-date profiles (player_season_profiles shape) from regular-season games before the date. */
      profiles() {
        return lazy('profiles', () => new Map(computeProfiles(season, seasonRowsBefore()).map(p => [p.player_key, p])));
      },

      /** Last season's full profile (complete before this season started). */
      priorSeasonProfile(key) {
        return seasonProfiles(prior).get(key) ?? null;
      },

      /** { current: as-of labels (classified only), prior: last season's labels }. */
      archetypeMaps() {
        return lazy('archetypes', () => {
          const current = new Map();
          for (const [key, p] of view.profiles()) {
            const label = classifyProfile(p).archetype;
            if (label !== 'unclassified') current.set(key, label);
          }
          return { current, prior: seasonLabels(prior) };
        });
      },

      /** { archetype, source: 'as-of' | 'prior-season' | 'none' } */
      archetype(key) {
        const { current, prior: last } = view.archetypeMaps();
        if (current.has(key)) return { archetype: current.get(key), source: 'as-of' };
        const label = last.get(key);
        if (label && label !== 'unclassified') return { archetype: label, source: 'prior-season' };
        return { archetype: 'unclassified', source: 'none' };
      },

      /** dvpAdjustment context (buildDvpContext) from defense before the date, as-of labels. */
      dvpContext() {
        return lazy('dvp', () => {
          const { current, prior: last } = view.archetypeMaps();
          const rows = seasonExpectations(season);
          let before = rows.slice(0, lowerBound(rows, date));
          let used = season;
          let labels = (key) => current.get(key) ?? last.get(key) ?? 'unclassified';
          if (!before.length) {
            // Before the season's first game: last season's full table and labels
            before = seasonExpectations(prior);
            used = prior;
            const older = seasonLabels(previousSeason(prior));
            labels = (key) => {
              const l = last.get(key);
              return l && l !== 'unclassified' ? l : older.get(key) ?? 'unclassified';
            };
          }
          const relabeled = before.map(g => ({ ...g, archetype: labels(g.player_key) }));
          const defenseRows = GROUPINGS.flatMap(grouping => aggregateDefense(relabeled, { site, grouping }));
          return buildDvpContext({ defenseRows, archetypes: current, priorArchetypes: last, season: used, site });
        });
      }
    };
    return view;
  }

  const views = new Map();
  function asOf(date) {
    let view = views.get(date);
    if (!view) {
      view = createView(date);
      views.set(date, view);
      while (views.size > VIEW_CACHE) views.delete(views.keys().next().value);
    }
    return view;
  }

  /**
   * Same-day context for date: teams playing (with OUT lists) and the
   * evaluation universe with outcomes. See the header.
   */
  function gameDay(date) {
    const view = asOf(date);
    const rows = byDate.get(date) ?? [];
    const listed = statusesByDate.get(date) ?? [];

    const teams = new Map();
    for (const g of teamGamesByDate.get(date) ?? []) {
      teams.set(g.team, { team: g.team, gameId: g.game_id, opponent: g.opponent, isHome: n(g.is_home) === 1, out: [] });
    }
    for (const r of rows) {
      if (!teams.has(r.team)) teams.set(r.team, { team: r.team, gameId: r.game_id, opponent: r.opponent, isHome: n(r.is_home) === 1, out: [] });
    }

    const expectedMinutes = (key) => {
      const recent = view.playerGames(key, { seasons: 'all' }).slice(0, 5);
      return recent.length ? recent.reduce((s, g) => s + n(g.minutes), 0) / recent.length : 0;
    };

    for (const s of listed) {
      if (String(s.status).toUpperCase() !== 'INACTIVE' || !teams.has(s.team)) continue;
      teams.get(s.team).out.push({ key: s.player_key, name: s.player_name, source: 'status', reason: s.reason ?? null, expectedMinutes: expectedMinutes(s.player_key) });
    }
    // Regulars with neither a box score row nor a listing, from this season's games
    // (inferOutPlayers keys by minutesModel.playerKey(name), so mark both spellings)
    const logs = view.minutesLogs();
    const seasonStart = lowerBound(played, seasonStartDate(view.season));
    const present = new Map([...teams.keys()].map(team => [team, new Set()]));
    for (const r of rows) present.get(r.team)?.add(r.player_key).add(modelKey(r.player_name));
    for (const s of listed) present.get(s.team)?.add(s.player_key).add(modelKey(s.player_name));
    for (const o of inferOutPlayers(logs.slice(seasonStart), present)) {
      const key = playerKey(o.name);
      teams.get(o.team)?.out.push({ key, name: o.name, source: 'inferred', reason: null, expectedMinutes: expectedMinutes(key) });
    }

    const players = rows.map(r => ({
      key: r.player_key,
      name: r.player_name,
      team: r.team,
      opponent: r.opponent,
      position: r.position ?? null,
      gameId: r.game_id,
      isHome: n(r.is_home) === 1,
      seasonType: r.season_type,
      isStarter: n(r.is_starter) === 1,
      played: n(r.minutes) > 0,
      status: n(r.minutes) > 0 ? 'PLAYED' : 'DNP',
      actual: actualStats(r, fpColumn)
    }));
    const inBox = new Set(rows.map(r => `${r.team}|${r.player_key}`));
    for (const s of listed) {
      if (String(s.status).toUpperCase() !== 'DNP' || inBox.has(`${s.team}|${s.player_key}`)) continue;
      const t = teams.get(s.team);
      if (!t) continue;
      const last = view.playerGames(s.player_key, { seasons: 'all', played: false })[0];
      players.push({
        key: s.player_key,
        name: s.player_name,
        team: s.team,
        opponent: t.opponent,
        position: last?.position ?? null,
        gameId: s.game_id,
        isHome: t.isHome,
        seasonType: rows.find(r => r.team === s.team)?.season_type ?? 'regular',
        isStarter: false,
        played: false,
        status: 'DNP',
        actual: { dk: 0, minutes: 0, ...Object.fromEntries(Object.keys(STAT_FIELDS).map(k => [k, 0])) }
      });
    }
    return { date, season: view.season, teams, players };
  }

  /** A store over the rows before `date` only (fitting on a training window). */
  function restrictTo(date) {
    return createFeatureStore({
      site,
      games: (data.games ?? []).filter(r => dateStr(r.game_date) < date),
      teamGames: (data.teamGames ?? []).filter(r => dateStr(r.game_date) < date),
      statuses: statuses.filter(r => r.game_date < date)
    });
  }

  return { site, fpColumn, dates, asOf, gameDay, restrictTo, size: { games: games.length, teamGames: teamGames.length, statuses: statuses.length } };
}
