import { cn } from './cn';
import { IconInbox } from './icons';

export default function EmptyState({ icon, title = 'Nothing here yet', description, action, compact = false, className }) {
  return (
    <div className={cn('flex flex-col items-center justify-center text-center', compact ? 'gap-1.5 py-6' : 'gap-2 py-12', className)}>
      <div className="flex h-10 w-10 items-center justify-center rounded-full border border-line bg-surface-sunken text-fg-subtle">
        {icon ?? <IconInbox size={18} />}
      </div>
      <h4 className="text-sm font-semibold text-fg">{title}</h4>
      {description && <p className="max-w-sm text-xs text-fg-muted">{description}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
