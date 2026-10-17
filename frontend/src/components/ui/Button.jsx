import { forwardRef } from 'react';
import { cn } from './cn';
import Spinner from './Spinner';

const VARIANTS = {
  primary: 'bg-accent text-accent-fg hover:bg-accent-hover border-transparent',
  secondary: 'bg-surface-raised text-fg border-line hover:border-line-strong hover:bg-surface-sunken',
  ghost: 'bg-transparent text-fg-muted border-transparent hover:bg-surface-raised hover:text-fg',
  outline: 'bg-transparent text-fg border-line hover:bg-surface-raised',
  danger: 'bg-negative text-white border-transparent hover:brightness-110',
  positive: 'bg-positive text-white border-transparent hover:brightness-110',
};

const SIZES = {
  xs: 'h-6 px-2 text-2xs gap-1',
  sm: 'h-7 px-2.5 text-xs gap-1.5',
  md: 'h-8 px-3 text-sm gap-2',
  lg: 'h-10 px-4 text-sm gap-2',
  icon: 'h-8 w-8 p-0 justify-center',
  'icon-sm': 'h-7 w-7 p-0 justify-center',
};

const Button = forwardRef(function Button(
  { variant = 'secondary', size = 'md', loading = false, leftIcon, rightIcon, className, disabled, children, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      className={cn(
        'inline-flex shrink-0 items-center rounded border font-medium transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 focus-visible:ring-offset-1 focus-visible:ring-offset-canvas',
        'disabled:pointer-events-none disabled:opacity-50',
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...rest}
    >
      {loading ? <Spinner size="xs" className="text-current" /> : leftIcon}
      {children}
      {rightIcon}
    </button>
  );
});

export default Button;
