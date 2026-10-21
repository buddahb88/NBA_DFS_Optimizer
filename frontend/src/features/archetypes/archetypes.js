// Pure helpers for the Archetypes page (GET /api/archetypes/*).

// Stat selector -> team_archetype_defense column (all shrunk, per player-game)
export const STATS = [
  { value: 'fp', label: 'FP', column: 'fp_over_expectation', unit: 'FP' },
  { value: 'pts', label: 'PTS', column: 'pts_delta', unit: 'PTS' },
  { value: 'reb', label: 'REB', column: 'reb_delta', unit: 'REB' },
  { value: 'ast', label: 'AST', column: 'ast_delta', unit: 'AST' },
  { value: 'fg3m', label: '3PM', column: 'fg3m_delta', unit: '3PM' },
]
export const statFor = (stat) => STATS.find((s) => s.value === stat) ?? STATS[0]

export const GROUPINGS = [
  { value: 'archetype', label: 'Archetype' },
  { value: 'position', label: 'Position (G/F/C)' },
]

export const LAST_N_OPTIONS = [
  { value: '', label: 'Full season' },
  { value: '5', label: 'Last 5 games' },
  { value: '10', label: 'Last 10 games' },
  { value: '15', label: 'Last 15 games' },
  { value: '20', label: 'Last 20 games' },
]

export const DEFAULT_FILTERS = { season: '', grouping: 'archetype', lastNGames: '', stat: 'fp' }

/**
 * Filters + site -> /defense query params, empty values left out. Auto season
 * (no season) asks the backend to use last season while the current one is thin.
 */
export function defenseParams({ season, grouping, lastNGames }, site) {
  const params = {}
  if (season) params.season = season
  if (grouping) params.grouping = grouping
  if (lastNGames) params.lastNGames = Number(lastNGames)
  if (site) params.site = site
  if (!season) params.seasonFallback = true
  return params
}

/**
 * /defense rows -> heatmap model. Teams A-Z; columns in definition order,
 * only those with data (Unclassified is never a column). `cell(team, key)`
 * returns { value, row } or null; maxAbs sets the color scale.
 */
export function buildHeatmap(rows, { definitions, grouping, stat }) {
  const { column } = statFor(stat)
  const cells = new Map()
  const teams = new Set()
  const present = new Set()
  let maxAbs = 0
  for (const row of rows ?? []) {
    if (row.group_key === 'unclassified') continue
    const value = row[column] ?? null
    cells.set(`${row.team}|${row.group_key}`, { value, row })
    teams.add(row.team)
    present.add(row.group_key)
    if (value != null) maxAbs = Math.max(maxAbs, Math.abs(value))
  }
  const defs = (grouping === 'position' ? definitions?.positions : definitions?.archetypes) ?? []
  const known = new Set(defs.map((d) => d.key))
  const groups = [
    ...defs.filter((d) => present.has(d.key)),
    // Keys the definitions don't know yet still get a column
    ...[...present].filter((k) => !known.has(k)).sort().map((key) => ({ key, label: key })),
  ]
  return {
    teams: [...teams].sort(),
    groups,
    maxAbs,
    cell: (team, key) => cells.get(`${team}|${key}`) ?? null,
  }
}

const MAX_ALPHA = 0.8
const MIN_ALPHA = 0.08

/**
 * Diverging fill: info (blue) where the defense allows more than expected,
 * negative (red) where it allows less, fading to the surface at zero.
 * Blue/red stays distinguishable under color-vision deficiency.
 */
export function cellColor(value, maxAbs) {
  if (value == null || value === 0 || !maxAbs) return 'transparent'
  const t = Math.min(1, Math.abs(value) / maxAbs)
  const alpha = Math.round((MIN_ALPHA + (MAX_ALPHA - MIN_ALPHA) * t) * 100) / 100
  return `rgb(var(--${value > 0 ? 'info' : 'negative'}) / ${alpha})`
}

/** +2.3 / -1.0 / 0.0; em dash for missing. */
export function formatDelta(value, digits = 1) {
  if (value == null || Number.isNaN(Number(value))) return '—'
  const fixed = Number(value).toFixed(digits)
  if (Number(fixed) === 0) return (0).toFixed(digits)
  return Number(fixed) > 0 ? `+${fixed}` : fixed
}

export const errorMessage = (err) => err?.response?.data?.error || err?.message || 'Request failed'
