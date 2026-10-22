import { useEffect, useState } from 'react';
import { IconPanelLeft, IconPanelRight, Tooltip, cn } from '../../components/ui';
import useMediaQuery from '../../hooks/useMediaQuery';

const RAIL_COLLAPSED_KEY = 'nba-dfs:chat-rail-collapsed';

function readCollapsed() {
  try {
    return localStorage.getItem(RAIL_COLLAPSED_KEY) === '1';
  } catch {
    return false;
  }
}

const headerButton =
  'rounded p-1.5 text-fg-muted transition-colors hover:bg-surface-raised hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50';

function Overlay({ side, onClose, children }) {
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className={cn('fixed inset-0 z-50 flex', side === 'right' && 'justify-end')}>
      <div className="absolute inset-0 bg-black/60 animate-fade-in motion-reduce:animate-none" onClick={onClose} aria-hidden="true" />
      <div
        role="dialog"
        aria-modal="true"
        className={cn(
          'relative z-10 h-full max-w-[85vw] shadow-pop motion-reduce:animate-none',
          side === 'right' ? 'animate-slide-in-right' : 'animate-slide-in-left',
        )}
      >
        {children}
      </div>
    </div>
  );
}

/**
 * Chat page layout: session rail | header, context bar, conversation, composer | context drawer.
 *   >= md: rail docked, collapsible to an icon rail (persisted); < md: rail is a slide-over
 *   >= lg: drawer docked; < lg: drawer is a slide-over
 *
 * renderRail({ collapsed, onToggleCollapse, onClose, dismiss }) renders the rail;
 * call dismiss() after an action that should close the mobile slide-over.
 */
export default function ChatShell({ renderRail, title, actions, contextBar, composer, renderDrawer, children }) {
  const isTabletUp = useMediaQuery('(min-width: 768px)');
  const isDesktop = useMediaQuery('(min-width: 1024px)');
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [railOpen, setRailOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);

  useEffect(() => {
    try {
      localStorage.setItem(RAIL_COLLAPSED_KEY, collapsed ? '1' : '0');
    } catch {
      // storage unavailable; the preference just won't persist
    }
  }, [collapsed]);

  useEffect(() => {
    if (isTabletUp) setRailOpen(false);
  }, [isTabletUp]);

  const closeRail = () => setRailOpen(false);
  const closeDrawer = () => setDrawerOpen(false);

  return (
    <div className="flex h-full min-h-0 bg-canvas text-fg">
      {isTabletUp
        ? renderRail({ collapsed, onToggleCollapse: () => setCollapsed((c) => !c), dismiss: () => {} })
        : railOpen && <Overlay onClose={closeRail}>{renderRail({ collapsed: false, onClose: closeRail, dismiss: closeRail })}</Overlay>}

      <section className="flex min-w-0 flex-1 flex-col" aria-label="Chat">
        <header className="flex h-11 shrink-0 items-center gap-2 border-b border-line bg-surface px-3">
          {!isTabletUp && (
            <button type="button" className={headerButton} aria-label="Open conversations" onClick={() => setRailOpen(true)}>
              <IconPanelLeft size={16} />
            </button>
          )}
          <h2 className="min-w-0 flex-1 truncate text-sm font-semibold text-fg">{title}</h2>
          <div className="flex items-center gap-1">
            {actions}
            <Tooltip content={drawerOpen ? 'Hide context' : 'Show context'} side="bottom">
              <button
                type="button"
                className={cn(headerButton, drawerOpen && 'bg-accent-soft text-accent')}
                aria-label="Toggle context panel"
                aria-pressed={drawerOpen}
                onClick={() => setDrawerOpen((o) => !o)}
              >
                <IconPanelRight size={16} />
              </button>
            </Tooltip>
          </div>
        </header>
        {contextBar}
        <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto">{children}</div>
        {composer}
      </section>

      {drawerOpen && (isDesktop ? renderDrawer({ onClose: closeDrawer }) : <Overlay side="right" onClose={closeDrawer}>{renderDrawer({ onClose: closeDrawer })}</Overlay>)}
    </div>
  );
}
