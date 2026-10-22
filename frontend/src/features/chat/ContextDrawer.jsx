import { EmptyState, IconPanelRight, IconX } from '../../components/ui';
import { formatSalary } from '../lineupStudio/lineupMath';
import { useChatBlocks } from './blocks/blocksContext';
import LineupBlock from './blocks/LineupBlock';
import { Headshot, PlayerActions } from './blocks/PlayerCard';

function PinnedPlayer({ player }) {
  const { findSlatePlayer } = useChatBlocks();
  const slatePlayer = findSlatePlayer(player);
  const salary = player.salary ?? slatePlayer?.salary;
  const projection = player.projection ?? slatePlayer?.projected_points;
  return (
    <li className="flex items-center gap-2 py-2">
      <Headshot name={player.name} src={player.headshot ?? slatePlayer?.headshot} size="sm" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs font-medium text-fg">{player.name}</p>
        <p className="num truncate text-2xs text-fg-subtle">
          {[player.team, salary != null && formatSalary(salary), projection != null && `${Number(projection).toFixed(1)} proj`].filter(Boolean).join(' · ')}
        </p>
      </div>
      <PlayerActions player={player} compact />
    </li>
  );
}

function Section({ title, count, children }) {
  return (
    <section aria-label={title} className="flex flex-col gap-1">
      <h3 className="flex items-center gap-1.5 text-2xs font-semibold uppercase tracking-wider text-fg-subtle">
        {title}
        {count != null && <span className="num rounded bg-surface-sunken px-1 text-fg-muted">{count}</span>}
      </h3>
      {children}
    </section>
  );
}

/** Right-hand context panel: players pinned this session and the latest lineup in the conversation. */
export default function ContextDrawer({ onClose, lineup }) {
  const { pinned } = useChatBlocks();
  const empty = pinned.length === 0 && !lineup;

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
      <div className="scrollbar-thin flex flex-1 flex-col gap-5 overflow-y-auto p-3">
        {empty ? (
          <EmptyState
            icon={<IconPanelRight size={18} />}
            title="Nothing pinned yet"
            description="Pin players from chat cards, and the latest lineup from the conversation shows up here."
          />
        ) : (
          <>
            <Section title="Pinned players" count={pinned.length}>
              {pinned.length ? (
                <ul className="divide-y divide-line/60">
                  {pinned.map((p) => (
                    <PinnedPlayer key={p.name} player={p} />
                  ))}
                </ul>
              ) : (
                <p className="text-xs text-fg-muted">Use the pin on a player card to keep them here.</p>
              )}
            </Section>
            {lineup && (
              <Section title="Lineup">
                <LineupBlock block={lineup} compact />
              </Section>
            )}
          </>
        )}
      </div>
    </aside>
  );
}
