import InsightCard from './InsightCard';
import { LEAGUE_CARDS } from './cards';

/** League-wide cards. `league` = useInsights().league (loaded once this tab opens). */
export default function LeagueTrendsTab({ league, onRetry }) {
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
      {LEAGUE_CARDS.map((card) => {
        const section = league[card.id];
        return (
          <InsightCard
            key={card.id}
            card={card}
            rows={section.data ?? []}
            status={section.status}
            error={section.error}
            onRetry={onRetry}
          />
        );
      })}
    </div>
  );
}
