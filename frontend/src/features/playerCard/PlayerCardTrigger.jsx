import { cn } from '../../components/ui';
import { usePlayerCard } from './playerCardContext';

/**
 * Wraps a player's name / headshot in a button that opens his card. Clicks
 * never reach the row underneath (ManualBuilder places a player on row click).
 * Without a PlayerCardProvider, or without an id, it renders the children as is.
 *
 * target: { playerId, slateId?, slateDate?, name?, headshot?, controls? } (see playerCardContext)
 */
export default function PlayerCardTrigger({ target, className, children, label }) {
  const { open } = usePlayerCard();
  if (!open || target?.playerId == null) return <span className={className}>{children}</span>;
  const stop = (e) => e.stopPropagation();
  return (
    <button
      type="button"
      aria-haspopup="dialog"
      aria-label={label ?? `Open ${target.name ?? 'player'} card`}
      title="Open player card"
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
