/**
 * DFS SITE RULES - single source of truth
 *
 * Classic (multi-game) NBA contest rules for each supported DFS site.
 * Everything here is public contest rules; never put credentials or API keys
 * in this file, because GET /api/sites returns it as-is.
 *
 * Rules were last checked 2026-10-17. Sources are cited for each site below.
 * Some official help pages block automated fetches, so a few values were
 * checked against the site's own articles; those are noted as such.
 */

const DEFAULT_SITE = 'draftkings';

/**
 * Scoring keys (all per-unit values):
 *   pts           points scored
 *   reb           rebounds
 *   ast           assists
 *   stl           steals
 *   blk           blocks
 *   tov           turnovers (negative)
 *   tpm           made 3-pointers, as a bonus on top of the points
 *                 (0 = the site counts only the 3 points)
 *   doubleDouble  bonus for 10+ in two of pts/reb/ast/stl/blk
 *   tripleDouble  bonus for 10+ in three of pts/reb/ast/stl/blk
 *   bonusesStack  true if a triple-double also earns the double-double bonus
 */

const SITES = {
  /**
   * DraftKings NBA Classic
   * - Rules: https://www.draftkings.com/help/rules/nba (blocked automated fetches)
   * - Roster and scoring as published by DraftKings:
   *   https://dknetwork.draftkings.com/2025/10/17/nba-daily-fantasy-101-how-to-play-dfs-on-draftkings/
   *   https://playbook.draftkings.com/uncategorized/draftkings-nba-scoring-tips-and-tricks/
   * - $50,000 cap: https://support.draftkings.com/dk/en-us/game-style-classic-overview?id=kb_article_view&sysparm_article=KB0010665
   * - Classic needs players from at least 2 teams in at least 2 games. There is no
   *   per-team max.
   * - Double-double +1.5 and triple-double +3 (each max 1 per player). A
   *   triple-double earns both, for +4.5. That matches nbaStatsService.
   * - CSV upload: header is the slot names; each cell is the DK player ID.
   */
  draftkings: {
    key: 'draftkings',
    name: 'DraftKings',
    sport: 'NBA',
    gameType: 'classic',
    salaryCap: 50000,
    rosterSlots: [
      { slot: 'PG', eligible: ['PG'] },
      { slot: 'SG', eligible: ['SG'] },
      { slot: 'SF', eligible: ['SF'] },
      { slot: 'PF', eligible: ['PF'] },
      { slot: 'C', eligible: ['C'] },
      { slot: 'G', eligible: ['PG', 'SG'] },
      { slot: 'F', eligible: ['SF', 'PF'] },
      { slot: 'UTIL', eligible: ['PG', 'SG', 'SF', 'PF', 'C'] }
    ],
    maxPlayersPerTeam: null,
    minTeams: 2,
    minGames: 2,
    scoring: {
      pts: 1,
      reb: 1.25,
      ast: 1.5,
      stl: 2,
      blk: 2,
      tov: -0.5,
      tpm: 0.5,
      doubleDouble: 1.5,
      tripleDouble: 3,
      bonusesStack: true
    },
    csvExport: {
      header: ['PG', 'SG', 'SF', 'PF', 'C', 'G', 'F', 'UTIL'],
      // Lineup slot order for the columns above (one entry per column)
      slotOrder: ['PG', 'SG', 'SF', 'PF', 'C', 'G', 'F', 'UTIL'],
      playerFormat: 'id' // e.g. 12345678
    }
  },

  /**
   * FanDuel NBA (full roster)
   * - Rules: https://www.fanduel.com/rules (blocked automated fetches; values
   *   taken from FanDuel's indexed rules text: 3-pt FG=3, 2-pt FG=2, FT=1,
   *   Rebound=1.2, Assist=1.5, Block=3, Steal=3, Turnover=-1)
   * - $60,000 cap, 9 players ("In a traditional FanDuel NBA lineup, you have a
   *   $60,000 salary cap to roster nine players"):
   *   https://www.fanduel.com/research/fanduel-single-game-daily-fantasy-basketball-helper-pacers-at-lakers-12-9-23
   * - Team limits: https://support.fanduel.com/s/article/How-many-players-can-I-select-from-one-team
   *   "Include players from at least three different teams. Cannot include more
   *   than four players from any one team."
   * - No 3PM bonus (made 3s count only as 3 points) and no DD/TD bonuses.
   * - CSV upload: header is the positions with PG, SG, SF and PF repeated, and
   *   each cell is "<FD player id>:<name>" (the id itself looks like "12345-67890").
   */
  fanduel: {
    key: 'fanduel',
    name: 'FanDuel',
    sport: 'NBA',
    gameType: 'classic',
    salaryCap: 60000,
    rosterSlots: [
      { slot: 'PG', eligible: ['PG'] },
      { slot: 'PG', eligible: ['PG'] },
      { slot: 'SG', eligible: ['SG'] },
      { slot: 'SG', eligible: ['SG'] },
      { slot: 'SF', eligible: ['SF'] },
      { slot: 'SF', eligible: ['SF'] },
      { slot: 'PF', eligible: ['PF'] },
      { slot: 'PF', eligible: ['PF'] },
      { slot: 'C', eligible: ['C'] }
    ],
    maxPlayersPerTeam: 4,
    minTeams: 3,
    minGames: null,
    scoring: {
      pts: 1,
      reb: 1.2,
      ast: 1.5,
      stl: 3,
      blk: 3,
      tov: -1,
      tpm: 0,
      doubleDouble: 0,
      tripleDouble: 0,
      bonusesStack: false
    },
    csvExport: {
      header: ['PG', 'PG', 'SG', 'SG', 'SF', 'SF', 'PF', 'PF', 'C'],
      slotOrder: ['PG', 'PG', 'SG', 'SG', 'SF', 'SF', 'PF', 'PF', 'C'],
      playerFormat: 'id:name'
    }
  },

  /**
   * Yahoo Daily Fantasy NBA (multi-game)
   * - Rules: https://dffe-sports.media.yahoo.com/dailyfantasy/help/nba/rules
   *   Positions: PG, SG, G, SF, PF, F, C, UTIL. "G can be filled by PG and SG",
   *   "F can be filled by SF and PF", "UTIL can be filled by PG, SG, SF, PF and C".
   *   Scoring: PT 1, REB 1.2, AST 1.5, ST 3, BLK 3, TO -1 (no 3PM or DD/TD bonus).
   * - Team limits: https://legal.yahoo.com/us/en/yahoo/terms/rules/dailyfantasybasketball/
   *   "at least three (3) different teams" and "no entrant may have more than
   *   six (6) players from the same real-world team".
   * - $200 cap: the official rules only say the cap is shown on each contest.
   *   $200 is the standard cap per https://sports.yahoo.com/guide-yahoo-daily-fantasy-basketball-160755509.html
   * - CSV upload: header is the slot names; each cell is the Yahoo player ID
   *   (e.g. "nba.p.1234").
   */
  yahoo: {
    key: 'yahoo',
    name: 'Yahoo',
    sport: 'NBA',
    gameType: 'classic',
    salaryCap: 200,
    rosterSlots: [
      { slot: 'PG', eligible: ['PG'] },
      { slot: 'SG', eligible: ['SG'] },
      { slot: 'G', eligible: ['PG', 'SG'] },
      { slot: 'SF', eligible: ['SF'] },
      { slot: 'PF', eligible: ['PF'] },
      { slot: 'F', eligible: ['SF', 'PF'] },
      { slot: 'C', eligible: ['C'] },
      { slot: 'UTIL', eligible: ['PG', 'SG', 'SF', 'PF', 'C'] }
    ],
    maxPlayersPerTeam: 6,
    minTeams: 3,
    minGames: null,
    scoring: {
      pts: 1,
      reb: 1.2,
      ast: 1.5,
      stl: 3,
      blk: 3,
      tov: -1,
      tpm: 0,
      doubleDouble: 0,
      tripleDouble: 0,
      bonusesStack: false
    },
    csvExport: {
      header: ['PG', 'SG', 'G', 'SF', 'PF', 'F', 'C', 'UTIL'],
      slotOrder: ['PG', 'SG', 'G', 'SF', 'PF', 'F', 'C', 'UTIL'],
      playerFormat: 'id'
    }
  }
};

// Freeze deeply so callers can't mutate the shared rules
const deepFreeze = (obj) => {
  Object.values(obj).forEach(v => {
    if (v && typeof v === 'object') deepFreeze(v);
  });
  return Object.freeze(obj);
};
deepFreeze(SITES);

export const SITE_KEYS = Object.keys(SITES);

export const isValidSite = (site) =>
  typeof site === 'string' && Object.prototype.hasOwnProperty.call(SITES, site.toLowerCase());

/**
 * Get the rules for a site. Falls back to DraftKings when site is empty.
 * Throws on an unknown site so typos fail loudly.
 */
export function getSiteConfig(site) {
  if (site === undefined || site === null || site === '') {
    return SITES[DEFAULT_SITE];
  }
  if (!isValidSite(site)) {
    throw new Error(`Unknown DFS site "${site}". Expected one of: ${SITE_KEYS.join(', ')}`);
  }
  return SITES[site.toLowerCase()];
}

/**
 * Distinct roster slots a player can fill on a site, in roster order.
 * positions: array (['PG', 'SG']) or a string split on ',' or '/' ("PG/SG").
 */
export function getEligibleSlots(site, positions) {
  const list = Array.isArray(positions)
    ? positions
    : String(positions || '').split(/[,/]/);
  const playerPositions = new Set(list.map(p => p.trim().toUpperCase()).filter(Boolean));
  const slots = [];
  for (const { slot, eligible } of getSiteConfig(site).rosterSlots) {
    if (!slots.includes(slot) && eligible.some(p => playerPositions.has(p))) {
      slots.push(slot);
    }
  }
  return slots;
}

export { SITES, DEFAULT_SITE };
export default SITES;
