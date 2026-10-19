import { Badge, Button, IconCheck, Tooltip, cn } from '../../components/ui';
import { formatSalary, lineupTotals } from './lineupMath';

/**
 * One generated lineup. `lineup` = { key, number, slots: [{ slot, player }] }.
 */
export default function LineupCard({ lineup, salaryCap, selected, onToggleSelect, saved, saving, onSave, onEdit, onReview, reviewing }) {
  const totals = lineupTotals(lineup.slots, salaryCap);
  const usedPct = Math.min(100, (totals.salary / salaryCap) * 100);

  return (
    <article
      className={cn(
        'flex flex-col rounded-md border bg-surface transition-colors',
        selected ? 'border-accent ring-1 ring-accent/40' : 'border-line hover:border-line-strong',
      )}
    >
      <header className="flex items-center justify-between gap-2 border-b border-line px-3 py-2">
        <label className="flex cursor-pointer items-center gap-2">
          <input
            type="checkbox"
            checked={selected}
            onChange={onToggleSelect}
            aria-label={`Select lineup ${lineup.number}`}
            className="h-3.5 w-3.5 accent-[rgb(var(--accent))]"
          />
          <span className="text-sm font-semibold text-fg">#{lineup.number}</span>
        </label>
        <div className="flex items-center gap-1">
          {saved && (
            <Badge tone="positive" size="sm">
              <IconCheck size={10} /> Saved
            </Badge>
          )}
        </div>
      </header>

      <dl className="grid grid-cols-3 gap-2 border-b border-line px-3 py-2">
        <div>
          <dt className="text-2xs uppercase tracking-wider text-fg-subtle">Salary</dt>
          <dd className="num text-sm font-semibold text-fg">{formatSalary(totals.salary)}</dd>
          <div className="mt-1 h-1 rounded-full bg-surface-sunken" aria-hidden="true">
            <div className="h-1 rounded-full bg-accent" style={{ width: `${usedPct}%` }} />
          </div>
        </div>
        <div>
          <dt className="text-2xs uppercase tracking-wider text-fg-subtle">Proj</dt>
          <dd className="num text-sm font-semibold text-accent">{totals.projection.toFixed(1)}</dd>
        </div>
        <div>
          <dt className="text-2xs uppercase tracking-wider text-fg-subtle">Own Σ</dt>
          <dd className="num text-sm font-semibold text-fg">{totals.ownership.toFixed(0)}%</dd>
        </div>
      </dl>

      <ul className="flex-1 divide-y divide-line/60 px-3 py-1">
        {lineup.slots.map(({ slot, player }, i) => (
          <li key={`${slot}-${i}`} className="flex items-center gap-2 py-1 text-xs">
            <span className="w-9 shrink-0 font-mono text-2xs font-semibold text-fg-subtle">{slot}</span>
            <span className="min-w-0 flex-1 truncate text-fg">{player?.name ?? '-'}</span>
            <span className="w-9 shrink-0 text-2xs text-fg-subtle">{player?.team}</span>
            <span className="num w-14 shrink-0 text-right text-fg-muted">{player ? formatSalary(player.salary) : ''}</span>
            <span className="num w-10 shrink-0 text-right font-medium text-fg">{player?.projected_points?.toFixed(1)}</span>
          </li>
        ))}
      </ul>

      <footer className="flex items-center justify-end gap-1 border-t border-line px-2 py-1.5">
        {onReview && (
          <Button variant="ghost" size="xs" onClick={onReview} loading={reviewing}>
            AI review
          </Button>
        )}
        <Tooltip content="Open in the manual builder">
          <Button variant="ghost" size="xs" onClick={onEdit}>
            Edit
          </Button>
        </Tooltip>
        <Button variant="secondary" size="xs" onClick={onSave} loading={saving} disabled={saved}>
          {saved ? 'Saved' : 'Save'}
        </Button>
      </footer>
    </article>
  );
}
