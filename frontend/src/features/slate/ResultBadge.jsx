import { Badge } from '../../components/ui';
import { resultLabel } from './backtest';

/** Backtest result (Played · min / DNP / Inactive / Pending) for a player carrying resultStatus. */
export default function ResultBadge({ player }) {
  const result = resultLabel(player);
  return result ? <Badge tone={result.tone} size="sm">{result.label}</Badge> : <span className="text-fg-muted">—</span>;
}
