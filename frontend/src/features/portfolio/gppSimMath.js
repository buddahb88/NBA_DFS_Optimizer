// GPP sim mode (POST /api/portfolio/gpp-sim): request building and display helpers.

export const GPP_SIM_DEFAULTS = {
  contestSize: 14000,
  entries: 3,
  mode: 'single',
  chalkCap: false,
  cheapMinutesFloor: false,
}

export const GPP_SIM_LIMITS = {
  contestSize: { min: 100, max: 500000 },
  entries: { min: 2, max: 150 },
}

/** Single-entry contests at or under this size get the "sharper field" caveat (backend SMALL_SINGLE_ENTRY). */
export const SMALL_SINGLE_ENTRY = 10000

export const GPP_STAGE_LABELS = {
  queued: 'Queued',
  loading: 'Loading slate and own-model projections',
  simulate: 'Simulating player outcomes',
  candidates: 'Building candidate lineups',
  field: 'Building the contest field',
  contest: 'Simulating the contest',
  select: 'Picking lineups',
  done: 'Done',
}
export const GPP_STAGE_ORDER = ['loading', 'simulate', 'candidates', 'field', 'contest', 'select']

const clamp = (v, { min, max }, fallback) => {
  const n = Math.floor(Number(v))
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback
}

/** Problems with the form (null when it can run). */
export function formError(form) {
  const size = Number(form.contestSize)
  if (!Number.isFinite(size) || size < GPP_SIM_LIMITS.contestSize.min || size > GPP_SIM_LIMITS.contestSize.max) {
    return `Contest size must be ${GPP_SIM_LIMITS.contestSize.min.toLocaleString()}-${GPP_SIM_LIMITS.contestSize.max.toLocaleString()}.`
  }
  if (form.mode === 'multi') {
    const n = Number(form.entries)
    if (!Number.isFinite(n) || n < GPP_SIM_LIMITS.entries.min || n > GPP_SIM_LIMITS.entries.max) {
      return `Entries must be ${GPP_SIM_LIMITS.entries.min}-${GPP_SIM_LIMITS.entries.max} for multi-entry.`
    }
  }
  return null
}

/** True when the form describes a small single-entry contest (show the sharper-field caveat). */
export const isSmallSingleEntry = (form) => form.mode === 'single' && Number(form.contestSize) <= SMALL_SINGLE_ENTRY

/**
 * The POST body. slateParams: { slateDate, ranges } in a backtest; excluded: player ids kept out
 * of our lineups (the Studio's exclusions); atLock: re-run at lock.
 */
export function buildGppSimRequest(form, { slateId, slateParams = {}, excluded = [], atLock = false } = {}) {
  const multi = form.mode === 'multi'
  return {
    slateId,
    ...(slateParams?.slateDate ? { slateDate: slateParams.slateDate } : {}),
    contestSize: clamp(form.contestSize, GPP_SIM_LIMITS.contestSize, GPP_SIM_DEFAULTS.contestSize),
    mode: multi ? 'multi' : 'single',
    entries: multi ? clamp(form.entries, GPP_SIM_LIMITS.entries, GPP_SIM_DEFAULTS.entries) : 1,
    chalkCap: !!form.chalkCap,
    cheapMinutesFloor: !!form.cheapMinutesFloor,
    atLock: !!atLock,
    excludedPlayers: [...excluded].map(String),
  }
}

/** Win / top-1% rates are small: two decimals under 1%. */
export const ratePct = (rate) => {
  if (rate === null || rate === undefined || Number.isNaN(Number(rate))) return '—'
  const v = Number(rate) * 100
  return `${v.toFixed(v < 1 ? 2 : 1)}%`
}

