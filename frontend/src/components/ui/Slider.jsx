import { useId } from 'react';
import { cn } from './cn';

/** Range input with label and live value readout. `onChange` receives a number. */
export default function Slider({ label, value, min = 0, max = 100, step = 1, onChange, format = (v) => v, className, disabled, id, ...rest }) {
  const autoId = useId();
  const sliderId = id || autoId;
  const pct = ((Number(value) - min) / (max - min || 1)) * 100;
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      {label != null && (
        <div className="flex items-center justify-between text-xs">
          <label htmlFor={sliderId} className="font-medium text-fg-muted">
            {label}
          </label>
          <span className="num text-fg">{format(value)}</span>
        </div>
      )}
      <input
        id={sliderId}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange?.(Number(e.target.value), e)}
        style={{
          background: `linear-gradient(to right, rgb(var(--accent)) ${pct}%, rgb(var(--line-strong)) ${pct}%)`,
        }}
        className={cn(
          'h-1.5 w-full cursor-pointer appearance-none rounded-full disabled:cursor-not-allowed disabled:opacity-50',
          '[&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full',
          '[&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-accent [&::-webkit-slider-thumb]:bg-surface',
          '[&::-moz-range-thumb]:h-3 [&::-moz-range-thumb]:w-3 [&::-moz-range-thumb]:rounded-full',
          '[&::-moz-range-thumb]:border-2 [&::-moz-range-thumb]:border-accent [&::-moz-range-thumb]:bg-surface',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
        )}
        {...rest}
      />
    </div>
  );
}
