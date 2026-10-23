// Backtest mode: rebuild a saved past slate (GET /api/slates/backtests) without
// touching the live one. Pure helpers shared by SlateContext and the pages.

/** Why live-only actions (sync, late swap, projection edits, export) are off. */
export const BACKTEST_DISABLED = 'Not available in backtest mode - switch the slate selector back to Live.'

export const RANGE_MODES = [
  { value: 'model', label: 'Model ranges', hint: 'Floor / ceiling recomputed with the current outcome model (no lookahead)' },
  { value: 'original', label: 'Pre-lock ranges', hint: 'Floor / ceiling exactly as they were before lock' },
]

export const backtestLabel = (backtest) => (backtest ? `Backtest ${backtest.slateDate}` : 'Live')

export const findBacktest = (backtests, slateDate) =>
  (slateDate && backtests?.find((b) => b.slateDate === slateDate)) || null

/** Select options: Live, then each saved night newest first. */
export function backtestOptions(backtests = []) {
  return [
    { value: '', label: 'Live' },
    ...backtests.map((b) => ({ value: b.slateDate, label: `Backtest: ${b.slateDate} (${b.players} players)` })),
  ]
}

/** Extra API params for slate requests: { slateDate, ranges } in a backtest, nothing live. */
export const slateRequestParams = (backtest, rangeMode = 'model') =>
  backtest ? { slateDate: backtest.slateDate, ranges: rangeMode } : {}

/** player-settings key: a backtest's own (as backend slateSource.backtestSettingsKey), never the live slate's. */
export const settingsKeyFor = (slateId, backtest) =>
  backtest ? `backtest:${backtest.slateDate}:${backtest.slateId}` : slateId

/** Sum of actualPoints over [{ slot, player }]; null when any player has no result. */
export function lineupActual(entries = []) {
  const players = entries.map((e) => (e && 'player' in e ? e.player : e)).filter(Boolean)
  if (!players.length || players.some((p) => p.actualPoints === null || p.actualPoints === undefined)) return null
  return Math.round(players.reduce((s, p) => s + Number(p.actualPoints), 0) * 10) / 10
}

export const formatActual = (v) => (v === null || v === undefined || Number.isNaN(Number(v)) ? '—' : Number(v).toFixed(1))
