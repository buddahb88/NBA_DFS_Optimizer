import { useState } from 'react';
import { Badge, DataTable, Tabs, Tooltip } from '../../components/ui';
import { TONIGHT_SORTS, edgeBadges, edgeExplanation, formatDelta, statFor, tonightSorting } from './archetypes';

function columnsFor(stat, edgeConfig) {
  const { unit } = statFor(stat);
  return [
    { accessorKey: 'name', header: 'Player' },
    { accessorKey: 'position', header: 'Pos' },
    { accessorKey: 'team', header: 'Tm' },
    { accessorKey: 'opponent', header: 'Opp' },
    { accessorKey: 'label', header: 'Archetype / Pos', meta: { label: 'Archetype / Pos' } },
    {
      id: 'flags',
      header: 'Flags',
      enableSorting: false,
      cell: ({ row }) => (
        <span className="inline-flex flex-wrap gap-1">
          {edgeBadges(row.original, edgeConfig).map((b) => (
            <Tooltip key={b.key} content={b.tip}>
              <span tabIndex={0}>
                <Badge tone={b.tone} size="sm">{b.label}</Badge>
              </span>
            </Tooltip>
          ))}
        </span>
      ),
    },
    {
      accessorKey: 'salary',
      header: 'Salary',
      meta: { numeric: true },
      cell: ({ getValue }) => (getValue() != null ? `$${Number(getValue()).toLocaleString()}` : '—'),
    },
    {
      accessorKey: 'projected_points',
      header: 'Proj',
      meta: { numeric: true },
      cell: ({ getValue }) => (getValue() != null ? Number(getValue()).toFixed(1) : '—'),
    },
    {
      accessorKey: 'projected_minutes',
      header: 'Min',
      meta: { numeric: true, label: 'Projected minutes' },
      cell: ({ getValue }) => (getValue() != null ? Number(getValue()).toFixed(0) : '—'),
    },
    {
      id: 'minutes_change',
      accessorFn: (p) => p.minutes?.change ?? null,
      header: '+/- Min',
      meta: { numeric: true, label: 'Minutes vs last season' },
      sortUndefined: 'last',
      cell: ({ getValue }) => {
        const v = getValue();
        if (v == null) return '—';
        return <span className={v <= -4 ? 'text-negative' : v >= 4 ? 'text-positive' : undefined}>{formatDelta(v)}</span>;
      },
    },
    {
      accessorKey: 'adjusted_edge',
      header: `Edge ${unit}`,
      meta: { numeric: true, label: 'Adjusted edge' },
      cell: ({ row, getValue }) => (
        <Tooltip content={edgeExplanation(row.original)}>
          <span className="font-semibold text-info">{formatDelta(getValue(), 2)}</span>
        </Tooltip>
      ),
    },
    {
      accessorKey: 'matchup_delta',
      header: `+/- ${unit}`,
      meta: { numeric: true, label: 'Matchup delta' },
      cell: ({ getValue }) => formatDelta(getValue(), 2),
    },
    {
      accessorKey: 'rank',
      header: 'Opp rank',
      meta: { numeric: true },
      cell: ({ row }) => `${row.original.rank} / ${row.original.teams}`,
    },
    {
      accessorKey: 'injury_status',
      header: 'Status',
      cell: ({ getValue }) => (getValue() ? <Badge tone="caution" size="sm">{getValue()}</Badge> : null),
    },
  ];
}

/**
 * Tonight's slate players facing a weak-tier defense for their archetype
 * (or G/F/C), sortable. Sorted by adjusted edge (matchup x minutes
 * confidence x crowding) by default, raw matchup delta on the toggle.
 * `data` = GET /archetypes/tonight body.
 */
export default function TonightTable({ data, stat, loading, emptyState }) {
  const [sort, setSort] = useState('adjusted');
  return (
    <DataTable
      // Remount so the toggle resets the table's own sorting
      key={sort}
      data={data?.players ?? []}
      columns={columnsFor(stat, data?.edgeConfig)}
      loading={loading && !data}
      maxHeight="60vh"
      initialSorting={tonightSorting(sort)}
      getRowId={(p) => p.player_id}
      emptyState={emptyState}
      toolbar={
        data && (
          <>
            <Tabs variant="pill" size="sm" tabs={TONIGHT_SORTS} value={sort} onChange={setSort} />
            <span className="num text-2xs text-fg-subtle">
              {data.players.length} of {data.matchedPlayers} classified slate players ({data.slatePlayers} total) face a
              bottom-third defense for their {data.grouping === 'position' ? 'position' : 'archetype'}
            </span>
          </>
        )
      }
    />
  );
}
