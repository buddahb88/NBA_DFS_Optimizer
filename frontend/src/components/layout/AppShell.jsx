import { useEffect, useState } from 'react';
import { Link, NavLink, useLocation } from 'react-router-dom';
import { cn } from '../ui/cn';
import Tooltip from '../ui/Tooltip';
import { IconChevronLeft, IconChevronRight, IconMenu, IconMoon, IconSun, IconX } from '../ui/icons';
import useTheme from '../../hooks/useTheme';
import useMediaQuery from '../../hooks/useMediaQuery';
import { DEV_NAV_ITEMS, NAV_ITEMS } from './navItems';
import { SiteSwitcherSlot, SlateSelectorSlot } from './TopBarSlots';

const COLLAPSE_KEY = 'nba-dfs:sidebar-collapsed';

function readCollapsed() {
  try {
    return localStorage.getItem(COLLAPSE_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * App chrome: collapsible left sidebar + top bar. Layout by width:
 *   >= lg (1024): sidebar expanded or collapsed per user toggle (persisted)
 *   md..lg:       sidebar pinned to icon rail
 *   < md:         sidebar hidden, opens as an overlay drawer from the top bar
 */
export default function AppShell({ children }) {
  const { theme, toggleTheme } = useTheme();
  const isDesktop = useMediaQuery('(min-width: 1024px)');
  const isTabletUp = useMediaQuery('(min-width: 768px)');
  const [collapsedPref, setCollapsedPref] = useState(readCollapsed);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const location = useLocation();

  useEffect(() => {
    try {
      localStorage.setItem(COLLAPSE_KEY, collapsedPref ? '1' : '0');
    } catch {
      // ignore
    }
  }, [collapsedPref]);

  // Close the mobile drawer on navigation.
  useEffect(() => setDrawerOpen(false), [location.pathname]);

  const collapsed = isDesktop ? collapsedPref : true;
  const navItems = import.meta.env.DEV ? [...NAV_ITEMS, ...DEV_NAV_ITEMS] : NAV_ITEMS;
  const current = [...NAV_ITEMS, ...DEV_NAV_ITEMS].find((i) =>
    i.end ? i.to === location.pathname : location.pathname.startsWith(i.to),
  );

  return (
    <div className="flex h-screen overflow-hidden bg-canvas text-fg">
      {/* Sidebar: rail on tablet+, drawer on mobile */}
      {isTabletUp ? (
        <Sidebar items={navItems} collapsed={collapsed} canCollapse={isDesktop} onToggle={() => setCollapsedPref((c) => !c)} />
      ) : (
        drawerOpen && (
          <div className="fixed inset-0 z-50 flex">
            <div className="absolute inset-0 bg-black/60 animate-fade-in" onClick={() => setDrawerOpen(false)} aria-hidden="true" />
            <Sidebar items={navItems} collapsed={false} className="relative z-10 animate-fade-in" onClose={() => setDrawerOpen(false)} />
          </div>
        )
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center gap-2 border-b border-line bg-surface px-3">
          {!isTabletUp && (
            <button
              type="button"
              onClick={() => setDrawerOpen(true)}
              aria-label="Open navigation"
              className="rounded p-1.5 text-fg-muted hover:bg-surface-raised hover:text-fg"
            >
              <IconMenu size={18} />
            </button>
          )}
          <h1 className="truncate text-sm font-semibold text-fg">{current?.label ?? 'NBA DFS'}</h1>
          <div className="ml-auto flex items-center gap-2">
            <SiteSwitcherSlot />
            <SlateSelectorSlot />
            <div className="mx-1 h-5 w-px bg-line" />
            <Tooltip content={theme === 'dark' ? 'Switch to light' : 'Switch to dark'} side="bottom">
              <button
                type="button"
                onClick={toggleTheme}
                aria-label="Toggle color theme"
                className="rounded p-1.5 text-fg-muted hover:bg-surface-raised hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
              >
                {theme === 'dark' ? <IconSun size={16} /> : <IconMoon size={16} />}
              </button>
            </Tooltip>
          </div>
        </header>

        <main className="scrollbar-thin min-h-0 flex-1 overflow-auto">{children}</main>
      </div>
    </div>
  );
}

function Sidebar({ items, collapsed, canCollapse, onToggle, onClose, className }) {
  return (
    <aside
      className={cn(
        'flex h-full shrink-0 flex-col border-r border-line bg-surface transition-[width] duration-150',
        collapsed ? 'w-14' : 'w-56',
        className,
      )}
    >
      <div className={cn('flex h-12 items-center border-b border-line', collapsed ? 'justify-center' : 'justify-between px-3')}>
        <Link to="/" className="flex items-center gap-2 font-semibold text-fg">
          <span className="flex h-7 w-7 items-center justify-center rounded bg-accent text-sm text-accent-fg">🏀</span>
          {!collapsed && <span className="text-sm tracking-tight">NBA DFS</span>}
        </Link>
        {onClose && (
          <button type="button" onClick={onClose} aria-label="Close navigation" className="rounded p-1 text-fg-muted hover:text-fg">
            <IconX size={16} />
          </button>
        )}
      </div>

      <nav className="scrollbar-thin flex-1 space-y-0.5 overflow-y-auto p-2" aria-label="Main">
        {items.map((item) => {
          const link = (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              aria-label={collapsed ? item.label : undefined}
              className={({ isActive }) =>
                cn(
                  'flex h-8 items-center gap-2.5 rounded text-sm font-medium transition-colors',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50',
                  collapsed ? 'justify-center' : 'px-2.5',
                  isActive ? 'bg-accent-soft text-accent' : 'text-fg-muted hover:bg-surface-raised hover:text-fg',
                )
              }
            >
              <item.icon size={16} className="shrink-0" />
              {!collapsed && <span className="truncate">{item.label}</span>}
            </NavLink>
          );
          return collapsed ? (
            <Tooltip key={item.to} content={item.label} side="right">
              {link}
            </Tooltip>
          ) : (
            link
          );
        })}
      </nav>

      {canCollapse && (
        <div className="border-t border-line p-2">
          <button
            type="button"
            onClick={onToggle}
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            className={cn(
              'flex h-8 w-full items-center gap-2 rounded text-xs text-fg-subtle hover:bg-surface-raised hover:text-fg',
              collapsed ? 'justify-center' : 'px-2.5',
            )}
          >
            {collapsed ? <IconChevronRight size={16} /> : <IconChevronLeft size={16} />}
            {!collapsed && 'Collapse'}
          </button>
        </div>
      )}
    </aside>
  );
}
