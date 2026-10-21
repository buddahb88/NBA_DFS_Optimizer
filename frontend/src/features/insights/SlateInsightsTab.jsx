import { Link } from 'react-router-dom';
import { Card, EmptyState, Stat } from '../../components/ui';
import InsightCard from './InsightCard';
import { SLATE_CARDS } from './cards';

/** Tonight's-slate cards plus a count strip. `sections` = useInsights() result. */
export default function SlateInsightsTab({ noSlate, sections, onRetry }) {
  if (noSlate) {
    return (
      <Card>
        <EmptyState
          title="No slate selected"
          description="Pick a slate in the top bar, or import one from the dashboard."
          action={
            <Link to="/" className="text-xs font-medium text-accent hover:underline">
              Go to the dashboard
            </Link>
          }
        />
      </Card>
    );
  }

  const cards = SLATE_CARDS.map((card) => {
    const section = sections[card.source];
    return { card, section, rows: section.status === 'error' ? [] : card.rows(section.data) };
  });
  const countFor = ({ section, rows }) => (section.status === 'ready' ? rows.length : '—');

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="Slate players" value={sections.playerCount ?? '—'} />
        {cards
          .filter((c) => c.card.kpi)
          .map((c) => (
            <Stat key={c.card.id} label={c.card.kpi} value={countFor(c)} />
          ))}
      </div>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        {cards.map(({ card, section, rows }) => (
          <InsightCard key={card.id} card={card} rows={rows} status={section.status} error={section.error} onRetry={onRetry} />
        ))}
      </div>
    </div>
  );
}
