import { describe, it, expect } from 'vitest'
import { expandCommand, filterCommands, findCommand, findPlaceholder, parseSlash } from './slashCommands'

const names = (cmds) => cmds.map((c) => c.name)

describe('slash commands', () => {
  it('lists every command for a bare slash', () => {
    expect(names(filterCommands(''))).toEqual(['value', 'stacks', 'player', 'matchups', 'score', 'usage', 'help'])
  })

  it('filters by prefix first, then by name or description', () => {
    expect(names(filterCommands('s'))).toEqual(['stacks', 'score', 'value', 'matchups', 'usage', 'help'])
    expect(names(filterCommands('PL'))).toEqual(['player', 'value'])
    expect(names(filterCommands('injur'))).toEqual(['usage'])
    expect(filterCommands('zzz')).toEqual([])
  })

  it('parses typing vs a command with an argument', () => {
    expect(parseSlash('/va')).toEqual({ query: 'va' })
    expect(parseSlash('/')).toEqual({ query: '' })
    expect(parseSlash('/player Luka Doncic')).toEqual({ command: findCommand('player'), arg: 'Luka Doncic' })
    expect(parseSlash('/nope thing')).toBeNull()
    expect(parseSlash('hello /value')).toBeNull()
  })

  it('expands templates with site and mode and tabbable placeholders', () => {
    const text = expandCommand(findCommand('value'), { site: 'DraftKings', mode: 'cash' })
    expect(text).toBe("Find the best Cash value plays under $[salary] on tonight's DraftKings slate. Rank by projected points per $1K and include minutes, ownership and injury risk.")
    expect(expandCommand(findCommand('stacks'), { site: 'FanDuel', mode: 'gpp' })).toMatch(/^What are the best game stacks for GPP on tonight's FanDuel slate\?/)
  })

  it('fills the first placeholder from an argument', () => {
    expect(expandCommand(findCommand('value'), { arg: '$5500', site: 'DraftKings', mode: 'gpp' })).toContain('under $5500 on')
    const score = expandCommand(findCommand('score'), { arg: '2026-10-21', site: 'DraftKings' })
    expect(score).toBe("Score this DraftKings lineup from 2026-10-21: [players]. Show each player's actual fantasy points and the lineup total.")
    expect(expandCommand(findCommand('player'), { arg: 'Luka Doncic', mode: 'gpp', site: 'DraftKings' })).toMatch(/^Break down Luka Doncic for GPP on DraftKings/)
  })

  it('finds placeholders forwards and backwards with wrap-around', () => {
    const text = 'a [one] b [two] c'
    expect(findPlaceholder(text, 0)).toEqual({ start: 2, end: 7 })
    expect(findPlaceholder(text, 7)).toEqual({ start: 10, end: 15 })
    expect(findPlaceholder(text, 15)).toEqual({ start: 2, end: 7 })
    expect(findPlaceholder(text, 10, -1)).toEqual({ start: 2, end: 7 })
    expect(findPlaceholder(text, 2, -1)).toEqual({ start: 10, end: 15 })
    expect(findPlaceholder('no placeholders')).toBeNull()
  })
})
