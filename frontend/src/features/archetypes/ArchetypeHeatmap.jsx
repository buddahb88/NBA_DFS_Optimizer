import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '../../components/ui';
import CellPopover from './CellPopover';
import { buildHeatmap, cellColor, formatDelta, statFor } from './archetypes';

function ScaleLegend({ maxAbs, unit }) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-2xs text-fg-subtle">
      <span>Tougher than expected</span>
      <span
        aria-hidden="true"
        className="h-2.5 w-32 rounded-sm border border-line"
        style={{
          background:
            'linear-gradient(to right, rgb(var(--negative) / 0.8), rgb(var(--negative) / 0.08), transparent, rgb(var(--info) / 0.08), rgb(var(--info) / 0.8))',
        }}
      />
      <span>Softer than expected</span>
      <span className="num ml-1 text-fg-muted">±{maxAbs.toFixed(1)} {unit}</span>
    </div>
  );
}

const OPEN_DELAY = 150;
const CLOSE_DELAY = 120;
const GAP = 4;
const EDGE = 8;
const NO_SLATE = { status: 'none' };
const EMPTY = [];

/** Fixed position for the popover next to `anchor`: below, else above; clamped to the viewport. */
export function popoverPosition(anchor, pop, viewport = { width: window.innerWidth, height: window.innerHeight }) {
  let top = anchor.bottom + GAP;
  if (top + pop.height > viewport.height - EDGE && anchor.top - GAP - pop.height >= EDGE) top = anchor.top - GAP - pop.height;
  top = Math.max(EDGE, Math.min(top, viewport.height - pop.height - EDGE));
  const left = Math.max(EDGE, Math.min(anchor.left, viewport.width - pop.width - EDGE));
  return { top, left };
}

/**
 * Teams (rows) x archetypes or G/F/C (columns), each cell the stat allowed
 * over expectation per player-game, on a diverging scale. Clicking a cell
 * calls onCellClick({ team, group, label }).
 * `teams` (list or null) narrows the rows; the color scale stays league-wide.
 * `opponents` (team -> tonight's opponent) adds a "vs X" hint while filtered.
 * `emptyState` shows without data, `filteredEmptyState` when the filter hides every row.
 *
 * Hover (mouse, after OPEN_DELAY) or keyboard focus shows one shared popover
 * (CellPopover) with the slate players facing that defense in that column;
 * Escape, leaving the cell and the popover, tapping elsewhere or scrolling
 * closes it. On touch a first tap shows the popover and a second tap (or
 * "View this cell's games") opens the drill-down. `slate`: { status, byCell
 * (slateCellPlayers), teams, isBacktest, cardTarget, verdictFor }; cells with
 * slate players get a count badge.
 */
export default function ArchetypeHeatmap({
  rows,
  definitions,
  grouping,
  stat,
  teams = null,
  opponents = null,
  slate = NO_SLATE,
  onCellClick,
  emptyState,
  filteredEmptyState,
}) {
  const map = useMemo(() => buildHeatmap(rows, { definitions, grouping, stat, teams }), [rows, definitions, grouping, stat, teams]);
  const { unit } = statFor(stat);
  const byCell = slate.byCell ?? null;

  // --- One shared popover --------------------------------------------------
  const [active, setActive] = useState(null); // { team, group, label, key }
  const [pos, setPos] = useState(null);
  const activeRef = useRef(null);
  const anchorRef = useRef(null);
  const popRef = useRef(null);
  const timers = useRef({ open: null, close: null });
  const pointerType = useRef(null);
  const onCellClickRef = useRef(onCellClick);
  onCellClickRef.current = onCellClick;
  const popoverId = useId();

  const clearTimers = useCallback(() => {
    clearTimeout(timers.current.open);
    clearTimeout(timers.current.close);
  }, []);
  const set = useCallback((next, anchor = null) => {
    if (anchorRef.current && anchorRef.current !== anchor) anchorRef.current.removeAttribute('aria-describedby');
    anchorRef.current = next ? anchor : null;
    activeRef.current = next;
    setPos(null);
    setActive(next);
  }, []);
  const show = useCallback(
    (el, delay) => {
      clearTimers();
      const { team, group, label } = el.dataset;
      const next = { team, group, label, key: `${team}|${group}` };
      if (activeRef.current?.key === next.key && anchorRef.current === el) return;
      if (delay) timers.current.open = setTimeout(() => el.isConnected && set(next, el), delay);
      else set(next, el);
    },
    [clearTimers, set],
  );
  const hideNow = useCallback(() => {
    clearTimers();
    if (activeRef.current) set(null);
  }, [clearTimers, set]);
  const hideSoon = useCallback(() => {
    clearTimers();
    timers.current.close = setTimeout(() => activeRef.current && set(null), CLOSE_DELAY);
  }, [clearTimers, set]);
  useEffect(() => clearTimers, [clearTimers]);

  // Cell handlers are stable and read the cell from data-*, so the grid stays memoized
  const handlers = useMemo(
    () => ({
      onPointerEnter: (e) => e.pointerType !== 'touch' && show(e.currentTarget, OPEN_DELAY),
      onPointerLeave: (e) => e.pointerType !== 'touch' && hideSoon(),
      onPointerDown: (e) => {
        pointerType.current = e.pointerType;
      },
      onFocus: (e) => show(e.currentTarget, OPEN_DELAY),
      onBlur: (e) => {
        if (popRef.current?.contains(e.relatedTarget)) return;
        hideSoon();
      },
      onClick: (e) => {
        const el = e.currentTarget;
        const { team, group, label } = el.dataset;
        const touch = pointerType.current === 'touch';
        pointerType.current = null;
        // Touch: the first tap previews, the second opens the drill-down
        if (touch && activeRef.current?.key !== `${team}|${group}`) {
          show(el, 0);
          return;
        }
        hideNow();
        onCellClickRef.current?.({ team, group, label });
      },
    }),
    [show, hideSoon, hideNow],
  );

  // A new grid keeps cells by key; close only when the hovered cell is gone (filtered out, regrouped)
  useEffect(() => {
    if (activeRef.current && !anchorRef.current?.isConnected) hideNow();
  }, [map, hideNow]);

  useEffect(() => {
    if (!active) return undefined;
    anchorRef.current?.setAttribute('aria-describedby', popoverId);
    const inside = (t) => Boolean(popRef.current?.contains(t));
    const onKey = (e) => e.key === 'Escape' && hideNow();
    const onDown = (e) => !inside(e.target) && !e.target.closest?.('[data-heatmap-cell]') && hideNow();
    const onScroll = (e) => !inside(e.target) && hideNow();
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onDown);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', hideNow);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onDown);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', hideNow);
    };
  }, [active, hideNow, popoverId]);

  useLayoutEffect(() => {
    if (!active || !anchorRef.current || !popRef.current) return;
    setPos(popoverPosition(anchorRef.current.getBoundingClientRect(), popRef.current.getBoundingClientRect()));
  }, [active]);

  const popoverHandlers = useMemo(
    () => ({
      onPointerEnter: () => clearTimers(),
      onPointerLeave: (e) => e.pointerType !== 'touch' && hideSoon(),
      onBlur: (e) => {
        if (popRef.current?.contains(e.relatedTarget) || e.relatedTarget === anchorRef.current) return;
        hideSoon();
      },
      // Opening a player card closes the popover (the trigger stops propagation, hence capture)
      onClickCapture: (e) => e.target.closest?.('[aria-haspopup="dialog"]') && hideNow(),
    }),
    [clearTimers, hideSoon, hideNow],
  );
  const viewGames = useCallback(() => {
    const cell = activeRef.current;
    hideNow();
    if (cell) onCellClickRef.current?.({ team: cell.team, group: cell.group, label: cell.label });
  }, [hideNow]);

  const hint = teams ? opponents : null;

  // The grid doesn't depend on the popover state: hovering never re-renders the cells
  const grid = useMemo(
    () => (
      <table className="w-full border-separate border-spacing-0 text-xs">
        <thead>
          <tr>
            <th
              scope="col"
              className="sticky left-0 top-0 z-20 border-b border-line bg-surface-sunken px-2 py-1.5 text-left text-2xs font-semibold uppercase tracking-wider text-fg-subtle"
            >
              Team
            </th>
            {map.groups.map((g) => (
              <th
                key={g.key}
                scope="col"
                className="sticky top-0 z-10 min-w-[5.5rem] border-b border-line bg-surface-sunken px-1.5 py-1.5 text-center align-bottom text-2xs font-semibold leading-tight text-fg-subtle"
              >
                {g.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {map.teams.map((team) => (
            <tr key={team}>
              <th scope="row" className="sticky left-0 z-10 whitespace-nowrap border-b border-line/60 bg-surface px-2 text-left font-semibold text-fg">
                {team}
                {hint?.get(team) && ' '}
                {hint?.get(team) && (
                  <span className="ml-1 text-2xs font-normal text-fg-subtle" title={`Plays ${hint.get(team)} on the selected slate`}>
                    vs {hint.get(team)}
                  </span>
                )}
              </th>
              {map.groups.map((g) => {
                const c = map.cell(team, g.key);
                if (!c || c.value == null) {
                  return (
                    <td key={g.key} className="border-b border-l border-line/60 text-center text-fg-subtle">
                      —
                    </td>
                  );
                }
                const text = formatDelta(c.value);
                const games = c.row.games ?? 0;
                const count = byCell?.get(`${team}|${g.key}`)?.length ?? 0;
                return (
                  <td key={g.key} className="border-b border-l border-line/60 p-0">
                    <button
                      type="button"
                      data-heatmap-cell=""
                      data-team={team}
                      data-group={g.key}
                      data-label={g.label}
                      {...handlers}
                      aria-label={`${team} vs ${g.label}: ${text} ${unit} over expectation, ${games} games${
                        count ? `, ${count} slate player${count === 1 ? '' : 's'}` : ''
                      }`}
                      style={{ backgroundColor: cellColor(c.value, map.maxAbs) }}
                      className={cn(
                        'num relative block h-7 w-full touch-manipulation px-1.5 text-center text-fg transition-shadow',
                        'hover:ring-2 hover:ring-inset hover:ring-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent',
                      )}
                    >
                      {text}
                      {count > 0 && (
                        <span
                          aria-hidden="true"
                          data-testid="slate-badge"
                          className="pointer-events-none absolute right-0.5 top-0.5 flex h-3 min-w-[0.75rem] items-center justify-center rounded-full bg-fg/70 px-0.5 text-[9px] font-semibold leading-none text-fg-inverted"
                        >
                          {count}
                        </span>
                      )}
                    </button>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    ),
    [map, unit, hint, byCell, handlers],
  );

  if (map.allTeams.length === 0) return emptyState ?? null;
  if (map.teams.length === 0) return filteredEmptyState ?? null;

  const activeCell = active ? map.cell(active.team, active.group) : null;
  const live = byCell && byCell.size > 0;

  return (
    <div className="flex flex-col gap-2">
      <div className="scrollbar-thin overflow-auto rounded-md border border-line">{grid}</div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <ScaleLegend maxAbs={map.maxAbs} unit={unit} />
        {(teams || live) && (
          <span className="num text-2xs text-fg-subtle">
            {live && 'Badge = slate players facing that defense · hover or tap a cell to list them'}
            {live && teams && ' · '}
            {teams && `${map.teams.length} of ${map.allTeams.length} teams · colors scaled to all teams`}
          </span>
        )}
      </div>
      {active &&
        activeCell &&
        createPortal(
          <CellPopover
            ref={popRef}
            id={popoverId}
            cell={{
              team: active.team,
              label: active.label,
              value: activeCell.value,
              unit,
              tier: map.tier(active.team, active.group),
              games: activeCell.row.games,
              playerGames: activeCell.row.player_games,
            }}
            players={byCell?.get(active.key) ?? EMPTY}
            slate={slate}
            onViewGames={viewGames}
            style={{ top: pos?.top ?? -9999, left: pos?.left ?? -9999 }}
            {...popoverHandlers}
          />,
          document.body,
        )}
    </div>
  );
}
