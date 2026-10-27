// Opportunity Radar (GET /api/opportunity/radar): pure helpers for the
// Insights tab - modes, filters, and the compact metric cells (value,
// tone and tooltip per metric, sample sizes included).

export const RADAR_MODES = [
  { value: 'cash', label: 'Cash', hint: 'Projected minutes, stability, floor and 5x hit rate weigh most' },
  { value: 'gpp', label: 'GPP', hint: 'Ceiling, leverage vs ownership, vacated usage and environment weigh most' },
]

export const POSITIONS = ['PG', 'SG', 'SF', 'PF', 'C']

export const DEFAULT_RADAR_FILTERS = { minSalary: '', maxSalary: '', position: '', minScore: '' }

const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v))
const signed = (x, digits = 1) => `${x > 0 ? '+' : ''}${x.toFixed(digits)}`
const pct = (x, digits = 1) => (x === null ? '—' : `${(100 * x).toFixed(digits)}%`)
const pts = (x) => (x === null ? '—' : signed(100 * x))
const or = (x, f) => (x === null ? '—' : f(x))

/** Rows passing the filters: salary range, position (multi-position aware), minimum score. */
export function filterRadarRows(rows = [], filters = DEFAULT_RADAR_FILTERS) {
  const min = num(filters.minSalary)
  const max = num(filters.maxSalary)
  const minScore = num(filters.minScore)
  return rows.filter((p) => {
    const salary = num(p.salary) ?? 0
    if (min !== null && salary < min) return false
    if (max !== null && salary > max) return false
    if (filters.position && !String(p.position || '').split('/').includes(filters.position)) return false
    if (minScore !== null && !(num(p.score) >= minScore)) return false
    return true
  })
}

/** Score badge tone: 60+ positive, under 45 negative, else neutral. */
export const scoreTone = (score) => (score === null || score === undefined ? 'neutral' : score >= 60 ? 'positive' : score < 45 ? 'negative' : 'neutral')

const COMPONENT_LABELS = {
  projMinutes: 'Projected minutes',
  minutes: 'Minutes trend',
  usage: 'Usage trend',
  vacated: 'Vacated usage',
  gap: 'Projection gap',
  hitRate: 'Value hit rate',
  stability: 'Role stability',
  floor: 'Floor / $1K',
  environment: 'Game environment',
  upside: 'Ceiling / $1K',
  leverage: 'Leverage vs ownership',
}

/** Score tooltip lines: each weighted component as 0-100 (— without data), then coverage. */
export function scoreBreakdown(row, weights = {}) {
  const lines = Object.entries(weights)
    .filter(([, w]) => w > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([key, w]) => {
      const c = row.components?.[key]
      return `${COMPONENT_LABELS[key] ?? key} (${Math.round(100 * w)}%): ${c === null || c === undefined ? '—' : Math.round(100 * c)}`
    })
  if (row.coverage !== null && row.coverage !== undefined) lines.push(`Data coverage ${Math.round(100 * row.coverage)}% of weight (missing = neutral 50)`)
  return lines
}

const sample = (n, unit = 'games') => `${n ?? 0} ${unit}`

/**
 * Compact metric cells: { id, header, label, value(row), format(v), tone(row) ->
 * 'positive' | 'caution' | 'negative' | null, tip(row) -> string }.
 */
export const RADAR_METRICS = [
  {
    id: 'min_trend',
    header: 'Min Δ',
    label: 'Minutes trend (L3 vs season)',
    value: (r) => num(r.min_delta_l3),
    format: (v) => or(v, signed),
    tone: (r) => {
      const v = num(r.min_delta_l3)
      return v === null ? null : v >= 3 ? 'positive' : v <= -3 ? 'negative' : null
    },
    tip: (r) =>
      `Minutes L3 ${or(num(r.min_l3), (x) => x.toFixed(1))} / L5 ${or(num(r.min_l5), (x) => x.toFixed(1))} vs ${r.season_fallback ? 'last season' : 'season'} ${or(num(r.min_season), (x) => x.toFixed(1))}` +
      ` (${sample(r.games_l3)} L3, ${sample(r.games_season)} baseline${r.season_fallback ? ', current season under 3 games' : ''}).` +
      (num(r.projected_minutes) !== null ? ` Projected tonight: ${num(r.projected_minutes).toFixed(0)}.` : ''),
  },
  {
    id: 'usage_trend',
    header: 'Usg Δ',
    label: 'Usage trend (L5 vs season, pts)',
    value: (r) => num(r.usg_delta),
    format: (v) => or(v, pts),
    tone: (r) => {
      const v = num(r.usg_delta)
      return v === null ? null : v >= 0.03 ? 'positive' : v <= -0.03 ? 'negative' : null
    },
    tip: (r) => `Usage L5 ${pct(num(r.usg_l5))} vs baseline ${pct(num(r.usg_season))} (${sample(r.games_l5)} L5, ${sample(r.games_season)} baseline).`,
  },
  {
    id: 'vacated',
    header: 'Vacated',
    label: 'Vacated usage absorbed (teammates out)',
    value: (r) => (r.teammate_sample === 'confirmed' || r.teammate_sample === 'thin' ? num(r.teammate_absorbed_pct) : null),
    format: (v) => (v === null ? '—' : `${Math.round(100 * v)}%`),
    tone: (r) => {
      if (r.teammate_sample !== 'confirmed' && r.teammate_sample !== 'thin') return null
      const v = num(r.teammate_absorbed_pct)
      if (v === null) return null
      if (v < 0) return 'negative'
      return r.teammate_sample === 'thin' ? 'caution' : v >= 0.1 ? 'positive' : null
    },
    tip: (r) => {
      const outs = r.team_out_names ?? []
      if (!outs.length) return 'No regulars ruled out before lock on his team.'
      const head = `${outs.join(', ')} OUT: ${pct(num(r.team_vacated_usage))} of team plays vacated.`
      if (r.teammate_sample !== 'confirmed' && r.teammate_sample !== 'thin') return `${head} No games without them to measure his share.`
      return `${head} Without ${(r.teammate_out_names ?? []).join(' + ')}: absorbs ${pct(num(r.teammate_absorbed_pct), 0)} of it` +
        ` (play share ${or(num(r.teammate_play_share_delta), pts)} pts, ${or(num(r.teammate_min_delta), signed)} min)` +
        ` over ${sample(r.teammate_games_without)} without, ${r.teammate_sample} sample.`
    },
  },
  {
    id: 'proj_gap',
    header: 'Proj gap',
    label: 'Rate projection vs posted (pts)',
    value: (r) => num(r.rate_gap),
    format: (v) => or(v, signed),
    tone: (r) => {
      const v = num(r.rate_gap)
      return v === null ? null : v >= 3 ? 'positive' : v <= -3 ? 'negative' : null
    },
    tip: (r) => {
      if (num(r.rate_projection) === null) {
        return r.rate_reason === 'no_projected_minutes' ? 'No projected minutes: no rate projection.' : 'No games before the slate: no rate projection.'
      }
      const mate = r.rate_teammate_applied ? ` × teammate-out ${num(r.rate_teammate_factor).toFixed(3)}` : ''
      return `Rate projection ${num(r.rate_projection).toFixed(1)} = ${or(num(r.projected_minutes), (x) => x.toFixed(0))} min × FPPM ${or(num(r.rate_fppm), (x) => x.toFixed(3))}` +
        ` × environment ${or(num(r.rate_env_factor), (x) => x.toFixed(3))}${mate}, vs posted ${or(num(r.projected_points), (x) => x.toFixed(1))}.`
    },
  },
  {
    id: 'hit_rate',
    header: 'Hit 5x',
    label: 'Value hit rate at tonight’s salary (L10)',
    value: (r) => num(r.hit5x_l10),
    format: (v) => or(v, (x) => `${Math.round(100 * x)}%`),
    tone: (r) => {
      const v = num(r.hit5x_l10)
      return v === null ? null : v >= 0.6 ? 'positive' : v <= 0.2 ? 'negative' : null
    },
    tip: (r) =>
      `Share of the last ${sample(r.value_games_l10)} at ≥ 4x / 5x / 6x tonight’s salary: ` +
      `${pct(num(r.hit4x_l10), 0)} / ${pct(num(r.hit5x_l10), 0)} / ${pct(num(r.hit6x_l10), 0)}.`,
  },
  {
    id: 'stability',
    header: 'Min SD',
    label: 'Role stability (minutes SD, L10)',
    value: (r) => num(r.min_sd_l10),
    format: (v) => or(v, (x) => x.toFixed(1)),
    tone: (r) => {
      const v = num(r.min_sd_l10)
      return v === null ? null : v <= 3 ? 'positive' : v >= 6 ? 'caution' : null
    },
    tip: (r) =>
      `Minutes SD ${or(num(r.min_sd_l10), (x) => x.toFixed(1))} over ${sample(r.games_l10)}; ${r.under20_l10 ?? '—'} under 20 min;` +
      ` ${r.starts_l5 ?? '—'} of ${r.games_l5 ?? 0} L5 started` +
      (r.starter_since && !r.season_fallback ? `; starter since ${r.starter_since} (${r.starter_streak} straight).` : '.'),
  },
  {
    id: 'environment',
    header: 'Env',
    label: 'Game environment (team implied total)',
    value: (r) => num(r.implied_total),
    format: (v) => or(v, (x) => x.toFixed(1)),
    tone: (r) => {
      if (r.blowout || r.back_to_back) return 'caution'
      const v = num(r.implied_total)
      return v === null ? null : v >= 118 ? 'positive' : v <= 108 ? 'negative' : null
    },
    tip: (r) =>
      `Implied ${or(num(r.implied_total), (x) => x.toFixed(1))}, O/U ${or(num(r.over_under), (x) => x.toFixed(1))}, spread ${or(num(r.spread), signed)}` +
      `${r.blowout ? ' (blowout risk)' : ''}; pace ${or(num(r.pace_proxy), (x) => x.toFixed(1))} vs league ${or(num(r.league_pace), (x) => x.toFixed(1))};` +
      ` rest ${r.rest_days ?? '—'} day(s)${r.back_to_back ? ', back-to-back' : ''}.`,
  },
]

/** Backtest strip: top decile vs slate 5x hit rate for a mode's validation block. */
export function validationSummary(v) {
  if (!v || !v.players) return null
  const fmt = (x) => (x === null || x === undefined ? '—' : `${Math.round(100 * x)}%`)
  return {
    top: `${v.top.hits}/${v.top.players} (${fmt(v.top.hitRate)})`,
    slate: `${v.slate.hits}/${v.slate.players} (${fmt(v.slate.hitRate)})`,
    lift: v.lift === null || v.lift === undefined ? '—' : `${v.lift.toFixed(2)}×`,
  }
}
