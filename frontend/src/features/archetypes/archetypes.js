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

// teams: [] = all defenses, 'tonight' = the teams on the selected slate, or a list of abbreviations
export const DEFAULT_FILTERS = { season: '', grouping: 'archetype', lastNGames: '', stat: 'fp', teams: [] }

export const TONIGHT_TEAMS = 'tonight'

/** ?teams= value -> [] (all) | 'tonight' | sorted unique abbreviations. Junk is dropped. */
export function parseTeams(value) {
  if (!value) return []
  if (value.trim().toLowerCase() === TONIGHT_TEAMS) return TONIGHT_TEAMS
  const teams = value.split(',').map((t) => t.trim().toUpperCase()).filter((t) => /^[A-Z]{2,4}$/.test(t))
  return [...new Set(teams)].sort()
}

/** Teams selection -> ?teams= value; '' for all. */
export function teamsParam(teams) {
  if (teams === TONIGHT_TEAMS) return TONIGHT_TEAMS
  return Array.isArray(teams) ? teams.join(',') : ''
}

/** Teams playing on the slate a /archetypes/tonight body covers (roster and its opponents, plus matchup rows), A-Z. */
export function slateTeams(tonight) {
  const teams = new Set()
  for (const p of tonight?.roster ?? []) {
    if (p.team) teams.add(p.team)
    if (p.opponent) teams.add(p.opponent)
  }
  for (const p of tonight?.players ?? []) {
    if (p.team) teams.add(p.team)
    if (p.opponent) teams.add(p.opponent)
  }
  return [...teams].sort()
}

/**
 * team -> tonight's opponent, from the roster's and Tonight rows' team/opponent
 * pairs (both ways). Games without a listed opponent are left out.
 */
export function slateOpponents(tonight) {
  const opponents = new Map()
  for (const p of [...(tonight?.roster ?? []), ...(tonight?.players ?? [])]) {
    if (!p.team || !p.opponent) continue
    opponents.set(p.team, p.opponent)
    opponents.set(p.opponent, p.team)
  }
  return opponents
}

/**
 * Selection -> the teams to show, or null for no filter (all, or the slate
 * shortcut before any slate teams are known).
 */
export function resolveTeams(teams, tonightTeams) {
  if (teams === TONIGHT_TEAMS) return tonightTeams?.length ? tonightTeams : null
  return Array.isArray(teams) && teams.length ? teams : null
}

/**
 * Deep link (?season=&grouping=&teams=&team=&group=, e.g. from a Player Pool
 * matchup) -> { filters, cell }: the grid filters to load, and the cell to open
 * once it has, or null. teams = BOS,NYK or 'tonight' (the slate's teams).
 */
export function parseDeepLink(params) {
  const filters = { ...DEFAULT_FILTERS }
  const season = params.get('season')
  if (season && /^\d{4}-\d{2}$/.test(season)) filters.season = season
  const grouping = params.get('grouping')
  if (GROUPINGS.some((g) => g.value === grouping)) filters.grouping = grouping
  filters.teams = parseTeams(params.get('teams'))
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
 * `teams` (optional list) narrows the rows only: columns and maxAbs stay
 * computed over every team, so a cell keeps its color when filtering.
 * allTeams = every team with data.
 */
export function buildHeatmap(rows, { definitions, grouping, stat, teams: only = null }) {
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
  const allTeams = [...teams].sort()
  const keep = only ? new Set(only) : null
  const tiers = defenseTiers(rows, stat)
  return {
    teams: keep ? allTeams.filter((t) => keep.has(t)) : allTeams,
    allTeams,
    groups,
    maxAbs,
    cell: (team, key) => cells.get(`${team}|${key}`) ?? null,
    tier: (team, key) => tiers.get(`${team}|${key}`) ?? 'neutral',
  }
}

// Same cut as the backend's weak tier (archetypeDefenseService.weakTiers)
const TIER_FRACTION = 1 / 3

/**
 * Map('team|group' -> 'target' | 'avoid' | 'neutral') for the stat, league-wide
 * per column: the top third of defenses (rounded up) that allow MORE than
 * expected are 'target' (the /tonight weak tier), the bottom third that allow
 * LESS are 'avoid'. Cells without a value are left out.
 */
export function defenseTiers(rows, stat) {
  const { column } = statFor(stat)
  const byGroup = new Map()
  for (const row of rows ?? []) {
    const value = row[column]
    if (value == null || Number.isNaN(Number(value))) continue
    if (!byGroup.has(row.group_key)) byGroup.set(row.group_key, [])
    byGroup.get(row.group_key).push({ team: row.team, value: Number(value) })
  }
  const tiers = new Map()
  for (const [group, list] of byGroup) {
    list.sort((a, b) => b.value - a.value || (a.team < b.team ? -1 : 1))
    const size = Math.ceil(list.length * TIER_FRACTION)
    list.forEach(({ team, value }, i) => {
      const tier = i < size && value > 0 ? 'target' : i >= list.length - size && value < 0 ? 'avoid' : 'neutral'
      tiers.set(`${team}|${group}`, tier)
    })
  }
  return tiers
}

const byProjection = (a, b) =>
  (Number(b.projected_points) || 0) - (Number(a.projected_points) || 0) ||
  (Number(b.salary) || 0) - (Number(a.salary) || 0) ||
  String(a.name).localeCompare(String(b.name))

/**
 * Slate players per heatmap cell: Map('defending team|group' -> roster entries,
 * best projection first). A player lands in his OPPONENT's row under his
 * archetype (or G/F/C) column, as /tonight's roster assigns them. Empty when
 * the body was built for another grouping (a refetch still in flight).
 */
export function slateCellPlayers(tonight, grouping) {
  const cells = new Map()
  if (!tonight?.roster || (grouping && tonight.grouping && tonight.grouping !== grouping)) return cells
  for (const p of tonight.roster) {
    if (!p.opponent || !p.group_key) continue
    const key = `${p.opponent}|${p.group_key}`
    if (!cells.has(key)) cells.set(key, [])
    cells.get(key).push(p)
  }
  for (const list of cells.values()) list.sort(byProjection)
  return cells
}

export const TIER_LABELS = { target: 'target', avoid: 'avoid', neutral: 'neutral' }

// "Guards" stay as is; "Primary Creator" -> "Primary Creators"
const plural = (label) => (/s$/i.test(label) ? label : `${label}s`)

/**
 * Hover popover model for one cell: { title, delta, header, tier, empty }.
 * header = "NYK vs Scoring Guard / Wing · +2.4 FP/player-game · target";
 * empty = why no player is listed (null when some are), from
 * slate.status ('none' | 'loading' | 'error' | 'ready') and slate.teams.
 */
export function cellPopoverModel({ team, label, value, unit, tier = 'neutral', players = [], slate = {} }) {
  const title = `${team} vs ${label}`
  const delta = `${formatDelta(value)} ${unit}/player-game`
  tier = TIER_LABELS[tier] ? tier : 'neutral'
  const header = `${title} · ${delta} · ${tier}`
  let empty = null
  if (slate.status === 'none') empty = 'No slate selected. Pick a slate in the top bar to see who faces this defense.'
  else if (slate.status === 'loading') empty = 'Loading slate players…'
  else if (slate.status === 'error') empty = 'Couldn’t load the slate players.'
  else if (!players.length) {
    empty = slate.teams && !slate.teams.has(team) ? `${team} is not on this slate` : `No ${plural(label)} face ${team} on this slate`
  }
  return { title, delta, header, tier, empty }
}

/** 4,500 -> "$4.5K"; missing -> em dash. */
export const formatSalary = (s) => (s == null || s === '' ? '—' : `$${(Number(s) / 1000).toFixed(1)}K`)

/** Projected ownership (percent) -> "12.3%"; missing -> em dash. */
export const formatOwnership = (o) => (o == null || o === '' || Number.isNaN(Number(o)) ? '—' : `${Number(o).toFixed(1)}%`)

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

/** Player card target for a Tonight row (or /tonight roster entry), on the slate the table shows (a backtest's night included). */
export const tonightCardTarget = (p, data) => ({
  playerId: p.player_id,
  slateId: data?.slateId ?? null,
  slateDate: data?.isBacktest ? data.slateDate ?? null : null,
  name: p.name,
  headshot: p.headshot ?? null,
  team: p.team,
});
