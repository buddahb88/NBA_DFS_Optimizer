import { Badge, Tooltip, cn } from '../../components/ui';
import { sanityNote } from './projectionSanity';
import { fadeNote, sourceNote } from './projectionSource';

/** "Fade 71%" badge: ours 4+ below RotoWire, with the bucket's saved-slate hit rate. */
export function FadeBadge({ player, className }) {
  const fade = fadeNote(player);
  if (!fade) return null;
  return (
    <Tooltip content={fade.text}>
      <Badge tone="caution" size="sm" tabIndex={0} data-testid="fade-badge" aria-label={fade.text} className={cn('ml-1 cursor-help', className)}>
        {fade.label}
      </Badge>
    </Tooltip>
  );
}

/**
 * Projection number for player tables: the active source's value (RotoWire,
 * ours or blend; value: the number to show instead, e.g. a manual override).
 * The tooltip explains it: RotoWire vs sanity-adjusted with the reasons, and
 * RotoWire / Ours / Blend with our minutes and p_play. A sanity change is
 * marked ▾ / ▴, a non-RotoWire source O / B (! when RotoWire was kept), and a
 * fade call gets its badge (showFade).
 */
export default function ProjectionCell({ player, value, className, showFade = true }) {
  const shown = Number(value ?? player?.projected_points ?? 0);
  const sanity = sanityNote(player);
  const source = sourceNote(player);
  const fade = showFade ? <FadeBadge player={player} /> : null;
  if (!sanity && !source) {
    return (
      <span className={cn('inline-flex items-center justify-end', className)}>
        {shown.toFixed(1)}
        {fade}
      </span>
    );
  }
  const text = [source?.text, sanity?.text].filter(Boolean).join('. ');
  const tone = sanity ? (sanity.delta < 0 ? 'text-caution' : sanity.delta > 0 ? 'text-positive' : 'text-fg-muted') : 'text-fg-muted';
  const sourceMark = source ? (source.fallback ? '!' : source.source === 'ours' ? 'O' : source.source === 'blend' ? 'B' : '') : '';
  return (
    <span className="inline-flex items-center justify-end">
      <Tooltip content={text}>
        <span
          data-testid={sanity ? 'projection-adjusted' : 'projection-source'}
          data-source={source?.source}
          aria-label={text}
          tabIndex={0}
          className={cn('cursor-help underline decoration-dotted underline-offset-2', className)}
        >
          {shown.toFixed(1)}
          {sanity && (
            <span aria-hidden="true" className={cn('ml-0.5 text-2xs', tone)}>
              {sanity.delta < 0 ? '▾' : sanity.delta > 0 ? '▴' : '•'}
            </span>
          )}
          {sourceMark && (
            <span aria-hidden="true" className={cn('ml-0.5 align-super text-2xs', source.fallback ? 'text-caution' : 'text-accent')}>
              {sourceMark}
            </span>
          )}
        </span>
      </Tooltip>
      {fade}
    </span>
  );
}
