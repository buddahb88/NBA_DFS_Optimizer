import { useMemo, useState } from 'react';
import { Badge, Button, DataTable, IconSearch, Input, cn } from '../../components/ui';
import { formatSalary } from './lineupMath';

/** Optimizer pool with lock / exclude toggles. */
export default function PlayerPoolTable({ players, locked, excluded, onToggleLock, onToggleExclude, onClear }) {
  const [search, setSearch] = useState('');

  const columns = useMemo(
    () => [
      {
        id: 'controls',
        header: '',
        enableSorting: false,
        size: 130,
        cell: ({ row }) => {
          const id = row.original.id;
          const isLocked = locked.has(id);
          const isExcluded = excluded.has(id);
          return (
            <div className="flex gap-1">
              <Button size="xs" variant={isLocked ? 'positive' : 'outline'} aria-pressed={isLocked} onClick={() => onToggleLock(id)}>
                {isLocked ? 'Locked' : 'Lock'}
              </Button>
              <Button size="xs" variant={isExcluded ? 'danger' : 'outline'} aria-pressed={isExcluded} onClick={() => onToggleExclude(id)}>
                {isExcluded ? 'Out' : 'Exclude'}
              </Button>
            </div>
          );
        },
      },
      { id: 'name', header: 'Player', accessorKey: 'name', meta: { className: 'font-medium' } },
      { id: 'pos', header: 'Pos', accessorKey: 'position', size: 70 },
      { id: 'team', header: 'Team', accessorFn: (p) => `${p.team ?? ''} v ${p.opponent ?? ''}`, size: 90 },
      { id: 'salary', header: 'Salary', accessorKey: 'salary', cell: (c) => formatSalary(c.getValue()), meta: { numeric: true } },
      { id: 'proj', header: 'Proj', accessorFn: (p) => p.projected_points || 0, cell: (c) => c.getValue().toFixed(1), meta: { numeric: true } },
      {
        id: 'value',
        header: 'Value',
        accessorFn: (p) => (p.salary ? ((p.projected_points || 0) / p.salary) * 1000 : 0),
        cell: (c) => c.getValue().toFixed(2),
        meta: { numeric: true },
      },
      { id: 'own', header: 'Own', accessorFn: (p) => p.rostership || 0, cell: (c) => `${c.getValue().toFixed(1)}%`, meta: { numeric: true } },
    ],
    [locked, excluded, onToggleLock, onToggleExclude],
  );

  return (
    <DataTable
      data={players}
      columns={columns}
      getRowId={(p) => String(p.id)}
      globalFilter={search}
      initialSorting={[{ id: 'proj', desc: true }]}
      maxHeight="calc(100vh - 300px)"
      rowClassName={(p) => cn(locked.has(p.id) && 'bg-positive-soft/40', excluded.has(p.id) && 'opacity-50')}
      toolbar={
        <div className="flex flex-1 items-center gap-2">
          <Input
            aria-label="Search players"
            placeholder="Search players…"
            leftIcon={<IconSearch size={13} />}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-56"
          />
          {locked.size > 0 && <Badge tone="positive">{locked.size} locked</Badge>}
          {excluded.size > 0 && <Badge tone="negative">{excluded.size} excluded</Badge>}
          {(locked.size > 0 || excluded.size > 0) && (
            <Button variant="ghost" size="xs" onClick={onClear}>
              Clear
            </Button>
          )}
        </div>
      }
    />
  );
}
