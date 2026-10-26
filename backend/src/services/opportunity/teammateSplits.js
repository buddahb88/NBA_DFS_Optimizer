/**
 * OPPORTUNITY TEAMMATE SPLITS
 *
 * Pure math behind teammate-out opportunity. Game rows are
 * playerProfileService GAME_ROWS_SELECT rows plus `fp`, the slate site's
 * fantasy points.
 *
 * - play_share: the share of the team's plays a player used,
 *   Σ(FGA + 0.44 FTA + TOV) / Σ(TmFGA + 0.44 TmFTA + TmTOV) over games with
 *   team totals. Equals usage x minutes share, so an absent player's
 *   play_share is the usage he vacates.
 * - usg_pct: computeProfiles' usage (per minute on the floor).
 * - A split compares a player's games without a teammate (or a set of
 *   teammates) to his games with them; absorbed_pct = the rise in his
 *   play_share / the play_share the absentees vacate.
 * - sample: 'confirmed' with CONFIRMED_GAMES_WITHOUT+ games without,
 *   'thin' with THIN_GAMES_WITHOUT+, else 'none' (also under
 *   MIN_GAMES_WITH games with).
 */

import { computeProfiles } from '../playerProfileService.js';

export const CONFIRMED_GAMES_WITHOUT = 5;
export const THIN_GAMES_WITHOUT = 2;
export const MIN_GAMES_WITH = 3;

const n = (v) => Number(v) || 0;
// + 0 turns -0 into 0
const round = (x, digits) => (x === null || x === undefined || !Number.isFinite(x) ? null : Number(x.toFixed(digits)) + 0);
const r1 = (x) => round(x, 1);
const r3 = (x) => round(x, 3);
const ratio = (num, den) => (den > 0 ? num / den : null);
const delta = (a, b) => (a === null || b === null ? null : a - b);
const sum = (games, f) => games.reduce((s, g) => s + f(g), 0);
const hasTeamTotals = (g) => n(g.tm_minutes) > 0 && g.tm_fga !== null && g.tm_fga !== undefined;
const used = (g) => n(g.fg_attempted) + 0.44 * n(g.ft_attempted) + n(g.turnovers);
const teamPlays = (g) => n(g.tm_fga) + 0.44 * n(g.tm_fta) + n(g.tm_tov);

export const sampleLabel = (gamesWithout, gamesWith) => {
  if (gamesWith < MIN_GAMES_WITH) return 'none';
  if (gamesWithout >= CONFIRMED_GAMES_WITHOUT) return 'confirmed';
  if (gamesWithout >= THIN_GAMES_WITHOUT) return 'thin';
  return 'none';
};

/** Unrounded sample stats: { games, min_pg, usg_pct, play_share, fppm, fpts_pg }. */
export function sampleStats(games) {
  if (!games.length) return { games: 0, min_pg: null, usg_pct: null, play_share: null, fppm: null, fpts_pg: null };
  const [profile] = computeProfiles(null, games.map(g => ({ ...g, player_key: 'sample' })));
  const withTeam = games.filter(hasTeamTotals);
  const minutes = sum(games, g => n(g.minutes));
  return {
    games: games.length,
    min_pg: minutes / games.length,
    usg_pct: profile.usg_pct,
    play_share: ratio(sum(withTeam, used), sum(withTeam, teamPlays)),
    fppm: ratio(sum(games, g => n(g.fp)), minutes),
    fpts_pg: sum(games, g => n(g.fp)) / games.length
  };
}

/** Rounded sample stats for a set of games (an absent player's vacated line). */
export function splitStats(games) {
  const s = sampleStats(games);
  return {
    games: s.games, min_pg: r1(s.min_pg), usg_pct: r3(s.usg_pct), play_share: r3(s.play_share),
    fppm: r3(s.fppm), fpts_pg: r1(s.fpts_pg)
  };
}

/**
 * One player's split around absent teammates.
 * @param {object[]} games  the player's games for the team in the split window
 * @param {{ absent: Set<string>, played: Set<string>, vacatedShare: number|null }} options
 *   absent / played: game dates the teammate(s) missed / played;
 *   vacatedShare: the play_share the absentees vacate
 */
export function computeSplit(games, { absent, played, vacatedShare = null }) {
  const without = sampleStats(games.filter(g => absent.has(g.game_date)));
  const withThem = sampleStats(games.filter(g => played.has(g.game_date)));
  const shareDelta = delta(without.play_share, withThem.play_share);
  return {
    games_with: withThem.games,
    games_without: without.games,
    sample: sampleLabel(without.games, withThem.games),
    min_with: r1(withThem.min_pg),
    min_without: r1(without.min_pg),
    min_delta: r1(delta(without.min_pg, withThem.min_pg)),
    usg_with: r3(withThem.usg_pct),
    usg_without: r3(without.usg_pct),
    usg_delta: r3(delta(without.usg_pct, withThem.usg_pct)),
    fppm_with: r3(withThem.fppm),
    fppm_without: r3(without.fppm),
    fppm_delta: r3(delta(without.fppm, withThem.fppm)),
    fpts_with: r1(withThem.fpts_pg),
    fpts_without: r1(without.fpts_pg),
    fpts_delta: r1(delta(without.fpts_pg, withThem.fpts_pg)),
    play_share_with: r3(withThem.play_share),
    play_share_without: r3(without.play_share),
    absorbed_pct: shareDelta !== null && vacatedShare > 0 ? r3(shareDelta / vacatedShare) : null
  };
}

const strongest = (splits) =>
  splits.reduce((best, s) => (best === null || (s.usg_delta ?? -Infinity) > (best.usg_delta ?? -Infinity) ? s : best), null);

/**
 * One adjusted line for a player with several teammates out, without
 * double counting: the same-set split (games all of them missed) when
 * confirmed, else the strongest confirmed single (largest usage bump), else
 * a thin same-set split, else the strongest thin single. Null when no split
 * has a sample. set: the same-set split (out_keys), null with one out.
 * Returns { basis: 'same_set' | 'single' | 'strongest_single', out_keys, ...split }.
 */
export function combineSplits(singles, set) {
  const pick = (sample) => {
    if (set && set.sample === sample) return { basis: 'same_set', ...set, out_keys: set.out_keys };
    const best = strongest(singles.filter(s => s.sample === sample));
    if (!best) return null;
    const { out_key: key, ...rest } = best;
    return { basis: singles.length === 1 ? 'single' : 'strongest_single', ...rest, out_keys: [key] };
  };
  return pick('confirmed') ?? pick('thin');
}

export default { sampleStats, splitStats, computeSplit, combineSplits, sampleLabel };
