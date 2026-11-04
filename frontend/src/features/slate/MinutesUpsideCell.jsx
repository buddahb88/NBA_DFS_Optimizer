import { Badge, Tooltip, cn } from '../../components/ui';
import { upsideNote } from './minutesUpside';

/**
 * Minutes upside for player tables: the 0-100 score (badge when high), with
 * our minutes band, RotoWire's minutes and the reasons in the tooltip. A dash
 * without a score (RotoWire source, or no own-model row).
 */
export default function MinutesUpsideCell({ player, className }) {
  const note = upsideNote(player);
  if (!note) return <span className="text-fg-subtle">—</span>;
  const value = Math.round(note.score);
  return (
    <Tooltip content={note.text}>
      {note.high ? (
        <Badge tone="positive" size="sm" tabIndex={0} data-testid="minutes-upside" aria-label={note.text} className={cn('num cursor-help', className)}>
          ↑{value}
        </Badge>
      ) : (
        <span
          tabIndex={0}
          data-testid="minutes-upside"
          aria-label={note.text}
          className={cn('num cursor-help', note.tone === 'info' ? 'text-info' : 'text-fg-muted', className)}
        >
          {value}
        </span>
      )}
    </Tooltip>
  );
}
