import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Button, Card, CardBody, EmptyState, IconChart, Spinner, Stat } from '../components/ui';
import GameCard from './home/GameCard';
import SlateLoader from './home/SlateLoader';
import { ChalkPanel, InjuryFeedPanel, LeveragePanel, TopValuesPanel } from './home/DashboardPanels';
import useSlateDashboard from './home/useSlateDashboard';
import { useSlate } from '../context/SlateContext';
import { DATA_STATUS_PATH, historyHealth } from '../features/dataStatus/dataStatus';
import StaleSlateBadge from '../features/slate/StaleSlateBadge';
import { BACKTEST_DISABLED } from '../features/slate/backtest';
import {
  buildGames,
  buildInjuryFeed,
  formatRelative,
  formatTipoff,
  parseTimestamp,
  summarizeSlate,
  topChalk,
  topLeverage,
  topValuesByPosition,
} from './home/slateDashboard';

// RotoWire's slate list (siteID=1) and player import are DraftKings only
const IMPORT_SITE = 'draftkings';

function ImportUnavailable({ siteName }) {
  return (
    <p className="rounded border border-caution/30 bg-caution-soft px-3 py-2 text-xs text-caution">
      Importing from RotoWire is only available for DraftKings. Switch the site in the top bar to DraftKings to load a
      slate{siteName ? `, or import a ${siteName} salary file on the Player Pool page` : ''}.
    </p>
  );
}

const HEALTH_LINKS = { unknown: 'Check data status', missing: 'Sync game logs', stale: 'Update' };

/** Game-log freshness; links to the Data Status panel when logs are missing, stale or unreadable. */
function GameLogHealth({ historyStatus }) {
  const { state, label } = historyHealth(historyStatus);
  return (
    <div className="flex min-w-0 items-center gap-1.5 text-2xs">
      <span className={`truncate ${state === 'current' || state === 'loading' ? 'text-fg-subtle' : 'text-caution'}`}>{label}</span>
      {HEALTH_LINKS[state] && (
        <Link to={DATA_STATUS_PATH} className="shrink-0 font-medium text-accent hover:underline">
          {HEALTH_LINKS[state]}
        </Link>
      )}
    </div>
  );
}

/** Re-render periodically so "updated 5m ago" stays honest. */
function useNow(intervalMs = 60000) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

function RefreshTile({ updatedAt, historyStatus, syncing, onRefresh, now, canRefresh, blockedReason = null }) {
  return (
    <div className="col-span-2 flex items-center justify-between gap-3 rounded-md border border-line bg-surface px-3 py-2.5">
      <div className="min-w-0">
        <span className="text-2xs font-medium uppercase tracking-wider text-fg-subtle">Slate data refreshed</span>
        <div className="num text-xl font-semibold leading-tight text-fg" title={updatedAt?.toLocaleString()}>
          {formatRelative(updatedAt, now)}
        </div>
        <GameLogHealth historyStatus={historyStatus} />
      </div>
      <Button
        variant="secondary"
        size="sm"
        loading={syncing}
        disabled={!canRefresh || !!blockedReason}
        title={blockedReason ?? (canRefresh ? undefined : 'RotoWire refresh is DraftKings only')}
        onClick={onRefresh}
      >
        {syncing ? 'Refreshing…' : 'Refresh data'}
      </Button>
    </div>
  );
}

function NoSlate({ syncSlate, syncing, syncError, canImport, siteName, syncBlocked }) {
  return (
    <div className="mx-auto max-w-2xl px-4 py-16">
      <Card>
        <CardBody className="flex flex-col gap-4 p-6">
          <EmptyState
            icon={<IconChart size={18} />}
            title="No slate loaded"
            description="Import a slate from RotoWire to see tonight's games, Vegas lines, injury news, value plays and ownership."
          />
          {canImport ? (
            <SlateLoader onLoad={syncSlate} loading={syncing} error={syncError} submitLabel="Load slate" disabledReason={syncBlocked} />
          ) : (
            <ImportUnavailable siteName={siteName} />
          )}
          <p className="text-2xs text-fg-subtle">
            Game logs and sync health live on the{' '}
            <Link to={DATA_STATUS_PATH} className="font-medium text-accent hover:underline">
              Data Status
            </Link>{' '}
            page.
          </p>
        </CardBody>
      </Card>
    </div>
  );
}

export default function HomePage() {
  const { status, error, slate, players, teamStats, historyStatus, news, syncing, syncError, reload, syncSlate, refresh } =
    useSlateDashboard();
  const { site, siteConfig, isBacktest = false } = useSlate();
  const canImport = site === IMPORT_SITE;
  // Syncing would replace the live slate; off while the selector is on a backtest
  const syncBlocked = isBacktest ? BACKTEST_DISABLED : null;
  const [showLoader, setShowLoader] = useState(false);
  const now = useNow();
  const navigate = useNavigate();

  const games = useMemo(() => buildGames(players, teamStats), [players, teamStats]);
  const summary = useMemo(() => summarizeSlate(players, games), [players, games]);
  const values = useMemo(() => topValuesByPosition(players, 3), [players]);
  const leverage = useMemo(() => topLeverage(players, 8), [players]);
  const chalk = useMemo(() => topChalk(players, 8), [players]);
  const feed = useMemo(() => buildInjuryFeed(players, news.missing, news.bumps), [players, news.missing, news.bumps]);
  const blowouts = games.filter((g) => g.blowout).length;

  if (status === 'loading') {
    return (
      <div className="flex justify-center py-24">
        <Spinner size="md" label="Loading slate" />
      </div>
    );
  }

  if (status === 'error') {
    return (
      <div className="mx-auto max-w-xl px-4 py-16">
        <EmptyState
          title="Couldn't load the slate"
          description={error}
          action={
            <Button variant="primary" onClick={() => reload()}>
              Try again
            </Button>
          }
        />
      </div>
    );
  }

  if (status === 'empty') {
    return (
      <NoSlate syncSlate={syncSlate} syncing={syncing} syncError={syncError} canImport={canImport} siteName={siteConfig?.name} syncBlocked={syncBlocked} />
    );
  }

  const slateId = slate.slate_id;

  return (
    <div className="mx-auto flex max-w-[1600px] flex-col gap-4 px-4 py-4 sm:px-6">
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h2 className="truncate text-lg font-semibold text-fg">{slate.name}</h2>
          <p className="text-xs text-fg-muted">
            First lock {formatTipoff(summary.firstLock)} · slate {slateId}
          </p>
          <StaleSlateBadge slate={slate} now={now} onSync={() => setShowLoader(true)} className="mt-1.5" />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => setShowLoader((v) => !v)}>
            {showLoader ? 'Cancel' : 'Change slate'}
          </Button>
          <Button variant="secondary" size="sm" onClick={() => navigate('/players')}>
            Player pool
          </Button>
          <Button variant="primary" size="sm" onClick={() => navigate('/optimizer')}>
            Optimize
          </Button>
        </div>
      </div>

      {showLoader && (
        <Card>
          <CardBody>
            {canImport ? (
              <SlateLoader
                activeSlateId={slateId}
                loading={syncing}
                error={syncError}
                disabledReason={syncBlocked}
                submitLabel="Load slate"
                onLoad={async (s) => {
                  if (await syncSlate(s)) setShowLoader(false);
                }}
              />
            ) : (
              <ImportUnavailable siteName={siteConfig?.name} />
            )}
          </CardBody>
        </Card>
      )}

      {!showLoader && syncError && (
        <p className="rounded border border-negative/30 bg-negative-soft px-3 py-2 text-xs text-negative">Refresh failed: {syncError}</p>
      )}

      {/* KPI strip */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="Players" value={summary.playerCount} hint="with projections" />
        <Stat label="Games" value={summary.gameCount} hint={blowouts ? `${blowouts} blowout risk` : 'no blowout flags'} />
        <Stat label="Avg total" value={summary.avgTotal != null ? summary.avgTotal.toFixed(1) : '—'} hint="Vegas O/U" />
        <Stat label="First lock" value={formatTipoff(summary.firstLock)} hint={summary.firstLock?.toLocaleDateString()} />
        <RefreshTile
          updatedAt={parseTimestamp(slate.updated_at)}
          historyStatus={historyStatus}
          syncing={syncing}
          onRefresh={refresh}
          canRefresh={canImport}
          blockedReason={syncBlocked}
          now={now}
        />
      </div>

      {/* Games */}
      <section className="flex flex-col gap-2">
        <div className="flex items-baseline justify-between">
          <h3 className="text-sm font-semibold text-fg">Games</h3>
          <span className="text-2xs text-fg-subtle">Sorted by total · implied team totals right-aligned</span>
        </div>
        {games.length === 0 ? (
          <Card>
            <EmptyState compact title="No games found" description="Players on this slate have no team/opponent data." />
          </Card>
        ) : (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
            {games.map((g) => (
              <GameCard key={g.key} game={g} />
            ))}
          </div>
        )}
      </section>

      {/* Panels */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <InjuryFeedPanel items={feed} loading={news.loading} error={news.error} />
        <LeveragePanel players={leverage} />
        <ChalkPanel players={chalk} />
      </div>
      <TopValuesPanel valuesByPosition={values} />
    </div>
  );
}
