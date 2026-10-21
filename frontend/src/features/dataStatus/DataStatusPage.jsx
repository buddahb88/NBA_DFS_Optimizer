import { useMemo } from 'react';
import { Badge, Button, Card, CardBody, CardHeader, DataTable, EmptyState, IconX, Spinner, Stat } from '../../components/ui';
import useDataStatus from './useDataStatus';
import {
  RUN_LABELS,
  RUN_TONES,
  dateRange,
  daysSince,
  formatTimestamp,
  runDuration,
  runStatus,
  sourceLabel,
} from './dataStatus';

const NOTICE_TONES = {
  positive: 'border-positive/30 bg-positive-soft text-positive',
  negative: 'border-negative/30 bg-negative-soft text-negative',
  info: 'border-info/30 bg-info-soft text-info',
};

const fmt = (n) => (n ?? 0).toLocaleString();

function SectionError({ label, error }) {
  return (
    <p role="alert" className="rounded border border-negative/30 bg-negative-soft px-3 py-2 text-xs text-negative">
      Couldn’t load {label}: {error}
    </p>
  );
}

function RunStatusBadge({ run }) {
  const status = runStatus(run);
  return (
    <Badge tone={RUN_TONES[status]} size="sm" dot>
      {RUN_LABELS[status]}
    </Badge>
  );
}

function SyncBanner({ syncing, progress, notice, onDismiss }) {
  if (syncing) {
    return (
      <div className="flex items-center gap-3 rounded border border-info/30 bg-info-soft px-3 py-2 text-xs text-info" role="status">
        <Spinner size="xs" className="text-current" />
        <span>{progress?.message || 'Sync running…'}</span>
      </div>
    );
  }
  if (!notice) return null;
  return (
    <div
      role={notice.tone === 'negative' ? 'alert' : 'status'}
      className={`flex items-start justify-between gap-3 rounded border px-3 py-2 text-xs ${NOTICE_TONES[notice.tone]}`}
    >
      <span className="break-words">{notice.text}</span>
      <button type="button" aria-label="Dismiss" className="shrink-0 opacity-70 hover:opacity-100" onClick={onDismiss}>
        <IconX size={12} />
      </button>
    </div>
  );
}

function CoverageCard({ coverage, busy, pending, onBackfill }) {
  const columns = useMemo(
    () => [
      {
        id: 'season',
        header: 'Season',
        accessorFn: (r) => r.season ?? 'Unknown',
        cell: ({ row }) => (
          <span className="flex items-center gap-1.5">
            {row.original.season ?? 'Unknown season'}
            {row.original.current && <Badge tone="accent" size="sm">Current</Badge>}
            {row.original.playerGames === 0 && <Badge tone="caution" size="sm">No games</Badge>}
          </span>
        ),
      },
      { accessorKey: 'games', header: 'Games', meta: { numeric: true }, cell: ({ getValue }) => fmt(getValue()) },
      { accessorKey: 'playerGames', header: 'Player games', meta: { numeric: true }, cell: ({ getValue }) => fmt(getValue()) },
      { accessorKey: 'players', header: 'Players', meta: { numeric: true }, cell: ({ getValue }) => fmt(getValue()) },
      {
        id: 'range',
        header: 'Date range',
        enableSorting: false,
        cell: ({ row }) => <span className="num">{dateRange(row.original.earliestGame, row.original.latestGame)}</span>,
      },
      {
        id: 'backfill',
        header: '',
        enableSorting: false,
        meta: { align: 'right' },
        cell: ({ row }) =>
          row.original.season && (
            <Button
              size="xs"
              variant="ghost"
              loading={pending === row.original.season}
              disabled={busy}
              title={`Walk every ${row.original.season} date on ESPN and load any missing games`}
              onClick={() => onBackfill(row.original.season)}
            >
              Backfill {row.original.season}
            </Button>
          ),
      },
    ],
    [busy, pending, onBackfill],
  );

  return (
    <Card>
      <CardHeader title="Game logs by season" subtitle="historical_games · ESPN box scores" />
      <CardBody className="flex flex-col gap-2">
        {coverage.error ? (
          <SectionError label="game log coverage" error={coverage.error} />
        ) : (
          <DataTable data={coverage.seasons} columns={columns} showColumnToggle={false} getRowId={(r) => r.season ?? 'unknown'} />
        )}
      </CardBody>
    </Card>
  );
}

function RunSummary({ label, run, empty }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5 rounded border border-line px-3 py-2">
      <span className="text-2xs font-medium uppercase tracking-wider text-fg-subtle">{label}</span>
      {run ? (
        <>
          <span className="flex items-center gap-1.5 text-xs text-fg">
            {formatTimestamp(run.finished_at || run.started_at)} <RunStatusBadge run={run} />
          </span>
          <span className="truncate text-2xs text-fg-muted" title={run.error || undefined}>
            {sourceLabel(run.source)}
            {run.season ? ` · ${run.season}` : ''} · {fmt(run.games_inserted)} games
            {run.error ? ` · ${run.error}` : ''}
          </span>
        </>
      ) : (
        <span className="text-xs text-fg-muted">{empty}</span>
      )}
    </div>
  );
}

function SyncHistoryCard({ sync }) {
  const columns = useMemo(
    () => [
      { accessorKey: 'id', header: 'Run', meta: { numeric: true }, cell: ({ getValue }) => `#${getValue()}` },
      { accessorKey: 'source', header: 'Source', cell: ({ getValue }) => sourceLabel(getValue()) },
      { accessorKey: 'season', header: 'Season', cell: ({ getValue }) => getValue() || '—' },
      { accessorKey: 'started_at', header: 'Started', cell: ({ getValue }) => formatTimestamp(getValue()) },
      { id: 'duration', header: 'Duration', enableSorting: false, meta: { numeric: true }, cell: ({ row }) => runDuration(row.original) },
      { accessorKey: 'games_inserted', header: 'Games', meta: { numeric: true }, cell: ({ getValue }) => fmt(getValue()) },
      { id: 'status', header: 'Status', enableSorting: false, cell: ({ row }) => <RunStatusBadge run={row.original} /> },
      {
        accessorKey: 'error',
        header: 'Error',
        enableSorting: false,
        meta: { className: 'max-w-[28rem]' },
        cell: ({ getValue }) =>
          getValue() ? (
            <span className="block truncate text-negative" title={getValue()}>
              {getValue()}
            </span>
          ) : (
            '—'
          ),
      },
    ],
    [],
  );

  return (
    <Card>
      <CardHeader title="Sync history" subtitle="sync_runs · manual and scheduled syncs" />
      <CardBody className="flex flex-col gap-3">
        {sync.error ? (
          <SectionError label="sync history" error={sync.error} />
        ) : (
          <>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              <RunSummary label="Last run" run={sync.lastRun} empty="No syncs recorded yet" />
              <RunSummary label="Last success" run={sync.lastSuccess} empty="No successful sync yet" />
              <RunSummary label="Last error" run={sync.lastError} empty="No failed syncs" />
            </div>
            <DataTable
              data={sync.recentRuns}
              columns={columns}
              showColumnToggle={false}
              getRowId={(r) => String(r.id)}
              emptyState={<EmptyState compact title="No sync runs" description="Run “Sync now” to load game logs from ESPN." />}
            />
          </>
        )}
      </CardBody>
    </Card>
  );
}

function SnapshotsCard({ snapshots }) {
  const columns = useMemo(
    () => [
      { accessorKey: 'site', header: 'Site' },
      { accessorKey: 'rows', header: 'Player rows', meta: { numeric: true }, cell: ({ getValue }) => fmt(getValue()) },
      { accessorKey: 'slates', header: 'Slates', meta: { numeric: true }, cell: ({ getValue }) => fmt(getValue()) },
      { accessorKey: 'gameDates', header: 'Game dates', meta: { numeric: true }, cell: ({ getValue }) => fmt(getValue()) },
      { accessorKey: 'latestGameDate', header: 'Latest', cell: ({ getValue }) => <span className="num">{getValue() || '—'}</span> },
    ],
    [],
  );

  return (
    <Card>
      <CardHeader title="Slate snapshots" subtitle="slate_player_snapshots · salary, projection and ownership history" />
      <CardBody className="flex flex-col gap-3">
        {snapshots.error ? (
          <SectionError label="snapshot coverage" error={snapshots.error} />
        ) : snapshots.rows === 0 ? (
          <EmptyState compact title="No snapshots yet" description="Snapshots are captured each time a slate is synced or a salary file is imported." />
        ) : (
          <>
            <p className="num text-xs text-fg-muted">
              {fmt(snapshots.rows)} player rows · {fmt(snapshots.slates)} slates · {fmt(snapshots.players)} players ·{' '}
              {dateRange(snapshots.earliestGameDate, snapshots.latestGameDate)} · last captured {formatTimestamp(snapshots.lastCapturedAt)}
            </p>
            <DataTable data={snapshots.bySite} columns={columns} showColumnToggle={false} getRowId={(r) => r.site} />
          </>
        )}
      </CardBody>
    </Card>
  );
}

export default function DataStatusPage() {
  const { report, syncing, progress, notice, pending, reload, syncNow, backfill, dismissNotice } = useDataStatus();
  const data = report.data;
  const busy = syncing || pending !== null;
  const totals = data?.coverage?.totals;
  const age = daysSince(totals?.latestGame);

  return (
    <div className="mx-auto flex max-w-[1600px] flex-col gap-4 px-4 py-4 sm:px-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h2 className="truncate text-lg font-semibold text-fg">Data Status</h2>
          <p className="text-xs text-fg-muted">Historical game logs, sync history and slate snapshots</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="secondary" size="sm" onClick={reload} disabled={report.status === 'loading'}>
            Refresh
          </Button>
          <Button
            variant="primary"
            size="sm"
            loading={pending === 'sync' || syncing}
            disabled={busy}
            title="Load every completed game from the latest stored game date through yesterday (ESPN)"
            onClick={syncNow}
          >
            {syncing ? 'Syncing…' : 'Sync now'}
          </Button>
        </div>
      </div>

      <SyncBanner syncing={syncing} progress={progress} notice={notice} onDismiss={dismissNotice} />

      {report.status === 'error' ? (
        <Card>
          <EmptyState
            title="Couldn’t load data status"
            description={report.error}
            action={
              <Button variant="primary" size="sm" onClick={reload}>
                Try again
              </Button>
            }
          />
        </Card>
      ) : !data ? (
        <div className="flex justify-center py-16">
          <Spinner size="md" label="Loading data status" />
        </div>
      ) : (
        <>
          {totals && (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Stat label="Games" value={fmt(totals.games)} hint="ESPN box scores" />
              <Stat label="Player games" value={fmt(totals.playerGames)} hint="historical_games rows" />
              <Stat label="Players" value={fmt(totals.players)} />
              <Stat
                label="Latest game"
                value={totals.latestGame || '—'}
                hint={age == null ? 'no games loaded' : age <= 1 ? 'up to date' : `${age} days ago`}
              />
            </div>
          )}
          <CoverageCard coverage={data.coverage} busy={busy} pending={pending} onBackfill={backfill} />
          <SyncHistoryCard sync={data.sync} />
          <SnapshotsCard snapshots={data.snapshots} />
        </>
      )}
    </div>
  );
}
