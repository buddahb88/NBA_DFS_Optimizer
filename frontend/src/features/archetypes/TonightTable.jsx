import { Badge, DataTable } from '../../components/ui';
import { formatDelta, statFor } from './archetypes';

function columnsFor(stat) {
  const { unit } = statFor(stat);
  return [
    { accessorKey: 'name', header: 'Player' },
    { accessorKey: 'position', header: 'Pos' },
    { accessorKey: 'team', header: 'Tm' },
    { accessorKey: 'opponent', header: 'Opp' },
    { accessorKey: 'label', header: 'Archetype / Pos', meta: { label: 'Archetype / Pos' } },
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
      accessorKey: 'matchup_delta',
      header: `+/- ${unit}`,
      meta: { numeric: true, label: 'Matchup delta' },
      cell: ({ getValue }) => <span className="font-semibold text-info">{formatDelta(getValue(), 2)}</span>,
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
 * (or G/F/C), sortable. `data` = GET /archetypes/tonight body.
 */
export default function TonightTable({ data, stat, loading, emptyState }) {
  return (
    <DataTable
      data={data?.players ?? []}
      columns={columnsFor(stat)}
      loading={loading && !data}
      maxHeight="60vh"
      initialSorting={[{ id: 'matchup_delta', desc: true }]}
      getRowId={(p) => p.player_id}
      emptyState={emptyState}
      toolbar={
        data && (
          <span className="num text-2xs text-fg-subtle">
            {data.players.length} of {data.matchedPlayers} classified slate players ({data.slatePlayers} total) face a
            bottom-third defense for their {data.grouping === 'position' ? 'position' : 'archetype'}
          </span>
        )
      }
    />
  );
}
