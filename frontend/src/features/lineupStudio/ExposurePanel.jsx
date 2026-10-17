import { useMemo, useState } from 'react';
import { DataTable, EmptyState, Tabs, cn } from '../../components/ui';
import { computeExposure, formatSalary } from './lineupMath';

function ExposureBar({ value, limit }) {
  const over = limit != null && value > limit + 1e-9;
  return (
    <div className="flex items-center justify-end gap-2">
      <div className="h-1.5 w-20 rounded-full bg-surface-sunken" aria-hidden="true">
        <div className={cn('h-1.5 rounded-full', over ? 'bg-caution' : 'bg-accent')} style={{ width: `${Math.min(100, value)}%` }} />
      </div>
      <span className={cn('num w-11 text-right', over && 'text-caution')}>{value.toFixed(1)}%</span>
    </div>
  );
}

/** Exposure summary per player and per team for a set of lineups ([{ slot, player }][]). */
export default function ExposurePanel({ lineups, maxExposure }) {
  const [view, setView] = useState('players');
  const { players, teams } = useMemo(() => computeExposure(lineups), [lineups]);
  const limit = lineups.length > 1 ? maxExposure : null;

  const playerColumns = useMemo(
    () => [
      { id: 'name', header: 'Player', accessorFn: (r) => r.player.name, meta: { className: 'font-medium' } },
      { id: 'pos', header: 'Pos', accessorFn: (r) => r.player.position, size: 70 },
      { id: 'team', header: 'Team', accessorFn: (r) => r.player.team, size: 60 },
      { id: 'salary', header: 'Salary', accessorFn: (r) => r.player.salary, cell: (c) => formatSalary(c.getValue()), meta: { numeric: true } },
      { id: 'proj', header: 'Proj', accessorFn: (r) => r.player.projected_points || 0, cell: (c) => c.getValue().toFixed(1), meta: { numeric: true } },
      { id: 'own', header: 'Own', accessorFn: (r) => r.player.rostership || 0, cell: (c) => `${c.getValue().toFixed(1)}%`, meta: { numeric: true } },
      { id: 'count', header: 'Lineups', accessorKey: 'count', meta: { numeric: true } },
      { id: 'exposure', header: 'Exposure', accessorKey: 'exposure', cell: (c) => <ExposureBar value={c.getValue()} limit={limit} />, meta: { numeric: true } },
    ],
    [limit],
  );

  const teamColumns = useMemo(
    () => [
      { id: 'team', header: 'Team', accessorKey: 'team', meta: { className: 'font-medium' } },
      { id: 'lineups', header: 'Lineups', accessorKey: 'lineups', meta: { numeric: true } },
      { id: 'slots', header: 'Player slots', accessorKey: 'slots', meta: { numeric: true } },
      {
        id: 'perLineup',
        header: 'Avg / lineup',
        accessorFn: (r) => (r.lineups ? r.slots / r.lineups : 0),
        cell: (c) => c.getValue().toFixed(2),
        meta: { numeric: true },
      },
      { id: 'exposure', header: 'Exposure', accessorKey: 'exposure', cell: (c) => <ExposureBar value={c.getValue()} />, meta: { numeric: true } },
    ],
    [],
  );

  if (lineups.length === 0) {
    return <EmptyState title="No exposure yet" description="Generate lineups to see how often each player and team is used." />;
  }

  return (
    <div className="flex flex-col gap-2">
      <DataTable
        key={view}
        data={view === 'players' ? players : teams}
        columns={view === 'players' ? playerColumns : teamColumns}
        getRowId={(r) => String(view === 'players' ? r.id : r.team)}
        initialSorting={[{ id: 'exposure', desc: true }]}
        maxHeight="calc(100vh - 300px)"
        showColumnToggle={false}
        toolbar={
          <div className="flex items-center gap-3">
            <Tabs
              variant="pill"
              size="sm"
              value={view}
              onChange={setView}
              tabs={[
                { value: 'players', label: 'Players', count: players.length },
                { value: 'teams', label: 'Teams', count: teams.length },
              ]}
            />
            <span className="text-2xs text-fg-subtle">
              Across {lineups.length} lineup{lineups.length === 1 ? '' : 's'}
              {limit != null && ` · max ${limit}%`}
            </span>
          </div>
        }
      />
    </div>
  );
}
