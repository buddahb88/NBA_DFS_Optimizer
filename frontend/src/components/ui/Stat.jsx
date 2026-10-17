import { cn } from './cn';
import { IconArrowDown, IconArrowUp } from './icons';

const DELTA_TONE = { positive: 'text-positive', negative: 'text-negative', neutral: 'text-fg-muted' };

/**
 * KPI tile. `delta` is a number (sign picks direction/colour) or a string;
 * pass `deltaTone` to override (e.g. when lower is better, like ownership).
 */
export default function Stat({ label, value, unit, delta, deltaLabel, deltaTone, hint, icon, className }) {
  const numericDelta = typeof delta === 'number';
  const tone = deltaTone ?? (numericDelta ? (delta > 0 ? 'positive' : delta < 0 ? 'negative' : 'neutral') : 'neutral');

  return (
    <div className={cn('flex flex-col gap-1 rounded-md border border-line bg-surface px-3 py-2.5', className)}>
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-2xs font-medium uppercase tracking-wider text-fg-subtle">{label}</span>
        {icon && <span className="text-fg-subtle">{icon}</span>}
      </div>
      <div className="flex items-baseline gap-1">
        <span className="num text-xl font-semibold leading-tight text-fg">{value}</span>
        {unit && <span className="text-xs text-fg-muted">{unit}</span>}
      </div>
      {(delta != null || hint) && (
        <div className="flex items-center gap-1.5 text-2xs">
          {delta != null && (
            <span className={cn('num inline-flex items-center gap-0.5 font-medium', DELTA_TONE[tone])}>
              {numericDelta && delta > 0 && <IconArrowUp size={10} />}
              {numericDelta && delta < 0 && <IconArrowDown size={10} />}
              {numericDelta ? Math.abs(delta).toLocaleString() : delta}
              {deltaLabel && <span className="font-normal text-fg-subtle">{deltaLabel}</span>}
            </span>
          )}
          {hint && <span className="truncate text-fg-subtle">{hint}</span>}
        </div>
      )}
    </div>
  );
}
