/**
 * The range model the RotoWire sync used before the game-log outcome model
 * (outcomeDistribution.js, commit 55351f5). Kept only to rebuild the pre-lock
 * std_dev / volatility / boom / bust / leverage of slates synced under it,
 * whose snapshots kept floor and ceiling but not the rest. Pure function of
 * the players row; a rebuild is trusted when it reproduces the stored
 * pre-lock floor and ceiling.
 */

const num = (v) => parseFloat(v) || 0;

// Abramowitz-Stegun normal CDF, as the old sync computed it
function normalCdf(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp(-z * z / 2);
  const prob = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z > 0 ? 1 - prob : prob;
}

function blowout(spread) {
  const abs = Math.abs(spread || 0);
  if (abs <= 10) return { floor: 0, ceiling: 0, risk: 0 };
  const m = abs - 10;
  return spread < 0
    ? { floor: -m * 0.5, ceiling: -m * 0.2, risk: m * 0.1 }
    : { floor: -m * 0.4, ceiling: m * 0.3, risk: m * 0.1 };
}

/**
 * Legacy ranges for a players / snapshot row
 * ({ projected_points, salary, rostership, vegas_spread, raw_data }).
 * Returns snake_case columns; null when the player had no projection.
 */
export function legacyPreLockRanges(row) {
  const projection = num(row.projected_points);
  if (projection <= 0) return null;
  let raw = row.raw_data;
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw); } catch { raw = null; }
  }
  const avg = raw?.stats?.avgFpts || {};
  const recent = [avg.last3, avg.last5, avg.last7, avg.season].map(num).filter((v) => v > 0);

  let stdDev = 0;
  let volatility = 0;
  if (recent.length >= 3) {
    const mean = recent.reduce((s, v) => s + v, 0) / recent.length;
    stdDev = Math.sqrt(recent.reduce((s, v) => s + (v - mean) ** 2, 0) / recent.length);
    volatility = mean > 0 ? stdDev / mean : 0;
  }
  if (stdDev === 0) {
    stdDev = projection * 0.15;
    volatility = 0.15;
  }

  let floor = Math.max(0, projection - stdDev);
  let ceiling = projection + stdDev;
  const b = blowout(num(row.vegas_spread));
  if (b.risk > 0) {
    floor = Math.max(0, floor + b.floor);
    ceiling += b.ceiling;
  }

  const salary = num(row.salary);
  let boom = 0;
  let bust = 0;
  if (salary) {
    const valueThreshold = (salary / 1000) * 5;
    boom = Math.max(0, Math.min(1, 1 - normalCdf((valueThreshold + 10 - projection) / stdDev))) * 100;
    bust = Math.max(0, Math.min(1, normalCdf((valueThreshold - projection) / stdDev))) * 100;
  }
  const ownership = num(row.rostership) || 1;

  return {
    floor,
    ceiling,
    std_dev: stdDev,
    volatility,
    boom_probability: boom,
    bust_probability: bust,
    leverage_score: (boom * 100) / (ownership + 1),
    blowout_risk: b.risk
  };
}

export default { legacyPreLockRanges };
