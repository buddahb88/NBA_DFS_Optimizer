import { forwardRef, useEffect, useId, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { IconArrowUp, IconStop, IconX, cn } from '../../components/ui';
import { activeMentions, filterPlayers, findMentionQuery, formatPositions, formatSalary, insertMention, toMention } from './mentions';
import { expandCommand, filterCommands, findPlaceholder, parseSlash } from './slashCommands';

const LINE_PX = 24; // leading-6
const MAX_LINES = 8;
const PAD_PX = 12; // py-1.5

/** Which popover (if any) the text before the caret asks for. */
function menuFor(text, caret) {
  const slash = parseSlash(text);
  if (slash && 'query' in slash) return { kind: 'slash', query: slash.query };
  const mention = findMentionQuery(text, caret);
  if (mention) return { kind: 'mention', match: mention };
  return null;
}

function PlayerAvatar({ name, src, size = 'h-6 w-6' }) {
  const [failed, setFailed] = useState(false);
  if (src && !failed) {
    return <img src={src} alt="" onError={() => setFailed(true)} className={cn(size, 'shrink-0 rounded-full border border-line bg-surface-sunken object-cover')} />;
  }
  const initials = name
    .split(' ')
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
  return (
    <span aria-hidden="true" className={cn(size, 'flex shrink-0 items-center justify-center rounded-full bg-surface-sunken text-[0.6rem] font-semibold text-fg-muted')}>
      {initials}
    </span>
  );
}

function MenuOption({ id, active, onPick, children }) {
  return (
    <li
      id={id}
      role="option"
      aria-selected={active}
      onMouseDown={(e) => {
        e.preventDefault(); // keep focus in the textarea
        onPick();
      }}
      className={cn('flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-sm', active ? 'bg-accent-soft text-fg' : 'text-fg-muted hover:bg-surface-raised')}
    >
      {children}
    </li>
  );
}

/**
 * Message input. Enter sends, Shift+Enter adds a line, Esc blurs, Cmd/Ctrl+K focuses,
 * Up on an empty composer edits the last message. "/" opens slash commands that expand
 * into prompt templates ([placeholders] are tabbable); "@" autocompletes slate players.
 * While streaming the stop button cancels.
 */
const Composer = forwardRef(function Composer(
  { value, mentions = [], onChange, onSubmit, onCancel, onEditLast, isStreaming, maxIterations, mode, siteName, players = [] },
  ref,
) {
  const textareaRef = useRef(null);
  const pendingSelection = useRef(null);
  const [menu, setMenu] = useState(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [placeholderMode, setPlaceholderMode] = useState(false);
  const listId = useId();

  useImperativeHandle(ref, () => textareaRef.current);

  const chips = activeMentions(mentions, value);
  const canSend = !isStreaming && value.trim().length > 0;

  const items = useMemo(() => {
    if (!menu) return [];
    if (menu.kind === 'slash') return filterCommands(menu.query);
    return filterPlayers(players, menu.match.query);
  }, [menu, players]);
  const menuOpen = items.length > 0;

  // Auto-grow from one line up to MAX_LINES, then scroll
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const max = LINE_PX * MAX_LINES + PAD_PX;
    el.style.height = `${Math.min(el.scrollHeight || LINE_PX + PAD_PX, max)}px`;
    el.style.overflowY = el.scrollHeight > max ? 'auto' : 'hidden';
  }, [value]);

  // Apply a caret/selection requested by the last edit once the new value is rendered
  useLayoutEffect(() => {
    const sel = pendingSelection.current;
    const el = textareaRef.current;
    if (!sel || !el) return;
    pendingSelection.current = null;
    el.focus();
    el.setSelectionRange(sel.start, sel.end);
  }, [value]);

  // Cmd/Ctrl+K focuses the composer from anywhere on the page
  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        textareaRef.current?.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const update = (text, caret, extra = {}) => {
    onChange({ text, ...extra });
    setMenu(menuFor(text, caret ?? text.length));
    setActiveIndex(0);
    if (placeholderMode && !findPlaceholder(text)) setPlaceholderMode(false);
  };

  const applyTemplate = (command, arg) => {
    const text = expandCommand(command, { arg, site: siteName, mode });
    const first = findPlaceholder(text);
    pendingSelection.current = first || { start: text.length, end: text.length };
    setPlaceholderMode(Boolean(first));
    onChange({ text });
    setMenu(null);
  };

  const pick = (item) => {
    if (menu?.kind === 'slash') {
      applyTemplate(item);
      return;
    }
    const { text, caret } = insertMention(value, menu.match, item.name);
    const nextMentions = mentions.some((m) => m.name === item.name) ? mentions : [...mentions, toMention(item)];
    pendingSelection.current = { start: caret, end: caret };
    onChange({ text, mentions: nextMentions });
    setMenu(null);
  };

  const removeChip = (name) => {
    const text = value.replace(name, '').replace(/ {2,}/g, ' ');
    onChange({ text, mentions: mentions.filter((m) => m.name !== name) });
    textareaRef.current?.focus();
  };

  const submit = () => {
    if (!canSend) return;
    onSubmit(value.trim(), activeMentions(mentions, value));
    setMenu(null);
    setPlaceholderMode(false);
  };

  const handleKeyDown = (e) => {
    if (e.nativeEvent.isComposing) return;
    const el = e.currentTarget;

    if (menuOpen) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const step = e.key === 'ArrowDown' ? 1 : -1;
        setActiveIndex((i) => (i + step + items.length) % items.length);
        return;
      }
      if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
        e.preventDefault();
        pick(items[Math.min(activeIndex, items.length - 1)]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setMenu(null);
        return;
      }
    }

    if (e.key === 'Tab' && placeholderMode) {
      const target = e.shiftKey ? findPlaceholder(value, el.selectionStart, -1) : findPlaceholder(value, el.selectionEnd, 1);
      if (target) {
        e.preventDefault();
        el.setSelectionRange(target.start, target.end);
        return;
      }
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const slash = parseSlash(value);
      if (slash?.command) applyTemplate(slash.command, slash.arg);
      else submit();
      return;
    }

    if (e.key === 'ArrowUp' && value === '' && onEditLast) {
      e.preventDefault();
      onEditLast();
      return;
    }

    if (e.key === 'Escape') {
      e.preventDefault();
      setPlaceholderMode(false);
      el.blur();
    }
  };

  const activeId = menuOpen ? `${listId}-opt-${Math.min(activeIndex, items.length - 1)}` : undefined;

  return (
    <div className="shrink-0 border-t border-line bg-surface px-3 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-4">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        className="relative mx-auto max-w-3xl"
      >
        {menuOpen && (
          <div className="absolute inset-x-0 bottom-full z-20 mb-2 overflow-hidden rounded-lg border border-line bg-surface shadow-pop">
            <div className="border-b border-line px-3 py-1.5 text-2xs font-semibold uppercase tracking-wide text-fg-subtle">
              {menu.kind === 'slash' ? 'Commands' : 'Players on this slate'}
            </div>
            <ul id={listId} role="listbox" aria-label={menu.kind === 'slash' ? 'Slash commands' : 'Player suggestions'} className="scrollbar-thin max-h-72 overflow-y-auto p-1">
              {menu.kind === 'slash'
                ? items.map((cmd, i) => (
                    <MenuOption key={cmd.name} id={`${listId}-opt-${i}`} active={i === activeIndex} onPick={() => pick(cmd)}>
                      <span className="font-mono text-sm font-medium text-accent">/{cmd.name}</span>
                      {cmd.args && <span className="font-mono text-2xs text-fg-subtle">{cmd.args}</span>}
                      <span className="ml-auto truncate text-xs text-fg-muted">{cmd.description}</span>
                    </MenuOption>
                  ))
                : items.map((p, i) => (
                    <MenuOption key={p.name} id={`${listId}-opt-${i}`} active={i === activeIndex} onPick={() => pick(p)}>
                      <PlayerAvatar name={p.name} src={p.headshot} />
                      <span className="truncate font-medium text-fg">{p.name}</span>
                      <span className="text-2xs text-fg-subtle">
                        {[p.team, formatPositions(p.position)].filter(Boolean).join(' · ')}
                      </span>
                      <span className="num ml-auto text-xs text-fg-muted">{formatSalary(p.salary)}</span>
                    </MenuOption>
                  ))}
            </ul>
          </div>
        )}

        <div className="rounded-lg border border-line bg-surface-sunken p-1.5 pl-3 transition-colors focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/30 motion-reduce:transition-none">
          {chips.length > 0 && (
            <ul aria-label="Mentioned players" className="mb-1.5 flex flex-wrap gap-1.5 pt-0.5">
              {chips.map((m) => (
                <li key={m.name} className="flex items-center gap-1.5 rounded-full border border-line bg-surface py-0.5 pl-0.5 pr-1 text-xs text-fg">
                  <PlayerAvatar name={m.name} src={m.headshot} size="h-5 w-5" />
                  <span className="font-medium">{m.name}</span>
                  {m.team && <span className="text-2xs text-fg-subtle">{m.team}</span>}
                  <button
                    type="button"
                    onClick={() => removeChip(m.name)}
                    aria-label={`Remove ${m.name}`}
                    className="rounded-full p-0.5 text-fg-subtle hover:bg-surface-raised hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
                  >
                    <IconX size={10} />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="flex items-end gap-2">
            <textarea
              ref={textareaRef}
              rows={1}
              value={value}
              onChange={(e) => update(e.target.value, e.target.selectionStart)}
              onKeyDown={handleKeyDown}
              onBlur={() => setMenu(null)}
              placeholder="Ask about tonight's slate… ( / for commands, @ for players)"
              aria-label="Message"
              aria-autocomplete="list"
              aria-controls={menuOpen ? listId : undefined}
              aria-activedescendant={activeId}
              enterKeyHint="send"
              className="min-w-0 flex-1 resize-none bg-transparent py-1.5 text-base leading-6 text-fg placeholder:text-fg-subtle focus:outline-none sm:text-sm"
            />
            {isStreaming ? (
              <button
                type="button"
                onClick={onCancel}
                aria-label="Stop generating"
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-negative-soft text-negative transition-colors hover:bg-negative hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-negative/50"
              >
                <IconStop size={14} />
              </button>
            ) : (
              <button
                type="submit"
                disabled={!canSend}
                aria-label="Send message"
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-accent text-accent-fg transition-colors hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <IconArrowUp size={16} />
              </button>
            )}
          </div>
        </div>
        <p className="mt-1.5 hidden text-center text-2xs text-fg-subtle sm:block">
          Enter to send · Shift+Enter for a new line · <kbd className="font-mono">/</kbd> commands · <kbd className="font-mono">@</kbd> players · Ctrl/⌘K to focus · up to {maxIterations} agent steps
        </p>
      </form>
    </div>
  );
});

export default Composer;
