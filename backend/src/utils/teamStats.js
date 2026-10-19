import { normalizeForRankings } from './teamMapping.js';

/**
 * Key team_defense_rankings rows by the slate's team abbreviations.
 * The rankings table uses its own abbreviations (PHO, WSH), so each requested
 * team is normalized before lookup. With no `teams`, every row is returned
 * under its stored abbreviation.
 */
export function buildTeamStatsMap(rows, teams = []) {
  const byRankingsAbbr = new Map(rows.map((r) => [r.team, r]));
  const keys = teams.length > 0 ? teams : rows.map((r) => r.team);
  const result = {};
  for (const team of keys) {
    const row = byRankingsAbbr.get(normalizeForRankings(team));
    if (!row) continue;
    result[team] = {
      pace: row.pace ?? null,
      offEff: row.off_eff ?? null,
      defEff: row.def_eff ?? null,
    };
  }

  const paces = rows.map((r) => r.pace).filter((p) => Number.isFinite(p) && p > 0);
  const leagueAvgPace = paces.length > 0 ? paces.reduce((s, p) => s + p, 0) / paces.length : null;
  const updatedAt = rows.reduce((latest, r) => (r.updated_at && (!latest || r.updated_at > latest) ? r.updated_at : latest), null);

  return { teams: result, leagueAvgPace, updatedAt };
}
