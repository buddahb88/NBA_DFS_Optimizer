/**
 * CANONICAL PLAYER / TEAM KEYS FOR HISTORICAL DATA
 *
 * Every historical_games write path stores playerKey(player_name) in
 * player_key and canonicalTeam() for team/opponent, so lookups by player or
 * team match regardless of the feed's spelling ("Luka Dončić" vs "Luka Doncic",
 * "BRK" vs "BKN"). Rules live in nameNormalizer.js so slate imports and
 * historical data share one definition.
 */

import { normalizeName, normalizeTeam } from './nameNormalizer.js';

/**
 * Player match key: lowercase, no diacritics/punctuation, no Jr./Sr./II/III/IV.
 * "Jaren Jackson Jr." -> "jaren jackson", "Luka Dončić" -> "luka doncic"
 */
export function playerKey(name) {
  return normalizeName(name);
}

/**
 * Canonical NBA team code ("BRK" -> "BKN", "PHO" -> "PHX", "gs" -> "GSW").
 * Unknown codes pass through uppercased; missing team returns null.
 */
export function canonicalTeam(code) {
  return normalizeTeam(code) || null;
}
