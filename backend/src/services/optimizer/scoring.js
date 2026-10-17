/**
 * Per-player optimizer scores
 *
 * Score formulas were tuned on DraftKings salaries ($50k cap), so salaries are
 * scaled to DK dollars before computing value. On DK the scale is 1 and the
 * scores are unchanged; on FanDuel ($60k) and Yahoo ($200) value stays
 * comparable.
 */

const REFERENCE_CAP = 50000;

export function salaryScale(site) {
  return REFERENCE_CAP / site.salaryCap;
}

/**
 * Projected points per $1k of DK-equivalent salary
 */
export function valuePer1k(points, salary, site) {
  return points / ((salary * salaryScale(site)) / 1000);
}

/**
 * Cash and GPP objective scores for one player
 */
export function playerScores(player, site) {
  const projection = player.adjustedProjection || player.projected_points || 0;
  const floor = player.floor || (projection * 0.75);
  const ceiling = player.ceiling || (projection * 1.25);
  const ownership = player.rostership || 10;
  const leverage = player.leverage_score || 1;

  // Cash score: weighted toward floor and consistency
  // Prioritize: high floor, solid projection, good value
  const value = valuePer1k(projection, player.salary, site);
  const cashScore = (projection * 0.5) + (floor * 0.4) + (value * 1.5);

  // GPP score: weighted toward ceiling, value, and ownership
  // Low ownership + high ceiling + good value = GPP gold
  // Leverage already factors in boom probability vs ownership
  const ceilingValue = valuePer1k(ceiling, player.salary, site);
  const ownershipBoost = Math.max(0, (25 - ownership) * 0.5); // Boost for <25% owned
  const leverageBonus = Math.min(leverage, 20) * 0.5; // Cap leverage impact
  const gppScore = (ceiling * 0.4) + (ceilingValue * 3) + ownershipBoost + leverageBonus;

  return { cashScore, gppScore };
}

/**
 * Default minimum salary for a site: 98% of the cap ($49,000 on DK)
 */
export function defaultMinSalary(site) {
  return Math.round(site.salaryCap * 0.98);
}
