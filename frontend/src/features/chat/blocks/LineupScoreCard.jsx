import { Badge, Tooltip, cn } from '../../../components/ui';
import { formatDelta } from '../../archetypes/archetypes';
import { formatSalary } from '../../lineupStudio/lineupMath';
import { valuePer1k } from './blockModel';
import BlockFrame from './BlockFrame';

export const HIT_MULTIPLE = 5;

const diffTone = (d) => (d == null ? 'text-fg-muted' : d > 0 ? 'text-positive' : d < 0 ? 'text-negative' : 'text-fg-muted');

function Summary({ label, children, className }) {
  return (
    <div>
      <dt className="text-2xs uppercase tracking-wider text-fg-subtle">{label}</dt>
      <dd className={cn('num text-sm font-semibold text-fg', className)}>{children}</dd>
    </div>
  );
}

/** lineup_score: projected vs actual per player (score_lineup), totals, value per $1K and 5x hits. */
export default function LineupScoreCard({ block }) {
  const d = block.data ?? {};
  const totals = d.totals ?? {};
  const rows = (Array.isArray(d.players) ? d.players : []).map((p) => {
    const points = Number(p.actual) || 0;
    const projected = p.projected ?? null;
    const diff = p.vs_projection ?? (projected != null && p.status === 'PLAYED' ? points - projected : null);
    const value = p.value_per_1k ?? valuePer1k(points, p.salary);
    return { ...p, points, projected, diff, value, hit: value != null && value >= HIT_MULTIPLE };
  });
  const hits = rows.filter((r) => r.hit).length;
  const totalDiff = totals.projected != null && totals.actual != null ? totals.actual - totals.projected : null;
  const totalValue = totals.value_per_1k ?? valuePer1k(totals.actual, totals.salary);
  const notFound = d.not_found?.length ? `Not found: ${d.not_found.join(', ')}` : null;
  const note = [block.note, d.incomplete && 'Some games are not final yet.', notFound].filter(Boolean).join(' ') || null;

  return (
    <BlockFrame title={block.title ?? 'Lineup result'} subtitle={d.context?.date} note={note}>
      <div className="max-w-xl overflow-hidden rounded-md border border-line bg-surface">
        <dl className="grid grid-cols-2 gap-3 border-b border-line px-3 py-2 sm:grid-cols-4">
          <Summary label="Actual" className="text-accent">
            {totals.actual != null ? Number(totals.actual).toFixed(1) : '—'}
          </Summary>
          <Summary label="vs Proj" className={diffTone(totalDiff)}>
            {totalDiff != null ? `${formatDelta(totalDiff)} (${Number(totals.projected).toFixed(1)})` : '—'}
          </Summary>
          <Summary label="Pts/$1K">{totalValue != null ? `${totalValue.toFixed(2)}x` : '—'}</Summary>
          <Summary label={`${HIT_MULTIPLE}x hits`} className={hits ? 'text-positive' : undefined}>
            {hits}/{rows.length}
          </Summary>
        </dl>

        <table className="w-full border-separate border-spacing-0 text-xs">
          <thead>
            <tr className="text-2xs uppercase tracking-wider text-fg-subtle">
              <th scope="col" className="px-3 py-1.5 text-left font-semibold">Player</th>
              <th scope="col" className="hidden px-2 py-1.5 text-right font-semibold sm:table-cell">Sal</th>
              <th scope="col" className="px-2 py-1.5 text-right font-semibold">Proj</th>
              <th scope="col" className="px-2 py-1.5 text-right font-semibold">Actual</th>
              <th scope="col" className="px-2 py-1.5 text-right font-semibold">+/-</th>
              <th scope="col" className="px-3 py-1.5 text-right font-semibold">Value</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={`${r.name}-${i}`}>
                <th scope="row" className="border-t border-line/60 px-3 py-1.5 text-left font-normal">
                  <span className="flex items-center gap-1.5">
                    <span className="truncate font-medium text-fg">{r.name}</span>
                    {r.status && r.status !== 'PLAYED' && (
                      <Tooltip content={r.status_reason ?? 'Scored 0'}>
                        <span tabIndex={0} className="rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50">
                          <Badge size="sm" tone="negative">{r.status}</Badge>
                        </span>
                      </Tooltip>
                    )}
                  </span>
                  {r.minutes != null && r.status === 'PLAYED' && <span className="num text-2xs text-fg-subtle">{Number(r.minutes).toFixed(0)} min</span>}
                </th>
                <td className="num hidden border-t border-line/60 px-2 text-right text-fg-muted sm:table-cell">{r.salary != null ? formatSalary(r.salary) : '—'}</td>
                <td className="num border-t border-line/60 px-2 text-right text-fg-muted">{r.projected != null ? Number(r.projected).toFixed(1) : '—'}</td>
                <td className="num border-t border-line/60 px-2 text-right font-semibold text-fg">{r.points.toFixed(1)}</td>
                <td className={cn('num border-t border-line/60 px-2 text-right', diffTone(r.diff))} data-testid="score-diff">
                  {r.diff != null ? formatDelta(r.diff) : '—'}
                </td>
                <td className="num border-t border-line/60 px-3 text-right">
                  <span className="inline-flex items-center justify-end gap-1">
                    {r.hit && (
                      <Badge size="sm" tone="positive" aria-label={`Hit ${HIT_MULTIPLE}x`}>
                        {HIT_MULTIPLE}x
                      </Badge>
                    )}
                    <span className={r.hit ? 'text-positive' : 'text-fg-muted'}>{r.value != null ? `${Number(r.value).toFixed(2)}` : '—'}</span>
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </BlockFrame>
  );
}
