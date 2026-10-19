// Cell components for the Player Pool table (see columns.jsx).
import { useEffect, useState } from 'react';
import { cn } from '../../components/ui';
import { ownershipTone } from './playerPool';

const TONE_TEXT = {
  positive: 'text-positive',
  negative: 'text-negative',
  caution: 'text-caution',
  info: 'text-info',
};

export const Dash = () => <span className="text-fg-subtle">–</span>;

export function Num({ value, digits = 1, suffix = '', tone }) {
  if (value == null) return <Dash />;
  return (
    <span className={cn(TONE_TEXT[tone])}>
      {Number(value).toFixed(digits)}
      {suffix}
    </span>
  );
}

export function OwnershipCell({ value }) {
  if (value == null) return <Dash />;
  const tone = ownershipTone(value);
  return (
    <span className="inline-flex items-center justify-end gap-1.5">
      <span className="h-1 w-8 overflow-hidden rounded-full bg-surface-sunken">
        <span
          className={cn('block h-full', tone === 'caution' ? 'bg-caution' : tone === 'info' ? 'bg-info' : 'bg-fg-subtle')}
          style={{ width: `${Math.min(value * 2, 100)}%` }}
        />
      </span>
      <span className={cn(TONE_TEXT[tone])}>{value.toFixed(1)}%</span>
    </span>
  );
}

// ── Controls ────────────────────────────────────────────────────────────────

export const IconLock = (props) => (
  <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
    <rect x="4" y="11" width="16" height="10" rx="2" />
    <path d="M8 11V7a4 4 0 0 1 8 0v4" />
  </svg>
);

export const IconBan = (props) => (
  <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
    <circle cx="12" cy="12" r="9" />
    <path d="m5.7 5.7 12.6 12.6" />
  </svg>
);

export function ControlButton({ active, tone, label, onClick, children }) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={!!active}
      title={label}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={cn(
        'inline-flex h-5 w-5 items-center justify-center rounded border transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50',
        active
          ? tone === 'positive'
            ? 'border-positive/40 bg-positive-soft text-positive'
            : 'border-negative/40 bg-negative-soft text-negative'
          : 'border-transparent text-fg-subtle hover:border-line hover:text-fg',
      )}
    >
      {children}
    </button>
  );
}

/**
 * Small numeric input that keeps a local draft and commits on blur / Enter
 * (Escape reverts). `onCommit` returns an error string to reject the value.
 */
export function NumberCell({ value, onCommit, placeholder, label, step = 1, className }) {
  const external = value == null ? '' : String(value);
  const [draft, setDraft] = useState(external);
  const [error, setError] = useState(null);

  useEffect(() => {
    setDraft(external);
    setError(null);
  }, [external]);

  const commit = () => {
    if (draft.trim() === external) return;
    const next = draft.trim() === '' ? null : Number(draft);
    if (next != null && !Number.isFinite(next)) {
      setError('Not a number');
      return;
    }
    const err = onCommit(next);
    setError(err || null);
  };

  // `title` rather than <Tooltip>: wrapping only on error would remount the input
  return (
    <input
      type="number"
      inputMode="decimal"
      step={step}
      aria-label={label}
      aria-invalid={error ? true : undefined}
      title={error || undefined}
      value={draft}
      placeholder={placeholder}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') {
          setDraft(external);
          setError(null);
        }
      }}
      className={cn(
        'num h-5 w-12 rounded border bg-surface-sunken px-1 text-right text-xs text-fg placeholder:text-fg-subtle/70',
        '[appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none',
        'focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/40',
        error ? 'border-negative' : value != null ? 'border-accent/50' : 'border-line',
        className,
      )}
    />
  );
}

