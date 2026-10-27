import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Badge, Button, Card, DataTable, EmptyState, Input, Select, Stat, Tabs, Tooltip, cn } from '../../components/ui';
import { useSlate } from '../../context/SlateContext';
import { Headshot } from '../chat/blocks/PlayerCard';
import SlateModeSelect from '../slate/SlateModeSelect';
import ProjectionCell from '../slate/ProjectionCell';
import { ACTUAL_COLUMN, RESULT_COLUMN } from '../slate/backtestColumns';
import useOpportunityRadar from './useOpportunityRadar';
import {
  DEFAULT_RADAR_FILTERS,
  POSITIONS,
  RADAR_METRICS,
  RADAR_MODES,
  filterRadarRows,
  scoreBreakdown,
  scoreTone,
  validationSummary,
} from './radar';

const TONE_TEXT = { positive: 'text-positive', caution: 'text-caution', negative: 'text-negative' };

const money = (v) => (v === null || v === undefined ? '—' : `$${Number(v).toLocaleString()}`);

function PlayerCell({ row }) {
  return (
    <div className="flex min-w-[200px] max-w-[320px] items-center gap-2 py-1">
      <Headshot name={row.name} src={row.headshot} size="sm" />
      <div className="min-w-0">
        <div className="truncate font-medium text-fg">
          {row.name} <span className="text-2xs font-normal text-fg-subtle">{row.position}</span>
        </div>
        {row.reason && (
          <Tooltip content={row.reason}>
            <div tabIndex={0} className="truncate text-2xs text-fg-muted" data-testid="radar-reason">
              {row.reason}
            </div>
          </Tooltip>
        )}
      </div>
    </div>
  );
}

function MetricCell({ metric, row }) {
  const value = metric.value(row);
  const tone = metric.tone(row);
  return (
    <Tooltip content={metric.tip(row)}>
      <span tabIndex={0} className={cn('num', TONE_TEXT[tone], value === null && 'text-fg-subtle')}>
        {metric.format(value)}
      </span>
    </Tooltip>
  );
}

function columnsFor({ isBacktest, weights }) {
  const columns = [
    { id: 'player', accessorKey: 'name', header: 'Player', meta: { label: 'Player' }, cell: ({ row }) => <PlayerCell row={row.original} /> },
    {
      id: 'matchup',
      accessorFn: (p) => `${p.team} vs ${p.opponent}`,
      header: 'Matchup',
      cell: ({ row }) => (
        <span className="whitespace-nowrap">
          {row.original.team} <span className="text-fg-subtle">vs</span> {row.original.opponent}
        </span>
      ),
    },
    { accessorKey: 'salary', header: 'Salary', meta: { numeric: true }, cell: ({ getValue }) => money(getValue()) },
    {
      accessorKey: 'projected_points',
      header: 'Proj',
      meta: { numeric: true, label: 'Projection (RotoWire after the sanity layer)' },
      cell: ({ getValue, row }) => (getValue() != null ? <ProjectionCell player={row.original} /> : '—'),
    },
    {
      accessorKey: 'score',
      header: 'Score',
      meta: { numeric: true, label: 'Opportunity Score' },
      sortUndefined: 'last',
      cell: ({ row, getValue }) => (
        <Tooltip content={<div className="flex flex-col gap-0.5">{scoreBreakdown(row.original, weights).map((l) => <span key={l}>{l}</span>)}</div>}>
          <span tabIndex={0}>
            <Badge tone={scoreTone(getValue())} size="sm" className="num">
              {getValue() != null ? Number(getValue()).toFixed(1) : '—'}
            </Badge>
          </span>
        </Tooltip>
      ),
    },
    ...RADAR_METRICS.map((metric) => ({
      id: metric.id,
      accessorFn: metric.value,
      header: metric.header,
      meta: { numeric: true, label: metric.label },
      sortUndefined: 'last',
      cell: ({ row }) => <MetricCell metric={metric} row={row.original} />,
    })),
  ];
  // Actual and Result next to the score
  if (isBacktest) columns.splice(columns.findIndex((c) => c.accessorKey === 'score') + 1, 0, ACTUAL_COLUMN, RESULT_COLUMN);
  return columns;
}

function RadarFilters({ value, onChange }) {
  const set = (key) => (e) => onChange({ ...value, [key]: e.target.value });
  return (
    <div className="flex flex-wrap items-end gap-2" role="group" aria-label="Radar filters">
      <Input label="Min salary" numeric inputMode="numeric" placeholder="5500" value={value.minSalary} onChange={set('minSalary')} className="w-24" />
      <Input label="Max salary" numeric inputMode="numeric" placeholder="8500" value={value.maxSalary} onChange={set('maxSalary')} className="w-24" />
      <Select
        label="Position"
        size="sm"
        value={value.position}
        onChange={set('position')}
        options={[{ value: '', label: 'All' }, ...POSITIONS]}
        className="w-24"
      />
      <Input label="Min score" numeric inputMode="numeric" placeholder="0" value={value.minScore} onChange={set('minScore')} className="w-20" />
      <Button variant="ghost" size="sm" onClick={() => onChange(DEFAULT_RADAR_FILTERS)}>
        Clear
      </Button>
    </div>
  );
}

function Validation({ data, mode }) {
  const v = validationSummary(data?.validation?.[mode]);
  if (!v) return null;
  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-3" data-testid="radar-validation">
      <Stat label="Top decile hit 5x" value={v.top} hint="Top 10% by Opportunity Score that scored 5x salary (DNP = miss)" />
      <Stat label="Slate hit 5x" value={v.slate} />
      <Stat label="Lift" value={v.lift} />
    </div>
  );
}

/**
 * Opportunity Radar: every slate player's O1-O3 opportunity metrics scored
 * 0-100 for Cash or GPP, with a reason line and compact color-coded metric
 * cells. Follows the slate selector (Live / Backtest); a backtest adds
 * Actual / Result columns and the top-decile 5x check.
 */
export default function OpportunityRadarTab({ reloadToken = 0 }) {
  const { slate, slateId: liveSlateId, site, loadingSlates, backtest = null, workSlateId } = useSlate();
  const slateId = workSlateId ?? liveSlateId;
  const [mode, setMode] = useState('cash');
  const [filters, setFilters] = useState(DEFAULT_RADAR_FILTERS);

  const radar = useOpportunityRadar({
    // Wait for the top bar's slate list so a stored slate isn't fetched twice
    slateId: loadingSlates ? null : slateId,
    slateDate: backtest?.slateDate ?? null,
    site,
    mode,
    reloadToken,
  });
  const data = radar.data;
  const rows = useMemo(() => filterRadarRows(data?.players ?? [], filters), [data, filters]);
  const isBacktest = !!data?.isBacktest;
  const columns = useMemo(() => columnsFor({ isBacktest, weights: data?.weights ?? {} }), [isBacktest, data?.weights]);

  if (!loadingSlates && !slate && !backtest) {
    return (
      <Card>
        <EmptyState
          title="No slate selected"
          description="Pick a slate in the top bar, or switch the slate selector to a backtest night."
          action={
            <Link to="/" className="text-xs font-medium text-accent hover:underline">
              Go to the dashboard
            </Link>
          }
        />
      </Card>
    );
  }

  const modeHint = RADAR_MODES.find((m) => m.value === mode)?.hint;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <SlateModeSelect />
          <div role="group" aria-label="Score mode">
            <Tabs variant="pill" size="sm" tabs={RADAR_MODES.map(({ value, label }) => ({ value, label }))} value={mode} onChange={setMode} />
          </div>
          {modeHint && <span className="text-2xs text-fg-subtle">{modeHint}</span>}
        </div>
        <RadarFilters value={filters} onChange={setFilters} />
      </div>

      {isBacktest && (
        <p className="text-xs text-fg-muted">
          Metrics from games before {data.slateDate} only (no lookahead), pre-lock salaries and projections; Actual = points scored that night.
        </p>
      )}
      {isBacktest && <Validation data={data} mode={mode} />}

      {radar.status === 'error' ? (
        <Card>
          <EmptyState title="Couldn’t load the Opportunity Radar" description={radar.error} />
        </Card>
      ) : (
        <DataTable
          data={rows}
          columns={columns}
          loading={radar.status === 'loading' && !data}
          maxHeight="65vh"
          initialSorting={[{ id: 'score', desc: true }]}
          getRowId={(p) => String(p.id ?? p.player_key)}
          emptyState={
            <EmptyState
              compact
              title={data?.players?.length ? 'No players match the filters' : 'No slate players'}
              description={data?.players?.length ? 'Widen the salary range, position or minimum score.' : 'Load the slate’s players from the Dashboard first.'}
            />
          }
          toolbar={
            data && (
              <span className="num text-2xs text-fg-subtle">
                {rows.length} of {data.count ?? data.players.length} players · {mode === 'gpp' ? 'GPP' : 'Cash'} weighting · hover a cell for its sample
              </span>
            )
          }
        />
      )}
    </div>
  );
}
