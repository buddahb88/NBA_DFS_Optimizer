import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import useChatSuggestions, { FALLBACK_SUGGESTIONS, withFallback } from './useChatSuggestions'
import { chatAPI } from '../../services/api'

vi.mock('../../services/api', () => ({ chatAPI: { getSuggestions: vi.fn() } }))

const gen = (kind) => ({ id: kind, kind, label: kind, prompt: `${kind} prompt` })

beforeEach(() => vi.clearAllMocks())

describe('withFallback', () => {
  it('keeps 4-6 generated suggestions as they are', () => {
    const four = ['usage_bump', 'archetype_edge', 'game_stack', 'value_play'].map(gen)
    expect(withFallback(four)).toEqual(four)
    const seven = [...four, ...['hot_streak', 'score_lineup', 'extra'].map(gen)]
    expect(withFallback(seven)).toHaveLength(6)
  })

  it('tops thin lists up to 4 with static prompts of kinds not already covered', () => {
    const list = withFallback([gen('value_play'), gen('game_stack')])
    expect(list).toHaveLength(4)
    expect(list.slice(0, 2).map((s) => s.prompt)).toEqual(['value_play prompt', 'game_stack prompt'])
    expect(list.slice(2).map((s) => s.kind)).toEqual(['archetype_edge', 'leverage'])
  })

  it('falls back entirely to static prompts with no data', () => {
    expect(withFallback([])).toEqual(FALLBACK_SUGGESTIONS.slice(0, 4))
  })
})

describe('useChatSuggestions', () => {
  it('loads generated suggestions for the slate', async () => {
    const six = ['usage_bump', 'archetype_edge', 'game_stack', 'hot_streak', 'value_play', 'score_lineup'].map(gen)
    chatAPI.getSuggestions.mockResolvedValue({ data: { success: true, suggestions: six } })
    const { result } = renderHook(() => useChatSuggestions('42'))
    expect(result.current.loading).toBe(true)
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(chatAPI.getSuggestions).toHaveBeenCalledWith('42')
    expect(result.current.suggestions).toEqual(six)
    expect(result.current.isFallback).toBe(false)
  })

  it('uses static prompts when the request fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    chatAPI.getSuggestions.mockRejectedValue(new Error('Network Error'))
    const { result } = renderHook(() => useChatSuggestions('42'))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.isFallback).toBe(true)
    expect(result.current.suggestions).toEqual(FALLBACK_SUGGESTIONS.slice(0, 4))
  })

  it('keeps a stale slate to its sync prompt without slate-specific fallbacks', async () => {
    const sync = { id: 'sync_slate', kind: 'sync_slate', label: "Sync tonight's slate", prompt: 'sync prompt' }
    chatAPI.getSuggestions.mockResolvedValue({ data: { success: true, isStale: true, slateDate: '2026-10-21', suggestions: [sync, gen('score_lineup')] } })
    const { result } = renderHook(() => useChatSuggestions('29805'))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.suggestions.map((s) => s.kind)).toEqual(['sync_slate', 'score_lineup'])
    expect(result.current.isStale).toBe(true)
  })

  it('does not fetch while disabled', () => {
    renderHook(() => useChatSuggestions('42', { enabled: false }))
    expect(chatAPI.getSuggestions).not.toHaveBeenCalled()
  })
})
