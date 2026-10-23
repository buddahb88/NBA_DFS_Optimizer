import { Badge, IconClock, Tabs, Tooltip } from '../../components/ui';
import { formatTipoff } from '../../pages/home/slateDashboard';
import StaleSlateBadge from '../slate/StaleSlateBadge';

const CHAT_MODES = [
  { value: 'cash', label: 'Cash', hint: 'Floor, minutes certainty, safe plays' },
  { value: 'gpp', label: 'GPP', hint: 'Ceiling, leverage, stacks, contrarian' },
];

/**
 * Strip above the conversation: which slate the assistant is looking at and
 * the Cash/GPP mode sent with each message. Cautions when the slate is from
 * an earlier night than today. slateSelector (Live / Backtest: <date>) sits
 * at the end of the slate info; with a backtest picked, questions go to that
 * saved night and the stale caution is replaced by its Backtest badge.
 */
export default function SlateContextBar({ slate, siteName, gameCount, firstLock, loading, mode, onModeChange, now, backtest = null, slateSelector = null }) {
  const activeMode = CHAT_MODES.find((m) => m.value === mode);

  return (
    <div role="region" aria-label="Slate context" className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-line bg-surface-raised/60 px-3 py-2 sm:px-4">
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        {slate ? (
          <>
            <span className="truncate font-semibold text-fg" title={slate.name}>
              {slate.name}
            </span>
            {siteName && <Badge tone="accent" size="sm">{siteName}</Badge>}
            <span className="text-fg-muted">
              {loading ? '…' : <><span className="num text-fg">{gameCount}</span> {gameCount === 1 ? 'game' : 'games'}</>}
            </span>
            <span className="flex items-center gap-1 text-fg-muted">
              <IconClock size={12} className="text-fg-subtle" />
              <span>
                Lock <span className="num text-fg">{loading ? '…' : formatTipoff(firstLock)}</span>
              </span>
            </span>
            {!backtest && <StaleSlateBadge slate={slate} now={now} />}
          </>
        ) : (
          <span className="text-fg-muted">{loading ? 'Loading slate…' : 'No slate selected — pick one in the top bar for slate-aware answers.'}</span>
        )}
        {slateSelector}
        {backtest && (
          <span className="text-fg-muted">Questions use the saved {backtest.slateDate} slate and its actual results.</span>
        )}
      </div>

      <Tooltip content={activeMode?.hint} side="bottom">
        <div aria-label="Contest mode" role="group">
          <Tabs variant="pill" size="sm" tabs={CHAT_MODES} value={mode} onChange={onModeChange} />
        </div>
      </Tooltip>
    </div>
  );
}
