import { Tooltip, cn } from '../../components/ui';
import { sanityNote } from './projectionSanity';

/**
 * Projection number for player tables. When the projection sanity layer moved
 * (or explained) it, the number is marked and the tooltip shows RotoWire vs
 * adjusted with the reasons. value: the number to show (default the
 * player's projected_points, e.g. a manual override instead).
 */
export default function ProjectionCell({ player, value, className }) {
  const shown = Number(value ?? player?.projected_points ?? 0);
  const note = sanityNote(player);
  if (!note) return <span className={className}>{shown.toFixed(1)}</span>;
  const tone = note.delta < 0 ? 'text-caution' : note.delta > 0 ? 'text-positive' : 'text-fg-muted';
  return (
    <Tooltip content={note.text}>
      <span
        data-testid="projection-adjusted"
        aria-label={note.text}
        tabIndex={0}
        className={cn('cursor-help underline decoration-dotted underline-offset-2', className)}
      >
        {shown.toFixed(1)}
        <span aria-hidden="true" className={cn('ml-0.5 text-2xs', tone)}>
          {note.delta < 0 ? '▾' : note.delta > 0 ? '▴' : '•'}
        </span>
      </span>
    </Tooltip>
  );
}
