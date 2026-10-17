import { cn } from './cn';

export function Card({ className, children, ...rest }) {
  return (
    <div className={cn('rounded-md border border-line bg-surface', className)} {...rest}>
      {children}
    </div>
  );
}

export function CardHeader({ title, subtitle, actions, className, children }) {
  return (
    <div className={cn('flex items-center justify-between gap-3 border-b border-line px-3 py-2', className)}>
      <div className="min-w-0">
        {title && <h3 className="truncate text-sm font-semibold text-fg">{title}</h3>}
        {subtitle && <p className="truncate text-xs text-fg-muted">{subtitle}</p>}
        {children}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-1.5">{actions}</div>}
    </div>
  );
}

export function CardBody({ className, children }) {
  return <div className={cn('p-3', className)}>{children}</div>;
}

export default Card;
