/**
 * Team name mapping utility
 * Maps player opponent abbreviations to defense table team abbreviations
 *
 * Note: The two defense tables use different abbreviations for some teams,
 * so we need separate mappings for each table.
 */

// Mapping for team_defense_rankings table
const RANKINGS_MAP = {
  'PHX': 'PHO',   // Phoenix Suns
  'WAS': 'WSH',   // Washington Wizards
  'UTAH': 'UTAH', // Utah Jazz (no change needed)
  // HOU, and other teams use standard abbreviations
};

// Mapping for team_defense_vs_position table
const VS_POSITION_MAP = {
  'PHX': 'PHO',   // Phoenix Suns
  'WAS': 'WAS',   // Washington Wizards (no change needed)
  'UTAH': 'UTA',  // Utah Jazz
  'HOU': 'HOU',   // Houston Rockets (no change needed)
};

/**
 * Normalize team name for team_defense_rankings table
 * @param {string} teamName - The team abbreviation from player data
 * @returns {string|null} - The normalized team abbreviation
 */
export function normalizeForRankings(teamName) {
  if (!teamName) return null;
  return RANKINGS_MAP[teamName] || teamName;
}

/**
 * Normalize team name for team_defense_vs_position table
 * @param {string} teamName - The team abbreviation from player data
 * @returns {string|null} - The normalized team abbreviation
 */
export function normalizeForVsPosition(teamName) {
  if (!teamName) return null;
  return VS_POSITION_MAP[teamName] || teamName;
}
