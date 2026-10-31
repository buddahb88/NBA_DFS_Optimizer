#!/usr/bin/env node

/**
 * TEAM RATINGS: rebuild team_defense_rankings (pace / efficiency) from
 * team_game_stats (services/teamRatingsService.js) and print it.
 *
 *   npm run ratings:teams -- [--season 2026-27] [--as-of 2026-11-15] [--dry-run]
 *     --dry-run   compute and print only, no database write
 */

import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../.env') });

const { default: db } = await import('../src/config/database.js');
const { computeTeamRatings, loadTeamGames, refreshTeamRatings } = await import('../src/services/teamRatingsService.js');
const { getCurrentSeason, seasonForDate } = await import('../src/utils/season.js');

const args = process.argv.slice(2);
const argValue = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : null;
};
const fmt = (v, d = 1) => (v === null || v === undefined ? '-' : Number(v).toFixed(d));
const pad = (v, w) => String(v).padStart(w);

const asOf = argValue('--as-of');
const season = argValue('--season') || (asOf ? seasonForDate(asOf) : getCurrentSeason());

try {
  const result = args.includes('--dry-run')
    ? { teams: null, ratings: computeTeamRatings(await loadTeamGames(season), { season, asOf }) }
    : await refreshTeamRatings({ season, asOf });
  const { ratings } = result;

  console.log(`Team ratings ${ratings.season}${asOf ? ` as of ${asOf}` : ''} (prior: ${ratings.priorSeason})` +
    (result.teams === null ? ' - dry run, not written' : ` - ${result.teams} teams written to team_defense_rankings`));
  console.log(`${'team'.padEnd(6)}${pad('gp', 4)}${pad('pace', 7)}${pad('off', 7)}${pad('def', 7)}${pad('net', 7)}${pad('eFG%', 7)}${pad('TS%', 7)}${pad('AST', 7)}${pad('TO', 7)}${pad('REBR', 7)}   raw off/def`);
  for (const t of [...ratings.teams].sort((a, b) => (a.defEff ?? Infinity) - (b.defEff ?? Infinity))) {
    console.log(`${t.team.padEnd(6)}${pad(t.games, 4)}${pad(fmt(t.pace), 7)}${pad(fmt(t.offEff), 7)}${pad(fmt(t.defEff), 7)}` +
      `${pad(fmt(t.offEff - t.defEff), 7)}${pad(fmt(t.effFgPct), 7)}${pad(fmt(t.tsPct), 7)}${pad(fmt(t.astRatio), 7)}` +
      `${pad(fmt(t.toRatio), 7)}${pad(fmt(t.rebr), 7)}   ${fmt(t.raw?.offEff)}/${fmt(t.raw?.defEff)}`);
  }
  if (ratings.league) {
    console.log(`League: ${ratings.league.games} team games, pace ${fmt(ratings.league.pace)}, efficiency ${fmt(ratings.league.offEff)}`);
  }
} finally {
  db.close();
}
