import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Button,
  IconChat,
  IconChevronLeft,
  IconChevronRight,
  IconPencil,
  IconPlus,
  IconSearch,
  IconTrash,
  IconX,
  Input,
  Modal,
  Spinner,
  Tooltip,
  cn,
} from '../../components/ui';
import { UNTITLED_SESSION, filterSessions, groupSessionsByDate } from './sessionGroups';

const iconButton =
  'flex h-7 w-7 items-center justify-center rounded text-fg-subtle transition-colors hover:bg-surface-sunken hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50';

function RenameField({ initial, onSave, onCancel }) {
  const [value, setValue] = useState(initial);
  const inputRef = useRef(null);
  const done = useRef(false);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const commit = () => {
    if (done.current) return;
    done.current = true;
    const title = value.trim();
    if (title && title !== initial) onSave(title);
    else onCancel();
  };

  return (
    <input
      ref={inputRef}
      value={value}
      maxLength={120}
      aria-label="Conversation title"
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          commit();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          done.current = true;
          onCancel();
        }
      }}
      className="h-8 w-full rounded border border-accent bg-surface-sunken px-2 text-sm text-fg focus:outline-none focus:ring-2 focus:ring-accent/30"
    />
  );
}

function SessionItem({ session, active, editing, onSelect, onStartRename, onRename, onCancelRename, onDelete }) {
  const title = session.title || UNTITLED_SESSION;

  if (editing) {
    return (
      <li className="px-1 py-0.5">
        <RenameField initial={title} onSave={(t) => onRename(session.id, t)} onCancel={onCancelRename} />
      </li>
    );
  }

  return (
    <li className="group relative">
      <button
        type="button"
        onClick={() => onSelect(session.id)}
        aria-current={active ? 'true' : undefined}
        className={cn(
          'flex w-full flex-col rounded px-2.5 py-1.5 pr-16 text-left transition-colors',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50',
          active ? 'bg-accent-soft text-fg' : 'text-fg-muted hover:bg-surface-raised hover:text-fg',
        )}
      >
        <span className="truncate text-sm">{title}</span>
        {session.message_count != null && <span className="text-2xs text-fg-subtle">{session.message_count} messages</span>}
      </button>
      <div className="absolute right-1 top-1/2 flex -translate-y-1/2 items-center opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100 motion-reduce:transition-none">
        <button type="button" className={iconButton} aria-label={`Rename ${title}`} onClick={() => onStartRename(session.id)}>
          <IconPencil size={13} />
        </button>
        <button type="button" className={cn(iconButton, 'hover:text-negative')} aria-label={`Delete ${title}`} onClick={() => onDelete(session)}>
          <IconTrash size={13} />
        </button>
      </div>
    </li>
  );
}

/**
 * Left rail of conversations: new chat, search, sessions grouped by recency,
 * rename and delete. `collapsed` shrinks it to an icon rail; `onClose` (mobile
 * slide-over) shows a close button instead of the collapse control.
 */
export default function SessionRail({
  sessions,
  loading,
  error,
  activeSessionId,
  collapsed = false,
  onToggleCollapse,
  onClose,
  onNewChat,
  onSelect,
  onRename,
  onDelete,
  className,
}) {
  const [query, setQuery] = useState('');
  const [editingId, setEditingId] = useState(null);
  const [pendingDelete, setPendingDelete] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const groups = useMemo(() => groupSessionsByDate(filterSessions(sessions, query)), [sessions, query]);

  const confirmDelete = async () => {
    setDeleting(true);
    await onDelete(pendingDelete.id);
    setDeleting(false);
    setPendingDelete(null);
  };

  const handleRename = async (id, title) => {
    setEditingId(null);
    await onRename(id, title);
  };

  if (collapsed) {
    return (
      <aside aria-label="Conversations" className={cn('flex h-full w-12 shrink-0 flex-col items-center gap-1 border-r border-line bg-surface py-2', className)}>
        <Tooltip content="Expand conversations" side="right">
          <button type="button" className={iconButton} aria-label="Expand conversations" onClick={onToggleCollapse}>
            <IconChevronRight size={16} />
          </button>
        </Tooltip>
        <Tooltip content="New chat" side="right">
          <button type="button" className={iconButton} aria-label="New chat" onClick={onNewChat}>
            <IconPlus size={16} />
          </button>
        </Tooltip>
        <Tooltip content="Search conversations" side="right">
          <button type="button" className={iconButton} aria-label="Search conversations" onClick={onToggleCollapse}>
            <IconSearch size={15} />
          </button>
        </Tooltip>
      </aside>
    );
  }

  return (
    <aside aria-label="Conversations" className={cn('flex h-full w-64 shrink-0 flex-col border-r border-line bg-surface', className)}>
      <div className="flex items-center gap-1 px-3 pb-2 pt-3">
        <h2 className="flex-1 text-xs font-semibold uppercase tracking-wide text-fg-subtle">Chats</h2>
        {onClose ? (
          <button type="button" className={iconButton} aria-label="Close conversations" onClick={onClose}>
            <IconX size={16} />
          </button>
        ) : (
          onToggleCollapse && (
            <button type="button" className={iconButton} aria-label="Collapse conversations" onClick={onToggleCollapse}>
              <IconChevronLeft size={16} />
            </button>
          )
        )}
      </div>
      <div className="flex flex-col gap-2 px-3 pb-2">
        <Button variant="primary" size="md" leftIcon={<IconPlus size={14} />} onClick={onNewChat} className="w-full justify-center">
          New chat
        </Button>
        <Input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search chats"
          aria-label="Search conversations"
          leftIcon={<IconSearch size={13} />}
        />
      </div>

      <nav aria-label="Conversation history" className="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {loading ? (
          <div className="flex justify-center py-6">
            <Spinner size="sm" />
          </div>
        ) : error ? (
          <p className="px-2 py-4 text-xs text-negative">{error}</p>
        ) : groups.length === 0 ? (
          <div className="flex flex-col items-center gap-1.5 px-2 py-8 text-center">
            <IconChat size={18} className="text-fg-subtle" />
            <p className="text-xs text-fg-muted">{query.trim() ? 'No chats match your search' : 'No conversations yet'}</p>
          </div>
        ) : (
          groups.map((group) => (
            <section key={group.key} className="mt-2 first:mt-0" aria-labelledby={`chat-group-${group.key}`}>
              <h3 id={`chat-group-${group.key}`} className="px-2.5 pb-1 pt-2 text-2xs font-semibold uppercase tracking-wide text-fg-subtle">
                {group.label}
              </h3>
              <ul className="space-y-0.5">
                {group.sessions.map((session) => (
                  <SessionItem
                    key={session.id}
                    session={session}
                    active={session.id === activeSessionId}
                    editing={session.id === editingId}
                    onSelect={onSelect}
                    onStartRename={setEditingId}
                    onRename={handleRename}
                    onCancelRename={() => setEditingId(null)}
                    onDelete={setPendingDelete}
                  />
                ))}
              </ul>
            </section>
          ))
        )}
      </nav>

      <Modal
        open={!!pendingDelete}
        onClose={() => !deleting && setPendingDelete(null)}
        size="sm"
        title="Delete conversation?"
        description={pendingDelete ? `“${pendingDelete.title || UNTITLED_SESSION}” and its messages will be removed.` : undefined}
        footer={
          <>
            <Button variant="ghost" onClick={() => setPendingDelete(null)} disabled={deleting}>
              Cancel
            </Button>
            <Button variant="danger" onClick={confirmDelete} loading={deleting}>
              Delete
            </Button>
          </>
        }
      >
        <p className="text-sm text-fg-muted">This can't be undone.</p>
      </Modal>
    </aside>
  );
}
