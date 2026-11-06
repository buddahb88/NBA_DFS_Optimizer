import { describe, it, expect } from 'vitest'
import {
  buildHeatmap, cellColor, cellPopoverModel, defenseParams, defenseTiers, edgeBadges, edgeExplanation, formatDelta, formatOwnership,
  formatSalary, parseDeepLink, parseTeams, resolveTeams, slateCellPlayers, slateOpponents, slateTeams, STATS, teamsParam, TONIGHT_SORTS,
  tonightSorting,
} from './archetypes'

const DEFINITIONS = {
  archetypes: [
    { key: 'primary_creator', label: 'Primary Creator' },
    { key: 'scoring_guard', label: 'Scoring Guard / Wing' },
    { key: 'role_player', label: 'Role Player' },
    { key: 'unclassified', label: 'Unclassified' },
  ],
  positions: [{ key: 'G', label: 'Guards' }, { key: 'F', label: 'Forwards' }, { key: 'C', label: 'Centers' }],
}

const ROWS = [
  { team: 'NYK', group_key: 'scoring_guard', fp_over_expectation: 3, pts_delta: 1, games: 8 },
  { team: 'BOS', group_key: 'scoring_guard', fp_over_expectation: -2, pts_delta: -1, games: 8 },
  { team: 'BOS', group_key: 'primary_creator', fp_over_expectation: 0.5, pts_delta: 0, games: 6 },
  { team: 'BOS', group_key: 'unclassified', fp_over_expectation: 9, pts_delta: 9, games: 2 },
]

describe('buildHeatmap', () => {
  it('teams as rows (A-Z), archetypes as columns in definition order, unclassified dropped', () => {
    const map = buildHeatmap(ROWS, { definitions: DEFINITIONS, grouping: 'archetype', stat: 'fp' })
    expect(map.teams).toEqual(['BOS', 'NYK'])
    // Only archetypes with data show
    expect(map.groups.map((g) => g.key)).toEqual(['primary_creator', 'scoring_guard'])
    expect(map.cell('NYK', 'scoring_guard')).toMatchObject({ value: 3, row: ROWS[0] })
    expect(map.cell('NYK', 'primary_creator')).toBeNull()
    expect(map.maxAbs).toBe(3)
  })

  it('reads the selected stat column and G/F/C columns for the position grouping', () => {
    const rows = [{ team: 'NYK', group_key: 'C', fp_over_expectation: 1, reb_delta: -0.8 }, { team: 'NYK', group_key: 'G', reb_delta: 0.4 }]
    const map = buildHeatmap(rows, { definitions: DEFINITIONS, grouping: 'position', stat: 'reb' })
    expect(map.groups.map((g) => g.label)).toEqual(['Guards', 'Centers'])
    expect(map.cell('NYK', 'C').value).toBe(-0.8)
    expect(map.maxAbs).toBe(0.8)
  })

  it('narrows rows to the selected teams but keeps the color scale and columns league-wide', () => {
    const all = buildHeatmap(ROWS, { definitions: DEFINITIONS, grouping: 'archetype', stat: 'fp' })
    const map = buildHeatmap(ROWS, { definitions: DEFINITIONS, grouping: 'archetype', stat: 'fp', teams: ['BOS'] })
    expect(map.teams).toEqual(['BOS'])
    expect(map.allTeams).toEqual(['BOS', 'NYK'])
    // NYK's +3 still sets the scale, so BOS's -2 keeps its color
    expect(map.maxAbs).toBe(3)
    expect(cellColor(map.cell('BOS', 'scoring_guard').value, map.maxAbs)).toBe(cellColor(all.cell('BOS', 'scoring_guard').value, all.maxAbs))
    expect(map.groups).toEqual(all.groups)
    // Unknown teams just match nothing
    expect(buildHeatmap(ROWS, { definitions: DEFINITIONS, grouping: 'archetype', stat: 'fp', teams: ['LAL'] }).teams).toEqual([])
    expect(buildHeatmap(ROWS, { definitions: DEFINITIONS, grouping: 'archetype', stat: 'fp', teams: null }).teams).toEqual(['BOS', 'NYK'])
  })

  it('handles no rows', () => {
    const map = buildHeatmap([], { definitions: DEFINITIONS, grouping: 'archetype', stat: 'fp' })
    expect(map.teams).toEqual([])
    expect(map.groups).toEqual([])
  })
})

describe('team filter helpers', () => {
  it('parses ?teams= into all / tonight / a sorted list and back', () => {
    expect(parseTeams(null)).toEqual([])
    expect(parseTeams('')).toEqual([])
    expect(parseTeams('Tonight')).toBe('tonight')
    expect(parseTeams('nyk, bos,NYK,,b@d,TOOLONG')).toEqual(['BOS', 'NYK'])
    expect(teamsParam([])).toBe('')
    expect(teamsParam('tonight')).toBe('tonight')
    expect(teamsParam(['BOS', 'NYK'])).toBe('BOS,NYK')
    for (const v of ['BOS,NYK', 'tonight', '']) expect(teamsParam(parseTeams(v))).toBe(v)
  })

  it('deep link carries the team filter alongside the cell', () => {
    const { filters, cell } = parseDeepLink(new URLSearchParams('season=2025-26&teams=NYK,BOS&team=nyk&group=scoring_guard'))
    expect(filters).toMatchObject({ season: '2025-26', teams: ['BOS', 'NYK'] })
    expect(cell).toEqual({ team: 'NYK', group: 'scoring_guard' })
    expect(parseDeepLink(new URLSearchParams('teams=tonight')).filters.teams).toBe('tonight')
    expect(parseDeepLink(new URLSearchParams('')).filters.teams).toEqual([])
  })

  const TONIGHT = {
    roster: [{ team: 'MIA' }, { team: 'NYK' }, { team: 'MIA' }, { team: null }],
    players: [{ team: 'MIA', opponent: 'NYK' }, { team: 'BOS', opponent: 'PHX' }],
  }

  it('slate teams come from the roster and matchup rows; opponents both ways', () => {
    expect(slateTeams(TONIGHT)).toEqual(['BOS', 'MIA', 'NYK', 'PHX'])
    expect(slateTeams(null)).toEqual([])
    expect(Object.fromEntries(slateOpponents(TONIGHT))).toEqual({ MIA: 'NYK', NYK: 'MIA', BOS: 'PHX', PHX: 'BOS' })
  })

  it('resolves the selection: null means no filter', () => {
    expect(resolveTeams([], ['BOS'])).toBeNull()
    expect(resolveTeams(['NYK'], ['BOS'])).toEqual(['NYK'])
    expect(resolveTeams('tonight', ['BOS', 'MIA'])).toEqual(['BOS', 'MIA'])
    // Shortcut before the slate's teams are known: show everything
    expect(resolveTeams('tonight', [])).toBeNull()
  })
})

describe('cellColor', () => {
  it('diverges: info hue above zero, negative below, alpha by magnitude, neutral at zero', () => {
    expect(cellColor(3, 3)).toBe('rgb(var(--info) / 0.8)')
    expect(cellColor(-1.5, 3)).toBe('rgb(var(--negative) / 0.44)')
    expect(cellColor(0, 3)).toBe('transparent')
    expect(cellColor(null, 3)).toBe('transparent')
    // Beyond the scale clamps
    expect(cellColor(10, 3)).toBe('rgb(var(--info) / 0.8)')
  })
})

describe('formatDelta', () => {
  it('signs and rounds', () => {
    expect(formatDelta(2.345)).toBe('+2.3')
    expect(formatDelta(-0.04)).toBe('0.0')
    expect(formatDelta(-1.25, 2)).toBe('-1.25')
    expect(formatDelta(null)).toBe('—')
  })
})

describe('defenseParams', () => {
  it('drops empty filters and asks for the season fallback on Auto', () => {
    expect(defenseParams({ season: '2026-27', grouping: 'position', lastNGames: '', stat: 'fp' }, 'fanduel')).toEqual({
      season: '2026-27', grouping: 'position', site: 'fanduel',
    })
    // Auto season: the backend may fall back to last season while the current one is thin
    expect(defenseParams({ season: '', grouping: 'archetype', lastNGames: 10 }, 'draftkings')).toEqual({
      grouping: 'archetype', lastNGames: 10, site: 'draftkings', seasonFallback: true,
    })
  })

  it('every stat maps to a defense column', () => {
    expect(STATS.map((s) => s.value)).toEqual(['fp', 'pts', 'reb', 'ast', 'fg3m'])
  })
})

const EDGE_CONFIG = { fullMinutes: 32, penalties: { new_team: 0.85, role_down: 0.8, role_up: 0.9, no_history: 0.85 }, crowdingPenalty: 0.25 }
const edgePlayer = (extra = {}) => ({
  name: "Kel'el Ware", team: 'MIL', opponent: 'WAS', label: 'Stretch Big', matchup_delta: 4.449, adjusted_edge: 2.363,
  projected_minutes: 25, last_team: 'MIA', flags: ['new_team', 'crowded'],
  minutes: { projected: 25, last_season: 22.2, current: null, current_games: 0, change: 2.8, basis: 'projected' },
  crowding: { count: 1, teammates: ['Myles Turner'] },
  components: { volume: 0.781, role_factor: 0.85, minutes_confidence: 0.664, crowding_factor: 0.8 },
  ...extra,
})

describe('tonight edge helpers', () => {
  it('sorts by adjusted edge by default, raw matchup on request', () => {
    expect(tonightSorting('adjusted')).toEqual([{ id: 'adjusted_edge', desc: true }])
    expect(tonightSorting('raw')).toEqual([{ id: 'matchup_delta', desc: true }])
    expect(TONIGHT_SORTS.map((s) => s.value)).toEqual(['adjusted', 'raw'])
  })

  it('builds a badge with a tooltip per flag', () => {
    const badges = edgeBadges(edgePlayer(), EDGE_CONFIG)
    expect(badges.map((b) => [b.key, b.label, b.tone])).toEqual([
      ['new_team', 'New team', 'info'],
      ['crowded', 'Crowded', 'caution'],
    ])
    expect(badges[0].tip).toBe('Was MIA last season (22.2 min). Role on a new team is uncertain: edge x0.85.')
    expect(badges[1].tip).toBe('Shares Stretch Big vs WAS with Myles Turner: edge x0.80.')
  })

  it('role badges explain the minutes change', () => {
    const down = edgeBadges(edgePlayer({
      flags: ['role_down'],
      minutes: { projected: 24, last_season: 32.1, current: 22, current_games: 2, change: -8.1, basis: 'projected' },
    }), EDGE_CONFIG)
    expect(down).toEqual([{
      key: 'role_down', label: 'Role ↓', tone: 'negative',
      tip: 'Projected 24 min vs 32.1 last season (-8.1); 22.0 min over 2 games this season. Edge x0.80.',
    }])
    const up = edgeBadges(edgePlayer({ flags: ['role_up', 'no_history'] }), EDGE_CONFIG)
    expect(up.map((b) => b.label)).toEqual(['Role ↑', 'No history'])
    expect(up[1].tip).toBe('No last-season profile to check minutes or role against: edge x0.85.')
  })

  it('explains the adjusted edge from its components', () => {
    expect(edgeExplanation(edgePlayer())).toBe(
      '+4.45 matchup x 0.78 minutes (25 min) x 0.85 role x 0.80 crowding = +2.36',
    )
    expect(edgeExplanation(edgePlayer({ adjusted_edge: null }))).toBe(null)
  })
})

describe('cell popover helpers', () => {
  // Six defenses vs scoring guards: tier size = ceil(6 / 3) = 2
  const TIER_ROWS = [
    ['AAA', 4], ['BBB', 2], ['CCC', 1], ['DDD', -1], ['EEE', -2], ['FFF', -3],
  ].map(([team, fp]) => ({ team, group_key: 'scoring_guard', fp_over_expectation: fp, reb_delta: -fp, games: 10 }))

  it('defenseTiers: top third allowing more = target, bottom third allowing less = avoid, per stat', () => {
    const tiers = defenseTiers(TIER_ROWS, 'fp')
    expect(['AAA', 'BBB', 'CCC', 'DDD', 'EEE', 'FFF'].map((t) => tiers.get(`${t}|scoring_guard`)))
      .toEqual(['target', 'target', 'neutral', 'neutral', 'avoid', 'avoid'])
    // Rebounds flip the order
    expect(defenseTiers(TIER_ROWS, 'reb').get('FFF|scoring_guard')).toBe('target')
    expect(defenseTiers(TIER_ROWS, 'reb').get('AAA|scoring_guard')).toBe('avoid')
  })

  it('defenseTiers: a top-third defense below expectation is not a target (and vice versa)', () => {
    const rows = [['AAA', -0.5], ['BBB', -1], ['CCC', -2]].map(([team, fp]) => ({ team, group_key: 'G', fp_over_expectation: fp }))
    const tiers = defenseTiers(rows, 'fp')
    expect(tiers.get('AAA|G')).toBe('neutral')
    expect(tiers.get('CCC|G')).toBe('avoid')
    const soft = [['AAA', 3], ['BBB', 2], ['CCC', 1]].map(([team, fp]) => ({ team, group_key: 'G', fp_over_expectation: fp }))
    expect(defenseTiers(soft, 'fp').get('CCC|G')).toBe('neutral')
  })

  it('buildHeatmap.tier stays league-wide under the team filter', () => {
    const map = buildHeatmap(TIER_ROWS, { definitions: DEFINITIONS, grouping: 'archetype', stat: 'fp', teams: ['EEE'] })
    expect(map.teams).toEqual(['EEE'])
    expect(map.tier('EEE', 'scoring_guard')).toBe('avoid')
    expect(map.tier('AAA', 'scoring_guard')).toBe('target')
    expect(map.tier('ZZZ', 'scoring_guard')).toBe('neutral')
  })

  const ROSTER = [
    { player_id: '1', name: 'Guard One', team: 'MIA', opponent: 'NYK', group_key: 'scoring_guard', projected_points: 30, salary: 7000 },
    { player_id: '2', name: 'Guard Two', team: 'MIA', opponent: 'NYK', group_key: 'scoring_guard', projected_points: 40, salary: 8000 },
    { player_id: '3', name: 'Big Three', team: 'MIA', opponent: 'NYK', group_key: 'rim_running_big', projected_points: 25 },
    { player_id: '4', name: 'Knick Guard', team: 'NYK', opponent: 'MIA', group_key: 'scoring_guard', projected_points: 35 },
    { player_id: '5', name: 'No Archetype', team: 'NYK', opponent: 'MIA', group_key: null, projected_points: 20 },
    { player_id: '6', name: 'No Opponent', team: 'LAL', opponent: null, group_key: 'scoring_guard', projected_points: 20 },
    { player_id: '7', name: 'Tie Cheap', team: 'MIA', opponent: 'NYK', group_key: 'scoring_guard', projected_points: 30, salary: 5000 },
  ]

  it('slateCellPlayers: each player sits in his opponent row under his column, best projection first', () => {
    const cells = slateCellPlayers({ grouping: 'archetype', roster: ROSTER }, 'archetype')
    expect(cells.get('NYK|scoring_guard').map((p) => p.name)).toEqual(['Guard Two', 'Guard One', 'Tie Cheap'])
    expect(cells.get('NYK|rim_running_big').map((p) => p.name)).toEqual(['Big Three'])
    expect(cells.get('MIA|scoring_guard').map((p) => p.name)).toEqual(['Knick Guard'])
    // Unclassified / no opponent: no cell
    expect([...cells.values()].flat().some((p) => ['No Archetype', 'No Opponent'].includes(p.name))).toBe(false)
    expect(cells.size).toBe(3)
  })

  it('slateCellPlayers: nothing for a body built for another grouping, or without a roster', () => {
    expect(slateCellPlayers({ grouping: 'archetype', roster: ROSTER }, 'position').size).toBe(0)
    expect(slateCellPlayers(null, 'archetype').size).toBe(0)
    expect(slateCellPlayers({ grouping: 'position', roster: [{ ...ROSTER[0], group_key: 'G' }] }, 'position').get('NYK|G')).toHaveLength(1)
  })

  it('slateTeams / slateOpponents include roster opponents', () => {
    const tonight = { roster: [{ team: 'MIA', opponent: 'NYK' }, { team: 'LAL', opponent: 'GSW' }], players: [] }
    expect(slateTeams(tonight)).toEqual(['GSW', 'LAL', 'MIA', 'NYK'])
    expect(slateOpponents(tonight).get('GSW')).toBe('LAL')
    expect(slateOpponents(tonight).get('NYK')).toBe('MIA')
  })

  const base = { team: 'NYK', label: 'Scoring Guard / Wing', value: 2.44, unit: 'FP' }
  const ready = { status: 'ready', teams: new Set(['NYK', 'MIA']) }

  it('cellPopoverModel: header with delta and tier', () => {
    expect(cellPopoverModel({ ...base, tier: 'target', players: [{}], slate: ready })).toEqual({
      title: 'NYK vs Scoring Guard / Wing',
      delta: '+2.4 FP/player-game',
      header: 'NYK vs Scoring Guard / Wing · +2.4 FP/player-game · target',
      tier: 'target',
      empty: null,
    })
    expect(cellPopoverModel({ ...base, value: -3, tier: 'avoid', players: [{}], slate: ready }).header)
      .toBe('NYK vs Scoring Guard / Wing · -3.0 FP/player-game · avoid')
    expect(cellPopoverModel({ ...base, players: [{}], slate: ready }).tier).toBe('neutral')
    expect(cellPopoverModel({ ...base, tier: 'bogus', players: [{}], slate: ready }).tier).toBe('neutral')
  })

  it('cellPopoverModel: empty states', () => {
    expect(cellPopoverModel({ ...base, slate: ready }).empty).toBe('No Scoring Guard / Wings face NYK on this slate')
    expect(cellPopoverModel({ ...base, label: 'Guards', slate: ready }).empty).toBe('No Guards face NYK on this slate')
    expect(cellPopoverModel({ ...base, team: 'BOS', slate: ready }).empty).toBe('BOS is not on this slate')
    expect(cellPopoverModel({ ...base, slate: { status: 'none' } }).empty).toMatch(/^No slate selected/)
    expect(cellPopoverModel({ ...base, slate: { status: 'loading' } }).empty).toBe('Loading slate players…')
    expect(cellPopoverModel({ ...base, slate: { status: 'error' } }).empty).toMatch(/load the slate players/)
  })

  it('formats salary and ownership', () => {
    expect(formatSalary(4500)).toBe('$4.5K')
    expect(formatSalary(null)).toBe('—')
    expect(formatOwnership(12.345)).toBe('12.3%')
    expect(formatOwnership(null)).toBe('—')
  })
})
