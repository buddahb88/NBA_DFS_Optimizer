import { describe, it, expect } from 'vitest'
import { activeMentions, filterPlayers, findMentionQuery, formatPositions, insertMention, mentionKey, toMention } from './mentions'

const PLAYERS = [
  { name: 'Luka Dončić', team: 'LAL', salary: 11000 },
  { name: 'LeBron James', team: 'LAL', salary: 9800 },
  { name: 'Jaren Jackson Jr.', team: 'MEM', salary: 8000 },
  { name: 'Kyle Lowry', team: 'PHI', salary: 3500 },
]

describe('mentions', () => {
  it('finds the @query before the caret', () => {
    expect(findMentionQuery('Is @lu')).toEqual({ start: 3, query: 'lu' })
    expect(findMentionQuery('@luka don')).toEqual({ start: 0, query: 'luka don' })
    expect(findMentionQuery('mail me@x')).toBeNull()
    expect(findMentionQuery('no mention')).toBeNull()
    expect(findMentionQuery('@lu and more', 3)).toEqual({ start: 0, query: 'lu' })
  })

  it('filters accent-insensitively, prefix matches first, then by salary', () => {
    expect(filterPlayers(PLAYERS, 'doncic').map((p) => p.name)).toEqual(['Luka Dončić'])
    expect(filterPlayers(PLAYERS, 'l').map((p) => p.name)).toEqual(['Luka Dončić', 'LeBron James', 'Kyle Lowry'])
    expect(filterPlayers(PLAYERS, 'ja').map((p) => p.name)).toEqual(['Jaren Jackson Jr.', 'LeBron James'])
    expect(filterPlayers(PLAYERS, '').length).toBe(4)
    expect(filterPlayers(PLAYERS, 'zz')).toEqual([])
  })

  it('replaces the @query with the plain name', () => {
    const text = 'Is @lu a play?'
    expect(insertMention(text, { start: 3, query: 'lu' }, 'Luka Dončić')).toEqual({ text: 'Is Luka Dončić a play?', caret: 14 })
    expect(insertMention('Fade @leb', { start: 5, query: 'leb' }, 'LeBron James')).toEqual({ text: 'Fade LeBron James ', caret: 18 })
  })

  it('builds mention metadata with a history player_key', () => {
    expect(mentionKey('Jaren Jackson Jr.')).toBe('jaren jackson')
    expect(mentionKey('Luka Dončić')).toBe('luka doncic')
    expect(toMention(PLAYERS[0])).toMatchObject({ name: 'Luka Dončić', team: 'LAL', salary: 11000, player_key: 'luka doncic' })
    expect(toMention({ name: 'X', player_key: 'custom' }).player_key).toBe('custom')
  })

  it('drops mentions whose name was deleted from the text', () => {
    const mentions = [toMention(PLAYERS[0]), toMention(PLAYERS[1])]
    expect(activeMentions(mentions, 'Luka Dončić or not').map((m) => m.name)).toEqual(['Luka Dončić'])
  })

  it('shows specific DK positions without the flex slots', () => {
    expect(formatPositions('PG,G,UTIL')).toBe('PG')
    expect(formatPositions('SG,SF,G,F,UTIL')).toBe('SG/SF')
    expect(formatPositions('G')).toBe('G')
    expect(formatPositions(null)).toBe('')
  })
})
