import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Badge, Button, IconCheck, IconExternal, Tooltip, cn } from '../../../components/ui';
import { lineupsAPI } from '../../../services/api';
import { FALLBACK_SITE, formatSalary, lineupTotals } from '../../lineupStudio/lineupMath';
import { lineupEntries, optimizerHandoff } from './blockModel';
import { useChatBlocks } from './blocksContext';
import { useToast } from './toastContext';

const errorMessage = (err) => err?.response?.data?.error || err?.message || 'Request failed';

/**
 * A lineup from the conversation, styled like the Lineup Studio card.
 * Save -> POST /lineups; Open in Optimizer -> the manual builder with these slots.
 */
export default function LineupBlock({ block, compact = false }) {
  const { slateId, site, siteConfig, slatePlayers } = useChatBlocks();
  const notify = useToast();
  const navigate = useNavigate();
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const entries = useMemo(() => lineupEntries(block.data, slatePlayers), [block.data, slatePlayers]);
  const salaryCap = siteConfig?.salaryCap ?? FALLBACK_SITE.salaryCap;
  const totals = lineupTotals(entries, salaryCap);
  const usedPct = Math.min(100, (totals.salary / salaryCap) * 100);
  const name = block.title || 'Chat lineup';
  const missing = entries.filter((e) => !e.onSlate).map((e) => e.player.name || `empty ${e.slot}`);
  const saveBlocked = !slateId ? 'No slate selected' : missing.length ? `Not on the current slate: ${missing.join(', ')}` : null;

  const save = async () => {
    setSaving(true);
    try {
      await lineupsAPI.create({
        slateId,
        site,
        name,
        players: entries.map(({ slot, player }) => ({ ...player, positionSlot: slot, projectedPoints: player.projected_points })),
      });
      setSaved(true);
      notify({ text: `Saved "${name}". Find it on the Lineups page.`, tone: 'positive' });
    } catch (err) {
      notify({ text: `Save failed: ${errorMessage(err)}`, tone: 'negative' });
    } finally {
      setSaving(false);
    }
  };

  const openInOptimizer = () => navigate('/optimizer?mode=manual', { state: { chatLineup: optimizerHandoff(entries) } });

  return (
    <article aria-label={name} className={cn('flex flex-col rounded-md border border-line bg-surface transition-colors hover:border-line-strong', !compact && 'my-3 max-w-md')}>
      <header className="flex items-center justify-between gap-2 border-b border-line px-3 py-2">
        <h3 className="truncate text-sm font-semibold text-fg">{name}</h3>
        {saved && (
          <Badge tone="positive" size="sm">
            <IconCheck size={10} /> Saved
          </Badge>
        )}
      </header>

      <dl className="grid grid-cols-3 gap-2 border-b border-line px-3 py-2">
        <div>
          <dt className="text-2xs uppercase tracking-wider text-fg-subtle">Salary</dt>
          <dd className="num text-sm font-semibold text-fg">{formatSalary(totals.salary)}</dd>
          <div className="mt-1 h-1 rounded-full bg-surface-sunken" aria-hidden="true">
            <div className={cn('h-1 rounded-full', totals.salary > salaryCap ? 'bg-negative' : 'bg-accent')} style={{ width: `${usedPct}%` }} />
          </div>
        </div>
        <div>
          <dt className="text-2xs uppercase tracking-wider text-fg-subtle">Proj</dt>
          <dd className="num text-sm font-semibold text-accent">{totals.projection.toFixed(1)}</dd>
        </div>
        <div>
          <dt className="text-2xs uppercase tracking-wider text-fg-subtle">Own Σ</dt>
          <dd className="num text-sm font-semibold text-fg">{totals.ownership ? `${totals.ownership.toFixed(0)}%` : '—'}</dd>
        </div>
      </dl>

      <ul className="flex-1 divide-y divide-line/60 px-3 py-1">
        {entries.map(({ slot, player, onSlate }, i) => (
          <li key={`${slot}-${i}`} className="flex items-center gap-2 py-1 text-xs">
            <span className="w-9 shrink-0 font-mono text-2xs font-semibold text-fg-subtle">{slot}</span>
            <span className={cn('min-w-0 flex-1 truncate', onSlate ? 'text-fg' : 'text-fg-muted line-through decoration-negative/60')}>{player.name || '-'}</span>
            <span className="w-9 shrink-0 text-2xs text-fg-subtle">{player.team}</span>
            <span className="num w-14 shrink-0 text-right text-fg-muted">{player.salary != null ? formatSalary(player.salary) : ''}</span>
            <span className="num w-10 shrink-0 text-right font-medium text-fg">{player.projected_points != null ? Number(player.projected_points).toFixed(1) : ''}</span>
          </li>
        ))}
      </ul>

      <footer className="flex items-center justify-end gap-1 border-t border-line px-2 py-1.5">
        <Tooltip content="Open in the manual builder">
          <Button variant="ghost" size="xs" onClick={openInOptimizer} rightIcon={<IconExternal size={11} />}>
            Open in Optimizer
          </Button>
        </Tooltip>
        <Tooltip content={saveBlocked}>
          <span>
            <Button variant="secondary" size="xs" onClick={save} loading={saving} disabled={saved || !!saveBlocked}>
              {saved ? 'Saved' : 'Save'}
            </Button>
          </span>
        </Tooltip>
      </footer>
    </article>
  );
}
