import { EmptyState, IconPanelRight, IconX } from '../../components/ui';

/** Right-hand context panel. Scaffold only; pinned players and the lineup in progress land here later. */
export default function ContextDrawer({ onClose }) {
  return (
    <aside aria-label="Context" className="flex h-full w-80 max-w-full shrink-0 flex-col border-l border-line bg-surface">
      <div className="flex h-11 items-center justify-between border-b border-line px-3">
        <h2 className="text-sm font-semibold text-fg">Context</h2>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close context panel"
          className="rounded p-1 text-fg-subtle hover:bg-surface-raised hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
        >
          <IconX size={16} />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto p-3">
        <EmptyState
          icon={<IconPanelRight size={18} />}
          title="Nothing pinned yet"
          description="Players you pin and the lineup you're building in chat will show up here."
        />
      </div>
    </aside>
  );
}
