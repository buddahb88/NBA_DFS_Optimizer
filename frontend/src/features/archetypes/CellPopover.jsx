import { forwardRef } from 'react';
import { cn } from '../../components/ui';
import PlayerCardTrigger from '../playerCard/PlayerCardTrigger';
import VerdictPills from '../playerCard/VerdictPills';
import { cellPopoverModel, formatOwnership, formatSalary } from './archetypes';

const TIER_STYLE = {
  target: 'border-info/40 bg-info-soft text-info',
  avoid: 'border-negative/40 bg-negative-soft text-negative',
  neutral: 'border-line bg-surface-sunken text-fg-muted',
};

const fmt1 = (v) => (v == null || v === '' || Number.isNaN(Number(v)) ? '—' : Number(v).toFixed(1));

/**
 * The heatmap's shared hover popover for one cell: header (defense vs column,
 * delta, target / avoid / neutral) and the slate players who face that
 * defense tonight in that column, best projection first.
 *
 * cell: { team, label, value, unit, tier, games, playerGames }
 * slate: { status: 'none' | 'loading' | 'error' | 'ready', teams: Set, isBacktest,
 *          cardTarget(p), verdictFor(p) | null }
 * players: roster entries for the cell (slateCellPlayers)
 * onViewGames: opens the cell's drill-down (the click action, for touch).
 * Positioned by the caller (style); pointer handlers keep it open while hovered.
 */
const CellPopover = forwardRef(function CellPopover({ id, cell, players, slate, onViewGames, style, ...handlers }, ref) {
  const model = cellPopoverModel({ ...cell, players, slate });
  const showVerdicts = Boolean(slate.verdictFor) && players.length > 0;
  const showActual = Boolean(slate.isBacktest) && players.some((p) => p.actualPoints !== undefined);

  return (
    <div
      ref={ref}
      id={id}
      role="dialog"
      aria-label={model.title}
      data-testid="cell-popover"
      style={style}
      className="fixed z-[80] w-[22rem] max-w-[calc(100vw-16px)] rounded-md border border-line-strong bg-surface-raised text-xs text-fg shadow-pop animate-fade-in"
      {...handlers}
    >
      <div className="flex items-start justify-between gap-2 border-b border-line px-3 py-2">
        <div className="min-w-0">
          <div className="num font-semibold" data-testid="cell-popover-header">
            {model.title} · {model.delta} ·{' '}
            <span className={cn('rounded border px-1 py-px text-2xs font-semibold uppercase', TIER_STYLE[model.tier])} data-tier={model.tier}>
              {model.tier}
            </span>
          </div>
          <div className="num mt-0.5 text-2xs text-fg-subtle">
            {cell.games ?? 0} games{cell.playerGames != null && ` · ${cell.playerGames} player-games`} · tonight’s players vs this defense
          </div>
        </div>
      </div>

      {model.empty ? (
        <p className="px-3 py-2 text-fg-muted" data-testid="cell-popover-empty">{model.empty}</p>
      ) : (
        <div className="scrollbar-thin max-h-64 overflow-y-auto">
          <table className="w-full text-left">
            <thead className="sticky top-0 bg-surface-raised text-2xs uppercase tracking-wider text-fg-subtle">
              <tr>
                <th className="px-3 py-1 font-semibold">Player</th>
                <th className="px-1 py-1 text-right font-semibold">Sal</th>
                <th className="px-1 py-1 text-right font-semibold">Proj</th>
                <th className="px-1 py-1 text-right font-semibold">Own</th>
                {showActual && <th className="px-1 py-1 text-right font-semibold">Act</th>}
                {showVerdicts && <th className="py-1 pr-3 text-right font-semibold"><span className="sr-only">Verdict</span></th>}
              </tr>
            </thead>
            <tbody>
              {players.map((p) => (
                <tr key={p.player_id} className="border-t border-line/60" data-testid="cell-popover-player">
                  <td className="max-w-[9rem] px-3 py-1">
                    <div className="truncate">
                      <PlayerCardTrigger target={slate.cardTarget?.(p)} className="font-medium" title={p.name}>
                        {p.name}
                      </PlayerCardTrigger>
                    </div>
                    <div className="text-2xs text-fg-subtle">
                      {p.team}
                      {p.injury_status && <span className="ml-1 text-caution">{p.injury_status}</span>}
                    </div>
                  </td>
                  <td className="num px-1 py-1 text-right">{formatSalary(p.salary)}</td>
                  <td className="num px-1 py-1 text-right">{fmt1(p.projected_points)}</td>
                  <td className="num px-1 py-1 text-right">{formatOwnership(p.rostership)}</td>
                  {showActual && <td className="num px-1 py-1 text-right">{fmt1(p.actualPoints)}</td>}
                  {showVerdicts && (
                    <td className="py-1 pr-3">
                      <VerdictPills entry={slate.verdictFor(p)} className="ml-auto" />
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="flex items-center justify-between gap-2 border-t border-line px-3 py-1.5">
        <span className="text-2xs text-fg-subtle">{slate.isBacktest ? 'Backtest slate' : 'Selected slate'}</span>
        <button
          type="button"
          onClick={onViewGames}
          className="rounded-sm text-2xs font-medium text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
        >
          View this cell’s games
        </button>
      </div>
    </div>
  );
});

export default CellPopover;
