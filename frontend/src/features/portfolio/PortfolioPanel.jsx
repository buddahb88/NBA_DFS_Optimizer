import { useEffect, useMemo, useState } from 'react';
import { exportAPI } from '../../services/api';
import { Badge, Button, Card, DataTable, EmptyState, IconChart, Stat, Tabs, cn } from '../../components/ui';
import { downloadText, formatSalary } from '../lineupStudio/lineupMath';
import { LeverageChart, ScoreHistogram } from './charts';
import {
  PORTFOLIO_SITE,
  STAGE_LABELS,
  dupeRisk,
  histogramRows,
  leverageChartRows,
  lineupNames,
  lineupRows,
  money,
  pct,
  signedPct,
  toExportLineups,
} from './portfolioMath';

const errorMessage = (err) => err.response?.data?.error || err.response?.data?.message || err.message;
const STAGE_ORDER = ['loading', 'simulate', 'pool', 'field', 'contest', 'optimal', 'select'];
const PROGRESS_CENTERED = 'flex min-h-[320px] items-center justify-center';

function useElapsed(since, running) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return undefined;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [running]);
  return since ? Math.max(0, Math.round(((running ? now : Date.now()) - since) / 1000)) : 0;
}

const duration = (s) => (s >= 60 ? `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s` : `${s}s`);

function JobProgress({ state, onCancel }) {
  const elapsed = useElapsed(state.startedAt, true);
  const progress = Math.round((state.progress || 0) * 100);
  const current = STAGE_ORDER.indexOf(state.stage);
  return (
    <Card className={PROGRESS_CENTERED}>
      <div className="flex w-full max-w-md flex-col gap-3 p-6" role="status" aria-live="polite">
        <div className="flex items-baseline justify-between gap-2">
          <h3 className="text-sm font-semibold text-fg">{STAGE_LABELS[state.stage] || state.message || 'Working'}…</h3>
          <span className="num text-xs text-fg-muted">
            {progress}% · {duration(elapsed)}
          </span>
        </div>
        <div
          className="h-2 overflow-hidden rounded-full bg-surface-sunken"
          role="progressbar"
          aria-label="Portfolio build progress"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={progress}
        >
          <div className="h-full rounded-full bg-accent transition-[width] duration-500" style={{ width: `${Math.max(2, progress)}%` }} />
        </div>
        <ol className="grid grid-cols-1 gap-1 text-xs sm:grid-cols-2">
          {STAGE_ORDER.map((s, i) => (
            <li
              key={s}
              className={cn(
                'flex items-center gap-1.5',
                i < current ? 'text-fg-muted' : i === current ? 'font-medium text-fg' : 'text-fg-subtle',
              )}
            >
              <span
                className={cn('h-1.5 w-1.5 rounded-full', i < current ? 'bg-positive' : i === current ? 'bg-accent' : 'bg-line-strong')}
                aria-hidden="true"
              />
              {STAGE_LABELS[s]}
            </li>
          ))}
        </ol>
        {state.status === 'queued' && <p className="text-xs text-fg-subtle">Waiting for another build to finish…</p>}
        <div>
          <Button size="sm" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </div>
    </Card>
  );
}

const SelectBox = ({ checked, indeterminate, onChange, label }) => (
  <input
    type="checkbox"
    className="h-3.5 w-3.5 cursor-pointer accent-[rgb(var(--accent))]"
    checked={checked}
    ref={(el) => el && (el.indeterminate = !!indeterminate)}
    onChange={onChange}
    onClick={(e) => e.stopPropagation()}
    aria-label={label}
  />
);

const TONE_TEXT = { positive: 'text-positive', negative: 'text-negative', caution: 'text-caution' };

function Results({ state, slateId, onNotice, onNewBuild }) {
  const { result } = state;
  const rows = useMemo(() => lineupRows(result), [result]);
  const dist = result.portfolio.scoreDistribution;
  const [selected, setSelected] = useState(() => new Set(rows.map((r) => r.key)));
  const [focusKey, setFocusKey] = useState(null);
  const [leverageMode, setLeverageMode] = useState('over');
  const [exporting, setExporting] = useState(false);
  const metrics = result.portfolio.metrics;
  const entryFee = result.contest.entryFee;

  const allSelected = selected.size === rows.length;
  const toggle = (key) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const lineupColumns = useMemo(
    () => [
      {
        id: 'select',
        enableSorting: false,
        size: 32,
        header: () => (
          <SelectBox
            checked={allSelected}
            indeterminate={selected.size > 0 && !allSelected}
            onChange={() => setSelected(allSelected ? new Set() : new Set(rows.map((r) => r.key)))}
            label="Select all lineups"
          />
        ),
        cell: ({ row }) => (
          <SelectBox checked={selected.has(row.original.key)} onChange={() => toggle(row.original.key)} label={`Select lineup ${row.original.number}`} />
        ),
        meta: { label: 'Select' },
      },
      { accessorKey: 'number', header: '#', size: 40, meta: { numeric: true } },
      {
        id: 'players',
        header: 'Players',
        accessorFn: (r) => lineupNames(r.players),
        enableSorting: false,
        cell: ({ getValue }) => (
          <span className="block max-w-[22rem] truncate text-fg-muted" title={getValue()}>
            {getValue()}
          </span>
        ),
      },
      { accessorKey: 'roi', header: 'ROI', meta: { numeric: true }, cell: ({ getValue }) => <span className={getValue() >= 0 ? 'text-positive' : 'text-negative'}>{signedPct(getValue())}</span> },
      { accessorKey: 'winRate', header: 'Win %', meta: { numeric: true }, cell: ({ getValue }) => pct(getValue(), 2) },
      { accessorKey: 'top1Rate', header: 'Top 1%', meta: { numeric: true }, cell: ({ getValue }) => pct(getValue()) },
      { accessorKey: 'cashRate', header: 'Cash %', meta: { numeric: true }, cell: ({ getValue }) => pct(getValue()) },
      {
        accessorKey: 'dupes',
        header: 'Dupe risk',
        meta: { numeric: true },
        cell: ({ getValue }) => {
          const risk = dupeRisk(getValue());
          return (
            <span title={`≈${getValue()} expected duplicate entries`}>
              <span className={cn('mr-1.5 text-2xs font-medium uppercase', TONE_TEXT[risk.tone])}>{risk.label}</span>
              {getValue().toFixed(1)}
            </span>
          );
        },
      },
      { accessorKey: 'totalOwnership', header: 'Own Σ', meta: { numeric: true }, cell: ({ getValue }) => `${getValue().toFixed(0)}%` },
      { accessorKey: 'meanScore', header: 'Sim avg', meta: { numeric: true }, cell: ({ getValue }) => getValue().toFixed(1) },
      { accessorKey: 'projection', header: 'Proj', meta: { numeric: true }, cell: ({ getValue }) => getValue().toFixed(1) },
      { accessorKey: 'salary', header: 'Salary', meta: { numeric: true }, cell: ({ getValue }) => formatSalary(getValue()) },
    ],
    [rows, selected, allSelected],
  );

  const playerColumns = useMemo(
    () => [
      { accessorKey: 'name', header: 'Player', cell: ({ row }) => <span className="font-medium">{row.original.name}</span> },
      { accessorKey: 'team', header: 'Team', size: 56 },
      { accessorKey: 'position', header: 'Pos', size: 64 },
      { accessorKey: 'salary', header: 'Salary', meta: { numeric: true }, cell: ({ getValue }) => formatSalary(getValue()) },
      { accessorKey: 'projected_points', header: 'Proj', meta: { numeric: true }, cell: ({ getValue }) => getValue().toFixed(1) },
      { accessorKey: 'optimalRate', header: 'Optimal %', meta: { numeric: true }, cell: ({ getValue }) => `${getValue().toFixed(1)}%` },
      { accessorKey: 'ownership', header: 'Own %', meta: { numeric: true }, cell: ({ getValue }) => `${getValue().toFixed(1)}%` },
      {
        accessorKey: 'leverage',
        header: 'Leverage',
        meta: { numeric: true },
        cell: ({ getValue }) => (
          <span className={getValue() > 0 ? 'text-positive' : getValue() < 0 ? 'text-negative' : 'text-fg-muted'}>
            {getValue() > 0 ? '+' : ''}
            {getValue().toFixed(1)}
          </span>
        ),
      },
      { accessorKey: 'portfolioExposure', header: 'Portfolio %', meta: { numeric: true }, cell: ({ getValue }) => `${getValue().toFixed(0)}%` },
    ],
    [],
  );

  const focus = rows.find((r) => r.key === focusKey) || null;
  const included = useMemo(() => new Set(rows.filter((r) => selected.has(r.key)).map((r) => r.distIndex)), [rows, selected]);
  const histRows = useMemo(
    () => histogramRows(dist, focus ? focus.distIndex : null, included.size ? included : null),
    [dist, focus, included],
  );
  const leverageRows = useMemo(() => leverageChartRows(result.players, leverageMode), [result.players, leverageMode]);
  const exportRows = rows.filter((r) => selected.has(r.key));

  const exportPortfolio = async () => {
    setExporting(true);
    try {
      const res = await exportAPI.lineups({ site: PORTFOLIO_SITE, slateId, lineups: toExportLineups(exportRows) });
      downloadText(res.data.filename, res.data.csv);
      const warnings = res.data.warnings || [];
      onNotice({
        tone: warnings.length ? 'caution' : 'positive',
        text: `Exported ${res.data.count} portfolio lineup${res.data.count === 1 ? '' : 's'} for DraftKings upload.`,
        details: warnings,
      });
    } catch (err) {
      onNotice({ tone: 'negative', text: `Export failed: ${errorMessage(err)}`, details: err.response?.data?.details });
    } finally {
      setExporting(false);
    }
  };

  const s = result.settings;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-fg-muted">
          {result.contest.label} · {result.contest.contestSize.toLocaleString()} entries · {money(entryFee)} ·{' '}
          {s.numLineups} of {result.pool.size.toLocaleString()} candidates · {s.iterations.toLocaleString()} sims
          {result.timings?.totalMs != null && ` · ${duration(Math.round(result.timings.totalMs / 1000))}`}
        </p>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="ghost" onClick={onNewBuild}>
            New build
          </Button>
          <Button size="sm" variant="primary" onClick={exportPortfolio} loading={exporting} disabled={exportRows.length === 0}>
            Export {exportRows.length} for DraftKings
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 md:grid-cols-5">
        <Stat
          label="Portfolio ROI"
          value={signedPct(metrics.roi)}
          delta={metrics.expectedProfit}
          deltaLabel=" expected profit"
          hint={`on ${money(metrics.totalFees)} in fees`}
        />
        <Stat label="Any lineup cashes" value={pct(metrics.anyCashRate)} />
        <Stat label="Any top 1%" value={pct(metrics.anyTop1Rate)} />
        <Stat label="Any win" value={pct(metrics.anyWinRate, 2)} />
        <Stat label="Profitable sims" value={pct(metrics.profitableRate)} hint={`± ${money(metrics.payoutStdev)} payout sd`} />
      </div>

      {result.portfolio.warnings?.length > 0 && (
        <div role="status" className="rounded-md border border-caution/40 bg-caution-soft px-3 py-2 text-sm text-caution">
          {result.portfolio.warnings.join(' ')}
        </div>
      )}

      <DataTable
        data={rows}
        columns={lineupColumns}
        getRowId={(r) => r.key}
        initialSorting={[{ id: 'roi', desc: true }]}
        maxHeight="420px"
        onRowClick={(r) => setFocusKey((k) => (k === r.key ? null : r.key))}
        rowClassName={(r) => cn(r.key === focusKey && 'bg-accent-soft/60 hover:bg-accent-soft/60', !selected.has(r.key) && 'opacity-60')}
        toolbar={
          <span className="text-xs text-fg-muted">
            Portfolio lineups · {selected.size} of {rows.length} selected for export · click a row to inspect it
          </span>
        }
      />

      {focus && (
        <Card className="p-3">
          <div className="mb-2 flex items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-fg">Lineup #{focus.number}</h3>
            <span className="num text-xs text-fg-muted">
              {formatSalary(focus.salary)} · {focus.projection.toFixed(1)} proj · {focus.totalOwnership.toFixed(0)}% own
            </span>
          </div>
          <ul className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-4">
            {focus.players.map((slot) => (
              <li key={slot.position} className="flex items-center gap-2">
                <Badge size="sm" className="w-10 justify-center">
                  {slot.position}
                </Badge>
                <span className="truncate text-fg">{slot.player.name}</span>
                <span className="num ml-auto text-fg-subtle">{slot.player.rostership.toFixed(0)}%</span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
        <Card className="p-3">
          <div className="mb-2">
            <h3 className="text-sm font-semibold text-fg">Simulated score distribution</h3>
            <p className="text-xs text-fg-muted">
              Share of sims in each score range across the {included.size || rows.length} selected lineups
              {focus ? `, with lineup #${focus.number} overlaid` : '. Click a lineup to overlay it'}.
            </p>
          </div>
          {histRows.length ? (
            <ScoreHistogram
              rows={histRows}
              focusLabel={focus ? `Lineup #${focus.number}` : undefined}
              focusMedian={focus ? dist.lineups[focus.distIndex]?.p50 : undefined}
            />
          ) : (
            <EmptyState compact title="No score distribution" description="Re-run the build to include score distributions." />
          )}
        </Card>

        <Card className="p-3">
          <div className="mb-2 flex flex-wrap items-start justify-between gap-2">
            <div>
              <h3 className="text-sm font-semibold text-fg">Optimal % vs ownership</h3>
              <p className="text-xs text-fg-muted">How often a player is in the sim-optimal lineup vs how often the field rosters them.</p>
            </div>
            <Tabs
              variant="pill"
              size="sm"
              value={leverageMode}
              onChange={setLeverageMode}
              tabs={[
                { value: 'over', label: 'Underowned' },
                { value: 'under', label: 'Overowned' },
              ]}
            />
          </div>
          {leverageRows.length ? (
            <LeverageChart rows={leverageRows} />
          ) : (
            <EmptyState compact title="No players on this side" description="Optimal rates need optimal iterations > 0." />
          )}
        </Card>
      </div>

      <DataTable
        data={result.players}
        columns={playerColumns}
        getRowId={(p) => String(p.id)}
        initialSorting={[{ id: 'leverage', desc: true }]}
        maxHeight="420px"
        toolbar={<span className="text-xs text-fg-muted">Player leverage · {result.players.length} players</span>}
      />
    </div>
  );
}

/**
 * Portfolio tab of the Lineup Studio: progress while a build runs, then results.
 * `job` comes from usePortfolioJob() owned by the page so it survives tab switches.
 */
export default function PortfolioPanel({ job, slateId, site, onNewBuild, onNotice }) {
  const { state } = job;

  if (state.status === 'idle') {
    return (
      <Card className={PROGRESS_CENTERED}>
        <EmptyState
          icon={<IconChart size={18} />}
          title="No portfolio yet"
          description={
            site === PORTFOLIO_SITE
              ? 'Simulate a GPP contest to rank candidate lineups by ROI and pick the best set of entries.'
              : 'Portfolio simulation supports DraftKings slates only. Switch site in the top bar.'
          }
          action={
            site === PORTFOLIO_SITE && (
              <Button variant="primary" size="sm" onClick={onNewBuild}>
                Simulate & build portfolio
              </Button>
            )
          }
        />
      </Card>
    );
  }

  if (job.running) return <JobProgress state={state} onCancel={job.cancel} />;

  if (state.status !== 'completed' || !state.result) {
    const cancelled = state.status === 'cancelled';
    return (
      <Card className={cn('p-4', !cancelled && 'border-negative/50')}>
        <h3 className={cn('text-sm font-semibold', cancelled ? 'text-fg' : 'text-negative')}>
          {cancelled ? 'Build cancelled' : 'Portfolio build failed'}
        </h3>
        {!cancelled && <p className="mt-1 text-sm text-fg">{state.error}</p>}
        <div className="mt-3 flex gap-2">
          {state.request && (
            <Button size="sm" onClick={() => job.start(state.request)}>
              {cancelled ? 'Run again' : 'Try again'}
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={onNewBuild}>
            Change settings
          </Button>
        </div>
      </Card>
    );
  }

  return <Results key={state.jobId} state={state} slateId={slateId} onNotice={onNotice} onNewBuild={onNewBuild} />;
}
