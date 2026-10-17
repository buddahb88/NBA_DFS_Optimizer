/**
 * FANTASY SCORING
 *
 * Turns a box score stat line into fantasy points for a DFS site, using the
 * scoring weights in config/sites.js (the single source of truth).
 *
 * Stat lines use the historical_games column names:
 *   points, rebounds, assists, steals, blocks, turnovers, fg3_made
 * Missing or null stats count as 0.
 *
 * Each site's points are stored in their own historical_games column
 * (see SITE_POINTS_COLUMNS). fantasyPointsSql() builds the same formula as a
 * SQL expression so backfills can run as one UPDATE on sqlite and Azure SQL.
 */

import { getSiteConfig, SITE_KEYS } from '../config/sites.js';

export const SITE_POINTS_COLUMNS = Object.freeze({
  draftkings: 'dk_fantasy_points',
  fanduel: 'fd_fantasy_points',
  yahoo: 'yahoo_fantasy_points'
});

// Sites whose column is added by the scoring migration (DK's already existed)
export const NEW_SITE_POINTS_SITES = Object.freeze(['fanduel', 'yahoo']);

// Scoring key -> historical_games column
const STAT_COLUMNS = {
  pts: 'points',
  reb: 'rebounds',
  ast: 'assists',
  stl: 'steals',
  blk: 'blocks',
  tov: 'turnovers',
  tpm: 'fg3_made'
};

// Categories that count toward double-doubles / triple-doubles
const DOUBLE_DIGIT_COLUMNS = ['points', 'rebounds', 'assists', 'steals', 'blocks'];

const round2 = (n) => Math.round(n * 100) / 100;

/**
 * Fantasy points for one stat line on a site (default DraftKings).
 * Rounded to 2 decimals. Throws on an unknown site.
 */
export function computeFantasyPoints(statLine, site) {
  const { scoring } = getSiteConfig(site);
  const stat = (column) => Number(statLine?.[column]) || 0;

  let total = 0;
  for (const [key, column] of Object.entries(STAT_COLUMNS)) {
    total += stat(column) * (scoring[key] || 0);
  }

  const doubleDigits = DOUBLE_DIGIT_COLUMNS.filter(c => stat(c) >= 10).length;
  total += bonus(scoring, doubleDigits);

  return round2(total);
}

function bonus(scoring, doubleDigits) {
  const dd = scoring.doubleDouble || 0;
  const td = scoring.tripleDouble || 0;
  if (doubleDigits >= 3) return scoring.bonusesStack ? dd + td : td;
  if (doubleDigits >= 2) return dd;
  return 0;
}

/**
 * Points for every site, keyed by column name, e.g.
 * { dk_fantasy_points: 45.25, fd_fantasy_points: 44.1, yahoo_fantasy_points: 44.1 }
 */
export function computeAllSitePoints(statLine, sites = SITE_KEYS) {
  const result = {};
  for (const site of sites) {
    result[SITE_POINTS_COLUMNS[site]] = computeFantasyPoints(statLine, site);
  }
  return result;
}

/**
 * historical_games column holding a site's fantasy points (default DraftKings).
 * Only returns names from SITE_POINTS_COLUMNS, so it is safe to put in SQL.
 */
export function fantasyPointsColumn(site) {
  return SITE_POINTS_COLUMNS[getSiteConfig(site).key];
}

/**
 * SQL expression (sqlite and Azure SQL) equal to computeFantasyPoints for the
 * historical_games row in scope.
 */
export function fantasyPointsSql(site) {
  const { scoring } = getSiteConfig(site);
  const col = (c) => `COALESCE(${c}, 0)`;

  const terms = Object.entries(STAT_COLUMNS)
    .filter(([key]) => scoring[key])
    .map(([key, column]) => `${col(column)} * ${scoring[key]}`);

  const dd = scoring.doubleDouble || 0;
  const td = scoring.tripleDouble || 0;
  if (dd || td) {
    const count = '(' + DOUBLE_DIGIT_COLUMNS
      .map(c => `CASE WHEN ${col(c)} >= 10 THEN 1 ELSE 0 END`)
      .join(' + ') + ')';
    const tripleBonus = scoring.bonusesStack ? dd + td : td;
    terms.push(`CASE WHEN ${count} >= 3 THEN ${tripleBonus} WHEN ${count} >= 2 THEN ${dd} ELSE 0 END`);
  }

  return `ROUND(${terms.join(' + ')}, 2)`;
}
