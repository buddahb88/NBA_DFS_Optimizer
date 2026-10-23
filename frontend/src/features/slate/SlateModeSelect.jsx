import { Badge, IconClock, Select, Tabs, Tooltip, cn } from '../../components/ui';
import { useSlate } from '../../context/SlateContext';
import { RANGE_MODES, backtestOptions } from './backtest';

/**
 * "Backtest 2026-10-21" badge: the page is showing a saved past slate,
 * rebuilt read-only, with actual points. Renders nothing live.
 */
export function BacktestBadge({ backtest, className }) {
  if (!backtest) return null;
  return (
    <Tooltip content={`Saved ${backtest.slateDate} slate (${backtest.slateId}), pre-lock salaries and projections, with actual points. Live slate untouched.`}>
      <Badge tone="caution" className={cn('gap-1', className)} role="status" data-testid="backtest-badge">
        <IconClock size={11} />
        Backtest {backtest.slateDate}
      </Badge>
    </Tooltip>
  );
}

/**
 * Slate selector: Live, or Backtest: <date> for each saved past slate of the
 * site (SlateContext). With showRanges, a backtest also picks model vs
 * pre-lock floor / ceiling. Hidden while there is nothing to backtest.
 */
export default function SlateModeSelect({ showRanges = false, className }) {
  const { backtests = [], backtest, setBacktestDate, rangeMode, setRangeMode } = useSlate();
  if (!setBacktestDate || (backtests.length === 0 && !backtest)) return null;

  return (
    <div className={cn('flex flex-wrap items-center gap-2', className)}>
      <Select
        size="sm"
        aria-label="Slate mode"
        value={backtest?.slateDate ?? ''}
        onChange={(e) => setBacktestDate(e.target.value || null)}
        options={backtestOptions(backtests)}
        className="w-60"
      />
      {showRanges && backtest && (
        <div role="group" aria-label="Backtest ranges">
          <Tabs
            variant="pill"
            size="sm"
            value={rangeMode}
            onChange={setRangeMode}
            tabs={RANGE_MODES.map(({ value, label }) => ({ value, label }))}
          />
        </div>
      )}
      <BacktestBadge backtest={backtest} />
    </div>
  );
}
