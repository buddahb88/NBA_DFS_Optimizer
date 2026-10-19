import { Badge, Card, CardBody, CardHeader, EmptyState, Spinner, cn } from '../../components/ui';
import { DK_POSITIONS, num } from './slateDashboard';

const money = (v) => `$${(num(v) ?? 0).toLocaleString()}`;
const pct = (v) => (num(v) != null ? `${num(v).toFixed(1)}%` : '—');

function PlayerRow({ player, metric, metricLabel, sub }) {
  return (
    <li className="flex items-center justify-between gap-2 py-1.5">
      <div className="min-w-0">
        <div className="truncate text-sm text-fg">{player.name}</div>
        <div className="truncate text-2xs text-fg-subtle">
          {player.team} · {player.position} · {money(player.salary)}
          {sub ? ` · ${sub}` : ''}
        </div>
      </div>
      <div className="shrink-0 text-right">
        <div className="num text-sm font-semibold text-fg">{metric}</div>
        {metricLabel && <div className="text-2xs text-fg-subtle">{metricLabel}</div>}
      </div>
    </li>
  );
}

export function InjuryFeedPanel({ items, loading, error, className }) {
  return (
    <Card className={cn('flex flex-col', className)}>
      <CardHeader
        title="Injuries & news"
        subtitle="Teammate bumps from historical games without the player"
        actions={loading && <Spinner size="xs" label="Loading usage bumps" />}
      />
      <CardBody className="scrollbar-thin max-h-[28rem] overflow-auto py-1">
        {items.length === 0 ? (
          <EmptyState
            compact
            title={loading ? 'Checking rosters…' : 'No injury news'}
            description={error ? `Historical lookup failed: ${error}` : loading ? null : 'No tagged or missing rotation players on this slate.'}
          />
        ) : (
          <ul className="divide-y divide-line">
            {items.map((item) => (
              <li key={item.id} className="py-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <Badge tone={item.status.tone} size="sm">
                      {item.status.label}
                    </Badge>
                    <span className="truncate text-sm font-medium text-fg">{item.name}</span>
                    <span className="text-2xs text-fg-subtle">{item.team}</span>
                  </div>
                  {item.detail && <span className="num shrink-0 text-2xs text-fg-muted">{item.detail}</span>}
                </div>
                {item.status.note && <p className="mt-0.5 truncate text-2xs text-fg-subtle">{item.status.note}</p>}
                {item.beneficiaries.length > 0 && (
                  <ul className="mt-1.5 space-y-0.5 border-l-2 border-positive/40 pl-2">
                    {item.beneficiaries.slice(0, 4).map((b) => (
                      <li key={b.player} className="flex items-baseline justify-between gap-2 text-xs">
                        <span className="truncate text-fg">
                          {b.player}
                          {b.salary ? <span className="text-fg-subtle"> · {money(b.salary)}</span> : null}
                        </span>
                        <span className="num shrink-0 text-positive" title={`${b.gamesWithout} games without, ${b.confidence} confidence`}>
                          +{b.dkBump} DK ({b.pctBump > 0 ? '+' : ''}
                          {Math.round(b.pctBump)}%)
                          {b.minBump ? <span className="text-fg-subtle"> · {b.minBump > 0 ? '+' : ''}{b.minBump} min</span> : null}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}

export function TopValuesPanel({ valuesByPosition, className }) {
  const hasAny = DK_POSITIONS.some((pos) => valuesByPosition[pos]?.length);
  return (
    <Card className={className}>
      <CardHeader title="Top values by position" subtitle="Projected DK points per $1K, 15+ projected minutes" />
      <CardBody>
        {!hasAny ? (
          <EmptyState compact title="No value plays" description="No players with projections and minutes yet." />
        ) : (
          <div className="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2 lg:grid-cols-5">
            {DK_POSITIONS.map((pos) => (
              <div key={pos} className="min-w-0">
                <h4 className="text-2xs font-semibold uppercase tracking-wider text-fg-subtle">{pos}</h4>
                <ul className="divide-y divide-line">
                  {(valuesByPosition[pos] || []).map((p) => (
                    <PlayerRow
                      key={`${pos}:${p.player_id ?? p.id}`}
                      player={p}
                      metric={`${p.valuePerK.toFixed(2)}x`}
                      metricLabel={`${num(p.projected_points)?.toFixed(1)} pts`}
                    />
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </CardBody>
    </Card>
  );
}

export function LeveragePanel({ players, className }) {
  return (
    <Card className={className}>
      <CardHeader title="GPP leverage" subtitle="Boom probability relative to projected ownership" />
      <CardBody className="py-1">
        {players.length === 0 ? (
          <EmptyState compact title="No leverage data" description="Leverage scores are computed on slate import." />
        ) : (
          <ul className="divide-y divide-line">
            {players.map((p) => (
              <PlayerRow
                key={p.player_id ?? p.id}
                player={p}
                metric={num(p.leverage_score).toFixed(1)}
                metricLabel={`${pct(p.rostership)} own`}
                sub={num(p.ceiling) ? `${num(p.ceiling).toFixed(0)} ceil` : null}
              />
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}

export function ChalkPanel({ players, className }) {
  return (
    <Card className={className}>
      <CardHeader title="Chalk" subtitle="Highest projected ownership" />
      <CardBody className="py-1">
        {players.length === 0 ? (
          <EmptyState compact title="No ownership projections" description="RotoWire hasn't published ownership for this slate yet." />
        ) : (
          <ul className="divide-y divide-line">
            {players.map((p) => (
              <PlayerRow
                key={p.player_id ?? p.id}
                player={p}
                metric={pct(p.rostership)}
                metricLabel={`${num(p.projected_points)?.toFixed(1)} pts`}
              />
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}
