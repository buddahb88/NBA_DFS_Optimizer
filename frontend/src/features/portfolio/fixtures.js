// Test fixtures shaped like the /api/portfolio responses.

const SLOTS = ['PG', 'SG', 'SF', 'PF', 'C', 'G', 'F', 'UTIL']

export const PRESETS = {
  'single-entry': { label: 'Single Entry', contestSize: 5000, entryFee: 20, maxEntries: 1, rake: 0.14, paidFraction: 0.22, firstPlaceShare: 0.1, minCashMultiple: 1.8 },
  '20-max': { label: '20-Max', contestSize: 40000, entryFee: 5, maxEntries: 20, rake: 0.15, paidFraction: 0.21, firstPlaceShare: 0.12, minCashMultiple: 1.6 },
}

export const LIMITS = {
  poolSize: { min: 10, max: 5000, default: 1000 },
  fieldSize: { min: 100, max: 20000, default: 5000 },
  iterations: { min: 100, max: 20000, default: 2000 },
  optimalIterations: { min: 0, max: 20000, default: 1000 },
}

export const makePlayers = () =>
  Array.from({ length: 9 }, (_, i) => ({
    id: i + 1,
    name: `Player ${i + 1}`,
    team: i % 2 ? 'BOS' : 'NYK',
    position: ['PG', 'SG', 'SF', 'PF', 'C', 'PG/SG', 'SF/PF', 'C', 'PF'][i],
    salary: 6000,
    projected_points: 40 - i,
    rostership: 10 + i,
  }))

const lineup = (n, ids, players, metrics) => ({
  lineupNumber: n,
  players: ids.map((id, i) => ({ position: SLOTS[i], player: players[id - 1] })),
  totalSalary: 48000,
  projectedPoints: 250 + n,
  metrics: {
    playerIds: ids,
    salary: 48000,
    projection: 250 + n,
    totalOwnership: 110 + n,
    dupes: 0.2 * n,
    meanScore: 251 + n,
    meanPayout: 6,
    payoutStdev: 40,
    marginalProfit: 1,
    portfolioMeanPayout: 5.5,
    portfolioRoi: 0.1,
    ...metrics,
  },
})

export function makeResult() {
  const players = makePlayers()
  return {
    seed: 1,
    contest: { name: '20-max', label: '20-Max', contestSize: 40000, entryFee: 5, maxEntries: 20, prizePool: 170000, paidPlaces: 8400 },
    settings: { numLineups: 2, poolSize: 100, fieldSize: 5000, iterations: 400, optimalIterations: 400 },
    timings: { totalMs: 12000 },
    pool: { size: 100, attempts: 120 },
    portfolio: {
      lineups: [
        lineup(1, [1, 2, 3, 4, 5, 6, 7, 8], players, { roi: -0.05, winRate: 0.0001, top1Rate: 0.01, cashRate: 0.2 }),
        lineup(2, [1, 2, 3, 4, 9, 6, 7, 8], players, { roi: 0.25, winRate: 0.0003, top1Rate: 0.02, cashRate: 0.25 }),
      ],
      metrics: {
        entries: 2,
        totalFees: 10,
        expectedPayout: 11,
        expectedProfit: 1,
        roi: 0.1,
        payoutStdev: 50,
        profitableRate: 0.3,
        anyCashRate: 0.35,
        anyWinRate: 0.0004,
        anyTop1Rate: 0.03,
      },
      warnings: [],
      scoreDistribution: {
        binStart: 200,
        binWidth: 10,
        binCount: 4,
        lineups: [
          { counts: [100, 200, 80, 20], mean: 222, stdev: 9, p10: 205, p50: 221, p90: 233, p99: 239 },
          { counts: [50, 150, 150, 50], mean: 226, stdev: 10, p10: 208, p50: 225, p90: 236, p99: 240 },
        ],
      },
    },
    players: players.map((p, i) => ({
      ...p,
      ownership: p.rostership,
      optimalRate: 30 - i * 3,
      leverage: 30 - i * 3 - p.rostership,
      fieldExposure: p.rostership,
      poolExposure: 20,
      portfolioExposure: 50,
    })),
    candidates: [],
  }
}
