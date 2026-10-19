import { Badge, Card, Tooltip, cn } from '../../components/ui';
import { formatSpread, formatTipoff } from './slateDashboard';

function TeamLine({ team, favorite }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className={cn('text-sm font-semibold', team.team === favorite ? 'text-fg' : 'text-fg-muted')}>{team.team}</span>
      <span className="num flex items-baseline gap-3 text-xs text-fg-muted">
        <span title="Spread">{formatSpread(team.spread)}</span>
        <span className="w-10 text-right text-sm font-semibold text-fg" title="Implied team total">
          {team.impliedTotal != null ? team.impliedTotal.toFixed(1) : '—'}
        </span>
      </span>
    </div>
  );
}

function Metric({ label, value, tone }) {
  return (
    <div className="flex flex-col">
      <span className="text-2xs uppercase tracking-wider text-fg-subtle">{label}</span>
      <span className={cn('num text-sm font-semibold', tone ?? 'text-fg')}>{value}</span>
    </div>
  );
}

export default function GameCard({ game }) {
  const { away, home, hasHomeAway, start, total, spread, favorite, pace, paceDelta, blowout } = game;
  const paceTone = paceDelta == null ? null : paceDelta >= 1.5 ? 'text-positive' : paceDelta <= -1.5 ? 'text-negative' : null;

  return (
    <Card className="flex flex-col gap-2.5 p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-xs font-medium text-fg-muted">
          {away.team} {hasHomeAway ? '@' : 'vs'} {home.team}
        </span>
        <div className="flex shrink-0 items-center gap-1">
          {blowout && (
            <Tooltip content={`${favorite} favored by ${spread}: starters' minutes at risk`}>
              <span>
                <Badge tone="caution" size="sm">
                  Blowout risk
                </Badge>
              </span>
            </Tooltip>
          )}
          <span className="num text-xs text-fg-subtle">{formatTipoff(start)}</span>
        </div>
      </div>

      <div className="flex flex-col gap-1">
        <TeamLine team={away} favorite={favorite} />
        <TeamLine team={home} favorite={favorite} />
      </div>

      <div className="grid grid-cols-3 gap-2 border-t border-line pt-2">
        <Metric label="Total" value={total != null ? total.toFixed(1) : '—'} />
        <Metric label="Spread" value={spread != null ? spread.toFixed(1) : '—'} tone={blowout ? 'text-caution' : null} />
        <Metric
          label="Pace"
          value={pace != null ? `${pace.toFixed(1)}${paceDelta != null ? ` (${paceDelta >= 0 ? '+' : ''}${paceDelta.toFixed(1)})` : ''}` : '—'}
          tone={paceTone}
        />
      </div>
    </Card>
  );
}
