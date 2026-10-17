import { cn } from './cn';

const SIZES = { xs: 'h-3 w-3 border', sm: 'h-4 w-4 border-2', md: 'h-6 w-6 border-2', lg: 'h-10 w-10 border-[3px]' };

export default function Spinner({ size = 'sm', className, label = 'Loading' }) {
  return (
    <span
      role="status"
      aria-label={label}
      className={cn(
        'inline-block animate-spin rounded-full border-current border-r-transparent text-accent',
        SIZES[size],
        className,
      )}
    />
  );
}
