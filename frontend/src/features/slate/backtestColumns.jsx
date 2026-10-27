import { formatActual } from './backtest';
import ResultBadge from './ResultBadge';

// Backtest-only DataTable columns for rows carrying withActuals fields
// (actualPoints / actualMinutes / resultStatus).

// What the player actually scored that night
export const ACTUAL_COLUMN = {
  id: 'actual',
  accessorFn: (p) => p.actualPoints ?? null,
  header: 'Actual',
  meta: { numeric: true, label: 'Actual DK points' },
  sortUndefined: 'last',
  cell: ({ getValue }) => <span className="font-semibold">{formatActual(getValue())}</span>,
};

// Played (with actual minutes) / DNP / inactive / pending
export const RESULT_COLUMN = {
  id: 'result',
  accessorFn: (p) => p.resultStatus ?? null,
  header: 'Result',
  meta: { label: 'Result that night' },
  sortUndefined: 'last',
  cell: ({ row }) => <ResultBadge player={row.original} />,
};
