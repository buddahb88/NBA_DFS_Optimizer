import { Badge, Button, Card, CardBody, CardHeader, EmptyState, Spinner, cn } from '../../components/ui';

const METRIC_TONE = { positive: 'text-positive', negative: 'text-negative' };

export function InsightRow({ name, meta, sub, metric, metricLabel, tone, badge }) {
  return (
    <div className="flex items-center justify-between gap-2 py-1.5">
      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-sm text-fg">{name}</span>
          {badge && (
            <Badge tone={badge.tone} size="sm">
              {badge.label}
            </Badge>
          )}
        </div>
        {meta && <div className="truncate text-2xs text-fg-subtle">{meta}</div>}
        {sub && <div className="text-2xs text-fg-muted">{sub}</div>}
      </div>
      <div className="shrink-0 text-right">
        <div className={cn('num text-sm font-semibold', METRIC_TONE[tone] ?? 'text-fg')}>{metric}</div>
        {metricLabel && <div className="num text-2xs text-fg-subtle">{metricLabel}</div>}
      </div>
    </div>
  );
}

/**
 * One insight list. `card` is a SLATE_CARDS / LEAGUE_CARDS entry, `rows` its
 * rows, `status`/`error` the useInsights section it reads. Loading, error and
 * empty states stay inside the card.
 */
export default function InsightCard({ card, rows, status, error, onRetry, className }) {
  const loading = status === 'loading' || status === 'idle';
  const hasRows = rows.length > 0;

  let body;
  if (status === 'error') {
    body = (
      <EmptyState
        compact
        title="Couldn't load this card"
        description={error}
        action={
          onRetry && (
            <Button size="sm" variant="secondary" onClick={onRetry}>
              Try again
            </Button>
          )
        }
      />
    );
  } else if (!hasRows && loading) {
    body = (
      <div className="flex justify-center py-8">
        <Spinner size="sm" label={`Loading ${card.title}`} />
      </div>
    );
  } else if (!hasRows) {
    body = <EmptyState compact title="Nothing to show" description={card.empty} />;
  } else {
    body = (
      <ul className="divide-y divide-line">
        {rows.map((r) => (
          <li key={card.getKey(r)}>
            <InsightRow {...card.row(r)} />
          </li>
        ))}
      </ul>
    );
  }

  return (
    <Card className={cn('flex flex-col', className)} aria-busy={loading || undefined} data-card={card.id}>
      <CardHeader
        title={card.title}
        subtitle={card.subtitle}
        actions={
          hasRows && loading ? (
            <Spinner size="xs" label={`Refreshing ${card.title}`} />
          ) : status === 'ready' ? (
            <Badge size="sm" className="num">
              {rows.length}
            </Badge>
          ) : null
        }
      />
      <CardBody className="scrollbar-thin max-h-80 overflow-auto py-1">{body}</CardBody>
    </Card>
  );
}
