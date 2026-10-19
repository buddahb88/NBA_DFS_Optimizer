import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import App from './App'

// Stub the shared axios instance so pages that fetch on mount never hit the network
vi.mock('axios', () => {
  const request = vi.fn(() => Promise.resolve({ data: [] }))
  const instance = { get: request, post: request, put: request, delete: request, patch: request }
  return { default: { create: () => instance, ...instance } }
})

describe('App', () => {
  it('renders the app shell and home page without crashing', async () => {
    render(<App />)

    // Slate dashboard home page; the stubbed API has no slates
    expect(await screen.findByText('No slate loaded')).toBeInTheDocument()
  })
})
