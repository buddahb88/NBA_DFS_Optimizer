import { forwardRef, useId } from 'react';
import { cn } from './cn';
import { fieldBase } from './fieldBase';

const Input = forwardRef(function Input({ label, hint, error, leftIcon, numeric = false, className, id, ...rest }, ref) {
  const autoId = useId();
  const inputId = id || autoId;
  return (
    <div className={cn('flex flex-col gap-1', className)}>
      {label && (
        <label htmlFor={inputId} className="text-xs font-medium text-fg-muted">
          {label}
        </label>
      )}
      <span className="relative flex items-center">
        {leftIcon && <span className="pointer-events-none absolute left-2 text-fg-subtle">{leftIcon}</span>}
        <input
          ref={ref}
          id={inputId}
          aria-invalid={error ? true : undefined}
          className={cn(fieldBase, leftIcon && 'pl-7', numeric && 'num text-right', error && 'border-negative focus:border-negative focus:ring-negative/30')}
          {...rest}
        />
      </span>
      {(error || hint) && <span className={cn('text-2xs', error ? 'text-negative' : 'text-fg-subtle')}>{error || hint}</span>}
    </div>
  );
});

export default Input;
