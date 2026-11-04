import { Badge, Tooltip } from '../../components/ui';
import { injuryRiskInfo } from './playerPool';

/**
 * Injury-tag risk badge ("Q 68%") with the tooltip that explains the
 * projection discount. Renders nothing for a healthy player.
 * compact: just the code (lineup cards); the tooltip keeps the details.
 */
export default function InjuryRiskBadge({ player, size = 'sm', compact = false, className }) {
  const info = injuryRiskInfo(player);
  if (!info) return null;
  return (
    <Tooltip content={info.tip}>
      <Badge
        size={size}
        tone={info.tone}
        className={className}
        aria-label={info.tip}
        data-risk={info.risk ?? 'none'}
        tabIndex={0}
      >
        {compact ? info.code : info.label}
      </Badge>
    </Tooltip>
  );
}
