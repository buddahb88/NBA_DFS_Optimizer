import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Button, Card, EmptyState, IconChart, Tabs } from '../../components/ui';
import { useSlate } from '../../context/SlateContext';
import InsightsFilters from './InsightsFilters';
import LeagueTrendsTab from './LeagueTrendsTab';
import SlateInsightsTab from './SlateInsightsTab';
import useInsights from './useInsights';
import { DEFAULT_WINDOW, hasHistory } from './insights';

// Sync controls live here until the Data Status panel replaces this route
export const DATA_STATUS_PATH = '/data-status';

const TABS = [
  { value: 'slate', label: 'Tonight’s slate' },
  { value: 'league', label: 'League trends' },
];

function SummaryLine({ summary }) {
  if (summary.status === 'error') {
    return <p className="text-xs text-negative">Couldn’t load the historical summary: {summary.error}</p>;
  }
  const s = summary.data;
  if (!s) return <p className="text-xs text-fg-muted">Historical game logs</p>;
  return (
    <p className="num text-xs text-fg-muted">
      {(s.totalGames ?? 0).toLocaleString()} games · {(s.uniquePlayers ?? 0).toLocaleString()} players
      {s.dateRange?.earliest && ` · ${s.dateRange.earliest} to ${s.dateRange.latest}`}
    </p>
  );
}

function NoHistory() {
  return (
    <Card>
      <EmptyState
        icon={<IconChart size={18} />}
        title="No historical game logs"
        description="Insights are built from historical box scores. Sync game logs to see streaks, matchups and usage bumps."
        action={
          <Link to={DATA_STATUS_PATH} className="text-xs font-medium text-accent hover:underline">
            Open data status &amp; sync
          </Link>
        }
      />
    </Card>
  );
}

export default function InsightsPage() {
  const { slate, slateId, site, siteConfig, loadingSlates } = useSlate();
  const [dateWindow, setDateWindow] = useState(DEFAULT_WINDOW);
  const [tab, setTab] = useState('slate');
  // League trends load the first time their tab opens, then stay cached
  const [leagueOpened, setLeagueOpened] = useState(false);

  const insights = useInsights({
    // Wait for the top bar's slate list so a stored slate isn't fetched twice
    slateId: loadingSlates ? null : slateId,
    site,
    dateWindow,
    leagueEnabled: leagueOpened,
  });
  const { summary, league, reload } = insights;

  const selectTab = (next) => {
    setTab(next);
    if (next === 'league') setLeagueOpened(true);
  };

  return (
    <div className="mx-auto flex max-w-[1600px] flex-col gap-4 px-4 py-4 sm:px-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h2 className="truncate text-lg font-semibold text-fg">Insights</h2>
          <SummaryLine summary={summary} />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Link to={DATA_STATUS_PATH} className="text-xs font-medium text-fg-muted hover:text-fg hover:underline">
            Data status &amp; sync
          </Link>
          <Button variant="secondary" size="sm" onClick={reload}>
            Refresh
          </Button>
        </div>
      </div>

      <InsightsFilters value={dateWindow} onChange={setDateWindow} siteName={siteConfig?.name} range={summary.data?.dateRange} />

      <Tabs tabs={TABS} value={tab} onChange={selectTab} />

      {summary.status === 'ready' && !hasHistory(summary.data) ? (
        <NoHistory />
      ) : tab === 'slate' ? (
        <SlateInsightsTab noSlate={!loadingSlates && !slate} sections={insights} onRetry={reload} />
      ) : (
        <LeagueTrendsTab league={league} onRetry={reload} />
      )}
    </div>
  );
}
