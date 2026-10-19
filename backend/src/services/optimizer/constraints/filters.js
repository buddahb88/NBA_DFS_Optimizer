import { valuePer1k } from '../scoring.js';

/**
 * PLAYER POOL FILTERS
 * Drops players that miss the request's stat thresholds before any solve.
 * Locked players always stay. A filter at its default value is off.
 */
export const name = 'filters';

export function filterPlayers(players, ctx) {
  const {
    minMinutes = 0,
    minUsage = 0,
    minProjection = 0,
    minValue = 0,
    maxRostership = 100,
    minDvpPtsAllowed = 0,
    minOppDefEff = 0,
    minImpliedTotal = 0,
    minOverUnder = 0,
    minFloor = 0,
    maxVolatility = 1,
    minLeverageScore = 0
  } = ctx.settings;

  console.log(`\n🔍 Applying filters:`);
  if (minMinutes > 0) console.log(`   - Min Minutes: ${minMinutes}`);
  if (minUsage > 0) console.log(`   - Min Usage: ${minUsage}%`);
  if (minProjection > 0) console.log(`   - Min Projection: ${minProjection} pts`);
  if (minValue > 0) console.log(`   - Min Value: ${minValue}x`);
  if (maxRostership < 100) console.log(`   - Max Ownership: ${maxRostership}%`);
  if (minDvpPtsAllowed > 0) console.log(`   - Min DVP Pts Allowed: ${minDvpPtsAllowed}`);
  if (minOppDefEff > 0) console.log(`   - Min Opp Def Eff: ${minOppDefEff}`);
  if (minImpliedTotal > 0) console.log(`   - Min Implied Total: ${minImpliedTotal}`);
  if (minOverUnder > 0) console.log(`   - Min Over/Under: ${minOverUnder}`);
  if (minFloor > 0) console.log(`   - Min Floor: ${minFloor}`);
  if (maxVolatility < 1) console.log(`   - Max Volatility: ${maxVolatility}`);
  if (minLeverageScore > 0) console.log(`   - Min Leverage: ${minLeverageScore}`);

  return players.filter(player => {
    // Always keep locked players
    if (ctx.lockedPlayers.has(player.id)) {
      return true;
    }

    // Must have a projection
    if (!player.projected_points || player.projected_points <= 0) {
      return false;
    }

    // Must have a salary
    if (!player.salary || player.salary <= 0) {
      return false;
    }

    // Calculate value for filtering (DK-equivalent pts per $1k)
    const playerValue = valuePer1k(player.projected_points, player.salary, ctx.site);

    // Core filters
    if (minMinutes > 0 && (player.projected_minutes || 0) < minMinutes) {
      return false;
    }

    if (minUsage > 0 && (player.usage || 0) < minUsage) {
      return false;
    }

    if (minProjection > 0 && player.projected_points < minProjection) {
      return false;
    }

    if (minValue > 0 && playerValue < minValue) {
      return false;
    }

    if (maxRostership < 100 && (player.rostership || 0) > maxRostership) {
      return false;
    }

    // Matchup filters
    if (minDvpPtsAllowed > 0 && (player.dvp_pts_allowed || 0) < minDvpPtsAllowed) {
      return false;
    }

    if (minOppDefEff > 0 && (player.opp_def_eff || 0) < minOppDefEff) {
      return false;
    }

    if (minImpliedTotal > 0 && (player.vegas_implied_total || 0) < minImpliedTotal) {
      return false;
    }

    if (minOverUnder > 0 && (player.vegas_over_under || 0) < minOverUnder) {
      return false;
    }

    // Safety/risk filters
    if (minFloor > 0 && (player.floor || 0) < minFloor) {
      return false;
    }

    if (maxVolatility < 1 && (player.volatility || 0) > maxVolatility) {
      return false;
    }

    if (minLeverageScore > 0 && (player.leverage_score || 0) < minLeverageScore) {
      return false;
    }

    return true;
  });
}
