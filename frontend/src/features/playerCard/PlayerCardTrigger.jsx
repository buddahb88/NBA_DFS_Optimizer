import { cn } from '../../components/ui';
import { usePlayerCard } from './playerCardContext';

/**
 * Wraps a player's name / headshot in a button that opens his card. Clicks
 * never reach the row underneath (ManualBuilder places a player on row click).
 * Without a PlayerCardProvider, or without an id, it renders the children as is.
 *
 * target: { playerId, slateId?, slateDate?, name?, headshot?, controls? } (see playerCardContext)
 * title: hover text (default "Open player card"); pass the full name where it may be clamped.
 */
export default function PlayerCardTrigger({ target, className, children, label, title }) {
  const { open } = usePlayerCard();
  if (!open || target?.playerId == null) return <span className={className} title={title}>{children}</span>;
  const stop = (e) => e.stopPropagation();
  return (
    <button
      type="button"
      aria-haspopup="dialog"
      aria-label={label ?? `Open ${target.name ?? 'player'} card`}
      title={title ?? 'Open player card'}
      onClick={(e) => {
        e.stopPropagation();
        e.preventDefault();
        open(target);
      }}
      onKeyDown={stop}
      onPointerDown={stop}
      className={cn(
        'max-w-full cursor-pointer rounded-sm text-left underline-offset-2 hover:text-accent hover:underline',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50',
        className,
      )}
    >
      {children}
    </button>
  );
}
