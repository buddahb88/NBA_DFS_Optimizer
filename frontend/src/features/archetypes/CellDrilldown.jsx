import { useMemo } from 'react';
import { Button, DataTable, EmptyState, Modal, Spinner, Stat } from '../../components/ui';
import { formatDelta } from './archetypes';

const delta = ({ getValue }) => formatDelta(getValue());
const toneFor = (v) => (v > 0 ? 'text-info' : v < 0 ? 'text-negative' : 'text-fg-muted');

const columns = [
  { accessorKey: 'game_date', header: 'Date' },
  { accessorKey: 'player_name', header: 'Player' },
  { accessorKey: 'team', header: 'Tm' },
  { accessorKey: 'minutes', header: 'Min', meta: { numeric: true }, cell: ({ getValue }) => Number(getValue()).toFixed(0) },
  { accessorKey: 'fp', header: 'FP', meta: { numeric: true }, cell: ({ getValue }) => Number(getValue()).toFixed(1) },
  { accessorKey: 'expected_fp', header: 'Exp', meta: { numeric: true }, cell: ({ getValue }) => Number(getValue()).toFixed(1) },
  {
    accessorKey: 'fp_over_expectation',
    header: '+/- FP',
    meta: { numeric: true },
    cell: ({ getValue }) => <span className={toneFor(getValue())}>{formatDelta(getValue())}</span>,
  },
  { accessorKey: 'pts_delta', header: 'PTS', meta: { numeric: true }, cell: delta },
  { accessorKey: 'reb_delta', header: 'REB', meta: { numeric: true }, cell: delta },
  { accessorKey: 'ast_delta', header: 'AST', meta: { numeric: true }, cell: delta },
  { accessorKey: 'fg3m_delta', header: '3PM', meta: { numeric: true }, cell: delta },
];

/** Modal listing the player-games behind one heatmap cell. */
export default function CellDrilldown({ cell, onClose, onRetry }) {
  const summary = cell?.data?.summary;
  const games = useMemo(() => cell?.data?.games ?? [], [cell]);

  return (
    <Modal
      open={Boolean(cell)}
      onClose={onClose}
      size="xl"
      title={cell ? `${cell.team} vs ${cell.label}` : ''}
      description="Every player-game behind this cell, newest first. Deltas are actual minus expected (unshrunk)."
    >
      {cell?.status === 'loading' && !cell.data ? (
        <div className="flex justify-center py-10">
          <Spinner size="md" />
        </div>
      ) : cell?.status === 'error' ? (
        <EmptyState
          compact
          title="Couldn’t load these games"
          description={cell.error}
          action={onRetry && <Button size="sm" variant="secondary" onClick={onRetry}>Retry</Button>}
        />
      ) : (
        <div className="flex flex-col gap-3">
          {summary && (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat label="Games" value={summary.games} />
              <Stat label="Player-games" value={summary.player_games} />
              <Stat label="Avg FP / expected" value={`${summary.avg_fp.toFixed(1)} / ${summary.avg_expected_fp.toFixed(1)}`} />
              <Stat label="FP over exp. (shrunk)" value={formatDelta(summary.fp_over_expectation)} />
            </div>
          )}
          <DataTable
            data={games}
            columns={columns}
            maxHeight="55vh"
            showColumnToggle={false}
            initialSorting={[{ id: 'game_date', desc: true }]}
            getRowId={(g) => `${g.game_id}|${g.player_key}`}
            emptyState={<EmptyState compact title="No games in this window" />}
          />
        </div>
      )}
    </Modal>
  );
}
