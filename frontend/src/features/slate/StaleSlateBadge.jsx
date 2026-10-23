import { Link } from 'react-router-dom';
import { Button, IconAlert, cn } from '../../components/ui';
import { formatSlateDate, slateStaleness } from './slateFreshness';

/**
 * Caution shown when the selected slate is from an earlier night than today
 * (ET). Links to Home (where slates sync) or, with onSync, runs it in place.
 * Renders nothing for tonight's slate or one without a known date.
 */
export default function StaleSlateBadge({ slate, now, onSync, className }) {
  const { slateDate, today, isStale } = slateStaleness(slate, now);
  if (!isStale) return null;

  return (
    <span
      role="status"
      title={`Slate ${slate.slate_id} covers ${slateDate}; today is ${today} (ET). Its players, salaries and projections are not tonight's.`}
      className={cn('inline-flex flex-wrap items-center gap-1.5 rounded border border-caution/30 bg-caution-soft px-2 py-0.5 text-xs font-medium text-caution', className)}
    >
      <IconAlert size={12} className="shrink-0" />
      <span>Slate is from {formatSlateDate(slateDate)} - sync tonight&apos;s slate</span>
      {onSync ? (
        <Button variant="ghost" size="sm" className="h-5 px-1.5" onClick={onSync}>
          Sync slate
        </Button>
      ) : (
        <Link to="/" className="font-semibold underline hover:no-underline">
          Sync slate
        </Link>
      )}
    </span>
  );
}
