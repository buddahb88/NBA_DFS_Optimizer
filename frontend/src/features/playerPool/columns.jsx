import { Badge, Tooltip, cn } from '../../components/ui';
import { bandTone, injuryCode, injuryTone } from './playerPool';
import { ControlButton, Dash, IconBan, IconLock, Num, NumberCell, OwnershipCell } from './cells';

// tanstack sorts `undefined` last with sortUndefined: 'last'
const orUndef = (v) => (v == null || Number.isNaN(Number(v)) ? undefined : Number(v));
const numericCol = { meta: { numeric: true }, sortUndefined: 'last', sortDescFirst: true };

/**
 * @param stats    slateStats() of the whole pool (for percentile colouring)
 * @param onUpdate (playerId, patch) => error string | null
 */
export function buildColumns({ stats, onUpdate }) {
  return [
    {
      id: 'controls',
      header: '',
      enableSorting: false,
      enableHiding: false,
      size: 52,
      meta: { label: 'Lock / exclude' },
      cell: ({ row }) => {
        const p = row.original;
        const s = p.settings || {};
        return (
          <span className="inline-flex gap-0.5">
            <ControlButton active={s.lock} tone="positive" label={`${s.lock ? 'Unlock' : 'Lock'} ${p.name}`} onClick={() => onUpdate(p.player_id, { lock: !s.lock })}>
              <IconLock />
            </ControlButton>
            <ControlButton active={s.exclude} tone="negative" label={`${s.exclude ? 'Include' : 'Exclude'} ${p.name}`} onClick={() => onUpdate(p.player_id, { exclude: !s.exclude })}>
              <IconBan />
            </ControlButton>
          </span>
        );
      },
    },
    {
      id: 'player',
      header: 'Player',
      accessorFn: (p) => p.name,
      enableHiding: false,
      meta: { label: 'Player' },
      cell: ({ row }) => {
        const p = row.original;
        return (
          <span className="flex min-w-[10rem] flex-col leading-tight">
            <span className={cn('truncate font-medium', p.settings?.exclude && 'text-fg-subtle line-through')}>{p.name}</span>
            <span className="text-2xs text-fg-subtle">
              {p.team ?? '—'} <span className="opacity-70">vs</span> {p.opponent ?? '—'}
            </span>
          </span>
        );
      },
    },
    {
      id: 'positions',
      header: 'Pos',
      accessorFn: (p) => p.position,
      meta: { label: 'Positions' },
      cell: ({ row }) => <span className="text-fg-muted">{String(row.original.position || '').replace(/,/g, '/')}</span>,
    },
    {
      id: 'salary',
      header: 'Salary',
      accessorFn: (p) => orUndef(p.salary),
      ...numericCol,
      cell: ({ getValue }) => (getValue() == null ? <Dash /> : `$${getValue().toLocaleString()}`),
    },
    {
      id: 'proj',
      header: 'Proj',
      accessorFn: (p) => orUndef(p.proj),
      ...numericCol,
      meta: { numeric: true, label: 'Projection' },
      cell: ({ row }) => {
        const p = row.original;
        if (!p.overridden) return <Num value={p.proj} />;
        return (
          <Tooltip content={`Override (model ${p.baseProj.toFixed(1)})`}>
            <span className="font-semibold text-accent">{p.proj.toFixed(1)}*</span>
          </Tooltip>
        );
      },
    },
    {
      id: 'override',
      header: 'Override',
      enableSorting: false,
      meta: { align: 'right', label: 'Projection override' },
      cell: ({ row }) => {
        const p = row.original;
        return (
          <NumberCell
            label={`Projection override for ${p.name}`}
            value={p.settings?.projectionOverride ?? null}
            placeholder={p.baseProj ? p.baseProj.toFixed(1) : ''}
            step={0.5}
            className="w-14"
            onCommit={(v) => onUpdate(p.player_id, { projectionOverride: v })}
          />
        );
      },
    },
    {
      id: 'value',
      header: 'Value',
      accessorFn: (p) => orUndef(p.valueAdj),
      ...numericCol,
      meta: { numeric: true, label: 'Value (pts/$1K)' },
      cell: ({ getValue }) => <Num value={getValue()} digits={2} suffix="x" tone={bandTone(getValue(), stats.value)} />,
    },
    {
      id: 'floor',
      header: 'Floor',
      accessorFn: (p) => orUndef(p.floorAdj),
      ...numericCol,
      cell: ({ getValue }) => <Num value={getValue()} />,
    },
    {
      id: 'ceiling',
      header: 'Ceil',
      accessorFn: (p) => orUndef(p.ceilingAdj),
      ...numericCol,
      meta: { numeric: true, label: 'Ceiling' },
      cell: ({ getValue }) => <Num value={getValue()} />,
    },
    {
      id: 'own',
      header: 'Own',
      accessorFn: (p) => orUndef(p.rostership),
      ...numericCol,
      meta: { numeric: true, label: 'Ownership' },
      cell: ({ getValue }) => <OwnershipCell value={getValue()} />,
    },
    {
      id: 'leverage',
      header: 'Lev',
      accessorFn: (p) => orUndef(p.leverage_score),
      ...numericCol,
      meta: { numeric: true, label: 'Leverage' },
      cell: ({ getValue }) => <Num value={getValue()} tone={bandTone(getValue(), stats.leverage)} />,
    },
    {
      id: 'boom',
      header: 'Boom',
      accessorFn: (p) => orUndef(p.boom_probability),
      ...numericCol,
      meta: { numeric: true, label: 'Boom %' },
      cell: ({ getValue }) => <Num value={getValue()} digits={0} suffix="%" />,
    },
    {
      id: 'minutes',
      header: 'Min',
      accessorFn: (p) => orUndef(p.projected_minutes),
      ...numericCol,
      meta: { numeric: true, label: 'Minutes' },
      cell: ({ getValue }) => <Num value={getValue()} digits={0} />,
    },
    {
      id: 'vegas',
      header: 'Imp',
      accessorFn: (p) => orUndef(p.vegas_implied_total),
      ...numericCol,
      meta: { numeric: true, label: 'Vegas implied total' },
      cell: ({ getValue }) => <Num value={getValue()} />,
    },
    {
      id: 'injury',
      header: 'Inj',
      accessorFn: (p) => injuryCode(p.injury_status) ?? undefined,
      sortUndefined: 'last',
      meta: { align: 'center', label: 'Injury' },
      cell: ({ getValue }) =>
        getValue() ? (
          <Badge size="sm" tone={injuryTone(getValue())}>
            {getValue()}
          </Badge>
        ) : null,
    },
    {
      id: 'minExp',
      header: 'Min %',
      enableSorting: false,
      meta: { align: 'right', label: 'Min exposure' },
      cell: ({ row }) => {
        const p = row.original;
        return (
          <NumberCell
            label={`Min exposure for ${p.name}`}
            value={p.settings?.minExposure ?? null}
            placeholder="0"
            onCommit={(v) => onUpdate(p.player_id, { minExposure: v })}
          />
        );
      },
    },
    {
      id: 'maxExp',
      header: 'Max %',
      enableSorting: false,
      meta: { align: 'right', label: 'Max exposure' },
      cell: ({ row }) => {
        const p = row.original;
        return (
          <NumberCell
            label={`Max exposure for ${p.name}`}
            value={p.settings?.maxExposure ?? null}
            placeholder="100"
            onCommit={(v) => onUpdate(p.player_id, { maxExposure: v })}
          />
        );
      },
    },
  ];
}
