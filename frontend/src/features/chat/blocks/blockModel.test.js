import { describe, it, expect } from 'vitest'
import {
  blocksFromMessage,
  cardPlayers,
  displayPosition,
  edgeTone,
  lineupEntries,
  nameKey,
  normalizeBlock,
  optimizerHandoff,
  playerFlags,
  resolveSlatePlayer,
  valuePer1k,
} from './blockModel'

// Fixtures follow the backend block schema (backend/src/services/chatTools/uiBlocks.js)
describe('normalizeBlock', () => {
  it('accepts { messageId, block } events and bare blocks, splitting envelope from payload', () => {
    const block = { version: 1, id: 'call_1:0', tool: 'get_streaks_and_consistency', type: 'streaks', title: 'Hot', note: 'n', kind: 'hot', players: [] }
    expect(normalizeBlock({ messageId: 'm1', block })).toEqual({ id: 'call_1:0', type: 'streaks', title: 'Hot', note: 'n', data: { kind: 'hot', players: [] } })
    expect(normalizeBlock({ version: 1, type: 'lineup', slots: [] }, 3)).toMatchObject({ id: 'lineup-3', type: 'lineup', data: { slots: [] } })
  })

  it('returns null for things that are not blocks', () => {
    expect(normalizeBlock(null)).toBeNull()
    expect(normalizeBlock({ players: [] })).toBeNull()
    expect(normalizeBlock('player_list')).toBeNull()
  })
})

describe('blocksFromMessage', () => {
  it('reads message.uiBlocks (live and saved messages)', () => {
    const block = { version: 1, type: 'lineup', slots: [] }
    expect(blocksFromMessage({ uiBlocks: [block, null] })).toHaveLength(1)
    expect(blocksFromMessage({ uiBlocks: [] })).toEqual([])
    expect(blocksFromMessage({ content: 'hi' })).toEqual([])
  })
})

describe('nameKey / resolveSlatePlayer', () => {
  const slate = [
    { id: 11, player_id: 'p11', name: 'Luka Dončić', team: 'LAL' },
    { id: 12, player_id: 'p12', name: 'Jaren Jackson Jr.', team: 'MEM' },
  ]

  it('strips accents, punctuation and suffixes', () => {
    expect(nameKey('Luka Dončić')).toBe('luka doncic')
    expect(nameKey("Jaren Jackson Jr.")).toBe('jaren jackson')
    expect(nameKey("De'Aaron Fox")).toBe('deaaron fox')
  })

  it('matches by id, player_id, then name', () => {
    expect(resolveSlatePlayer(slate, { id: 12 })?.name).toBe('Jaren Jackson Jr.')
    expect(resolveSlatePlayer(slate, { playerId: 'p11' })?.id).toBe(11)
    expect(resolveSlatePlayer(slate, { name: 'Luka Doncic' })?.id).toBe(11)
    expect(resolveSlatePlayer(slate, { name: 'Nobody' })).toBeNull()
  })
})

describe('cardPlayers', () => {
  it('maps player_list rows', () => {
    const [p] = cardPlayers('player_list', {
      players: [
        {
          name: 'A One', player_key: 'a one', team: 'BOS', opponent: 'NYK', position: 'PG', salary: 8000, projection: 44,
          archetype: 'primary_creator', archetype_label: 'Primary Creator', matchup_edge: 3.1, adjusted_edge: 2.4,
          projected_minutes: 34, last_season_minutes: 30, ownership: 12, flags: ['role_up'], injury_status: 'Q',
        },
      ],
    })
    expect(p).toMatchObject({
      name: 'A One', playerKey: 'a one', team: 'BOS', opponent: 'NYK', salary: 8000, projection: 44, archetypeLabel: 'Primary Creator',
      matchupEdge: 3.1, adjustedEdge: 2.4, minutes: 34, lastSeasonMinutes: 30, ownership: 12, injuryStatus: 'Q',
    })
  })

  it('labels a bare archetype key and summarizes profile stats', () => {
    const [p] = cardPlayers('player_list', { players: [{ name: 'P', archetype: 'stretch_big', stats: { usg_pct: 0.31, dk_avg: 42.5, minutes_pg: 33 } }] })
    expect(p).toMatchObject({ archetypeLabel: 'Stretch Big', minutes: 33 })
    expect(p.note).toBe('USG 31% · 42.5 DK avg')
  })

  it('maps usage bumps with the bumped projection and minutes without / with', () => {
    const [p] = cardPlayers('usage_bumps', {
      bumps: [
        {
          player: { name: 'B Two', team: 'GSW', opponent: 'LAL', salary: 5000, projection: 25 },
          missing_player: 'Star Guy', avg_with: 24, avg_without: 30.2, minutes_with: 26, minutes_without: 32, bumped_projection: 31, confidence: 'high',
        },
      ],
    })
    expect(p).toMatchObject({ name: 'B Two', projection: 31, minutes: 32, lastSeasonMinutes: 26 })
    expect(p.note).toBe('+6.2 FP without Star Guy (high confidence)')
  })

  it('maps streak rows (no salary)', () => {
    const [p] = cardPlayers('streaks', { kind: 'hot', players: [{ name: 'C Three', team: 'DEN', season_avg: 40, last3_avg: 52 }] })
    expect(p).toMatchObject({ name: 'C Three', team: 'DEN', salary: null })
    expect(p.note).toMatch(/52/)
  })
})

describe('playerFlags', () => {
  it('turns flags and injury status into badges with tips', () => {
    const flags = playerFlags({ flags: ['role_down', 'new_team', 'crowded', 'missing'], injuryStatus: 'GTD', minutes: 20, lastSeasonMinutes: 28 })
    expect(flags.map((f) => f.label)).toEqual(['Role ↓', 'New team', 'Crowded', 'Missing', 'GTD'])
    expect(flags.find((f) => f.key === 'role_down').tip).toMatch(/20 min vs 28/)
    expect(flags.find((f) => f.key === 'injury').tone).toBe('negative')
    expect(playerFlags({ injuryStatus: 'Active' })).toEqual([])
  })
})

describe('displayPosition', () => {
  it('drops site flex slots', () => {
    expect(displayPosition('PG,G,UTIL')).toBe('PG')
    expect(displayPosition('SG,SF,G,F,UTIL')).toBe('SG/SF')
    expect(displayPosition('C')).toBe('C')
    expect(displayPosition(null)).toBeNull()
  })
})

describe('numbers', () => {
  it('value per 1K and edge tone', () => {
    expect(valuePer1k(40, 8000)).toBe(5)
    expect(valuePer1k(40, null)).toBeNull()
    expect(edgeTone(2.5)).toBe('positive')
    expect(edgeTone(-2.5)).toBe('negative')
    expect(edgeTone(0.4)).toBe('neutral')
  })
})

describe('lineups', () => {
  const slate = [
    { id: 1, player_id: 'a', name: 'Guard One', team: 'BOS', position: 'PG', salary: 9000, projected_points: 45 },
    { id: 2, player_id: 'b', name: 'Big Two', team: 'NYK', position: 'C', salary: 7000, projected_points: 38 },
  ]

  it('lineupEntries resolves block slots against the slate', () => {
    const entries = lineupEntries(
      { slots: [{ slot: 'PG', player: { name: 'Guard One' } }, { slot: 'C', player: { name: 'Unknown Guy', salary: 3000, projection: 12 } }, { slot: 'UTIL', player: null }] },
      slate,
    )
    expect(entries[0]).toMatchObject({ slot: 'PG', player: { id: 1, salary: 9000 }, onSlate: true })
    expect(entries[1]).toMatchObject({ slot: 'C', player: { name: 'Unknown Guy', salary: 3000, projected_points: 12 }, onSlate: false })
    expect(entries[2]).toMatchObject({ slot: 'UTIL', player: { name: '' }, onSlate: false })
  })

  it('optimizerHandoff keeps slot + ids + name', () => {
    const entries = lineupEntries({ slots: [{ slot: 'PG', player: { name: 'Guard One' } }] }, slate)
    expect(optimizerHandoff(entries)).toEqual({ slots: [{ slot: 'PG', id: 1, playerId: 'a', name: 'Guard One' }] })
  })
})
