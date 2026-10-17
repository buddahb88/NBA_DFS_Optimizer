import { cn } from './cn';

const TONES = {
  neutral: 'bg-surface-sunken text-fg-muted border-line',
  accent: 'bg-accent-soft text-accent border-accent/30',
  positive: 'bg-positive-soft text-positive border-positive/30',
  negative: 'bg-negative-soft text-negative border-negative/30',
  caution: 'bg-caution-soft text-caution border-caution/30',
  info: 'bg-info-soft text-info border-info/30',
};

const SIZES = {
  sm: 'h-4 px-1 text-2xs',
  md: 'h-5 px-1.5 text-xs',
};

export default function Badge({ tone = 'neutral', size = 'md', dot = false, className, children, ...rest }) {
  return (
    <span
      className={cn('inline-flex items-center gap-1 whitespace-nowrap rounded border font-medium leading-none', TONES[tone], SIZES[size], className)}
      {...rest}
    >
      {dot && <span className="h-1.5 w-1.5 rounded-full bg-current" />}
      {children}
    </span>
  );
}
