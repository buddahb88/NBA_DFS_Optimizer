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
 * Deep link (?season=&grouping=&team=&group=, e.g. from a Player Pool matchup)
 * -> { filters, cell }: the grid filters to load, and the cell to open once it
 * has, or null.
 */
export function parseDeepLink(params) {
  const filters = { ...DEFAULT_FILTERS }
  const season = params.get('season')
  if (season && /^\d{4}-\d{2}$/.test(season)) filters.season = season
  const grouping = params.get('grouping')
  if (GROUPINGS.some((g) => g.value === grouping)) filters.grouping = grouping
  const team = params.get('team')
  const group = params.get('group')
  return { filters, cell: team && group ? { team: team.toUpperCase(), group } : null }
}

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

// Tonight: adjusted edge (backend archetypeMatchupService) vs raw matchup
export const TONIGHT_SORTS = [
  { value: 'adjusted', label: 'Adjusted edge' },
  { value: 'raw', label: 'Raw matchup' },
]

export const tonightSorting = (mode) => [{ id: mode === 'raw' ? 'matchup_delta' : 'adjusted_edge', desc: true }]

const times = (x) => (x == null ? '' : ` x${Number(x).toFixed(2)}`)

function roleTip(m, penalty) {
  const parts = []
  if (m.projected != null) parts.push(`Projected ${m.projected} min vs ${m.last_season} last season (${formatDelta(m.projected - m.last_season)})`)
  if (m.current != null) {
    const vs = m.projected == null ? ` vs ${m.last_season} last season` : ''
    parts.push(`${Number(m.current).toFixed(1)} min over ${m.current_games} game${m.current_games === 1 ? '' : 's'} this season${vs}`)
  }
  return `${parts.join('; ')}. Edge${times(penalty)}.`
}

/**
 * Badges for a Tonight row's flags, in flag order: [{ key, label, tone, tip }].
 * `config` = the response's edgeConfig (penalties per flag).
 */
export function edgeBadges(p, config) {
  const penalty = (flag) => config?.penalties?.[flag]
  const m = p.minutes ?? {}
  return (p.flags ?? []).map((flag) => {
    switch (flag) {
      case 'new_team':
        return { key: flag, label: 'New team', tone: 'info', tip: `Was ${p.last_team} last season (${m.last_season} min). Role on a new team is uncertain: edge${times(penalty(flag))}.` }
      case 'role_down':
        return { key: flag, label: 'Role ↓', tone: 'negative', tip: roleTip(m, penalty(flag)) }
      case 'role_up':
        return { key: flag, label: 'Role ↑', tone: 'positive', tip: roleTip(m, penalty(flag)) }
      case 'crowded':
        return { key: flag, label: 'Crowded', tone: 'caution', tip: `Shares ${p.label} vs ${p.opponent} with ${p.crowding?.teammates?.join(', ')}: edge${times(p.components?.crowding_factor)}.` }
      case 'no_history':
        return { key: flag, label: 'No history', tone: 'neutral', tip: `No last-season profile to check minutes or role against: edge${times(penalty(flag))}.` }
      default:
        return { key: flag, label: flag, tone: 'neutral', tip: null }
    }
  })
}

const MINUTES_USED = {
  projected: (m) => `${m.projected} min`,
  current: (m) => `${Number(m.current).toFixed(1)} min so far`,
  last_season: (m) => `${m.last_season} min last season`,
}

/** "+4.45 matchup x 0.78 minutes (25 min) x 0.85 role x 0.80 crowding = +2.36"; null without an edge. */
export function edgeExplanation(p) {
  if (p.adjusted_edge == null || !p.components) return null
  const c = p.components
  const used = MINUTES_USED[p.minutes?.basis]?.(p.minutes) ?? 'minutes unknown'
  let text = `${formatDelta(p.matchup_delta, 2)} matchup x ${c.volume.toFixed(2)} minutes (${used})`
  if (c.role_factor !== 1) text += ` x ${c.role_factor.toFixed(2)} role`
  if (c.crowding_factor !== 1) text += ` x ${c.crowding_factor.toFixed(2)} crowding`
  return `${text} = ${formatDelta(p.adjusted_edge, 2)}`
}
