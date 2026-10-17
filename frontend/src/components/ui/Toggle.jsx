import { useId } from 'react';
import { cn } from './cn';

export default function Toggle({ checked, onChange, label, description, size = 'md', disabled, className, id }) {
  const autoId = useId();
  const toggleId = id || autoId;
  const track = size === 'sm' ? 'h-4 w-7' : 'h-5 w-9';
  const knob = size === 'sm' ? 'h-3 w-3' : 'h-4 w-4';
  const shift = size === 'sm' ? 'translate-x-3' : 'translate-x-4';
  return (
    <div className={cn('inline-flex items-center gap-2', disabled && 'opacity-50', className)}>
      <button
        id={toggleId}
        type="button"
        role="switch"
        aria-checked={!!checked}
        disabled={disabled}
        onClick={() => onChange?.(!checked)}
        className={cn(
          'relative inline-flex shrink-0 items-center rounded-full p-0.5 transition-colors disabled:cursor-not-allowed',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50',
          checked ? 'bg-accent' : 'bg-line-strong',
          track,
        )}
      >
        <span className={cn('rounded-full bg-white shadow transition-transform', knob, checked ? shift : 'translate-x-0')} />
      </button>
      {(label || description) && (
        <label htmlFor={toggleId} className={cn('flex flex-col', disabled ? 'cursor-not-allowed' : 'cursor-pointer')}>
          {label && <span className="text-sm text-fg">{label}</span>}
          {description && <span className="text-2xs text-fg-subtle">{description}</span>}
        </label>
      )}
    </div>
  );
}
