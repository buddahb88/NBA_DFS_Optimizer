import { describe, it, expect, vi } from 'vitest'
import { useState } from 'react'
import { fireEvent, render, screen, within } from '@testing-library/react'
import Composer from './Composer'

const PLAYERS = [
  { name: 'Luka Doncic', team: 'LAL', position: 'PG', salary: 11000, headshot: 'luka.png' },
  { name: 'LeBron James', team: 'LAL', position: 'SF', salary: 9800 },
  { name: 'Kyle Lowry', team: 'PHI', position: 'PG', salary: 3500 },
]

function Harness({ initial = '', onSubmit = vi.fn(), onEditLast, ...props }) {
  const [draft, setDraft] = useState({ text: initial, mentions: [] })
  return (
    <Composer
      value={draft.text}
      mentions={draft.mentions}
      onChange={(u) => setDraft((d) => ({ ...d, ...u }))}
      onSubmit={onSubmit}
      onCancel={vi.fn()}
      onEditLast={onEditLast}
      isStreaming={false}
      maxIterations={10}
      mode="cash"
      siteName="DraftKings"
      players={PLAYERS}
      {...props}
    />
  )
}

const box = () => screen.getByRole('textbox', { name: 'Message' })
const type = (text) => fireEvent.change(box(), { target: { value: text, selectionStart: text.length } })
const key = (k, opts = {}) => fireEvent.keyDown(box(), { key: k, ...opts })
const optionNames = (list) => within(list).getAllByRole('option').map((o) => o.textContent)

describe('Composer', () => {
  it('Enter sends, Shift+Enter does not, and send is disabled while empty', () => {
    const onSubmit = vi.fn()
    render(<Harness onSubmit={onSubmit} />)
    expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled()
    type('   ')
    key('Enter')
    expect(onSubmit).not.toHaveBeenCalled()

    type('line one')
    key('Enter', { shiftKey: true })
    expect(onSubmit).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Send message' })).toBeEnabled()
    key('Enter')
    expect(onSubmit).toHaveBeenCalledWith('line one', [])
  })

  it('is a multi-line textarea that grows', () => {
    render(<Harness />)
    expect(box().tagName).toBe('TEXTAREA')
    expect(box()).toHaveAttribute('rows', '1')
  })

  it('Esc blurs and Cmd/Ctrl+K focuses the composer', () => {
    render(<Harness />)
    box().focus()
    key('Escape')
    expect(box()).not.toHaveFocus()
    fireEvent.keyDown(document, { key: 'k', ctrlKey: true })
    expect(box()).toHaveFocus()
    box().blur()
    fireEvent.keyDown(document, { key: 'K', metaKey: true })
    expect(box()).toHaveFocus()
  })

  it('Up arrow on an empty composer edits the last message', () => {
    const onEditLast = vi.fn()
    render(<Harness onEditLast={onEditLast} />)
    key('ArrowUp')
    expect(onEditLast).toHaveBeenCalledTimes(1)
    type('x')
    key('ArrowUp')
    expect(onEditLast).toHaveBeenCalledTimes(1)
  })

  describe('slash commands', () => {
    it('opens a filtered, keyboard-navigable menu', () => {
      render(<Harness />)
      type('/')
      const list = screen.getByRole('listbox', { name: 'Slash commands' })
      expect(within(list).getAllByRole('option')).toHaveLength(7)
      expect(optionNames(list)[0]).toMatch(/^\/value/)

      type('/s')
      const commandNames = within(screen.getByRole('listbox')).getAllByText(/^\//).map((el) => el.textContent)
      expect(commandNames).toEqual(['/stacks', '/score', '/value', '/matchups', '/usage', '/help'])
      const options = within(screen.getByRole('listbox')).getAllByRole('option')
      expect(options[0]).toHaveAttribute('aria-selected', 'true')
      expect(box()).toHaveAttribute('aria-activedescendant', options[0].id)

      key('ArrowDown')
      expect(within(screen.getByRole('listbox')).getAllByRole('option')[1]).toHaveAttribute('aria-selected', 'true')
      key('ArrowUp')
      key('ArrowUp')
      expect(within(screen.getByRole('listbox')).getAllByRole('option')[5]).toHaveAttribute('aria-selected', 'true')

      key('Escape')
      expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
      expect(box()).toHaveValue('/s')
    })

    it('expands the picked command with mode and site and selects the first placeholder', () => {
      const onSubmit = vi.fn()
      render(<Harness onSubmit={onSubmit} />)
      type('/val')
      key('Enter')
      expect(onSubmit).not.toHaveBeenCalled()
      expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
      const text = "Find the best Cash value plays under $[salary] on tonight's DraftKings slate. Rank by projected points per $1K and include minutes, ownership and injury risk."
      expect(box()).toHaveValue(text)
      expect(box()).toHaveFocus()
      expect(text.slice(box().selectionStart, box().selectionEnd)).toBe('[salary]')
    })

    it('tabs through placeholders', () => {
      render(<Harness mode="gpp" />)
      type('/score')
      fireEvent.mouseDown(within(screen.getByRole('listbox')).getByText('/score'))
      const value = box().value
      expect(value).toBe("Score this DraftKings lineup from [YYYY-MM-DD]: [players]. Show each player's actual fantasy points and the lineup total.")
      const selected = () => value.slice(box().selectionStart, box().selectionEnd)
      expect(selected()).toBe('[YYYY-MM-DD]')
      key('Tab')
      expect(selected()).toBe('[players]')
      key('Tab')
      expect(selected()).toBe('[YYYY-MM-DD]')
      key('Tab', { shiftKey: true })
      expect(selected()).toBe('[players]')
    })

    it('fills an argument typed after the command', () => {
      render(<Harness />)
      type('/player Kyle Lowry')
      expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
      key('Enter')
      expect(box().value).toMatch(/^Break down Kyle Lowry for Cash on DraftKings: recent game log/)
    })
  })

  describe('@mentions', () => {
    it('autocompletes slate players with team, salary and headshot', () => {
      render(<Harness />)
      type('Is @l')
      const list = screen.getByRole('listbox', { name: 'Player suggestions' })
      const options = within(list).getAllByRole('option')
      expect(options.map((o) => o.textContent)).toEqual(['Luka DoncicLAL · PG$11.0K', 'LJLeBron JamesLAL · SF$9.8K', 'KLKyle LowryPHI · PG$3.5K'])
      expect(options[0].querySelector('img')).toHaveAttribute('src', 'luka.png')

      type('Is @lowr')
      expect(optionNames(screen.getByRole('listbox'))).toEqual(['KLKyle LowryPHI · PG$3.5K'])
      type('Is @zzz')
      expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    })

    it('inserts the plain name, renders a chip and sends mention metadata', () => {
      const onSubmit = vi.fn()
      render(<Harness onSubmit={onSubmit} />)
      type('Is @leb')
      key('Enter')
      expect(box()).toHaveValue('Is LeBron James ')
      const chips = screen.getByRole('list', { name: 'Mentioned players' })
      expect(chips).toHaveTextContent('LeBron James')
      expect(chips).toHaveTextContent('LAL')

      fireEvent.change(box(), { target: { value: 'Is LeBron James a play?', selectionStart: 23 } })
      key('Enter')
      expect(onSubmit).toHaveBeenCalledWith('Is LeBron James a play?', [
        expect.objectContaining({ name: 'LeBron James', team: 'LAL', player_key: 'lebron james' }),
      ])
    })

    it('removing a chip removes the name; deleting the name removes the chip', () => {
      render(<Harness />)
      type('@luka')
      key('Tab')
      type(`${box().value}and @kyle`)
      key('Enter')
      expect(box()).toHaveValue('Luka Doncic and Kyle Lowry ')
      const chips = () => screen.queryByRole('list', { name: 'Mentioned players' })
      expect(within(chips()).getAllByRole('listitem')).toHaveLength(2)

      fireEvent.click(screen.getByRole('button', { name: 'Remove Luka Doncic' }))
      expect(box()).toHaveValue(' and Kyle Lowry ')
      expect(within(chips()).getAllByRole('listitem')).toHaveLength(1)

      type('and someone')
      expect(chips()).not.toBeInTheDocument()
    })
  })

  it('shows a stop button while streaming', () => {
    const onCancel = vi.fn()
    render(<Harness isStreaming onCancel={onCancel} initial="next question" />)
    expect(screen.queryByRole('button', { name: 'Send message' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Stop generating' }))
    expect(onCancel).toHaveBeenCalled()
  })
})
