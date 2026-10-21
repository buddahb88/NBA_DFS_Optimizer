// Trim slate players to what /historical/slate-insights, /usage-bumps and
// /missing-players use (only name and team are required by the backend)
export function toInsightsPlayers(players) {
  return (players || []).map(({ name, team, opponent, position, salary, projected_points, projected_minutes }) => ({
    name, team, opponent, position, salary, projected_points, projected_minutes,
  }));
}
